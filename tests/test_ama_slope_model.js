'use strict';

const assert = require('assert');

console.log('Running ama_slope_model tests');

const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');

// Generate a series of N values with a given pattern
function flatSeries(n, value) {
    return new Array(n).fill(value);
}

// Default opts use erPeriod=781, lookbackBars=72 — too large for unit tests.
// Override erPeriod=10, lookbackBars=10 so we need 10+10+1=21 values minimum.
const SMALL_OPTS = { erPeriod: 10, lookbackBars: 10 };
const MIN_LEN = 21; // erPeriod + lookbackBars + 1

// ─── isReady guard ──────────────────────────────────────────────────────────

function testNotReadyWhenTooFewValues() {
    const result = computeAmaSlopeWeights(flatSeries(20, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false, 'should not be ready with fewer than erPeriod+lookback+1 values');
    assert.strictEqual(result.sellW, 0.5, 'fallback sellW should be baseline');
    assert.strictEqual(result.buyW, 0.5, 'fallback buyW should be baseline');
    assert.strictEqual(result.slopeOffset, 0);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.strictEqual(result.slopePct, 0);
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.trend, 'NEUTRAL');
}

function testNotReadyOnEmptyArray() {
    const result = computeAmaSlopeWeights([], 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false);
}

function testNotReadyOnExactMinusOne() {
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN - 1, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false);
}

function testReadyOnExactMinimum() {
    // Flat series → neutral zone → isReady=true, slopeOffset=0
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, true);
}

// ─── Neutral zone ────────────────────────────────────────────────────────────

function testNeutralZoneZeroSlope() {
    // Perfectly flat: last === past → slopePct=0
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.015, SMALL_OPTS);
    assert.strictEqual(result.isReady, true);
    assert.strictEqual(result.trend, 'NEUTRAL');
    assert.strictEqual(result.slopeOffset, 0);
    assert.strictEqual(result.confidence, 0);
}

function testNeutralZoneJustBelow() {
    // slopePct = 0.14% < neutralZonePct=0.15% → still NEUTRAL
    const values = flatSeries(MIN_LEN, 100);
    // Set last value slightly higher: 100 * 1.0014 = 100.14
    values[MIN_LEN - 1] = 100.14;
    const result = computeAmaSlopeWeights(values, 0, { ...SMALL_OPTS, neutralZonePct: 0.15 });
    assert.strictEqual(result.trend, 'NEUTRAL');
    assert.strictEqual(result.slopeOffset, 0);
}

function testTrendJustAboveNeutralZone() {
    // slopePct = 0.16% > neutralZonePct=0.15% → UP
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 100.16;
    const result = computeAmaSlopeWeights(values, 0, { ...SMALL_OPTS, neutralZonePct: 0.15 });
    assert.strictEqual(result.trend, 'UP');
    assert.ok(result.slopeOffset > 0, 'positive slopeOffset for UP trend');
}

// ─── Positive slope (up trend) ──────────────────────────────────────────────

function testPositiveSlopePartialSaturation() {
    // slopePct = 1.5%, maxSlopePct = 3.0 → slopeOffset = (1.5/3.0)*0.5 = 0.25
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 101.5; // past=100, last=101.5 → 1.5%
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.isReady, true);
    assert.strictEqual(result.trend, 'UP');
    assert.strictEqual(result.slopeOffset, 0.25);
    assert.strictEqual(result.confidence, 50);
}

function testPositiveSlopeFullSaturation() {
    // slopePct = 6% > maxSlopePct=3.0 → clamped to 1 → slopeOffset=0.5
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'UP');
    assert.strictEqual(result.slopeOffset, 0.5);
    assert.strictEqual(result.confidence, 100);
}

// ─── Negative slope (down trend) ────────────────────────────────────────────

function testNegativeSlopePartialSaturation() {
    // slopePct = -1.5%, maxSlopePct=3.0 → slopeOffset = -0.25
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 98.5;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.25);
    assert.strictEqual(result.confidence, 50);
}

function testNegativeSlopeFullSaturation() {
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 94;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.5);
    assert.strictEqual(result.confidence, 100);
}

// ─── Volatility (symmetricDelta) ─────────────────────────────────────────────

function testZeroVolatilitySymmetricDelta() {
    // weightVariance=0 → volFactor=1 → symmetricDelta = (1*2-1)*0.5 = +0.5
    const opts = { ...SMALL_OPTS, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, opts);
    assert.strictEqual(result.symmetricDelta, 0.5);
    // neutral slope: sellW = 0.5 + 0 + 0.5 = 1.0, buyW = 1.0
    assert.strictEqual(result.sellW, 1.0);
    assert.strictEqual(result.buyW, 1.0);
}

function testMidVolatilitySymmetricDelta() {
    // weightVariance = maxVolatilityThreshold/2 = 0.015 → volFactor=0.5 → symmetricDelta=0
    const opts = { ...SMALL_OPTS, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.015, opts);
    assert.strictEqual(result.symmetricDelta, 0);
    // neutral slope, neutral vol: sellW = buyW = 0.5
    assert.strictEqual(result.sellW, 0.5);
    assert.strictEqual(result.buyW, 0.5);
}

function testHighVolatilitySymmetricDelta() {
    // weightVariance >= maxVolatilityThreshold → volFactor=0 → symmetricDelta = (0-1)*0.5 = -0.5
    const opts = { ...SMALL_OPTS, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.03, opts);
    assert.strictEqual(result.symmetricDelta, -0.5);
    // neutral slope, high vol: sellW = buyW = 0.5 + 0 - 0.5 = 0.0
    assert.strictEqual(result.sellW, 0.0);
    assert.strictEqual(result.buyW, 0.0);
}

function testVolatilityAboveThresholdClamped() {
    const opts = { ...SMALL_OPTS, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.10, opts);
    // Over-threshold clamps to same as exactly at threshold
    assert.strictEqual(result.symmetricDelta, -0.5);
}

// ─── Combined slope + volatility ─────────────────────────────────────────────

function testCombinedUptrendLowVol() {
    // slopeOffset=+0.25 (partial UP), symmetricDelta=+0.5 (zero vol)
    // sellW = 0.5 + 0.25 + 0.5 = 1.25, buyW = 0.5 - 0.25 + 0.5 = 0.75
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 101.5;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.sellW, 1.25);
    assert.strictEqual(result.buyW, 0.75);
}

function testCombinedUptrendHighVol() {
    // slopeOffset=+0.5 (full UP), symmetricDelta=-0.5 (full high vol)
    // sellW = 0.5 + 0.5 - 0.5 = 0.5, buyW = 0.5 - 0.5 - 0.5 = -0.5 (clamped to -0.5)
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0.03, opts);
    assert.strictEqual(result.sellW, 0.5);
    assert.strictEqual(result.buyW, -0.5);
}

function testClampPreventsExceedingMaxWeight() {
    // Full UP slope + zero vol → sellW would be 0.5 + 0.5 + 0.5 = 1.5 (at MAX_WEIGHT)
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.sellW, 1.5, 'sellW at MAX_WEIGHT');
    assert.ok(result.buyW >= -0.5, 'buyW at or above MIN_WEIGHT');
}

// ─── Confidence derivation ────────────────────────────────────────────────────

function testConfidenceDerivation() {
    // slopeOffset=0 → confidence=0
    const r1 = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, SMALL_OPTS);
    assert.strictEqual(r1.confidence, 0);

    // slopeOffset=0.5 (full) → confidence=100
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const r2 = computeAmaSlopeWeights(values, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 });
    assert.strictEqual(r2.confidence, 100);

    // slopeOffset=0.25 (half) → confidence=50
    const values2 = flatSeries(MIN_LEN, 100);
    values2[MIN_LEN - 1] = 101.5;
    const r3 = computeAmaSlopeWeights(values2, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 });
    assert.strictEqual(r3.confidence, 50);
}

// ─── Example tables from plan (§4b) ─────────────────────────────────────────

function testNeutralSlopeVolatilityTable() {
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const flat = flatSeries(MIN_LEN, 100);

    // ATR/price = 0.00 → sellW=1.00, buyW=1.00
    let r = computeAmaSlopeWeights(flat, 0.00, opts);
    assert.strictEqual(r.sellW, 1.0);
    assert.strictEqual(r.buyW, 1.0);

    // ATR/price = 0.015 → sellW=0.50, buyW=0.50
    r = computeAmaSlopeWeights(flat, 0.015, opts);
    assert.strictEqual(r.sellW, 0.5);
    assert.strictEqual(r.buyW, 0.5);

    // ATR/price = 0.03 → sellW=0.00, buyW=0.00
    r = computeAmaSlopeWeights(flat, 0.03, opts);
    assert.strictEqual(r.sellW, 0.0);
    assert.strictEqual(r.buyW, 0.0);
}

function testUptrendSlopeOffsetTable() {
    // slopeOffset ≈ +0.33: slopePct = 2% → slopeOffset = (2/3)*0.5 = 0.333... → 0.33 rounded
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15, maxVolatilityThreshold: 0.03 };
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 102; // slopePct = 2%

    // ATR/price = 0.00 → sellW = 0.5 + 0.33 + 0.5 = 1.33 (≤1.5 MAX), buyW = 0.5 - 0.33 + 0.5 = 0.67
    let r = computeAmaSlopeWeights(values, 0.00, opts);
    assert.strictEqual(r.slopeOffset, 0.33);
    assert.strictEqual(r.sellW, 1.33);
    assert.strictEqual(r.buyW, 0.67);

    // ATR/price = 0.015 → sellW = 0.5 + 0.33 + 0 = 0.83, buyW = 0.5 - 0.33 + 0 = 0.17
    r = computeAmaSlopeWeights(values, 0.015, opts);
    assert.strictEqual(r.sellW, 0.83);
    assert.strictEqual(r.buyW, 0.17);

    // ATR/price = 0.03 → sellW = 0.5 + 0.33 - 0.5 = 0.33 → 0.33 (no clamp needed), buyW = 0.5 - 0.33 - 0.5 = -0.33 → -0.33
    r = computeAmaSlopeWeights(values, 0.03, opts);
    assert.strictEqual(r.sellW, 0.33);
    assert.strictEqual(r.buyW, -0.33);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function run() {
    testNotReadyWhenTooFewValues();
    testNotReadyOnEmptyArray();
    testNotReadyOnExactMinusOne();
    testReadyOnExactMinimum();
    testNeutralZoneZeroSlope();
    testNeutralZoneJustBelow();
    testTrendJustAboveNeutralZone();
    testPositiveSlopePartialSaturation();
    testPositiveSlopeFullSaturation();
    testNegativeSlopePartialSaturation();
    testNegativeSlopeFullSaturation();
    testZeroVolatilitySymmetricDelta();
    testMidVolatilitySymmetricDelta();
    testHighVolatilitySymmetricDelta();
    testVolatilityAboveThresholdClamped();
    testCombinedUptrendLowVol();
    testCombinedUptrendHighVol();
    testClampPreventsExceedingMaxWeight();
    testConfidenceDerivation();
    testNeutralSlopeVolatilityTable();
    testUptrendSlopeOffsetTable();
}

run()
    .then(() => console.log('ama_slope_model tests passed'))
    .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
