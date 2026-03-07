const assert = require('assert');

console.log('Running backtest AMA sweep logic tests');

const {
    countCancelableOrders,
    simulatePersistentGrid,
    sweepOneAma,
} = require('../analysis/bot_fitting/backtest_ama_sweep');

function makeCandle(close, high = close, low = close) {
    return { timestamp: 0, open: close, high, low, close, volume: 1 };
}

// Reposition should realize unmatched inventory instead of discarding it.
{
    const candles = Array.from({ length: 23 }, () => makeCandle(100));
    candles[21] = makeCandle(99, 100, 98);
    candles[22] = makeCandle(90, 90, 90);

    const amaValues = new Array(23).fill(100);
    amaValues[22] = 90;

    const result = simulatePersistentGrid(candles, amaValues, {
        spreadPct: 2,
        incrementPct: 0.01,
        maxMinRatio: 2,
        maxOrders: 1,
        feeRoundtripPct: 0.2,
        capital: 10000,
        repositionThreshold: 0.05,
        btsCreateFee: 0,
        btsCancelFee: 1,
        makerCreateFactor: 0,
        txFeePrice: 0,
    }, 'neutral', 0);

    assert.strictEqual(result.matchedPairs, 0, 'scenario should not produce matched pairs');
    assert.strictEqual(result.repositionCount, 1, 'scenario should force one reposition');
    assert.strictEqual(result.canceledOnReposition, 1, 'only still-live orders should be counted as canceled on reposition');
    assert.strictEqual(result.avgCancelOrdersPerReposition, 1, 'filled inventory placeholders must not add cancel fees');
    assert.strictEqual(result.totalRepositionFeesBts, 1, 'cancel fee totals should only include live orders');
    assert.ok(result.totalProfitUnits < 0, 'forced close on reposition should realize a loss');
    assert.ok(result.maxDrawdown > 0, 'realized reposition loss should increase drawdown');
    assert.ok(result.maxDrawdownPct > 0, 'realized reposition loss should increase drawdown percent');
}

// Cancelable order counting should ignore already-filled inventory placeholders.
{
    const openBuys = new Map([[1, { filled: true }], [2, { filled: false }]]);
    const openSells = new Map([[1, { filled: false }], [2, { filled: true }]]);
    assert.strictEqual(countCancelableOrders(openBuys, openSells), 2, 'only unfilled orders should be cancelable');
}

// Drawdown should reflect unrealized losses on open inventory even before reposition.
{
    const candles = Array.from({ length: 23 }, () => makeCandle(100));
    candles[21] = makeCandle(99, 100, 98);
    candles[22] = makeCandle(90, 90, 90);

    const amaValues = new Array(23).fill(100);

    const result = simulatePersistentGrid(candles, amaValues, {
        spreadPct: 2,
        incrementPct: 0.01,
        maxMinRatio: 2,
        maxOrders: 1,
        feeRoundtripPct: 0.2,
        capital: 10000,
        repositionThreshold: 0.5,
        btsCreateFee: 0,
        btsCancelFee: 0,
        makerCreateFactor: 0,
        txFeePrice: 0,
    }, 'neutral', 0);

    assert.strictEqual(result.repositionCount, 0, 'scenario should avoid repositioning');
    assert.strictEqual(result.totalProfitUnits, 0, 'without forced close, realized profit should remain zero');
    assert.ok(result.maxDrawdown > 0, 'unrealized loss should contribute to drawdown');
    assert.ok(result.maxDrawdownPct > 0, 'unrealized loss should contribute to drawdown percent');
}

// minSpreadFactor should filter out invalid spread/increment combinations before simulation.
{
    const candles = Array.from({ length: 40 }, () => makeCandle(100));
    const closes = candles.map((c) => c.close);

    const result = sweepOneAma(
        { id: 'TEST', name: 'TEST', er: 2, fast: 2, slow: 10 },
        candles,
        closes,
        [['neutral', 0]],
        {
            spreadValues: [1],
            incrementValues: [1],
            ratioValues: [2],
            maxOrders: 1,
            feeRoundtripPct: 0.2,
            capital: 1000,
            repositionPct: 5,
            btsCreateFee: 0,
            btsCancelFee: 0,
            makerCreateFactor: 0,
            txFeePrice: 0,
            minSpreadFactor: 2,
        }
    );

    assert.strictEqual(result.evaluated, 0, 'spread/increment pairs below minSpreadFactor should be skipped');
    assert.strictEqual(result.best, null, 'no invalid combinations should be simulated');
    assert.deepStrictEqual(result.allSims, [], 'skipped combinations should not produce results');
}

console.log('backtest AMA sweep logic tests passed');
process.exit(0);
