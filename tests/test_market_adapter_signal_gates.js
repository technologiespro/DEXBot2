'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
            { timestamp: '2026-01-01T05:00:00Z', price: 105, ama3Price: 105, amaSlopePct: 1, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T06:00:00Z', price: 106, ama3Price: 106, amaSlopePct: 2, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
        ],
        amaConfig: { erPeriod: 1, slowPeriod: 1 },
        amaWeightConfig: { lookbackBars: 1 },
    }, 'Dynamic Weight Test');

    const payload = extractHtmlPayload(html);
    assert.strictEqual(payload.amaSlowPeriod, 1, 'chart payload should carry AMA slow-period warmup');
    assert.strictEqual(payload.amaWarmupBars, 5, 'chart payload should expose the full AMA warmup window');
    assert.strictEqual(payload.amaPercentiles[100], 2, 'AMA clip percentiles should ignore startup bars before the full warmup');
    assert.match(html, /data\.amaSlowPeriod/, 'interactive chart should use the AMA slow period in its readiness gate');
    assert.match(html, /for \(let i = amaReadyBar; i < data\.realBarCount; i\+\+\)/, 'interactive clip-threshold recompute should skip the full AMA warmup window');
}

function testDynamicWeightChartKeepsGainLinearAtEnd() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 0.4, velocityPct: 0.2, displacementPct: 0.1, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 0.5, velocityPct: 0.25, displacementPct: 0.15, isReady: true, signal: 'NEUTRAL' },
        ],
        gain: 0.8,
        minOutputThreshold: 0.12,
    }, 'Dynamic Weight Test');

    assert.match(
        html,
        /const channelNorm = Math\.max\(Math\.abs\(OUTPUT_CLAMP\), 1e-9\);/,
        'chart should normalize the blended channels by the configured output clamp'
    );
    assert.match(
        html,
        /const outputThreshold = currentMinOutputThreshold;/,
        'chart should keep the dead-band independent from the final gain slider'
    );
    assert.match(
        html,
        /const mo = OUTPUT_CLAMP;/,
        'chart should cap AMA and Kalman input channels with the runtime output clamp rather than gain'
    );
    assert.match(
        html,
        /const blendedOff = \(currentAlpha \* \(aOff \/ channelNorm\) \+ \(1 - currentAlpha\) \* \(kOff \/ channelNorm\)\);/,
        'chart should compute the blended shape before applying gain'
    );
    assert.match(
        html,
        /const gatedOff = Math\.abs\(blendedOff \* finalMult\) < outputThreshold \? 0 : \(blendedOff \* finalMult\);/,
        'chart should make the dead-band decision in pre-gain space so gain does not reshape the signal'
    );
    assert.match(
        html,
        /const off = gatedOff \* currentGain;/,
        'chart should apply gain only as a final linear scale factor'
    );
}

function testDynamicWeightChartShowsOutputClampGuide() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 0.4, velocityPct: 0.2, displacementPct: 0.1, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 0.5, velocityPct: 0.25, displacementPct: 0.15, isReady: true, signal: 'NEUTRAL' },
        ],
        gain: 0.8,
    }, 'Dynamic Weight Test');

    assert.match(html, /const OUTPUT_CLAMP = data\.outputClamp \?\? 0\.5;/,
        'bottom output panel should resolve the clamp from payload data or the runtime default');
    assert.match(html, /makeClampPairHooks\('ow', OUTPUT_CLAMP\)/,
        'bottom output panel should draw both clamp guide lines');
    assert.match(html, /makeClampLineHook\(scaleKey, -clampValue, 'clamp -' \+ clampValue\.toFixed\(2\)\)/,
        'bottom output panel should include the mirrored negative clamp guide');
    assert.match(html, /const OUTPUT_CLAMP = data\.outputClamp \?\? 0\.5;[\s\S]*function recalcInputs\(\)/,
        'output clamp constant should be declared before recalcInputs uses it');
}

function testLiveServiceMatchesChartGainStructure() {
    const serviceSource = fs.readFileSync(
        path.join(__dirname, '..', 'market_adapter', 'core', 'market_adapter_service.js'),
        'utf8'
    );

    assert.match(
        serviceSource,
        /const channelNorm = Math\.max\(Math\.abs\(offsetClamp\), 1e-9\);/,
        'live service should normalize the blended channels by the runtime offset clamp'
    );
    assert.match(
        serviceSource,
        /const outputThreshold = minOutputThreshold;/,
        'live service should keep the dead-band in pre-gain space'
    );
    assert.match(
        serviceSource,
        /const hasDirectionalOffset = mo > 0;/,
        'live service should disable the directional branch when maxSlopeOffset is zero'
    );
    assert.match(
        serviceSource,
        /const useAmaBlend = hasDirectionalOffset && alpha !== 0;/,
        'live service should short-circuit the AMA branch when alpha is zero or directional offset is disabled'
    );
    assert.match(
        serviceSource,
        /const useKalmanBlend = hasDirectionalOffset && alpha !== 1;/,
        'live service should short-circuit the Kalman branch when alpha is one'
    );
    assert.match(
        serviceSource,
        /if \(useAmaBlend && useKalmanBlend\) \{/,
        'live service should still compute the full blend when both channels participate'
    );
    assert.match(
        serviceSource,
        /const gatedOff = outputThresholdIsZero\s*\?\s*regimeAdjusted\s*:\s*\(Math\.abs\(regimeAdjusted\) < outputThreshold \? 0 : regimeAdjusted\);/,
        'live service should skip the dead-band comparison when the threshold is zero'
    );
    assert.match(
        serviceSource,
        /const off = Math\.max\(-offsetClamp, Math\.min\(offsetClamp, gatedOff \* gain\)\);/,
        'live service should still apply gain as the final scale factor before the runtime clamp'
    );
    assert.match(
        serviceSource,
        /let echoedGatedOffSeries = new Array\(closes\.length\)\.fill\(0\);/,
        'live service should track a latched pre-gain series alongside the applied output'
    );
    assert.match(
        serviceSource,
        /const finalPreGainOff = echoedGatedOffSeries\[echoedGatedOffSeries\.length - 1\] \?\? rawFinalPreGainOff;/,
        'live service should evaluate the threshold against the confirmed pre-gain state'
    );
    assert.match(
        serviceSource,
        /const belowMinOutputThreshold = Math\.abs\(finalPreGainOff\) < outputThreshold;/,
        'live service should keep thresholding aligned with the latched output state'
    );
}

function main() {
    testAmaSlopeWarmupUsesSlowPeriod();
    testAtrRejectsInvalidCandles();
    testAtrInvalidCandleBreaksTrueRangeChain();
    testKalmanWarmupIsConfigurable();
    testRegimeMultiplierReturnsSeries();
    testDynamicWeightChartUsesSlowPeriodWarmup();
    testDynamicWeightChartKeepsGainLinearAtEnd();
    testDynamicWeightChartShowsOutputClampGuide();
    testLiveServiceMatchesChartGainStructure();
    console.log('market adapter signal gate tests passed');
}

main();
