'use strict';

const { MARKET_ADAPTER } = require('../../../modules/constants');
const {
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} = require('../config_normalizers');

const MAX_OFFSET_FROM_NEUTRAL = MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
const MAX_SYMMETRIC_SHIFT = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;

const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;
const DEFAULT_SLOW_PERIOD = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].slowPeriod;

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
 * @param {number}   weightVariance      ATR(period) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]              Market-reading tuning — no offset bounds here
 * @param {number}   [opts.lookbackBars=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS]  Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT]  Slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT]  Dead-band around zero slope
 * @param {number}   [opts.volatilityExponent=1.0]      Exponent for ATR-based penalty
 * @param {number}   [opts.volatilityScaleX=10.0]       Scale factor penalty (10.0 = normal start)
 * @param {number}   [opts.volatilityThreshold=0.1]      Minimum |symmetricDelta| before penalty applies
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @param {number}   [opts.slowPeriod=DEFAULT_SLOW_PERIOD]  AMA slow period used for warm-up guard
 * @param {number}   [opts.maxSlopeOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP]  Per-bot cap on buy/sell asymmetry offset
 * @param {number}   [opts.maxVolatilityOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP]  Per-bot cap on volatility shift
 * @param {number}   [opts.clipPercentile=0]             Percentile clip on slope (0=off, 10=clip top 10%)
 * @param {number}   [opts.clipThreshold]                Pre-computed clip threshold from slope history
 * @returns {{ slopeOffset, symmetricDelta, slopePct, clippedSlopePct, confidence, trend, isReady }}
 */
function computeAmaSlopeWeights(amaValues, weightVariance, opts = {}) {
    const lookbackBars = Number.isFinite(opts.lookbackBars) && opts.lookbackBars >= 0
        ? Math.ceil(opts.lookbackBars)
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const maxSlopePct = opts.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const neutralZonePct = opts.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const volatilityExponent = opts.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const volatilityScaleX = opts.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const volatilityThreshold = normalizeVolatilityThreshold(opts.volatilityThreshold);
    const erPeriod = Number.isFinite(opts.erPeriod) && opts.erPeriod > 0
        ? Math.ceil(opts.erPeriod)
        : DEFAULT_ER_PERIOD;
    const slowPeriod = Number.isFinite(opts.slowPeriod) && opts.slowPeriod > 0
        ? Math.ceil(opts.slowPeriod)
        : DEFAULT_SLOW_PERIOD;
    const maxSlopeOffset = opts.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const maxVolatilityOffset = normalizeMaxVolatilityOffset(opts.maxVolatilityOffset);
    const clipThreshold = opts.clipThreshold ?? Infinity;
    const hasDirectionalOffset = Number.isFinite(maxSlopeOffset) && maxSlopeOffset > 0;
    const safeWeightVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeVolatilityExponent = Number.isFinite(volatilityExponent) && volatilityExponent >= 0
        ? volatilityExponent
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeVolatilityScaleX = Number.isFinite(volatilityScaleX) && volatilityScaleX >= 0
        ? volatilityScaleX
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

    const notReady = {
        isReady: false,
        slopeOffset: 0,
        symmetricDelta: 0,
        slopePct: 0,
        clippedSlopePct: 0,
        confidence: 0,
        trend: 'NEUTRAL',
    };

    const warmupBars = erPeriod + slowPeriod + lookbackBars;

    // 1. Guard: need ER warm-up + slow-period convergence + lookback window + current bar.
    if (!Array.isArray(amaValues) || amaValues.length < warmupBars + 1) {
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
    if (Math.abs(clippedSlopePct) <= neutralZonePct) {
        slopeOffset = 0;
        trend = 'NEUTRAL';
    } else {
        slopeOffset = clamp(clippedSlopePct / maxSlopePct, -1, 1) * maxSlopeOffset;
        trend = clippedSlopePct > 0 ? 'UP' : 'DOWN';
    }

    // 4. Confidence derived from slope offset magnitude (0–100)
    const roundedSlopeOffset = Math.round(slopeOffset * 100) / 100;
    const confidence = hasDirectionalOffset
        ? Math.round((Math.abs(slopeOffset) / maxSlopeOffset) * 100)
        : 0;

    // 5. Volatility penalty — symmetric downward shift from ATR/price ratio.
    //    Formula: symmetricDelta = -weightVariance^exponent * scaleX

    // Sync clamps with research tools:
    // Exponent: 0.5 to 1.0 (prevents over-aggressive scaling on low ATR)
    // ScaleX: 1.0 to 100.0
    const effectiveExponent = Math.max(0.5, Math.min(1.0, safeVolatilityExponent));
    const effectiveScaleX = Math.max(1.0, Math.min(100.0, safeVolatilityScaleX));

    let symmetricDelta = 0;
    if (safeWeightVariance > 0 && maxVolatilityOffset > 0) {
        const volDelta = -Math.pow(safeWeightVariance, effectiveExponent) * effectiveScaleX;
        const rawSymmetricDelta = clamp(volDelta, -maxVolatilityOffset, 0);
        symmetricDelta = Math.abs(rawSymmetricDelta) < volatilityThreshold ? 0 : rawSymmetricDelta;
    }

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

module.exports = { computeAmaSlopeWeights };
