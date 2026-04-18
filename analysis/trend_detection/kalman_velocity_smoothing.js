'use strict';

const { MARKET_ADAPTER } = require('../../modules/constants');

const KALMAN_SMOOTHING_BUDGET = 0.60;
const KALMAN_SMOOTHING_FLOOR = 0;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function resolveKalmanVelocitySmoothingConfig(config = {}) {
    const blend = clamp(
        config.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
        0,
        200
    ) / 100;
    const dispScale = clamp(
        config.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT,
        1.0,
        3.0
    );
    const dispThreshold = clamp(
        config.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT,
        0.25,
        3.0
    );
    const spanPct = clamp(
        config.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT,
        20,
        200
    );

    return {
        blend,
        dispScale,
        dispThreshold,
        smoothingFloor: KALMAN_SMOOTHING_FLOOR,
        smoothingBudget: KALMAN_SMOOTHING_BUDGET,
        smoothingSpan: KALMAN_SMOOTHING_BUDGET * spanPct / 100,
    };
}

function smoothKalmanVelocityPoint(rawVelocityPct, displacementPct, prevAdaptiveVelocity, config = {}) {
    if (rawVelocityPct == null || displacementPct == null) {
        return {
            adaptiveVelocityPct: null,
            smoothedVelocityPct: null,
            trendConfidence: null,
            smoothingAlpha: null,
        };
    }

    const resolved = resolveKalmanVelocitySmoothingConfig(config);
    const trendConfidence = clamp(Math.abs(displacementPct) / (resolved.dispScale * resolved.dispThreshold), 0, 1);
    const smoothingAlpha = Math.min(
        resolved.smoothingBudget,
        resolved.smoothingFloor + (resolved.smoothingSpan * trendConfidence)
    );
    const adaptiveVelocityPct = prevAdaptiveVelocity == null
        ? rawVelocityPct
        : (smoothingAlpha * rawVelocityPct) + ((1 - smoothingAlpha) * prevAdaptiveVelocity);
    const smoothedVelocityPct = resolved.blend === 0
        ? rawVelocityPct
        : (rawVelocityPct + ((adaptiveVelocityPct - rawVelocityPct) * resolved.blend));

    return {
        adaptiveVelocityPct,
        smoothedVelocityPct,
        trendConfidence,
        smoothingAlpha,
    };
}

function buildKalmanVelocitySeries(kalmanHistory, config = {}) {
    if (!Array.isArray(kalmanHistory) || kalmanHistory.length === 0) return [];

    const series = new Array(kalmanHistory.length).fill(null);
    let prevAdaptiveVelocity = null;

    for (let i = 0; i < kalmanHistory.length; i++) {
        const point = kalmanHistory[i];
        const result = smoothKalmanVelocityPoint(
            point?.velocityPct ?? null,
            point?.displacementPct ?? null,
            prevAdaptiveVelocity,
            config
        );
        series[i] = result.smoothedVelocityPct;
        prevAdaptiveVelocity = result.adaptiveVelocityPct;
    }

    return series;
}

function computeAbsolutePercentileThreshold(series, clipPercentile, fallback = Infinity) {
    if (!(clipPercentile > 0)) return fallback;

    const magnitudes = [];
    for (const value of series || []) {
        if (value != null && Number.isFinite(value)) magnitudes.push(Math.abs(value));
    }
    if (magnitudes.length === 0) return fallback;

    magnitudes.sort((a, b) => a - b);
    const idx = Math.min(
        Math.floor((100 - clipPercentile) / 100 * magnitudes.length),
        magnitudes.length - 1
    );
    return magnitudes[idx];
}

module.exports = {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
    resolveKalmanVelocitySmoothingConfig,
    smoothKalmanVelocityPoint,
};
