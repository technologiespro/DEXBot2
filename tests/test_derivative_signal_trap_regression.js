const assert = require('assert');
const path = require('path');

const { DerivativeAnalyzer } = require('../analysis/derivative_analyzer');
const { createSource } = require('../analysis/price_sources');

function createAnalyzer() {
    return new DerivativeAnalyzer({
        slowSmaPeriod: 500,
        fastSmaPeriod: 100,
        macdEnabled: true,
        macdFastPeriod: 48,
        macdSlowPeriod: 104,
        macdSignalPeriod: 36,
        macdMinHist: 0.02,
        rsiEnabled: true,
        rsiPeriod: 96,
        rsiOverboughtLevel: 90,
        rsiOversoldLevel: 10,
        rsiBullThreshold: 60,
        rsiBearThreshold: 40,
        interpConfirmBars: 3,
        interpHoldBars: 3,
        trendFilterEnabled: true,
        trendFilterMinBars: 3,
        momentumGateEnabled: true,
        momentumGateMinBars: 3,
        priceRegimeGateEnabled: true,
    });
}

async function testHistoricalBullTrapExit() {
    const source = createSource('json', {
        filePath: path.join(__dirname, '..', 'market_adapter', 'inputs', 'data', 'lp', '1_3_5537_1_3_0', 'lp_pool_133_1h.json'),
    });
    const candles = await source.fetchCandles();
    const analyzer = createAnalyzer();
    const bars = new Map();

    for (let i = 0; i < candles.length; i++) {
        const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
        const result = analyzer.update(marketPrice, timestamp);
        if (i >= 2767 && i <= 2772) {
            bars.set(i, {
                interpretation: result.interpretation,
                interpretationRaw: result.interpretationRaw,
                timestamp,
            });
        }
    }

    assert.strictEqual(bars.get(2767).interpretation, 'NEUTRAL', 'shallow bull cross should not confirm');
    assert.strictEqual(bars.get(2768).interpretation, 'NEUTRAL', 'shallow bull cross should remain filtered');
    assert.strictEqual(bars.get(2769).interpretation, 'NEUTRAL', 'late shallow bull cross should remain filtered');
    assert.strictEqual(bars.get(2770).interpretationRaw, 'NEUTRAL', 'dump bar should invalidate the raw BULL signal');
    assert.strictEqual(bars.get(2770).interpretation, 'NEUTRAL', 'dump bar should exit directly to NEUTRAL');
}

function testHardInvalidationBypassesHold() {
    const bullAnalyzer = createAnalyzer();
    bullAnalyzer.currInterpretation = 'BULL';
    bullAnalyzer.currMacd = { macd: 0.08, signal: 0.01, histogram: 0.07 };
    bullAnalyzer.currPrice = 99;
    bullAnalyzer.currSma = 100;
    bullAnalyzer._applyWithHysteresis('NEUTRAL');
    assert.strictEqual(bullAnalyzer.currInterpretation, 'NEUTRAL', 'price regime invalidation should bypass BULL hold');

    const bearAnalyzer = createAnalyzer();
    bearAnalyzer.currInterpretation = 'BEAR';
    bearAnalyzer.currMacd = { macd: -0.08, signal: -0.01, histogram: -0.07 };
    bearAnalyzer.currPrice = 101;
    bearAnalyzer.currSma = 100;
    bearAnalyzer._applyWithHysteresis('NEUTRAL');
    assert.strictEqual(bearAnalyzer.currInterpretation, 'NEUTRAL', 'price regime invalidation should bypass BEAR hold');
}

async function main() {
    console.log('Running test: derivative signal trap regression');
    await testHistoricalBullTrapExit();
    testHardInvalidationBypassesHold();
    console.log('✓ derivative signal trap regression PASSED');
}

main().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
