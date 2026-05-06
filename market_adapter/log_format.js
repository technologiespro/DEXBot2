'use strict';

function formatLogNumber(value, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function formatLogPercent(value, digits = 2) {
    return Number.isFinite(value) ? `${Number(value).toFixed(digits)}%` : 'n/a';
}

function formatLogPair(first, second, digits = 2) {
    return `${formatLogNumber(first, digits)}/${formatLogNumber(second, digits)}`;
}

function formatAmaTuple(ama) {
    if (!ama) return 'n/a';
    return `${formatLogNumber(ama.erPeriod, 0)}/${formatLogNumber(ama.fastPeriod, 1)}/${formatLogNumber(ama.slowPeriod, 1)}`;
}

function formatAsymmetryFactor(value, digits = 1) {
    return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : 'n/a';
}

function buildWeightSummary(weights) {
    return weights ? ` weights(sell/buy)=${formatLogPair(weights.sell, weights.buy, 2)}` : '';
}

function buildDynamicWeightInputsLog(meta, amaConfig, options = {}) {
    const asymmetricBoundsWhitelisted = options.asymmetricBoundsWhitelisted === true;
    return [
        `ama=${formatAmaTuple(amaConfig)}`,
        `base=${formatLogPair(meta?.staticSell, meta?.staticBuy, 2)}`,
        `clamp=${formatLogPair(meta?.maxSlopeOffset, meta?.maxVolatilityOffset, 2)}`,
        `asymCap=${asymmetricBoundsWhitelisted ? formatAsymmetryFactor(meta?.maxAsymmetryFactor, 0) : 'n/a'}`,
        `rawAsym=${asymmetricBoundsWhitelisted ? formatAsymmetryFactor(meta?.rawAsymmetryFactor) : 'n/a'}`,
        `appliedAsym=${asymmetricBoundsWhitelisted ? formatAsymmetryFactor(meta?.appliedAsymmetryFactor) : 'n/a'}`,
        `atr=${formatLogNumber(meta?.atrPeriod, 0)}`,
        `confirm=${Number.isFinite(meta?.signalConfirmBars) ? Math.round(meta.signalConfirmBars) : 'n/a'}`,
    ].join(' | ');
}

function buildDynamicWeightTuningLog(meta) {
    return [
        `slopeMax=${formatLogNumber(meta?.amaSlope?.maxSlopePct, 2)}`,
        `kalmanMax=${formatLogNumber(meta?.kalmanSlope?.maxSlopePct, 2)}`,
        `alpha=${formatLogNumber(meta?.alpha, 2)}`,
        `dw=${formatLogNumber(meta?.dw, 2)}`,
        `gain=${formatLogNumber(meta?.gain, 2)}`,
        `vol(thr/exp/x)=${formatLogNumber(meta?.volatilityThreshold, 2)}/${formatLogNumber(meta?.volatilityExponent, 2)}/${formatLogNumber(meta?.volatilityScaleX, 2)}`,
        `clip=${formatLogPercent(meta?.clipPercentile, 0)}`,
        `nz=${formatLogNumber(meta?.neutralZonePct, 2)}`,
        `minOut=${formatLogNumber(meta?.minOutputThreshold, 2)}`,
        `reg(sens/abs)=${formatLogNumber(meta?.regimeSensitivity, 2)}/${formatLogNumber(meta?.absoluteThreshold, 2)}`,
        `kalman(sm/disp/th/span)=${formatLogNumber(meta?.kalmanSmoothPct, 2)}/${formatLogNumber(meta?.kalmanDispScaleMult, 2)}/${formatLogNumber(meta?.kalmanDispThresholdMult, 2)}/${formatLogNumber(meta?.kalmanSmoothSpanPct, 2)}`,
    ].join(' | ');
}

function buildAsymmetricBoundsLog(meta) {
    return `raw=${formatAsymmetryFactor(meta?.rawAsymmetryFactor)}, applied=${formatAsymmetryFactor(meta?.appliedAsymmetryFactor)}, maxAsym=${formatAsymmetryFactor(meta?.maxAsymmetryFactor, 0)}`;
}

function buildStartupDefaultsLog(defaultAma, defaultConfig, marketAdapterCfg) {
    return `  defaults: ama=${formatAmaTuple(defaultAma)} | `
        + `weightFallback=${formatLogPair(defaultConfig?.weightDistribution?.sell, defaultConfig?.weightDistribution?.buy, 2)} | `
        + `dynamicBase=explicit-only | `
        + `clamp=${formatLogPair(marketAdapterCfg?.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP, marketAdapterCfg?.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 2)} | `
        + `asymCap=${formatAsymmetryFactor(marketAdapterCfg?.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR, 0)}`;
}

module.exports = {
    formatLogPercent,
    buildWeightSummary,
    buildDynamicWeightInputsLog,
    buildDynamicWeightTuningLog,
    buildAsymmetricBoundsLog,
    buildStartupDefaultsLog,
};
