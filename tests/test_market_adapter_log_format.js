'use strict';

const assert = require('assert');

const {
    buildWeightSummary,
    buildDynamicWeightInputsLog,
    buildDynamicWeightTuningLog,
    buildAsymmetricBoundsLog,
    buildStartupDefaultsLog,
} = require('../market_adapter/log_format');
const { DEFAULT_CONFIG, MARKET_ADAPTER } = require('../modules/constants');
const { DEFAULT_AMA } = require('../market_adapter/market_adapter');

console.log('Running market adapter log format tests');

function testBuildWeightSummaryFormatsSellBuyOrder() {
    assert.strictEqual(
        buildWeightSummary({ sell: 0.61, buy: 0.39 }),
        ' weights(sell/buy)=0.61/0.39',
        'weight summary should preserve sell/buy ordering'
    );
    assert.strictEqual(buildWeightSummary(null), '', 'missing weights should yield an empty suffix');
}

function testBuildDynamicWeightInputsLogMasksAsymmetryWhenDisabled() {
    const text = buildDynamicWeightInputsLog({
        staticSell: 0.6,
        staticBuy: 0.4,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0.25,
        maxAsymmetryFactor: 0.35,
        rawAsymmetryFactor: 0.24,
        appliedAsymmetryFactor: 0.11,
        atrPeriod: 14,
        signalConfirmBars: 2,
    }, {
        erPeriod: 781,
        fastPeriod: 5.2,
        slowPeriod: 112.7,
    }, {
        asymmetricBoundsWhitelisted: false,
    });

    assert.ok(text.includes('ama=781/5.2/112.7'), 'AMA tuple should be included');
    assert.ok(text.includes('base=0.60/0.40'), 'base weights should be formatted');
    assert.ok(text.includes('clamp=0.50/0.25'), 'clamp pair should be formatted');
    assert.ok(text.includes('asymCap=n/a'), 'asymmetry cap should be hidden when bounds are disabled');
    assert.ok(text.includes('rawAsym=n/a'), 'raw asymmetry should be hidden when bounds are disabled');
    assert.ok(text.includes('appliedAsym=n/a'), 'applied asymmetry should be hidden when bounds are disabled');
    assert.ok(text.includes('atr=14'), 'ATR period should be shown');
    assert.ok(text.includes('confirm=2'), 'confirm bars should be shown');
}

function testBuildDynamicWeightInputsLogShowsAsymmetryWhenEnabled() {
    const text = buildDynamicWeightInputsLog({
        staticSell: 0.6,
        staticBuy: 0.4,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0.25,
        maxAsymmetryFactor: 0.35,
        rawAsymmetryFactor: 0.24,
        appliedAsymmetryFactor: 0.11,
        atrPeriod: 14,
        signalConfirmBars: 2,
    }, null, {
        asymmetricBoundsWhitelisted: true,
    });

    assert.ok(text.includes('asymCap=35%'), 'asymmetry cap should be shown when bounds are enabled');
    assert.ok(text.includes('rawAsym=24.0%'), 'raw asymmetry should be shown when bounds are enabled');
    assert.ok(text.includes('appliedAsym=11.0%'), 'applied asymmetry should be shown when bounds are enabled');
}

function testBuildDynamicWeightTuningLogFormatsKnobs() {
    const text = buildDynamicWeightTuningLog({
        amaSlope: { maxSlopePct: 0.9 },
        kalmanSlope: { maxSlopePct: 1.8 },
        alpha: 0.35,
        dw: 0.7,
        gain: 1.75,
        volatilityThreshold: 0.1,
        volatilityExponent: 0.5,
        volatilityScaleX: 10,
        clipPercentile: 10,
        neutralZonePct: 0.02,
        minOutputThreshold: 0.08,
        regimeSensitivity: 1,
        absoluteThreshold: 0.03,
        kalmanSmoothPct: 60,
        kalmanDispScaleMult: 1.7,
        kalmanDispThresholdMult: 1.15,
        kalmanSmoothSpanPct: 120,
    });

    assert.ok(text.includes('slopeMax=0.90'), 'AMA slope max should be formatted');
    assert.ok(text.includes('kalmanMax=1.80'), 'Kalman slope max should be formatted');
    assert.ok(text.includes('vol(thr/exp/x)=0.10/0.50/10.00'), 'volatility tuning tuple should be formatted');
    assert.ok(text.includes('reg(sens/abs)=1.00/0.03'), 'regime tuning tuple should be formatted');
    assert.ok(text.includes('kalman(sm/disp/th/span)=60.00/1.70/1.15/120.00'), 'Kalman tuning tuple should be formatted');
}

function testBuildAsymmetricBoundsLogFormatsPercentages() {
    assert.strictEqual(
        buildAsymmetricBoundsLog({
            rawAsymmetryFactor: 0.24,
            appliedAsymmetryFactor: 0.11,
            maxAsymmetryFactor: 0.35,
        }),
        'raw=24.0%, applied=11.0%, maxAsym=35%',
        'asymmetric bounds log should format all percentages consistently'
    );
}

function testBuildStartupDefaultsLogReflectsExplicitOnlyDynamicBase() {
    const text = buildStartupDefaultsLog(DEFAULT_AMA, DEFAULT_CONFIG, MARKET_ADAPTER);
    const expectedFallback = `weightFallback=${Number(DEFAULT_CONFIG.weightDistribution.sell).toFixed(2)}/${Number(DEFAULT_CONFIG.weightDistribution.buy).toFixed(2)}`;

    assert.ok(text.includes('dynamicBase=explicit-only'), 'startup defaults should document explicit-only dynamic base weights');
    assert.ok(text.includes(expectedFallback), 'startup defaults should include fallback weights');
    assert.ok(text.includes('asymCap=35%'), 'startup defaults should include default asymmetry cap');
}

testBuildWeightSummaryFormatsSellBuyOrder();
testBuildDynamicWeightInputsLogMasksAsymmetryWhenDisabled();
testBuildDynamicWeightInputsLogShowsAsymmetryWhenEnabled();
testBuildDynamicWeightTuningLogFormatsKnobs();
testBuildAsymmetricBoundsLogFormatsPercentages();
testBuildStartupDefaultsLogReflectsExplicitOnlyDynamicBase();

console.log('market adapter log format tests passed');
