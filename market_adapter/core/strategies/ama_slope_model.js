'use strict';

const { MARKET_ADAPTER } = require('../../../modules/constants');

const MAX_OFFSET_FROM_NEUTRAL = MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
const MAX_SYMMETRIC_SHIFT = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;

const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/**
 * Compute AMA slope and volatility offsets from the AMA series.
 *
 * Two independent additive factors:
 *   slopeOffset (asymmetric): AMA slope magnitude → trend direction
 *   symmetricDelta (symmetric): ATR/price ratio → noise level
 *
 * @param {number[]} amaValues           Full AMA series (output of calculateAMA)
 * @param {number}   weightVariance      ATR(14) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]              Market-reading tuning — no offset bounds here
 * @param {number}   [opts.lookbackBars=72]             Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=3.0]             Slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=0.15]         Dead-band around zero slope
 * @param {number}   [opts.volatilityExponent=1.0]      Exponent for ATR-based penalty
 * @param {number}   [opts.volatilityScaleX=10.0]       Scale factor penalty (10.0 = normal start)
 * @param {number}   [opts.volatilityThreshold=0.1]      Minimum |symmetricDelta| before penalty applies
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @param {number}   [opts.maxSlopeOffset=MAX_OFFSET_FROM_NEUTRAL]  Per-bot cap on buy/sell asymmetry offset
 * @param {number}   [opts.clipPercentile=0]             Percentile clip on slope (0=off, 10=clip top 10%)
 * @param {number}   [opts.clipThreshold]                Pre-computed clip threshold from slope history
 * @returns {{ slopeOffset, symmetricDelta, slopePct, clippedSlopePct, confidence, trend, isReady }}
 */
function computeAmaSlopeWeights(amaValues, weightVariance, opts = {}) {
    const lookbackBars = opts.lookbackBars ?? 72;
    const maxSlopePct = opts.maxSlopePct ?? 3.0;
    const neutralZonePct = opts.neutralZonePct ?? 0.15;
    const volatilityExponent = opts.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const volatilityScaleX = opts.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const volatilityThreshold = opts.volatilityThreshold
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD;
    const erPeriod = opts.erPeriod ?? DEFAULT_ER_PERIOD;
    const maxSlopeOffset = opts.maxSlopeOffset ?? MAX_OFFSET_FROM_NEUTRAL;
    const clipThreshold = opts.clipThreshold ?? Infinity;
    const safeWeightVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeVolatilityExponent = Number.isFinite(volatilityExponent) && volatilityExponent >= 0
        ? volatilityExponent
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeVolatilityScaleX = Number.isFinite(volatilityScaleX) && volatilityScaleX >= 0
        ? volatilityScaleX
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const safeVolatilityThreshold = Number.isFinite(volatilityThreshold) && volatilityThreshold >= 0
        ? volatilityThreshold
        : (MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD);

    const notReady = {
        isReady: false,
        slopeOffset: 0,
        symmetricDelta: 0,
        slopePct: 0,
        clippedSlopePct: 0,
        confidence: 0,
        trend: 'NEUTRAL',
    };

    // 1. Guard: need erPeriod warm-up + lookback window + current bar
    if (!Array.isArray(amaValues) || amaValues.length < erPeriod + lookbackBars + 1) {
        return notReady;
    }

    const N = amaValues.length;
    const last = amaValues[N - 1];
    const past = amaValues[N - 1 - lookbackBars];

    if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) {
        return notReady;
    }

    // 2. Slope percent over lookback window
    const slopePct = (last - past) / past * 100;

    // 2b. Percentile clip — symmetric clip on slope magnitude
    const clippedSlopePct = Math.max(-clipThreshold, Math.min(clipThreshold, slopePct));

    // 3. Slope offset (asymmetric) — based on clipped slope
    let slopeOffset;
    let trend;
    if (Math.abs(clippedSlopePct) < neutralZonePct) {
        slopeOffset = 0;
        trend = 'NEUTRAL';
    } else {
        slopeOffset = clamp(clippedSlopePct / maxSlopePct, -1, 1) * maxSlopeOffset;
        trend = clippedSlopePct > 0 ? 'UP' : 'DOWN';
    }

    // 4. Confidence derived from slope offset magnitude (0–100)
    const confidence = Math.round(Math.abs(slopeOffset) / maxSlopeOffset * 100);

    // 5. Volatility penalty — symmetric downward shift from ATR/price ratio.
    //    Formula: symmetricDelta = -weightVariance^exponent * scaleX
    //    Clamped to the configured symmetric shift bound: only reduces weights, never raises.
    //    Suppressed when |symmetricDelta| < volatilityThreshold (mirrors minOutputThreshold for trend).
    const effectiveScaleX = clamp(safeVolatilityScaleX, 5.0, 50.0);
    const volDelta = -Math.pow(safeWeightVariance, safeVolatilityExponent) * effectiveScaleX;
    const rawSymmetricDelta = clamp(volDelta, -MAX_SYMMETRIC_SHIFT, 0);
    const symmetricDelta = Math.abs(rawSymmetricDelta) < safeVolatilityThreshold ? 0 : rawSymmetricDelta;
    const roundedSlopeOffset = Math.round(slopeOffset * 100) / 100;
    const roundedSymmetricDelta = (Math.round(symmetricDelta * 100) / 100) || 0;

    return {
        slopeOffset: roundedSlopeOffset,
        symmetricDelta: roundedSymmetricDelta,
        slopePct,
        clippedSlopePct,
        confidence,
        trend,
        isReady: true,
    };
}

module.exports = { computeAmaSlopeWeights, MAX_OFFSET_FROM_NEUTRAL, MAX_SYMMETRIC_SHIFT };
