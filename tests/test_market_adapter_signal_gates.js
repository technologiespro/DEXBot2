'use strict';

const assert = require('assert');
const { MARKET_ADAPTER } = require('../modules/constants');
const { getAmaWarmupBars } = require('../analysis/ama_fitting/ama');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');
const { calculateATR } = require('../market_adapter/core/strategies/atr/calculator');
const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { computeRegimeMultiplier } = require('../market_adapter/core/strategies/regime_gate');
const { generateHTML } = require('../analysis/trend_detection/dynamic_weight_chart_generator');

console.log('Running market adapter signal gate tests');

function testAmaSlopeWarmupUsesSlowPeriod() {
    const erPeriod = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;
    const slowPeriod = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].slowPeriod;
    const lookbackBars = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const warmupBars = getAmaWarmupBars(erPeriod, slowPeriod, lookbackBars);

    const shortSeries = new Array(warmupBars).fill(100);
    const shortResult = computeAmaSlopeWeights(shortSeries, 0, {
        erPeriod,
        slowPeriod,
        lookbackBars,
    });
    assert.strictEqual(shortResult.isReady, false, 'AMA slope should not be ready before the slow-period warmup');

    const readySeries = new Array(warmupBars + 1).fill(100);
    readySeries[warmupBars] = 101;
    const readyResult = computeAmaSlopeWeights(readySeries, 0, {
        erPeriod,
        slowPeriod,
        lookbackBars,
    });
    assert.strictEqual(readyResult.isReady, true, 'AMA slope should be ready after the slow-period warmup');
}

function testAtrRejectsInvalidCandles() {
    const candles = [];
    for (let i = 0; i < 20; i++) {
        candles.push([i + 1, 1, 2 + (i * 0.01), 1, 1 + (i * 0.01), 10]);
    }
    candles[8] = [9, 1, Number.NaN, 1, 1.08, 10];

    const atr = calculateATR(candles, 3);
    assert.ok(Number.isFinite(atr), 'ATR should skip isolated invalid candles instead of disabling volatility');
    assert.ok(atr > 0, 'ATR should remain positive when enough valid candles are present');
}

function testAtrInvalidCandleBreaksTrueRangeChain() {
    const candles = [
        [1, 0, 101, 99, 100, 10],
        [2, 0, 101, 99, 100, 10],
        [3, 0, 101, 99, 100, 10],
        [4, 0, Number.NaN, Number.NaN, Number.NaN, 10],
        [5, 0, 201, 199, 200, 10],
        [6, 0, 201, 199, 200, 10],
        [7, 0, 201, 199, 200, 10],
    ];

    const atr = calculateATR(candles, 2);
    assert.strictEqual(atr, 2, 'ATR should restart after an invalid candle instead of carrying forward a stale close');
}

function testKalmanWarmupIsConfigurable() {
    const analyzer = new KalmanTrendAnalyzer({ warmupBars: 5 });
    for (let i = 0; i < 5; i++) {
        const result = analyzer.update(100 + i);
        assert.strictEqual(result.isReady, false, 'Kalman analyzer should still be warming up at the configured boundary');
    }
    const ready = analyzer.update(105);
    assert.strictEqual(ready.isReady, true, 'Kalman analyzer should become ready after the configured warmup');
}

function testRegimeMultiplierReturnsSeries() {
    const closes = [];
    for (let i = 0; i < 400; i++) closes.push(100 + i * 0.1);
    const result = computeRegimeMultiplier(closes, { regimeSensitivity: 1 });
    assert.ok(Array.isArray(result.series), 'regime multiplier should expose the per-bar series');
    assert.strictEqual(result.series.length, closes.length, 'regime multiplier series should match the input length');
    assert.ok(Number.isFinite(result.multiplier), 'final regime multiplier should remain finite');
}

function extractHtmlPayload(html) {
    const match = html.match(/<script id="payload" type="application\/json">(.*?)<\/script>/s);
    assert.ok(match, 'generated HTML should include an embedded JSON payload');
    return JSON.parse(match[1]);
}

function testDynamicWeightChartUsesSlowPeriodWarmup() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T02:00:00Z', price: 102, ama3Price: 102, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T03:00:00Z', price: 103, ama3Price: 103, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T04:00:00Z', price: 104, ama3Price: 104, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T05:00:00Z', price: 105, ama3Price: 105, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T06:00:00Z', price: 106, ama3Price: 106, amaSlopePct: 1, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T07:00:00Z', price: 107, ama3Price: 107, amaSlopePct: 2, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
        ],
        amaConfig: { erPeriod: 2, slowPeriod: 3 },
        amaWeightConfig: { lookbackBars: 1 },
    }, 'Dynamic Weight Test');

    const payload = extractHtmlPayload(html);
    assert.strictEqual(payload.amaSlowPeriod, 3, 'chart payload should carry AMA slow-period warmup');
    assert.strictEqual(payload.amaWarmupBars, 6, 'chart payload should expose the full AMA warmup window');
    assert.strictEqual(payload.amaPercentiles[100], 2, 'AMA clip percentiles should ignore startup bars before the full warmup');
    assert.match(html, /data\.amaSlowPeriod/, 'interactive chart should use the AMA slow period in its readiness gate');
    assert.match(html, /for \(let i = amaReadyBar; i < data\.realBarCount; i\+\+\)/, 'interactive clip-threshold recompute should skip the full AMA warmup window');
}

function main() {
    testAmaSlopeWarmupUsesSlowPeriod();
    testAtrRejectsInvalidCandles();
    testAtrInvalidCandleBreaksTrueRangeChain();
    testKalmanWarmupIsConfigurable();
    testRegimeMultiplierReturnsSeries();
    testDynamicWeightChartUsesSlowPeriodWarmup();
    console.log('market adapter signal gate tests passed');
}

main();
