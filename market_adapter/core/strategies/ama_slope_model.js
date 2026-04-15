'use strict';

const { MARKET_ADAPTER } = require('../../../modules/constants');

const MAX_OFFSET_FROM_NEUTRAL = 0.5; // default cap — overridable per bot via opts
const MIN_WEIGHT = -0.5;
const MAX_WEIGHT = 1.5;
const BASELINE_WEIGHT = 0.5;

const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/**
 * Compute buy/sell order weights from AMA slope and ATR volatility.
 *
 * Two independent additive factors:
 *   sellW = baseline + slopeOffset + symmetricDelta
 *   buyW  = baseline - slopeOffset + symmetricDelta
 *
 * slopeOffset (asymmetric): AMA slope magnitude → trend direction
 * symmetricDelta (symmetric): ATR/price ratio → noise level
 *
 * @param {number[]} amaValues           Full AMA series (output of calculateAMA)
 * @param {number}   weightVariance      ATR(14) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]              Market-reading tuning — no offset bounds here
 * @param {number}   [opts.lookbackBars=72]             Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=3.0]             Slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=0.15]         Dead-band around zero slope
 * @param {number}   [opts.maxVolatilityThreshold=0.03] ATR/price ratio = full high-vol state
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @param {number}   [opts.maxSlopeOffset=0.5]          Per-bot cap on buy/sell asymmetry offset
 * @param {number}   [opts.maxVolatilityOffset=0.5]     Per-bot cap on symmetric volatility offset
 * @param {number}   [opts.clipPercentile=0]             Percentile clip on slope (0=off, 10=clip top 10%)
 * @param {number}   [opts.clipThreshold]                Pre-computed clip threshold from slope history
 * @returns {{ sellW, buyW, slopeOffset, symmetricDelta, slopePct, clippedSlopePct, confidence, trend, isReady }}
 */
function computeAmaSlopeWeights(amaValues, weightVariance, opts = {}) {
    const lookbackBars = opts.lookbackBars ?? 72;
    const maxSlopePct = opts.maxSlopePct ?? 3.0;
    const neutralZonePct = opts.neutralZonePct ?? 0.15;
    const maxVolatilityThreshold = opts.maxVolatilityThreshold ?? 0.03;
    const erPeriod = opts.erPeriod ?? DEFAULT_ER_PERIOD;
    const maxSlopeOffset = opts.maxSlopeOffset ?? MAX_OFFSET_FROM_NEUTRAL;
    const maxVolatilityOffset = opts.maxVolatilityOffset ?? MAX_OFFSET_FROM_NEUTRAL;
    const clipThreshold = opts.clipThreshold ?? Infinity;

    const notReady = {
        isReady: false,
        sellW: BASELINE_WEIGHT,
        buyW: BASELINE_WEIGHT,
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

    // 5. Volatility factor → symmetric delta
    const volFactor = 1 - clamp(weightVariance / maxVolatilityThreshold, 0, 1);
    const symmetricDelta = (volFactor * 2 - 1) * maxVolatilityOffset;

    // 6-7. Final weights
    let sellW = clamp(BASELINE_WEIGHT + slopeOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT);
    let buyW = clamp(BASELINE_WEIGHT - slopeOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT);

    // 8. Round to 2 decimal places
    sellW = Math.round(sellW * 100) / 100;
    buyW = Math.round(buyW * 100) / 100;
    const roundedSlopeOffset = Math.round(slopeOffset * 100) / 100;
    const roundedSymmetricDelta = Math.round(symmetricDelta * 100) / 100;

    return {
        sellW,
        buyW,
        slopeOffset: roundedSlopeOffset,
        symmetricDelta: roundedSymmetricDelta,
        slopePct,
        clippedSlopePct,
        confidence,
        trend,
        isReady: true,
    };
}

module.exports = { computeAmaSlopeWeights, MAX_OFFSET_FROM_NEUTRAL };
