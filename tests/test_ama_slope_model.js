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
const MODEL_NEUTRAL_WEIGHT = 0.5;
const HALF_POWER_VOL_OPTS = {
    ...SMALL_OPTS,
    volatilityExponent: 0.5,
    volatilityScaleX: 0.5,
};
const HALF_POWER_SLOPE_VOL_OPTS = {
    ...HALF_POWER_VOL_OPTS,
    maxSlopePct: 3.0,
    neutralZonePct: 0.15,
};

function derivedWeights(result) {
    return {
        sellW: Math.round((MODEL_NEUTRAL_WEIGHT + result.slopeOffset + result.symmetricDelta) * 100) / 100,
        buyW: Math.round((MODEL_NEUTRAL_WEIGHT - result.slopeOffset + result.symmetricDelta) * 100) / 100,
    };
}

// ─── isReady guard ──────────────────────────────────────────────────────────

function testNotReadyWhenTooFewValues() {
    const result = computeAmaSlopeWeights(flatSeries(20, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false, 'should not be ready with fewer than erPeriod+lookback+1 values');
    assert.ok(!('sellW' in result), 'model should not return sellW');
    assert.ok(!('buyW' in result), 'model should not return buyW');
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
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
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
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
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
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.25);
    assert.strictEqual(result.confidence, 50);
}

function testNegativeSlopeFullSaturation() {
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 94;
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.5);
    assert.strictEqual(result.confidence, 100);
}

// ─── Volatility penalty (symmetricDelta) ────────────────────────────────────
// New formula: symmetricDelta = -weightVariance^exponent * (scalePct / 100)
// Penalty is always ≤ 0: high ATR → lower weights (wider grid). Zero ATR → no effect.
// Threshold: |symmetricDelta| must be >= 0.1 (default) to apply, otherwise suppressed to 0.

function testZeroVolatilityNoPenalty() {
    // weightVariance=0 → pow(0, 0.5)=0 → symmetricDelta=0 (no penalty, no bonus)
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, opts);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.5, buyW: 0.5 });
}

function testBelowVolatilityThresholdSuppressed() {
    // weightVariance=0.01, exponent=0.5, scalePct=50 → sqrt(0.01)=0.1 * 0.5 = 0.05 → delta=-0.05
    // |0.05| < 0.1 threshold → suppressed to 0
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.01, opts);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.5, buyW: 0.5 });
}

function testAtVolatilityThresholdPasses() {
    // weightVariance=0.04, exponent=0.5, scalePct=50 → sqrt(0.04)=0.2 * 0.5 = 0.1 → delta=-0.1
    // |0.1| >= 0.1 threshold → passes through
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.04, opts);
    assert.strictEqual(result.symmetricDelta, -0.10);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.40, buyW: 0.40 });
}

function testMidVolatilityPenalty() {
    // weightVariance=0.09, exponent=0.5, scalePct=50 → sqrt(0.09)=0.3 * 0.5 = 0.15 → delta=-0.15
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.09, opts);
    assert.strictEqual(result.symmetricDelta, -0.15);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.35, buyW: 0.35 });
}

function testHighVolatilityPenaltyMaxed() {
    // weightVariance=1.0, exponent=0.5, scalePct=50 → pow(1, 0.5)=1 * 0.5 = 0.5 → delta=-0.5
    // Clamped to the configured symmetric shift bound.
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 1.0, opts);
    assert.strictEqual(result.symmetricDelta, -0.5);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.0, buyW: 0.0 });
}

function testVolatilityAboveMaxClamped() {
    // weightVariance=1.0 is already max (pow(1, 0.5) = 1), so same as testHighVolatilityPenaltyMaxed
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 1.0, opts);
    assert.strictEqual(result.symmetricDelta, -0.5);
}

function testVolatilityPenaltyNeverPositive() {
    // penalty is strictly ≤ 0 regardless of low ATR
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, opts);
    assert.ok(result.symmetricDelta <= 0, 'volatility penalty must never be positive');
}

function testCustomVolatilityThreshold() {
    // Custom threshold=0.2: delta=-0.15 should be suppressed
    const opts = { ...HALF_POWER_VOL_OPTS, volatilityThreshold: 0.2 };
    // weightVariance=0.09 → delta=-0.15 → |0.15| < 0.2 → suppressed
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.09, opts);
    assert.strictEqual(result.symmetricDelta, 0);
}

function testInvalidWeightVarianceFallsBackToNoPenalty() {
    const opts = { ...SMALL_OPTS };

    const negative = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), -0.25, opts);
    assert.strictEqual(negative.symmetricDelta, 0, 'negative variance should be ignored');
    assert.deepStrictEqual(derivedWeights(negative), { sellW: 0.5, buyW: 0.5 });

    const nanValue = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), Number.NaN, opts);
    assert.strictEqual(nanValue.symmetricDelta, 0, 'NaN variance should be ignored');
    assert.deepStrictEqual(derivedWeights(nanValue), { sellW: 0.5, buyW: 0.5 });
}

function testInvalidMaxVolatilityOffsetFallsBackToDefaultClamp() {
    const opts = { ...SMALL_OPTS, maxVolatilityOffset: -0.25, volatilityThreshold: 0.01 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 1.0, opts);
    assert.strictEqual(result.symmetricDelta, -0.5, 'invalid clamp should fall back to the default symmetric cap');
    assert.ok(result.symmetricDelta <= 0, 'invalid clamp must not invert the volatility penalty');
}

// ─── Combined slope + volatility ─────────────────────────────────────────────

function testCombinedUptrendZeroVol() {
    // slopeOffset=+0.25 (partial UP), symmetricDelta=0 (no penalty at zero ATR)
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 101.5;
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.75, buyW: 0.25 });
}

function testCombinedUptrendHighVol() {
    // slopeOffset=+0.5 (full UP), weightVariance=0.09, exponent=0.5, scalePct=50 → delta=-0.15
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 0.09, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.85, buyW: -0.15 });
}

function testClampAtMaxPenalty() {
    // Full UP slope (slopeOffset=0.5) + max penalty (symmetricDelta=-0.5)
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 1.0, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.5, buyW: -0.5 });
}

// ─── Confidence derivation ────────────────────────────────────────────────────

function testConfidenceDerivation() {
    // slopeOffset=0 → confidence=0
    const r1 = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, SMALL_OPTS);
    assert.strictEqual(r1.confidence, 0);

    // slopeOffset=0.5 (full) → confidence=100
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 106;
    const r2 = computeAmaSlopeWeights(values, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 });
    assert.strictEqual(r2.confidence, 100);

    // slopeOffset=0.25 (half) → confidence=50
    const values2 = flatSeries(MIN_LEN, 100);
    values2[MIN_LEN - 1] = 101.5;
    const r3 = computeAmaSlopeWeights(values2, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 });
    assert.strictEqual(r3.confidence, 50);
}

// ─── Volatility penalty table (exponent=0.5, scalePct=50) ───────────

function testNeutralSlopeVolatilityTable() {
    // exponent=0.5, scalePct=50: symmetricDelta = -weightVariance^0.5 * 0.5
    // threshold=0.1: penalty suppressed when |delta| < 0.1
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const flat = flatSeries(MIN_LEN, 100);

    // ATR/price = 0.00 → delta=0 → derived weights remain at neutral 0.50 / 0.50
    let r = computeAmaSlopeWeights(flat, 0.00, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.5, buyW: 0.5 });

    // ATR/price = 0.01 → sqrt(0.01)=0.1 * 0.5 = 0.05 → |0.05| < 0.1 → suppressed → neutral weights
    r = computeAmaSlopeWeights(flat, 0.01, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.5, buyW: 0.5 });

    // ATR/price = 0.04 → sqrt(0.04)=0.2 * 0.5 = 0.1 → |0.1| >= 0.1 → delta=-0.10
    r = computeAmaSlopeWeights(flat, 0.04, opts);
    assert.strictEqual(r.symmetricDelta, -0.10);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.40, buyW: 0.40 });

    // ATR/price = 0.09 → sqrt(0.09)=0.3 * 0.5 = 0.15 → delta=-0.15
    r = computeAmaSlopeWeights(flat, 0.09, opts);
    assert.strictEqual(r.symmetricDelta, -0.15);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.35, buyW: 0.35 });

    // ATR/price = 1.0 → sqrt(1.0)=1 * 0.5 = 0.5 → delta=-0.5 (clamped)
    r = computeAmaSlopeWeights(flat, 1.0, opts);
    assert.strictEqual(r.symmetricDelta, -0.5);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.0, buyW: 0.0 });
}

function testUptrendSlopeOffsetTable() {
    // slopeOffset ≈ +0.33: slopePct = 2% → slopeOffset = (2/3)*0.5 = 0.333... → 0.33 rounded
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const values = flatSeries(MIN_LEN, 100);
    values[MIN_LEN - 1] = 102; // slopePct = 2%

    // ATR/price = 0.00 → delta=0 → derived weights reflect the 0.5 neutral center
    let r = computeAmaSlopeWeights(values, 0.00, opts);
    assert.strictEqual(r.slopeOffset, 0.33);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.83, buyW: 0.17 });

    // ATR/price = 0.01 → sqrt(0.01)=0.1 * 0.5 = 0.05 → |0.05| < 0.1 → suppressed → same as zero vol
    r = computeAmaSlopeWeights(values, 0.01, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.83, buyW: 0.17 });

    // ATR/price = 0.04 → delta=-0.10
    r = computeAmaSlopeWeights(values, 0.04, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.73, buyW: 0.07 });

    // ATR/price = 0.09 → delta=-0.15
    r = computeAmaSlopeWeights(values, 0.09, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.68, buyW: 0.02 });

    // ATR/price = 1.0 → delta=-0.5
    r = computeAmaSlopeWeights(values, 1.0, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.33, buyW: -0.33 });
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
    testZeroVolatilityNoPenalty();
    testBelowVolatilityThresholdSuppressed();
    testAtVolatilityThresholdPasses();
    testMidVolatilityPenalty();
    testHighVolatilityPenaltyMaxed();
    testVolatilityAboveMaxClamped();
    testVolatilityPenaltyNeverPositive();
    testCustomVolatilityThreshold();
    testInvalidWeightVarianceFallsBackToNoPenalty();
    testInvalidMaxVolatilityOffsetFallsBackToDefaultClamp();
    testCombinedUptrendZeroVol();
    testCombinedUptrendHighVol();
    testClampAtMaxPenalty();
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
