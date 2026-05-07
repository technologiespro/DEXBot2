'use strict';

const { calculateATR } = require('./strategies/atr/calculator');
const {
    computeAmaSlopeWeights,
    computeAverageAmaSlopePct,
} = require('./strategies/ama_slope_model');
const {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} = require('./config_normalizers');
const { normalizeMarketSource, hasNumericStartPrice, resolveMarketSourceForBot } = require('../utils/chain');
const { computeRegimeMultiplier } = require('./strategies/regime_gate');
const { calculateAMA, getAmaWarmupBars } = require('../../analysis/ama_fitting/ama');
const { KalmanTrendAnalyzer } = require('../../analysis/trend_detection/kalman_trend_analyzer');
const {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
} = require('../../analysis/trend_detection/kalman_velocity_smoothing');
const { adjustCollateralRatio } = require('./strategies/collateral_manager');
const {
    resolveMaxAsymmetryFactor,
    computeAsymmetricBoundsMetrics,
} = require('./asymmetric_bounds');
const { DEFAULT_CONFIG, MARKET_ADAPTER } = require('../../modules/constants');
const { resolveConfiguredPriceBound } = require('../../modules/order/utils/order');

const AMA_SLOPE_PERCENT_MODE_PER_BAR = 'perBar';
const AMA_SLOPE_PERCENT_MODE_WINDOW = 'window';

function normalizeAmaSlopePercentMode(value) {
    const text = String(value || '').trim().toLowerCase();
    if (['perbar', 'per_bar', 'per-bar', 'averageperbar', 'average_per_bar'].includes(text)) {
        return AMA_SLOPE_PERCENT_MODE_PER_BAR;
    }
    if (['window', 'lookback', 'cumulative', 'legacy'].includes(text)) {
        return AMA_SLOPE_PERCENT_MODE_WINDOW;
    }
    return null;
}

function normalizeAmaSlopeLookbackBars(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
    return MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
}

function convertSlopePercentToPerBar(value, lookbackBars, mode) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return mode === AMA_SLOPE_PERCENT_MODE_PER_BAR
        ? n
        : n / normalizeAmaSlopeLookbackBars(lookbackBars);
}

function normalizePersistedAmaSlopeSnapshot(snapshot, lookbackBars, mode) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const normalized = { ...snapshot };
    const slopePct = convertSlopePercentToPerBar(snapshot.slopePct, lookbackBars, mode);
    if (Number.isFinite(slopePct)) {
        normalized.slopePct = slopePct;
    }
    return normalized;
}

function normalizePersistedAmaSlopeDiagnostics(data, lookbackBars) {
    if (!data || typeof data !== 'object') return data;
    const mode = normalizeAmaSlopePercentMode(data.amaSlopePercentMode) || AMA_SLOPE_PERCENT_MODE_WINDOW;
    const normalized = { ...data };
    normalized.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
    normalized.amaSlope = normalizePersistedAmaSlopeSnapshot(data.amaSlope, lookbackBars, mode);
    normalized.gridRangeScalingAmaSlope = normalizePersistedAmaSlopeSnapshot(
        data.gridRangeScalingAmaSlope,
        lookbackBars,
        mode
    );
    const deltaPercent = convertSlopePercentToPerBar(data.amaSlopeDeltaPercent, lookbackBars, mode);
    const thresholdPercent = convertSlopePercentToPerBar(data.amaSlopeThresholdPercent, lookbackBars, mode);
    normalized.amaSlopeDeltaPercent = Number.isFinite(deltaPercent) ? deltaPercent : null;
    normalized.amaSlopeThresholdPercent = Number.isFinite(thresholdPercent) ? thresholdPercent : null;
    return normalized;
}


class MarketAdapterService {
    constructor(deps = {}) {
        this.deps = deps;
    }

    static isRetryableClosedCandleFailure(reason) {
        return reason === 'ama_center_persist_failed'
            || reason === 'dynamic_weight_persist_failed'
            || reason === 'ama_slope_persist_failed';
    }

    getNowMs() {
        return typeof this.deps.getNowMs === 'function' ? this.deps.getNowMs() : Date.now();
    }

    selectClosedCandles(candles, intervalSeconds, nowMs = this.getNowMs()) {
        const bucketMs = Number(intervalSeconds) * 1000;
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
            return {
                closedCandles: Array.isArray(candles) ? candles.slice() : [],
                currentBucketStartMs: null,
            };
        }

        const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
        const closedCandles = (Array.isArray(candles) ? candles : [])
            .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] < currentBucketStartMs);

        return { closedCandles, currentBucketStartMs };
    }

    buildBotContextSignature(bot) {
        return [
            bot?.assetA,
            bot?.assetB,
            bot?.assetAId,
            bot?.assetBId,
            bot?.assetAPrecision,
            bot?.assetBPrecision,
            bot?.poolId,
            bot?.startPrice,
        ].map((v) => String(v ?? '')).join('|');
    }

    buildGapRepairTimeRange(missingTimestamps, intervalSeconds, maxGapHours = 24) {
        const bucketMs = Number(intervalSeconds) * 1000;
        if (!Array.isArray(missingTimestamps) || missingTimestamps.length === 0) return null;
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;

        const maxGapMs = Number.isFinite(maxGapHours) && maxGapHours > 0 ? maxGapHours * 3600 * 1000 : 24 * 3600 * 1000;
        const requestedStart = missingTimestamps[0] - bucketMs;
        const requestedEnd = missingTimestamps[missingTimestamps.length - 1] + (bucketMs * 2) - 1;
        const cappedStart = Math.max(requestedStart, requestedEnd - maxGapMs);

        return {
            gte: new Date(cappedStart).toISOString(),
            lte: new Date(requestedEnd).toISOString(),
        };
    }

    getGapRepairMaxHours(cfg) {
        const intervalSeconds = Number(cfg?.intervalSeconds);
        const intervalHours = Number.isFinite(intervalSeconds) && intervalSeconds > 0
            ? intervalSeconds / 3600
            : 1;
        const maxCandles = Number.isFinite(cfg?.maxNativeGapFillCandles)
            ? cfg.maxNativeGapFillCandles
            : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;

        // Include the candle before and after the missing run so Kibana repair
        // does not truncate a valid threshold-sized gap while still respecting
        // the configured suspicious-gap threshold.
        return Math.max(1, (maxCandles + 2) * intervalHours);
    }

    fillNativeIncrementalClosedGaps(candles, previousLastTs, intervalSeconds, nowMs = this.getNowMs()) {
        const deps = this.deps;
        if (typeof deps.fillCandleGaps !== 'function') return candles;
        if (!Array.isArray(candles) || candles.length === 0) return candles;

        const bucketMs = Number(intervalSeconds) * 1000;
        const startTs = Number(previousLastTs);
        if (!Number.isFinite(bucketMs) || bucketMs <= 0 || !Number.isFinite(startTs) || startTs <= 0) {
            return candles;
        }

        const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
        const latestClosedBucketTs = currentBucketStartMs - bucketMs;
        if (!Number.isFinite(latestClosedBucketTs) || latestClosedBucketTs < startTs) {
            return candles;
        }

        const tailCandles = candles.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] >= startTs);
        if (tailCandles.length === 0) return candles;

        const filledTail = deps.fillCandleGaps(tailCandles, intervalSeconds, startTs, latestClosedBucketTs);
        return deps.mergeCandles(candles, filledTail);
    }

    buildIncrementalCandleCollision(existing, incoming) {
        const existingVol = Number(existing?.[5] || 0);
        const incomingVol = Number(incoming?.[5] || 0);
        if (existingVol <= 0 && incomingVol > 0) return incoming;
        if (incomingVol <= 0) return existing;
        return [
            existing[0],
            existing[1],
            Math.max(existing[2], incoming[2]),
            Math.min(existing[3], incoming[3]),
            incoming[4],
            existingVol + incomingVol,
        ];
    }

    getNativeRecentTradeSequences(trades, limit = 8) {
        const seen = new Set();
        return (Array.isArray(trades) ? trades : [])
            .filter((t) => Number.isFinite(Number(t?.sequence)))
            .sort((a, b) => {
                const at = Number(a.tsMs || 0);
                const bt = Number(b.tsMs || 0);
                if (bt !== at) return bt - at;
                return Number(b.sequence) - Number(a.sequence);
            })
            .map((t) => Number(t.sequence))
            .filter((seq) => {
                const key = String(seq);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, limit);
    }

    filterTimeBasedNativeNewTrades(trades, knownSequences, nativeLastTradeTs, lastCandleTs, intervalSeconds) {
        const seqSet = knownSequences instanceof Set
            ? knownSequences
            : new Set((Array.isArray(knownSequences) ? knownSequences : []).map((seq) => String(seq)));
        const seqNumbers = [...seqSet]
            .map((seq) => Number(seq))
            .filter(Number.isFinite);
        const maxKnownSeq = seqNumbers.length > 0 ? Math.max(...seqNumbers) : null;
        const lastTradeTs = Number(nativeLastTradeTs);
        const lastTs = Number(lastCandleTs);
        const bucketMs = Number(intervalSeconds) * 1000;

        return (Array.isArray(trades) ? trades : []).filter((trade) => {
            const seq = Number(trade?.sequence);
            const seqKey = Number.isFinite(seq) ? String(seq) : null;
            if (seqKey && seqSet.has(seqKey)) return false;
            if (Number.isFinite(seq) && Number.isFinite(maxKnownSeq)) return seq > maxKnownSeq;

            const tsMs = Number(trade?.tsMs);
            if (!Number.isFinite(tsMs)) return true;
            if (Number.isFinite(lastTradeTs) && lastTradeTs > 0) return tsMs > lastTradeTs;

            if (Number.isFinite(bucketMs) && bucketMs > 0 && Number.isFinite(lastTs) && lastTs > 0) {
                const tradeBucketTs = Math.floor(tsMs / bucketMs) * bucketMs;
                return tradeBucketTs > lastTs;
            }

            return true;
        });
    }

    clampGridPriceToBounds(centerPrice, referencePrice, bot) {
        const base = Number(centerPrice);
        const ref = Number(referencePrice);
        if (!Number.isFinite(base) || base <= 0) return centerPrice;
        try {
            const startPrice = Number.isFinite(ref) && ref > 0 ? ref : base;
            const minP = resolveConfiguredPriceBound(bot?.minPrice, DEFAULT_CONFIG.minPrice, startPrice, 'min');
            const maxP = resolveConfiguredPriceBound(bot?.maxPrice, DEFAULT_CONFIG.maxPrice, startPrice, 'max');
            if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return base;
            return Math.min(maxP, Math.max(minP, base));
        } catch (_) {
            return base;
        }
    }

    computeAppliedAsymmetryMetrics(bot, centerPrice, dynamicWeights) {
        const maxAsymmetryFactor = resolveMaxAsymmetryFactor(
            bot?.asymmetricBounds?.maxAsymmetryFactor,
            dynamicWeights?.maxAsymmetryFactor,
            MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR
        );
        let minP = null;
        let maxP = null;
        try {
            minP = resolveConfiguredPriceBound(bot?.minPrice, DEFAULT_CONFIG.minPrice, centerPrice, 'min');
            maxP = resolveConfiguredPriceBound(bot?.maxPrice, DEFAULT_CONFIG.maxPrice, centerPrice, 'max');
        } catch (_) {}
        return computeAsymmetricBoundsMetrics({
            centerPrice,
            minPrice: minP,
            maxPrice: maxP,
            trend: dynamicWeights?.trend,
            slopeOffset: Number.isFinite(dynamicWeights?.rawSlopeOffset)
                ? dynamicWeights.rawSlopeOffset
                : dynamicWeights?.slopeOffset,
            maxSlopeOffset: dynamicWeights?.maxSlopeOffset,
            maxAsymmetryFactor,
        });
    }

    buildDefaultBotState(bot, overrides = {}) {
        return {
            botName: bot.name,
            botKey: bot.botKey,
            marketSource: null,
            priceMode: null,
            lastCycleSource: null,
            lastCycleAt: null,
            pendingClosedCandle: false,
            lastTriggerSuppressedReason: null,
            poolId: null,
            candleFile: null,
            candleCount: 0,
            analysisCandleCount: 0,
            kibanaGapRepairCount: 0,
            kibanaBackfillCount: 0,
            unresolvedGapCount: 0,
            nativeRecentTradeSequences: [],
            nativeLastTradeTs: null,
            nativeOverlapCount: null,
            nativePagesFetched: null,
            lastCandleTs: null,
            rawLastCandleTs: null,
            lastClosedCandleTs: null,
            gridCenterPrice: null,
            centerPrice: null,
            amaCenterPrice: null,
            amaConfig: null,
            atr: null,
            weightVariance: null,
            weights: null,
            effectiveWeights: null,
            collateralRecommendation: null,
            amaSlope: null,
            amaSlopeDeltaPercent: null,
            amaSlopeThresholdPercent: null,
            rawKeepCount: 0,
            analysisKeepCount: 0,
            amaWarmupBars: 0,
            staleData: false,
            staleAgeHours: null,
            ...overrides,
        };
    }

    buildDefaultResult(bot, overrides = {}) {
        return {
            ok: true,
            dryRunMessages: [],
            source: null,
            marketSource: null,
            candleCount: 0,
            analysisCandleCount: 0,
            kibanaGapRepairCount: 0,
            kibanaBackfillCount: 0,
            unresolvedGapCount: 0,
            nativeRecentTradeSequences: [],
            nativeLastTradeTs: null,
            nativeOverlapCount: null,
            nativePagesFetched: null,
            amaPrice: null,
            deltaPercent: null,
            thresholdPercent: null,
            referencePrice: null,
            amaComparison: [],
            triggered: false,
            triggerPath: null,
            staleData: false,
            staleAgeHours: null,
            triggerCallbackError: null,
            triggerSuppressedReason: null,
            weights: null,
            collateralRecommendation: null,
            amaSlope: null,
            amaSlopeDeltaPercent: null,
            amaSlopeThresholdPercent: null,
            rawKeepCount: 0,
            analysisKeepCount: 0,
            amaWarmupBars: 0,
            poolId: null,
            candleFile: null,
            lastCandleTs: null,
            rawLastCandleTs: null,
            lastClosedCandleTs: null,
            centerPrice: null,
            amaConfig: null,
            atr: null,
            weightVariance: null,
            pendingClosedCandle: false,
            ...overrides,
        };
    }

    resolveAmaSlopeDeltaThresholdPercent(cfg) {
        const threshold = Number(cfg?.amaSlopeDeltaThresholdPercent);
        return Number.isFinite(threshold) && threshold > 0
            ? threshold
            : MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT;
    }

    buildAmaSlopeResetDetails(currentAmaSlope, previousAmaSlope, cfg) {
        const thresholdPercent = this.resolveAmaSlopeDeltaThresholdPercent(cfg);
        const currentSlopePct = Number(currentAmaSlope?.slopePct);
        const previousSlopePct = Number(previousAmaSlope?.slopePct);
        const currentReady = !!currentAmaSlope?.isReady && Number.isFinite(currentSlopePct);
        const previousReady = !!previousAmaSlope && Number.isFinite(previousSlopePct);

        const deltaPercent = currentReady && previousReady
            ? Math.abs(currentSlopePct - previousSlopePct)
            : null;
        const thresholdCrossed = Number.isFinite(deltaPercent) && deltaPercent >= thresholdPercent;

        return {
            thresholdPercent,
            currentSlopePct: Number.isFinite(currentSlopePct) ? currentSlopePct : null,
            previousSlopePct: Number.isFinite(previousSlopePct) ? previousSlopePct : null,
            deltaPercent,
            thresholdCrossed,
            shouldTrigger: thresholdCrossed,
        };
    }

    normalizePersistedBotState(botState, lookbackBars) {
        if (!botState || typeof botState !== 'object') return {};
        return normalizePersistedAmaSlopeDiagnostics(botState, lookbackBars);
    }

    extractPersistedDynamicGridState(snapshot, lookbackBars) {
        if (!snapshot || typeof snapshot !== 'object') return null;

        const gridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
        const amaCenterPrice = Number(snapshot.amaCenterPrice);
        const normalized = normalizePersistedAmaSlopeDiagnostics({
            amaSlopePercentMode: snapshot.amaSlopePercentMode,
            amaSlope: snapshot.amaSlope,
            gridRangeScalingAmaSlope: snapshot.gridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: snapshot.amaSlopeDeltaPercent,
            amaSlopeThresholdPercent: snapshot.amaSlopeThresholdPercent,
        }, lookbackBars);
        const amaSlope = normalized?.amaSlope ?? null;
        const gridRangeScalingAmaSlope = normalized?.gridRangeScalingAmaSlope ?? amaSlope;

        return {
            gridCenterPrice: Number.isFinite(gridCenterPrice) && gridCenterPrice > 0 ? gridCenterPrice : null,
            centerPrice: Number.isFinite(gridCenterPrice) && gridCenterPrice > 0 ? gridCenterPrice : null,
            amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : null,
            amaSlope,
            gridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: normalized?.amaSlopeDeltaPercent ?? null,
            amaSlopeThresholdPercent: normalized?.amaSlopeThresholdPercent ?? null,
            amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
        };
    }

    _computeDynamicWeights(params) {
        const {
            analysisCandles, closes, amaValues, amaWarmupBars, lookbackBars,
            botAma, weightVariance, amaPrice, nowIso, cfg, bot, ctx, deps
        } = params;

        const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const amaMaxS = cfg.amaSlope?.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
        const kalMaxS = cfg.kalmanSlope?.maxSlopePct
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
        const mo = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
        const volatilityThreshold = normalizeVolatilityThreshold(cfg.volatilityThreshold);
        const volatilityExponent = cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
        const volatilityScaleX = cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

        // Compute separate clip thresholds for AMA (slopes) and Kalman (velocities)
        let amaClipThreshold = Infinity;
        let kalClipThreshold = Infinity;

        if (clipPercentile > 0 && amaValues.length > amaWarmupBars) {
            // AMA clip threshold from slope distribution — skip initialization period
            const amaSlopes = [];
            for (let i = amaWarmupBars; i < amaValues.length; i++) {
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                const slopePct = computeAverageAmaSlopePct(last, past, lookbackBars);
                if (Number.isFinite(slopePct)) amaSlopes.push(Math.abs(slopePct));
            }
            if (amaSlopes.length > 0) {
                const sorted = amaSlopes.sort((a, b) => a - b);
                const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * sorted.length), sorted.length - 1);
                amaClipThreshold = sorted[idx];
            }
        }

        const slopeCfg = {
            ...(cfg.amaSlope || {}),
            erPeriod:              botAma.erPeriod,
            slowPeriod:            botAma.slowPeriod,
            fastPeriod:            botAma.fastPeriod,
            maxSlopeOffset:        cfg.maxSlopeOffset,
            maxVolatilityOffset:   volatilityClamp,
            volatilityExponent,
            volatilityScaleX,
            volatilityThreshold,
            neutralZonePct:        nz,
            clipPercentile,
            clipThreshold:         amaClipThreshold,
        };

        const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

        // Kalman filter computation - collect per-bar results in single pass
        const kalman = new KalmanTrendAnalyzer({
            rNoise: cfg.kalman?.rNoise ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
            qTactical: cfg.kalman?.qTactical ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
            qModal: cfg.kalman?.qModal ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
            warmupBars: cfg.kalman?.warmupBars ?? 20,
        });

        const kalmanHistory = [];
        for (const price of closes) {
            const kr = kalman.update(price);
            kalmanHistory.push(kr);
        }

        const kalmanResult = kalmanHistory[kalmanHistory.length - 1];
        const kalmanWarmupBars = kalman.warmupBars ?? 20;

        // Regime gate (Hurst + PE bilinear multiplier)
        const regimeSensitivity = cfg.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY;
        const absoluteThreshold = cfg.absoluteThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT;
        let regimeResult = null;
        let regimeMultiplier = 1.0;
        const regimeMultipliers = new Array(closes.length).fill(1.0);

        if (regimeSensitivity > 0) {
            regimeResult = computeRegimeMultiplier(closes, {
                regimeSensitivity,
                regimeTable: cfg.regimeTable,
                hurstZoneBand: cfg.hurstZoneBand,
                peNodes: cfg.peNodes,
            });
            regimeMultiplier = regimeResult.isReady && Math.abs(regimeResult.multiplier - 1.0) >= absoluteThreshold
                ? regimeResult.multiplier
                : 1.0;
            if (Array.isArray(regimeResult.series) && regimeResult.series.length === closes.length) {
                for (let i = 0; i < closes.length; i++) {
                    const rawMult = regimeResult.series[i];
                    regimeMultipliers[i] = Math.abs(rawMult - 1.0) >= absoluteThreshold ? rawMult : 1.0;
                }
            }
        }

        const alpha = cfg.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA;
        const dw = cfg.dw ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW;
        const gain = cfg.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN;
        const kalmanSmoothPct = cfg.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT;
        const kalmanDispScaleMult = cfg.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT;
        const kalmanDispThresholdMult = cfg.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT;
        const kalmanSmoothSpanPct = cfg.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT;
        const signalConfirmBars = cfg.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT;
        const minOutputThreshold = cfg.minOutputThreshold
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD;
        const dispScaleMinPct  = cfg.dispScaleMinPct  ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;
        const hasDirectionalOffset = mo > 0;
        const useAmaBlend = hasDirectionalOffset && alpha !== 0;
        const useKalmanBlend = hasDirectionalOffset && alpha !== 1;
        const useNeutralZone = nz > 0;
        const useClipThreshold = clipPercentile > 0;
        const zeroOutputThreshold = minOutputThreshold === 0;

        let kalmanSmoothedVelocityPct = new Array(kalmanHistory.length).fill(null);
        let amaOffsets = new Array(closes.length).fill(0);
        let kalmanOffsets = new Array(closes.length).fill(0);

        if (useKalmanBlend) {
            kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanHistory, {
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
            });

            kalClipThreshold = useClipThreshold
                ? computeAbsolutePercentileThreshold(
                    kalmanSmoothedVelocityPct.slice(kalmanWarmupBars),
                    clipPercentile,
                    Infinity
                )
                : Infinity;

            for (let i = 0; i < kalmanHistory.length; i++) {
                const kr = kalmanHistory[i];
                const vp = kalmanSmoothedVelocityPct[i];
                if (!kr.isReady || vp == null || kr.displacementRawPct == null) continue;

                const dp = kr.displacementRawPct;
                const clippedV = Math.max(-kalClipThreshold, Math.min(kalClipThreshold, vp));
                if (useNeutralZone && Math.abs(clippedV) < nz) continue;

                const dispScale = Math.max(1e-6, dispScaleMinPct);
                const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
                const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
                const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                kalmanOffsets[i] = Math.max(-mo, Math.min(mo, (composite / kalMaxS) * mo));
            }
        }

        if (useAmaBlend) {
            for (let i = 0; i < closes.length; i++) {
                if (!slopeResult.isReady || i < amaWarmupBars) continue;
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) continue;
                const sp = computeAverageAmaSlopePct(last, past, lookbackBars);
                if (!Number.isFinite(sp)) continue;
                const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
                amaOffsets[i] = (!useNeutralZone || Math.abs(csp) >= nz)
                    ? Math.max(-mo, Math.min(mo, (csp / amaMaxS) * mo))
                    : 0;
            }
        }

        const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
        const outputThreshold = minOutputThreshold;
        const outputThresholdIsZero = zeroOutputThreshold;

        const combinedOffSeries = new Array(closes.length).fill(0);
        const gatedOffSeries = new Array(closes.length).fill(0);
        for (let i = 0; i < closes.length; i++) {
            let blendedOff;
            if (useAmaBlend && useKalmanBlend) {
                blendedOff = (alpha * (amaOffsets[i] / channelNorm) + (1 - alpha) * (kalmanOffsets[i] / channelNorm));
            } else if (useAmaBlend) {
                blendedOff = amaOffsets[i] / channelNorm;
            } else if (useKalmanBlend) {
                blendedOff = kalmanOffsets[i] / channelNorm;
            } else {
                blendedOff = 0;
            }

            const regimeAdjusted = blendedOff * regimeMultipliers[i];
            const gatedOff = outputThresholdIsZero
                ? regimeAdjusted
                : (Math.abs(regimeAdjusted) < outputThreshold ? 0 : regimeAdjusted);
            const off = Math.max(-offsetClamp, Math.min(offsetClamp, gatedOff * gain));
            gatedOffSeries[i] = gatedOff;
            combinedOffSeries[i] = Math.round(off * 1000) / 1000;
        }

        const confirmBars = Math.max(0, Math.min(5, Math.round(signalConfirmBars)));
        let echoedOffSeries = new Array(closes.length).fill(0);
        let echoedGatedOffSeries = new Array(closes.length).fill(0);
        if (confirmBars === 0) {
            echoedOffSeries = combinedOffSeries;
            echoedGatedOffSeries = gatedOffSeries;
        } else {
            let latchedSign = 0;
            let pendingSign = 0;
            let pendingCount = 0;
            let latchedOff = 0;
            let latchedGatedOff = 0;
            for (let i = 0; i < closes.length; i++) {
                const raw = combinedOffSeries[i];
                const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
                if (sign === latchedSign) {
                    pendingSign = 0;
                    pendingCount = 0;
                    latchedOff = raw;
                    latchedGatedOff = gatedOffSeries[i];
                } else {
                    if (pendingSign !== sign) {
                        pendingSign = sign;
                        pendingCount = 1;
                    } else {
                        pendingCount++;
                    }
                    if (pendingCount >= confirmBars) {
                        latchedSign = sign;
                        pendingSign = 0;
                        pendingCount = 0;
                        latchedOff = raw;
                        latchedGatedOff = gatedOffSeries[i];
                    }
                }
                echoedOffSeries[i] = latchedOff;
                echoedGatedOffSeries[i] = latchedGatedOff;
            }
        }

        const rawFinalOff = combinedOffSeries[combinedOffSeries.length - 1] ?? 0;
        const rawFinalPreGainOff = gatedOffSeries[gatedOffSeries.length - 1] ?? 0;
        const finalPreGainOff = echoedGatedOffSeries[echoedGatedOffSeries.length - 1] ?? rawFinalPreGainOff;
        const finalOff = echoedOffSeries[echoedOffSeries.length - 1] ?? rawFinalOff;

        const lastAmaOffset = useAmaBlend ? (amaOffsets[amaOffsets.length - 1] ?? 0) : 0;
        const amaSlopeGated = slopeResult.isReady
            ? Math.round((alpha * (lastAmaOffset / channelNorm) * gain * regimeMultiplier) * 1000) / 1000
            : 0;

        const amaSlope = {
            trend:          slopeResult.trend,
            confidence:     slopeResult.confidence,
            slopePct:       slopeResult.slopePct,
            slopeOffset:    slopeResult.slopeOffset,
            rawSlopeOffset: slopeResult.rawSlopeOffset,
            amaSlopeGated,
            regimeMultiplier,
            symmetricDelta: slopeResult.symmetricDelta,
            weightVariance,
            isReady:        slopeResult.isReady,
            kalmanReady:    kalmanResult?.isReady ?? false,
            alpha,
            dw,
            gain,
            atrPeriod:      params.atrPeriod,
            maxSlopeOffset: mo,
            amaSlope: {
                maxSlopePct: amaMaxS,
            },
            kalmanSlope: {
                maxSlopePct: kalMaxS,
            },
            maxVolatilityOffset: volatilityClamp,
            kalmanSmoothPct,
            kalmanDispScaleMult,
            kalmanDispThresholdMult,
            kalmanSmoothSpanPct,
            signalConfirmBars,
        };

        const staticSell = bot.weightDistribution.sell;
        const staticBuy = bot.weightDistribution.buy;
        const MIN_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
        const MAX_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        const belowMinOutputThreshold = Math.abs(finalPreGainOff) < outputThreshold;
        const volPenalty = slopeResult.isReady ? (slopeResult.symmetricDelta ?? 0) : 0;
        const trendOff   = belowMinOutputThreshold ? 0 : finalOff;

        const effectiveSell = Math.round(clamp(staticSell + trendOff + volPenalty, MIN_W, MAX_W) * 100) / 100;
        const effectiveBuy  = Math.round(clamp(staticBuy  - trendOff + volPenalty, MIN_W, MAX_W) * 100) / 100;

        const weights = {
            sell: effectiveSell,
            buy:  effectiveBuy,
            profile: !slopeResult.isReady ? 'static'
                : trendOff !== 0 ? 'slope'
                : volPenalty !== 0 ? 'volatility'
                : 'flat',
            meta: {
                source:                  'dynamic_weight',
                staticSell,
                staticBuy,
                trend:                   slopeResult.trend,
                confidence:              slopeResult.confidence,
                slopePct:                slopeResult.slopePct,
                slopeOffset:             slopeResult.slopeOffset,
                rawSlopeOffset:          slopeResult.rawSlopeOffset,
                amaSlopeGated,
                regimeMultiplier,
                regimeSensitivity,
                absoluteThreshold,
                volatilityPenalty:       volPenalty,
                alpha,
                dw,
                gain,
                atrPeriod:      params.atrPeriod,
                maxSlopeOffset: mo,
                maxAsymmetryFactor:  (cfg.asymmetricBounds?.maxAsymmetryFactor != null)
                    ? cfg.asymmetricBounds.maxAsymmetryFactor
                    : null,
                clipPercentile,
                neutralZonePct: nz,
                volatilityThreshold,
                volatilityExponent,
                volatilityScaleX,
                amaSlope: {
                    maxSlopePct: amaMaxS,
                },
                kalmanSlope: {
                    maxSlopePct: kalMaxS,
                },
                maxVolatilityOffset: volatilityClamp,
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
                signalConfirmBars,
                amaChannelContribution: amaSlopeGated,
                rawFinalOffset:          rawFinalOff,
                trendOffset:             trendOff,
                finalOffset:             finalOff,
                minOutputThreshold,
                outputThreshold,
                belowMinOutputThreshold,
                kalmanReady:             kalmanResult?.isReady ?? false,
                isReady:                 slopeResult.isReady,
            },
        };

        const dynamicWeightsPayload = {
            effectiveWeights: { sell: effectiveSell, buy: effectiveBuy },
            baseWeights:      { sell: staticSell,    buy: staticBuy },
            slopeOffset:      slopeResult.slopeOffset,
            rawSlopeOffset:   slopeResult.rawSlopeOffset,
            amaSlopeGated,
            volatilityPenalty: volPenalty,
            finalOffset:      finalOff,
            alpha,
            dw,
            gain,
            atrPeriod:      params.atrPeriod,
            maxSlopeOffset: mo,
            amaSlope: {
                maxSlopePct: amaMaxS,
            },
            kalmanSlope: {
                maxSlopePct: kalMaxS,
            },
            clipPercentile,
            neutralZonePct: nz,
            volatilityThreshold,
            volatilityExponent,
            volatilityScaleX,
            maxVolatilityOffset: volatilityClamp,
            kalmanSmoothPct,
            kalmanDispScaleMult,
            kalmanDispThresholdMult,
            kalmanSmoothSpanPct,
            signalConfirmBars,
            rawFinalOffset:      rawFinalOff,
            maxAsymmetryFactor:  (cfg.asymmetricBounds?.maxAsymmetryFactor != null)
                ? cfg.asymmetricBounds.maxAsymmetryFactor
                : null,
            amaChannelContribution: amaSlopeGated,
            trend:                   slopeResult.trend,
            confidence:              slopeResult.confidence,
            slopePct:                slopeResult.slopePct,
            regimeMultiplier,
            regimeSensitivity,
            absoluteThreshold,
            minOutputThreshold,
            outputThreshold,
            belowMinOutputThreshold,
            kalmanReady:             kalmanResult?.isReady ?? false,
            ...(regimeResult ? {
                hurst:       regimeResult.hurst,
                pe:          regimeResult.pe,
                hurstRegime: regimeResult.hurstRegime,
                peRegime:    regimeResult.peRegime,
                regimeReady: regimeResult.isReady,
            } : {}),
            isReady:          slopeResult.isReady && (!belowMinOutputThreshold || volPenalty !== 0),
            updatedAt:        nowIso,
        };

        return { weights, dynamicWeightsPayload, slopeResult, regimeResult, kalmanResult, amaSlope };
    }

    async processBot(bot, state, cfg, contextCache, hooks = {}) {

        const deps = this.deps;
        const isDryRun = !!hooks.isDryRun;
        const forceWhitelistAll = !!hooks.forceWhitelistAll;
        let dryRunMessages = [];
        
        if ((!bot.assetA && !bot.assetAId) || (!bot.assetB && !bot.assetBId)) {
            return { ok: false, reason: 'missing asset pair' };
        }

        if (hasNumericStartPrice(bot?.startPrice)) {
            const nowIso = new Date().toISOString();
            const thresholdPercent = typeof deps.calculateBotThreshold === 'function'
                ? deps.calculateBotThreshold(cfg)
                : null;
            state.bots = state.bots || {};
            state.bots[bot.botKey] = this.buildDefaultBotState(bot, {
                startPrice: bot.startPrice,
                priceMode: 'fixed',
                lastCycleSource: 'fixed-start-price',
                lastCycleAt: nowIso,
                lastTriggerSuppressedReason: 'fixed_start_price',
            });

            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: 'fixed-start-price',
                thresholdPercent,
                triggerSuppressedReason: 'fixed_start_price',
            });
        }

        const contextSignature = this.buildBotContextSignature(bot);
        const cached = contextCache.get(bot.botKey);
        const cachedCtx = cached && typeof cached === 'object' && cached.ctx ? cached.ctx : cached;
        const cachedSignature = cached && typeof cached === 'object' && cached.signature ? cached.signature : null;
        let ctx = cachedCtx;
        if (!ctx || cachedSignature !== contextSignature) {
            ctx = await deps.resolveBotContext(bot);
            contextCache.set(bot.botKey, {
                signature: contextSignature,
                ctx,
            });
        }

        const botAma = deps.resolveAmaForBot(bot, ctx, cfg);
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }
        const lookbackBars = cfg.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
        const filePath = deps.candleFileForBot(bot.botKey, cfg.intervalSeconds);
        const existing = deps.loadJson(filePath, null);
        const existingMeta = existing?.meta && typeof existing.meta === 'object' ? existing.meta : {};
        let existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];
        const existingMarketSource = normalizeMarketSource(existingMeta.marketSource);
        const marketSource = resolveMarketSourceForBot(bot) || 'pool';
        const isBookSource = marketSource === 'book';
        const kibanaRequestTimeoutMs = Number.isFinite(cfg.kibanaRequestTimeoutMs) && cfg.kibanaRequestTimeoutMs > 0
            ? cfg.kibanaRequestTimeoutMs
            : MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS;

        const fetchKibanaCandles = async (options = {}) => {
            const kibanaOptions = {
                timeout: kibanaRequestTimeoutMs,
                ...options,
            };
            if (isBookSource) {
                if (!deps.kibanaMarketSource || typeof deps.kibanaMarketSource.getMarketCandles !== 'function') {
                    throw new Error('orderbook candle source unavailable');
                }
                return deps.kibanaMarketSource.getMarketCandles(ctx.assetA, ctx.assetB, kibanaOptions);
            }

            if (!deps.kibanaSource || typeof deps.kibanaSource.getLpCandlesForPool !== 'function') {
                throw new Error('liquidity pool candle source unavailable');
            }
            return deps.kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, kibanaOptions);
        };

        const staleTailVerifiedRangeFromMeta = () => {
            const startTs = Number(existingMeta.staleTailVerifiedStartTs);
            const endTs = Number(existingMeta.staleTailVerifiedEndTs);
            if (Number.isFinite(startTs) && Number.isFinite(endTs)) {
                return { startTs, endTs };
            }

            const legacyStartTs = Number(existingMeta.staleTailVerifiedTs);
            if (Number.isFinite(legacyStartTs)) {
                return { startTs: legacyStartTs, endTs: Number.POSITIVE_INFINITY };
            }
            return {};
        };

        const verifyAndPruneStaleTail = async (candles, threshold, verifiedRange = {}) => {
            if (typeof deps.pruneStaleTail !== 'function') return { candles };
            const pruned = deps.pruneStaleTail(candles, threshold);
            if (pruned.length === candles.length || candles.length === 0) {
                return { candles: pruned };
            }

            // Use the shared detector to find the tail range without re-sorting
            const detected = typeof deps.detectStaleTail === 'function'
                ? deps.detectStaleTail(candles, threshold)
                : null;
            if (!detected) return { candles: pruned };
            const tailStartTs = detected.sorted[detected.sorted.length - detected.runLength][0];
            const tailEndTs = detected.sorted[detected.sorted.length - 1][0];

            // Skip Kibana verification if this tail range was already confirmed flat
            // on a previous cycle (the current tail is contained within a verified range).
            const { startTs: vStart, endTs: vEnd } = verifiedRange;
            if (Number.isFinite(vStart) && (Number.isFinite(vEnd) || vEnd === Number.POSITIVE_INFINITY)
                    && tailStartTs >= vStart && tailEndTs <= vEnd) {
                return { candles, keptStaleTailStartTs: tailStartTs, keptStaleTailEndTs: tailEndTs };
            }

            // Verify with Kibana: did the market actually trade during this period?
            try {
                const kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                    intervalSeconds: cfg.intervalSeconds,
                    consolidateByTimestamp: true,
                    fillGapsToRequestedRange: false,
                    apiKey: null,
                    timeRange: {
                        gte: new Date(tailStartTs).toISOString(),
                        lte: new Date(tailEndTs).toISOString(),
                    },
                }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana stale-tail verification failed');

                if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                    const hasKibanaActivity = kibanaCandles.some(
                        (c) => Array.isArray(c) && Number(c[5] || 0) > 0
                    );
                    if (!hasKibanaActivity) {
                        // Kibana confirms flat/inactive: our data is genuine → keep it
                        return { candles, keptStaleTailStartTs: tailStartTs, keptStaleTailEndTs: tailEndTs };
                    }
                    // Kibana shows real trades: our gap-fill is stale → prune it
                }
                // Kibana has no data for this period (or query failed) → prune
                return { candles: pruned };
            } catch (_) {
                // Kibana query failed: prune (existing behavior)
                return { candles: pruned };
            }
        };

        const applyStaleTailVerificationMeta = (verified) => {
            if (Number.isFinite(verified?.keptStaleTailStartTs) && Number.isFinite(verified?.keptStaleTailEndTs)) {
                existingMeta.staleTailVerifiedStartTs = verified.keptStaleTailStartTs;
                existingMeta.staleTailVerifiedEndTs = verified.keptStaleTailEndTs;
                return;
            }
            existingMeta.staleTailVerifiedStartTs = null;
            existingMeta.staleTailVerifiedEndTs = null;
        };

        // Prune stale trailing candles from a previous run before any processing.
        // Verifies with Kibana first to avoid removing genuinely flat market periods.
        if (existingCandles.length > 0) {
            const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                ? cfg.staleTailThreshold
                : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
            const verified = await verifyAndPruneStaleTail(
                existingCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
            );
            existingCandles = verified.candles;
            applyStaleTailVerificationMeta(verified);
        }

        const hasStoredPoolContext = existingMeta.pool != null && String(existingMeta.pool).trim() !== '';
        const sourceMismatch = (existingMarketSource && existingMarketSource !== marketSource)
            || (marketSource === 'book' && hasStoredPoolContext)
            || (marketSource === 'pool' && existingMarketSource === 'book');
        if (sourceMismatch) {
            existingCandles = [];
            existingMeta.nativeRecentTradeSequences = [];
            existingMeta.nativeLastTradeTs = null;
            existingMeta.staleTailVerifiedTs = null;
            existingMeta.staleTailVerifiedStartTs = null;
            existingMeta.staleTailVerifiedEndTs = null;
        }

        const needBootstrap = existingCandles.length === 0;
        const amaWarmupBars = getAmaWarmupBars(botAma.erPeriod, botAma.slowPeriod, lookbackBars, botAma.fastPeriod);
        const analysisKeepCount = amaWarmupBars + 1;
        // Retain one extra raw candle so the closed-candle analysis window still keeps a
        // full warmup/history set when the newest bucket is the current in-progress bar.
        const rawKeepCount = analysisKeepCount + 1;
        const nowIso = new Date().toISOString();
        const botThreshold = deps.calculateBotThreshold(cfg);
        if (!Number.isFinite(botThreshold) || botThreshold <= 0) {
            throw new Error(`deltaThresholdPercent missing/invalid for bot ${bot.name}`);
        }

        const loadCandles = async () => {
            let nextCandles = existingCandles;
            let sourceLabel = 'native-incremental';
            let kibanaBootstrapEmpty = false;
            let nativeRecentTradeSequences = Array.isArray(existingMeta.nativeRecentTradeSequences)
                ? existingMeta.nativeRecentTradeSequences.slice()
                : [];
            let nativeLastTradeTs = Number.isFinite(existingMeta.nativeLastTradeTs)
                ? existingMeta.nativeLastTradeTs
                : null;
            let nativeOverlapCount = null;
            let nativePagesFetched = null;

            if (isBookSource) {
                nativeRecentTradeSequences = [];
                nativeLastTradeTs = null;
                nativeOverlapCount = null;
                nativePagesFetched = null;
                const bucketMs = Number(cfg.intervalSeconds) * 1000;
                const nowMs = this.getNowMs();

                if (needBootstrap) {
                    // Bootstrap: Kibana first (deep history), native as fallback
                    const kibanaLookbackHours = Math.max(cfg.bootstrapLookbackHours, analysisKeepCount * 2);
                    let kibanaCandles = null;
                    try {
                        kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                            intervalSeconds: cfg.intervalSeconds,
                            lookbackHours: kibanaLookbackHours,
                            consolidateByTimestamp: true,
                            fillGapsToRequestedRange: false,
                            apiKey: null,
                        }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana orderbook bootstrap failed');
                    } catch (_) {}

                    if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                        nextCandles = kibanaCandles;
                        sourceLabel = 'kibana-book-bootstrap';
                    } else {
                        // Fall back to native
                        const nativeLookbackHours = Math.max(
                            Number(cfg.bootstrapLookbackHours) || 0,
                            Number(cfg.nativeBackfillHours) || 0,
                            (analysisKeepCount * Math.max(Number(cfg.intervalSeconds) || 3600, 3600)) / 3600
                        );
                        const nativeStartMs = Math.max(0, nowMs - (nativeLookbackHours * 3600 * 1000));
                        let nativeCandles = [];
                        try {
                            if (typeof deps.fetchNativeMarketHistorySince === 'function') {
                                nativeCandles = await deps.withRetries(() => deps.fetchNativeMarketHistorySince(
                                    ctx.assetA,
                                    ctx.assetB,
                                    nativeStartMs,
                                    nowMs,
                                    cfg.intervalSeconds,
                                    { fillCandleGaps: deps.fillCandleGaps }
                                ), cfg.sourceRetries, cfg.retryDelayMs, 'native market history bootstrap failed');
                            }
                        } catch (_) {}

                        if (Array.isArray(nativeCandles) && nativeCandles.length > 0) {
                            nextCandles = nativeCandles;
                            sourceLabel = 'native-book-bootstrap';
                        } else {
                            throw new Error('both kibana and native orderbook bootstrap failed');
                        }
                    }
                } else {
                    // Incremental: native fetch
                    const nativeLookbackHours = Math.max(
                        Number(cfg.bootstrapLookbackHours) || 0,
                        Number(cfg.nativeBackfillHours) || 0,
                        (analysisKeepCount * Math.max(Number(cfg.intervalSeconds) || 3600, 3600)) / 3600
                    );
                    const nativeStartMs = Math.max(0, (nextCandles[nextCandles.length - 1]?.[0] || 0) - bucketMs);
                    let nativeCandles = [];
                    try {
                        if (typeof deps.fetchNativeMarketHistorySince === 'function') {
                            nativeCandles = await deps.withRetries(() => deps.fetchNativeMarketHistorySince(
                                ctx.assetA,
                                ctx.assetB,
                                nativeStartMs,
                                nowMs,
                                cfg.intervalSeconds,
                                { fillCandleGaps: deps.fillCandleGaps }
                            ), cfg.sourceRetries, cfg.retryDelayMs, 'native market history fetch failed');
                        }
                    } catch (_) {}

                    if (Array.isArray(nativeCandles) && nativeCandles.length > 0) {
                        nextCandles = deps.mergeCandles(nextCandles, nativeCandles);
                        sourceLabel = 'native-book-history';
                    } else {
                        sourceLabel = 'cached-book';
                    }
                }

                if (nextCandles.length > 0) {
                    const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                        ? cfg.staleTailThreshold
                        : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                    const verified = await verifyAndPruneStaleTail(
                        nextCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
                    );
                    nextCandles = verified.candles;
                    applyStaleTailVerificationMeta(verified);

                }
            } else if (needBootstrap) {
                const lookbackHours = Math.max(cfg.bootstrapLookbackHours, analysisKeepCount * 2);

                // ── Step 1: Kibana first (deep history, handles large candle requirements) ──
                let kibanaCandles = null;
                try {
                    kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                        intervalSeconds: cfg.intervalSeconds,
                        lookbackHours,
                        consolidateByTimestamp: true,
                        fillGapsToRequestedRange: false,
                        apiKey: null,
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana bootstrap failed');
                } catch (_) {
                    kibanaCandles = null;
                }

                if (Array.isArray(kibanaCandles) && kibanaCandles.length >= amaWarmupBars) {
                    nextCandles = kibanaCandles;
                    sourceLabel = 'kibana-bootstrap';
                } else {
                    // ── Step 2: Kibana insufficient → fall back to native ──
                    let nativeCandles = [];
                        try {
                            const sinceMs = Date.now() - (lookbackHours * 3600 * 1000);
                            const fetchResult = await deps.withRetries(
                                () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                                cfg.sourceRetries,
                                cfg.retryDelayMs,
                                'native bootstrap failed'
                            );
                            const trades = Array.isArray(fetchResult?.trades) ? fetchResult.trades : [];
                            if (fetchResult?.truncated && typeof deps.logger?.warn === 'function') {
                                deps.logger.warn(`[market_adapter] ${bot.botKey}: native bootstrap history truncated (exhausted ${cfg.maxPages} pages)`);
                            }
                            if (trades.length > 0) {
                                nativeRecentTradeSequences = this.getNativeRecentTradeSequences(trades);
                                const latestTradeTs = Math.max(...trades.map((t) => Number(t?.tsMs)).filter(Number.isFinite));
                                if (Number.isFinite(latestTradeTs)) nativeLastTradeTs = latestTradeTs;
                            }
                            nativeCandles = deps.tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
                        if (nativeCandles.length > 0 && typeof deps.fillCandleGaps === 'function') {
                            const eTs = nativeCandles[0][0];
                            const lTs = nativeCandles[nativeCandles.length - 1][0];
                            nativeCandles = deps.fillCandleGaps(nativeCandles, cfg.intervalSeconds, eTs, lTs);
                        }
                    } catch (_) {
                        nativeCandles = [];
                    }

                    if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                        if (nativeCandles.length > 0) {
                            // Stitch: Kibana older + Native recent (no overlap; native wins)
                            const nativeOldestTs = nativeCandles[0][0];
                            const kbnOlder = kibanaCandles.filter(
                                (c) => Array.isArray(c) && c[0] < nativeOldestTs
                            );
                            const stitched = [...kbnOlder, ...nativeCandles]
                                .sort((a, b) => a[0] - b[0]);
                            if (stitched.length > 1 && typeof deps.fillCandleGaps === 'function') {
                                const sTs = stitched[0][0];
                                const eTs = stitched[stitched.length - 1][0];
                                nextCandles = deps.fillCandleGaps(stitched, cfg.intervalSeconds, sTs, eTs);
                            } else {
                                nextCandles = stitched;
                            }
                            sourceLabel = 'kibana+native-bootstrap';
                        } else {
                            nextCandles = kibanaCandles;
                            sourceLabel = 'kibana-bootstrap';
                        }
                    } else if (nativeCandles.length > 0) {
                        kibanaBootstrapEmpty = true;
                        nextCandles = nativeCandles;
                        sourceLabel = 'native-bootstrap';
                    } else {
                        kibanaBootstrapEmpty = true;
                    }
                }
            } else {
                const lastTs = existingCandles[existingCandles.length - 1]?.[0] || 0;

                try {
                    const knownSequences = new Set(nativeRecentTradeSequences.map((seq) => String(seq)));
                    let fetchedTrades = [];
                    let newTrades = [];
                    let overlapUsed = false;

                    if (knownSequences.size >= 2 && typeof deps.fetchNativeTradesUntilOverlap === 'function') {
                        try {
                            const overlapResult = await deps.withRetries(
                                () => deps.fetchNativeTradesUntilOverlap(ctx.poolId, nativeRecentTradeSequences, 2, cfg.pageLimit, cfg.maxPages),
                                cfg.sourceRetries,
                                cfg.retryDelayMs,
                                'native incremental overlap fetch failed'
                            );
                            if (overlapResult?.reachedOverlap === false) {
                                if (typeof deps.logger?.warn === 'function') {
                                    deps.logger.warn(`[market_adapter] ${bot.botKey}: native overlap fetch exhausted (${cfg.maxPages} pages) without finding an overlap; falling back to time-based`);
                                }
                            } else {
                                fetchedTrades = Array.isArray(overlapResult?.trades) ? overlapResult.trades : [];
                                nativeOverlapCount = Number(overlapResult?.overlapCount || 0);
                                nativePagesFetched = Number(overlapResult?.pages || 0);
                                sourceLabel = 'native-incremental-overlap';
                                newTrades = fetchedTrades.filter((trade) => {
                                    if (!Number.isFinite(Number(trade?.sequence))) return true;
                                    return !knownSequences.has(String(trade.sequence));
                                });
                                overlapUsed = true;
                            }
                        } catch (overlapErr) {
                            if (typeof deps.logger?.log === 'function') {
                                deps.logger.log(`[market_adapter] ${bot.botKey}: overlap fetch exhausted (${overlapErr.message}), falling back to time-based`, 'warn');
                            }
                            // Fall through to time-based path below
                        }
                    }

                    if (!overlapUsed) {
                        const sinceMs = lastTs - (cfg.nativeBackfillHours * 3600 * 1000);
                        const fetchResult = await deps.withRetries(
                            () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                            cfg.sourceRetries,
                            cfg.retryDelayMs,
                            'native incremental fetch failed'
                        );
                        fetchedTrades = Array.isArray(fetchResult?.trades) ? fetchResult.trades : [];
                        if (fetchResult?.truncated && typeof deps.logger?.warn === 'function') {
                            deps.logger.warn(`[market_adapter] ${bot.botKey}: native incremental history truncated (exhausted ${cfg.maxPages} pages)`);
                        }
                        newTrades = this.filterTimeBasedNativeNewTrades(
                            fetchedTrades,
                            knownSequences,
                            nativeLastTradeTs,
                            lastTs,
                            cfg.intervalSeconds
                        );
                        sourceLabel = 'native-incremental-time';
                        nativeOverlapCount = null;
                        nativePagesFetched = fetchResult?.pages || null;
                    }

                    if (fetchedTrades.length > 0) {
                        nativeRecentTradeSequences = this.getNativeRecentTradeSequences(fetchedTrades);
                        const latestTradeTs = Math.max(...fetchedTrades.map((t) => Number(t?.tsMs)).filter(Number.isFinite));
                        if (Number.isFinite(latestTradeTs)) nativeLastTradeTs = latestTradeTs;
                    }

                    const incomingCandles = deps.tradesToCandles(newTrades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
                    nextCandles = deps.mergeCandles(existingCandles, incomingCandles, {
                        onCollision: (existingCandle, incomingCandle) => this.buildIncrementalCandleCollision(existingCandle, incomingCandle),
                    });

                    // Fill bounded no-trade gaps from native incremental fetch. Ordinary LP
                    // inactivity should remain a continuous flat 1h series; very large gaps stay
                    // visible for Kibana repair/stale-tail handling instead of carrying stale prices.
                    const bucketMs = Number(cfg.intervalSeconds) * 1000;
                    const nowMs = this.getNowMs();
                    const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
                    const latestClosedBucketTs = currentBucketStartMs - bucketMs;
                    const earliestIncomingTs = incomingCandles.length > 0 ? incomingCandles[0][0] : null;
                    const gapEndTs = Number.isFinite(earliestIncomingTs) && earliestIncomingTs > lastTs
                        ? earliestIncomingTs
                        : latestClosedBucketTs + bucketMs;
                    const gapBuckets = Number.isFinite(gapEndTs) && gapEndTs > lastTs
                        ? Math.round((gapEndTs - lastTs) / bucketMs) - 1
                        : 0;
                    const maxNativeGapFill = Number.isFinite(cfg.maxNativeGapFillCandles)
                        ? cfg.maxNativeGapFillCandles
                        : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                    if (gapBuckets <= maxNativeGapFill) {
                        nextCandles = this.fillNativeIncrementalClosedGaps(nextCandles, lastTs, cfg.intervalSeconds);
                    }
                } catch (err) {
                    if (typeof deps.logger?.warn === 'function') {
                        deps.logger.warn(`[market_adapter] Native fetch failed for ${bot.botKey}; continuing with cached candles (${err.message})`);
                    }
                    nativePagesFetched = 0;
                    nativeOverlapCount = null;
                    sourceLabel = 'cached-native-fetch-err';
                    nextCandles = existingCandles;
                }

                // After incremental merge (or native fetch failure), prune any stale tail
                // that may have been carried forward when the pool had no activity.
                // Verifies with Kibana first to avoid removing genuinely flat market periods.
                const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                    ? cfg.staleTailThreshold
                    : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                const verified = await verifyAndPruneStaleTail(
                    nextCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
                );
                nextCandles = verified.candles;
                applyStaleTailVerificationMeta(verified);

            }

            let kibanaGapRepairTimestamps = [];
            let kibanaGapRepairAttempted = false;
            let gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
                : { gapCount: 0, missingTimestamps: [] };

            const hasKibanaSource = isBookSource
                ? deps.kibanaMarketSource && typeof deps.kibanaMarketSource.getMarketCandles === 'function'
                : deps.kibanaSource && typeof deps.kibanaSource.getLpCandlesForPool === 'function';

            if (gapAnalysis.gapCount > 0 && hasKibanaSource) {
                const timeRange = this.buildGapRepairTimeRange(
                    gapAnalysis.missingTimestamps,
                    cfg.intervalSeconds,
                    this.getGapRepairMaxHours(cfg)
                );
                if (timeRange) {
                    kibanaGapRepairAttempted = true;
                    try {
                        const kibanaGapCandles = await deps.withRetries(() => fetchKibanaCandles({
                            intervalSeconds: cfg.intervalSeconds,
                            consolidateByTimestamp: true,
                            fillGapsToRequestedRange: false,
                            apiKey: null,
                            timeRange,
                        }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana gap repair failed');

                        if (Array.isArray(kibanaGapCandles) && kibanaGapCandles.length > 0) {
                            const beforeTimestamps = new Set(nextCandles.map((c) => c[0]));
                            nextCandles = deps.mergeCandles(nextCandles, kibanaGapCandles);
                            const afterTimestamps = new Set(nextCandles.map((c) => c[0]));
                            kibanaGapRepairTimestamps = gapAnalysis.missingTimestamps.filter((ts) => !beforeTimestamps.has(ts) && afterTimestamps.has(ts));
                        }
                    } catch (_) {}
                }
                gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                    ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
                    : { gapCount: 0, missingTimestamps: [] };
            }

            // ── Historical backfill: if candle count is still insufficient for AMA warmup,
            //    fetch older history from Kibana using a targeted timeRange. This handles
            //    cases where native bootstrap fell short or the file was truncated.
            const candleShortfall = rawKeepCount - nextCandles.length;
            let kibanaBackfillCount = 0;
            const needsHistoricalBackfill = !kibanaGapRepairAttempted || gapAnalysis.gapCount > 0;
            if (!kibanaBootstrapEmpty && needsHistoricalBackfill && candleShortfall > 0 && nextCandles.length > 0 && hasKibanaSource) {
                const oldestTs = nextCandles[0][0];
                const shortfallMs = candleShortfall * cfg.intervalSeconds * 1000;
                const bufferMs = 24 * 3600 * 1000; // 24h buffer
                const backfillStartMs = Math.max(0, oldestTs - shortfallMs - bufferMs);
                const backfillEndMs = oldestTs + cfg.intervalSeconds * 1000;
                try {
                    const historicalCandles = await deps.withRetries(() => fetchKibanaCandles({
                        intervalSeconds: cfg.intervalSeconds,
                        consolidateByTimestamp: true,
                        fillGapsToRequestedRange: false,
                        apiKey: null,
                        timeRange: {
                            gte: new Date(backfillStartMs).toISOString(),
                            lte: new Date(backfillEndMs).toISOString(),
                        },
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana historical backfill failed');
                    if (Array.isArray(historicalCandles) && historicalCandles.length > 0) {
                        nextCandles = deps.mergeCandles(nextCandles, historicalCandles);
                        kibanaBackfillCount = historicalCandles.length;
                        sourceLabel = `${sourceLabel}+kibana-backfill`;
                    }
                } catch (_) {}
            }

            nextCandles = deps.pruneCandles(nextCandles, rawKeepCount);
            const retainedTimestamps = new Set(nextCandles.map((c) => c[0]));
            const kibanaGapRepairCount = kibanaGapRepairTimestamps.filter((ts) => retainedTimestamps.has(ts)).length;
            const retainedGapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
                : { gapCount: 0, missingTimestamps: [] };
            return {
                nextCandles,
                sourceLabel,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount: retainedGapAnalysis.gapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
            };
        };

        let closedCandles = [];
        let currentBucketStartMs = null;
        let rawLastCandle = [0, 0, 0, 0, 0];
        let rawLastCandleTs = null;
        let latestClosedCandle = null;
        let lastClosedCandleTs = null;
        let botState = {};
        let previousClosedCandleTs = 0;
        let hasNewClosedCandle = false;
        let consumedClosedCandleTs = null;
        let nextCandles = existingCandles;
        let sourceLabel = 'native-incremental';
        let kibanaGapRepairCount = 0;
        let kibanaBackfillCount = 0;
        let unresolvedGapCount = 0;
        let nativeRecentTradeSequences = [];
        let nativeLastTradeTs = null;
        let nativeOverlapCount = null;
        let nativePagesFetched = null;

        const loadResult = await loadCandles();
        nextCandles = loadResult.nextCandles;
        sourceLabel = loadResult.sourceLabel;
        kibanaGapRepairCount = loadResult.kibanaGapRepairCount;
        kibanaBackfillCount = loadResult.kibanaBackfillCount || 0;
        unresolvedGapCount = loadResult.unresolvedGapCount;
        nativeRecentTradeSequences = Array.isArray(loadResult.nativeRecentTradeSequences) ? loadResult.nativeRecentTradeSequences : [];
        nativeLastTradeTs = Number.isFinite(loadResult.nativeLastTradeTs) ? loadResult.nativeLastTradeTs : null;
        nativeOverlapCount = Number.isFinite(loadResult.nativeOverlapCount) ? loadResult.nativeOverlapCount : null;
        nativePagesFetched = Number.isFinite(loadResult.nativePagesFetched) ? loadResult.nativePagesFetched : null;

        const nowMs = this.getNowMs();
        ({ closedCandles, currentBucketStartMs } = this.selectClosedCandles(nextCandles, cfg.intervalSeconds, nowMs));
        rawLastCandle = nextCandles[nextCandles.length - 1] || [0, 0, 0, 0, 0];
        rawLastCandleTs = rawLastCandle[0] || null;
        latestClosedCandle = closedCandles[closedCandles.length - 1] || null;
        lastClosedCandleTs = latestClosedCandle ? latestClosedCandle[0] : null;
        botState = this.normalizePersistedBotState(state.bots[bot.botKey], lookbackBars);
        if (sourceMismatch) {
            botState = {};
        }
        const stateGridCenterPrice = Number(botState.gridCenterPrice ?? botState.centerPrice);
        if (Number.isFinite(stateGridCenterPrice) && stateGridCenterPrice > 0) {
            botState.gridCenterPrice = stateGridCenterPrice;
            botState.centerPrice = stateGridCenterPrice;
        }
        const dynGridPath = deps.path.join(
            deps.root, 'profiles', 'orders', `${bot.botKey}.dynamicgrid.json`,
        );
        const persistedDynamicGridState = typeof deps.loadJson === 'function'
            ? this.extractPersistedDynamicGridState(deps.loadJson(dynGridPath, null), lookbackBars)
            : null;
        if (persistedDynamicGridState) {
            if (!(Number(botState.gridCenterPrice ?? botState.centerPrice) > 0) && persistedDynamicGridState.gridCenterPrice) {
                botState.gridCenterPrice = persistedDynamicGridState.gridCenterPrice;
                botState.centerPrice = persistedDynamicGridState.gridCenterPrice;
            }
            if (!(Number(botState.amaCenterPrice) > 0) && persistedDynamicGridState.amaCenterPrice) {
                botState.amaCenterPrice = persistedDynamicGridState.amaCenterPrice;
            }
            if (!botState.amaSlope && persistedDynamicGridState.amaSlope) {
                botState.amaSlope = persistedDynamicGridState.amaSlope;
            }
            if (!botState.gridRangeScalingAmaSlope && persistedDynamicGridState.gridRangeScalingAmaSlope) {
                botState.gridRangeScalingAmaSlope = persistedDynamicGridState.gridRangeScalingAmaSlope;
            }
            if (botState.amaSlopeDeltaPercent == null && persistedDynamicGridState.amaSlopeDeltaPercent != null) {
                botState.amaSlopeDeltaPercent = persistedDynamicGridState.amaSlopeDeltaPercent;
            }
            if (botState.amaSlopeThresholdPercent == null && persistedDynamicGridState.amaSlopeThresholdPercent != null) {
                botState.amaSlopeThresholdPercent = persistedDynamicGridState.amaSlopeThresholdPercent;
            }
        }
        const previousAmaSlope = botState.amaSlope || null;
        const previousGridResetAmaSlope = botState.gridRangeScalingAmaSlope || previousAmaSlope;
        delete botState.gridPriceOffsetPct;
        delete botState.gridPriceOffsetClampToBounds;
        previousClosedCandleTs = Number(botState.lastClosedCandleTs || 0);
        consumedClosedCandleTs = Number.isFinite(previousClosedCandleTs) && previousClosedCandleTs > 0
            ? previousClosedCandleTs
            : null;
        hasNewClosedCandle = Number.isFinite(lastClosedCandleTs) && lastClosedCandleTs > previousClosedCandleTs;

        const candlePayload = {
            meta: {
                updatedAt: nowIso,
                source: sourceLabel,
                pool: ctx.poolId,
                marketSource,
                assetA: ctx.assetA,
                assetB: ctx.assetB,
                intervalSeconds: cfg.intervalSeconds,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                currentBucketStartMs,
                lastClosedCandleTs,
                rawLastCandleTs,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                staleTailVerifiedStartTs: Number.isFinite(existingMeta.staleTailVerifiedStartTs)
                    ? existingMeta.staleTailVerifiedStartTs : null,
                staleTailVerifiedEndTs: Number.isFinite(existingMeta.staleTailVerifiedEndTs)
                    ? existingMeta.staleTailVerifiedEndTs : null,
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles: nextCandles,
        };
        deps.saveJson(filePath, candlePayload);

        if (!hasNewClosedCandle) {
            const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastClosedCandleTs, cfg.maxStaleHours);
            const pendingClosedCandle = !staleData;
            const triggerSuppressedReason = staleData
                ? 'stale_candle_data'
                : 'waiting_for_new_closed_candle';
            state.bots[bot.botKey] = {
                ...botState,
                botName: bot.name,
                botKey: bot.botKey,
                poolId: ctx.poolId,
                marketSource,
                candleFile: deps.path.relative(deps.root, filePath),
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                lastCycleSource: sourceLabel,
                lastCycleAt: nowIso,
                staleData,
                staleAgeHours,
                pendingClosedCandle,
                lastTriggerSuppressedReason: triggerSuppressedReason,
            };
            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: sourceLabel,
                marketSource,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                thresholdPercent: botThreshold,
                staleData,
                staleAgeHours,
                triggerSuppressedReason,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                amaConfig: {
                    erPeriod: botAma.erPeriod,
                    fastPeriod: botAma.fastPeriod,
                    slowPeriod: botAma.slowPeriod,
                },
                pendingClosedCandle,
            });
        }

        // ------------------ MARKET ADAPTER STRATEGIES ------------------

        // 1. AMA series and closes — used for price reference and signal computation
        const analysisCandles = closedCandles;
        const closes = analysisCandles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);

        // ── AMA warmup guard ──────────────────────────────────────────────────
        // calculateAMA echoes raw close prices until history.length > erPeriod.
        // If we don't have enough candles for the full warmup, the "AMA" is just
        // the last raw price — useless for grid centering. Abort analysis but
        // still save candles so the next cycle can try again after backfill.
        if (closes.length < amaWarmupBars + 1) {
            const triggerSuppressedReason = 'ama_warmup_insufficient';
            const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastClosedCandleTs, cfg.maxStaleHours);
            state.bots[bot.botKey] = {
                ...botState,
                botName: bot.name,
                botKey: bot.botKey,
                poolId: ctx.poolId,
                marketSource,
                candleFile: deps.path.relative(deps.root, filePath),
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                lastCycleSource: sourceLabel,
                lastCycleAt: nowIso,
                staleData,
                staleAgeHours,
                pendingClosedCandle: false,
                lastTriggerSuppressedReason: triggerSuppressedReason,
            };
            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: sourceLabel,
                marketSource,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                thresholdPercent: botThreshold,
                staleData,
                staleAgeHours,
                triggerSuppressedReason,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                amaConfig: {
                    erPeriod: botAma.erPeriod,
                    fastPeriod: botAma.fastPeriod,
                    slowPeriod: botAma.slowPeriod,
                },
            });
        }

        const amaValues = calculateAMA(closes, botAma);

        // amaPrice is the last value of the full AMA series
        const amaPrice = amaValues[amaValues.length - 1];
        const lastCandle = latestClosedCandle || [0, 0, 0, 0, 0];

        // 2. ATR — used only for the symmetric volatility shift. The asymmetrical
        //    trend/Kalman branch stays ATR-free to match the research HTML.
        const atrPeriod = normalizeAtrPeriod(cfg.atrPeriod);
        const atr = calculateATR(analysisCandles, atrPeriod);
        const warn = (message) => {
            if (typeof deps.logger?.log === 'function') {
                deps.logger.log(message, 'warn');
            } else if (typeof deps.logger?.warn === 'function') {
                deps.logger.warn(message);
            } else {
                console.warn(message);
            }
        };
        if (!Number.isFinite(atr)) {
            warn(`[market_adapter] ATR calculation failed for ${bot.botKey}; disabling volatility penalty for this cycle.`);
        }
        const weightVariance = Number.isFinite(atr) && amaPrice > 0 ? (atr / amaPrice) : 0;

        // 3. Dynamic weight computation — live path uses AMA + Kalman + regime gate,
        //    with ATR applied only as a separate symmetric penalty.
        //    Calculations always run for AMA-grid bots; live application is gated
        //    later by the AMA whitelist and the dynamic-weight whitelist.
        const isDynamicWeightWhitelisted = forceWhitelistAll || (typeof deps.isBotDynamicWeightWhitelisted === 'function'
            && deps.isBotDynamicWeightWhitelisted(bot.botKey));
        const isGridRangeScalingWhitelisted = forceWhitelistAll
            || (typeof deps.isBotGridRangeScalingWhitelisted === 'function'
                && deps.isBotGridRangeScalingWhitelisted(bot.botKey))
            || (typeof deps.isBotAsymmetricBoundsWhitelisted === 'function'
                && deps.isBotAsymmetricBoundsWhitelisted(bot.botKey));
        const isAsymmetricBoundsWhitelisted = isGridRangeScalingWhitelisted;
        const hasExplicitBaseWeights = Number.isFinite(bot.weightDistribution?.sell)
            && Number.isFinite(bot.weightDistribution?.buy);
        const isAmaGridBot = /^ama(?:[1-4])?$/i.test(String(bot?.gridPrice || '').trim());
        const shouldComputeDynamicWeights = isAmaGridBot && hasExplicitBaseWeights;
        const canApplyDynamicWeights = isDynamicWeightWhitelisted && shouldComputeDynamicWeights;
        if (!hasExplicitBaseWeights && isAmaGridBot) {
            warn(`[market_adapter] ${bot.botKey} is missing explicit weightDistribution; skipping dynamic volatility weights for this cycle.`);
        }

        const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const amaMaxS = cfg.amaSlope?.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
        const kalMaxS = cfg.kalmanSlope?.maxSlopePct
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
        const mo = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
        const volatilityThreshold = normalizeVolatilityThreshold(cfg.volatilityThreshold);
        const volatilityExponent = cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
        const volatilityScaleX = cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

        // Compute separate clip thresholds for AMA (slopes) and Kalman (velocities)
        let amaClipThreshold = Infinity;
        let kalClipThreshold = Infinity;

        if (clipPercentile > 0 && amaValues.length > amaWarmupBars) {
            // AMA clip threshold from slope distribution — skip initialization period
            const amaSlopes = [];
            for (let i = amaWarmupBars; i < amaValues.length; i++) {
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                const slopePct = computeAverageAmaSlopePct(last, past, lookbackBars);
                if (Number.isFinite(slopePct)) amaSlopes.push(Math.abs(slopePct));
            }
            if (amaSlopes.length > 0) {
                const sorted = amaSlopes.sort((a, b) => a - b);
                const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * sorted.length), sorted.length - 1);
                amaClipThreshold = sorted[idx];
            }
        }

        const slopeCfg = {
            ...(cfg.amaSlope || {}),
            erPeriod:              botAma.erPeriod,
            slowPeriod:            botAma.slowPeriod,
            fastPeriod:            botAma.fastPeriod,
            maxSlopeOffset:        cfg.maxSlopeOffset,
            maxVolatilityOffset:   volatilityClamp,
            volatilityExponent,
            volatilityScaleX,
            volatilityThreshold,
            neutralZonePct:        nz,
            clipPercentile,
            clipThreshold:         amaClipThreshold,
        };

        let slopeResult = null;
        let amaSlope = null;
        let weights = null;
        let dynamicWeightsPayload = null;

        if (shouldComputeDynamicWeights) {
            const dwResult = this._computeDynamicWeights({
                analysisCandles,
                closes,
                amaValues,
                amaWarmupBars,
                lookbackBars,
                botAma,
                weightVariance,
                amaPrice,
                nowIso,
                cfg,
                bot,
                ctx,
                deps,
                atrPeriod,
            });
            slopeResult = dwResult.slopeResult;
            amaSlope = dwResult.amaSlope;
            weights = dwResult.weights;
            dynamicWeightsPayload = dwResult.dynamicWeightsPayload;
        }
        const amaSlopeResetDetails = this.buildAmaSlopeResetDetails(amaSlope, previousGridResetAmaSlope, cfg);
        const amaSlopeDeltaPercent = amaSlopeResetDetails.deltaPercent;
        const amaSlopeThresholdPercent = amaSlopeResetDetails.thresholdPercent;

        // 4. Advisory collateral-ratio hint only; execution is owned by the debt runtime.
        const collateralRecommendation = shouldComputeDynamicWeights ? adjustCollateralRatio(slopeResult, 1.5, 2.0) : null;

        const amaComparison = deps.calcAmaComparison(analysisCandles, bot, ctx);
        const closedCandleTs = lastCandle[0] || null;
        const { staleData, staleAgeHours } = deps.computeCandleStaleness(closedCandleTs, cfg.maxStaleHours);

        const referencePrice = amaPrice;
        const clampedCenterPrice = this.clampGridPriceToBounds(referencePrice, referencePrice, bot);
        const centerPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0
            ? clampedCenterPrice
            : referencePrice;
        if (dynamicWeightsPayload) {
            const asymmetryMetrics = isAsymmetricBoundsWhitelisted
                ? this.computeAppliedAsymmetryMetrics(bot, centerPrice, dynamicWeightsPayload)
                : {
                    rawAsymmetryFactor: null,
                    appliedAsymmetryFactor: null,
                };
            Object.assign(dynamicWeightsPayload, asymmetryMetrics);
            if (weights?.meta) {
                Object.assign(weights.meta, asymmetryMetrics);
            }
        }
        const shouldPersistRangeScalingSnapshot = isGridRangeScalingWhitelisted && dynamicWeightsPayload;
        const dynamicSnapshotPayload = (canApplyDynamicWeights || shouldPersistRangeScalingSnapshot)
            ? dynamicWeightsPayload
            : null;

        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;
        let snapshotPersistedThisCycle = false;
        let previousCenterPrice = Number(botState.centerPrice || 0);

        const buildDynamicGridOptions = (options = {}) => ({
            gridCenterPrice: options.gridCenterPrice ?? null, // explicit baseline if provided
            amaCenterPrice: amaPrice,
            amaSlope: options.amaSlope ?? amaSlope,
            gridRangeScalingAmaSlope: options.gridRangeScalingAmaSlope ?? (amaSlope || previousGridResetAmaSlope || null),
            amaSlopeDeltaPercent,
            amaSlopeThresholdPercent,
            ...(options.previousCenterPrice !== undefined
                ? { previousCenterPrice: options.previousCenterPrice }
                : {}),
            ...(dynamicSnapshotPayload
                ? { dynamicWeights: dynamicSnapshotPayload }
                : {}),
        });

        const persistDynamicGridSnapshot = (snapshotCenterPrice, options = {}) => {
            if (!isDryRun && typeof deps.writeBotDynamicGrid === 'function') {
                return deps.writeBotDynamicGrid(
                    bot.botKey,
                    snapshotCenterPrice,
                    buildDynamicGridOptions(options),
                ) !== false;
            }
            if (isDryRun) {
                dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${snapshotCenterPrice}`);
            }
            return true;
        };

        const advanceTriggeredBotState = (newCenterPrice, options = {}) => {
            snapshotPersistedThisCycle = true;
            botState.gridCenterPrice = newCenterPrice;
            botState.centerPrice = newCenterPrice;
            botState.amaCenterPrice = amaPrice;
            botState.lastGridResetAt = nowIso;
            botState.amaSlope = options.amaSlope ?? (amaSlope || previousAmaSlope || null);
            botState.gridRangeScalingAmaSlope = options.gridRangeScalingAmaSlope ?? (amaSlope || previousGridResetAmaSlope || null);
            botState.amaSlopeDeltaPercent = Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null;
            botState.amaSlopeThresholdPercent = amaSlopeThresholdPercent;
            botState.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
            botState.triggerCount = Number(botState.triggerCount || 0) + 1;
            if (canApplyDynamicWeights && dynamicWeightsPayload) {
                botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
            }
            triggered = true;
        };

        const writeTriggerAndNotify = async ({ triggerPayload, hookPayload, dryRunMessage }) => {
            if (!isDryRun) {
                triggerPath = deps.writeGridResetTrigger(bot, triggerPayload);
            } else {
                dryRunMessages.push(dryRunMessage);
            }

            if (typeof hooks.onTrigger === 'function') {
                try {
                    await hooks.onTrigger({
                        bot,
                        botKey: bot.botKey,
                        botName: bot.name,
                        poolId: ctx.poolId,
                        ...hookPayload,
                        triggerPath,
                        marketSource,
                    });
                } catch (err) {
                    triggerCallbackError = err.message;
                }
            }
        };

        if (!staleData && Number.isFinite(referencePrice) && referencePrice > 0) {
            // Bootstrap when market-adapter state is missing (e.g. after clearing)
            // or when a bot runs for the first time.
            if (!Number.isFinite(previousCenterPrice) || previousCenterPrice <= 0) {
                const bootstrapCenterPrice = Number.isFinite(centerPrice) && centerPrice > 0
                    ? centerPrice
                    : referencePrice;

                const amaCenterPersisted = persistDynamicGridSnapshot(bootstrapCenterPrice, {
                    amaSlope: amaSlope || previousAmaSlope || null,
                });

                if (amaCenterPersisted) {
                    advanceTriggeredBotState(bootstrapCenterPrice, {
                        amaSlope: amaSlope || previousAmaSlope || null,
                    });
                    // First-ever bootstrap — no previous center anywhere.
                    // Create a trigger so the bot recalibrates to the new center.
                    await writeTriggerAndNotify({
                        triggerPayload: {
                            reason: 'market_adapter_bootstrap',
                            newCenterPrice: bootstrapCenterPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                            amaSlope: amaSlope || previousAmaSlope || null,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            poolId: ctx.poolId,
                            marketSource,
                        },
                        hookPayload: {
                            thresholdPercent: botThreshold,
                            deltaPercent: null,
                            previousCenterPrice: undefined,
                            newCenterPrice: bootstrapCenterPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                        },
                        dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey} (bootstrap)`,
                    });
                } else {
                    triggerSuppressedReason = 'ama_center_persist_failed';
                }
            }

            // Unified delta check — runs when previousCenterPrice is known
            // (either from state or recovered from .dynamicgrid.json).
            if (!triggered && Number.isFinite(previousCenterPrice) && previousCenterPrice > 0) {
                deltaPercent = Math.abs((centerPrice - previousCenterPrice) / previousCenterPrice) * 100;
                if (deltaPercent >= botThreshold) {
                    const amaCenterPersisted = persistDynamicGridSnapshot(centerPrice, {
                        previousCenterPrice,
                    });

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        advanceTriggeredBotState(centerPrice);
                        await writeTriggerAndNotify({
                            triggerPayload: {
                                reason: 'market_adapter_delta_threshold',
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice,
                                newCenterPrice: centerPrice,
                                referencePrice,
                                amaCenterPrice: amaPrice,
                                amaSlope,
                                amaSlopeDeltaPercent,
                                amaSlopeThresholdPercent,
                                poolId: ctx.poolId,
                                marketSource,
                            },
                            hookPayload: {
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice,
                                newCenterPrice: centerPrice,
                                referencePrice,
                                amaCenterPrice: amaPrice,
                            },
                            dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey}`,
                        });
                    }
                }
            }

            if (!triggered && !triggerSuppressedReason && isGridRangeScalingWhitelisted && amaSlopeResetDetails.shouldTrigger) {
                const amaSlopePersisted = persistDynamicGridSnapshot(centerPrice);

                if (!amaSlopePersisted) {
                    triggerSuppressedReason = 'ama_slope_persist_failed';
                } else {
                    advanceTriggeredBotState(centerPrice);
                    await writeTriggerAndNotify({
                        triggerPayload: {
                            reason: 'market_adapter_ama_slope_delta_threshold',
                            thresholdPercent: amaSlopeThresholdPercent,
                            deltaPercent: amaSlopeDeltaPercent,
                            previousAmaSlope,
                            previousGridResetAmaSlope,
                            amaSlope,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            previousCenterPrice,
                            newCenterPrice: centerPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                            poolId: ctx.poolId,
                            marketSource,
                        },
                        hookPayload: {
                            thresholdPercent: amaSlopeThresholdPercent,
                            deltaPercent: amaSlopeDeltaPercent,
                            previousAmaSlope,
                            previousGridResetAmaSlope,
                            amaSlope,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            previousCenterPrice,
                            newCenterPrice: centerPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                        },
                        dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey} (AMA slope)`,
                    });
                }
            }
        }

        const acceptedGridCenterPrice = Number(botState.gridCenterPrice ?? botState.centerPrice);
        const persistedCenterPrice = acceptedGridCenterPrice > 0
            ? acceptedGridCenterPrice
            : undefined;

        // Weight-only update path: persist fresh weights to dynamicgrid.json without a grid reset.
        // The bot will pick these up on the next recalculation cycle after fills or config reload.
        if (!snapshotPersistedThisCycle && !triggered && !triggerSuppressedReason && !isDryRun && !staleData && canApplyDynamicWeights
                && dynamicWeightsPayload && persistedCenterPrice > 0
                && typeof deps.writeBotDynamicGrid === 'function') {
            const dynamicWeightsPersisted = deps.writeBotDynamicGrid(bot.botKey, persistedCenterPrice, {
                amaCenterPrice: amaPrice,
                amaSlope: amaSlope || previousAmaSlope || null,
                gridRangeScalingAmaSlope: botState.gridRangeScalingAmaSlope || previousGridResetAmaSlope || null,
                amaSlopeDeltaPercent,
                amaSlopeThresholdPercent,
                dynamicWeights: dynamicWeightsPayload,
            }) !== false;
            if (dynamicWeightsPersisted) {
                botState.amaCenterPrice = amaPrice;
                botState.amaSlope = amaSlope || previousAmaSlope || null;
                botState.amaSlopeDeltaPercent = Number.isFinite(amaSlopeDeltaPercent)
                    ? amaSlopeDeltaPercent
                    : botState.amaSlopeDeltaPercent ?? null;
                botState.amaSlopeThresholdPercent = amaSlopeThresholdPercent;
                botState.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
                botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
                snapshotPersistedThisCycle = true;
            } else if (!triggerSuppressedReason) {
                triggerSuppressedReason = 'dynamic_weight_persist_failed';
            }
        }

        if (Number.isFinite(lastClosedCandleTs) && lastClosedCandleTs > 0
                && (!hasNewClosedCandle || !MarketAdapterService.isRetryableClosedCandleFailure(triggerSuppressedReason))) {
            consumedClosedCandleTs = lastClosedCandleTs;
        }

        const preserveRetryBaseline = hasNewClosedCandle
            && MarketAdapterService.isRetryableClosedCandleFailure(triggerSuppressedReason);
        const stateAmaSlope = preserveRetryBaseline
            ? (botState.amaSlope || previousAmaSlope || null)
            : (amaSlope || botState.amaSlope || null);
        const stateAmaSlopeDeltaPercent = preserveRetryBaseline
            ? (botState.amaSlopeDeltaPercent ?? null)
            : (Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null);
        const stateAmaSlopeThresholdPercent = preserveRetryBaseline
            ? (botState.amaSlopeThresholdPercent ?? amaSlopeThresholdPercent ?? null)
            : (amaSlopeThresholdPercent ?? botState.amaSlopeThresholdPercent ?? null);
        const stateGridRangeScalingAmaSlope = preserveRetryBaseline
            ? (botState.gridRangeScalingAmaSlope || previousGridResetAmaSlope || null)
            : (botState.gridRangeScalingAmaSlope || previousGridResetAmaSlope || null);

        state.bots[bot.botKey] = {
            ...botState,
            botName: bot.name,
            botKey: bot.botKey,
            poolId: ctx.poolId,
            marketSource,
            candleFile: deps.path.relative(deps.root, filePath),
            candleCount: nextCandles.length,
            analysisCandleCount: analysisCandles.length,
            rawKeepCount,
            analysisKeepCount,
            amaWarmupBars,
            kibanaGapRepairCount,
            kibanaBackfillCount,
            unresolvedGapCount,
            nativeRecentTradeSequences,
            nativeLastTradeTs,
            nativeOverlapCount,
            nativePagesFetched,
            lastCandleTs: rawLastCandleTs,
            rawLastCandleTs,
            lastClosedCandleTs: consumedClosedCandleTs,
            lastAmaPrice: amaPrice,
            amaCenterPrice: Number(botState.amaCenterPrice || 0) > 0
                ? Number(botState.amaCenterPrice)
                : undefined,
            gridCenterPrice: acceptedGridCenterPrice > 0
                ? acceptedGridCenterPrice
                : persistedCenterPrice,
            centerPrice: acceptedGridCenterPrice > 0
                ? acceptedGridCenterPrice
                : persistedCenterPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            amaComparison,
            lastDeltaPercent: deltaPercent,
            thresholdPercent: botThreshold,
            referencePrice,
            lastCycleSource: sourceLabel,
            lastCycleAt: nowIso,
            staleData,
            staleAgeHours,
            lastTriggerFile: triggerPath || botState.lastTriggerFile || null,
            lastTriggerSuppressedReason: triggerSuppressedReason || null,
            weights,
            collateralRecommendation,
            atr,
            weightVariance,
            amaSlope: stateAmaSlope,
            gridRangeScalingAmaSlope: stateGridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: stateAmaSlopeDeltaPercent,
            amaSlopeThresholdPercent: stateAmaSlopeThresholdPercent,
            amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
            effectiveWeights:         (canApplyDynamicWeights && (snapshotPersistedThisCycle || isDryRun) && dynamicWeightsPayload?.effectiveWeights)
                ? dynamicWeightsPayload.effectiveWeights
                : (botState.effectiveWeights || null),
            dynamicWeightWhitelisted: isDynamicWeightWhitelisted,
            asymmetricBoundsWhitelisted: isAsymmetricBoundsWhitelisted,
            gridRangeScalingWhitelisted: isGridRangeScalingWhitelisted,
            dynamicWeightReady:       dynamicWeightsPayload?.isReady ?? false,
            dynamicWeightProfile:     weights?.profile || null,
            dynamicWeightApplied:     snapshotPersistedThisCycle && canApplyDynamicWeights,
            hasExplicitBaseWeights,
            pendingClosedCandle: false,
        };

        return {
            ok: true,
            dryRunMessages,
            source: sourceLabel,
            marketSource,
            intervalSeconds: cfg.intervalSeconds,
            candleCount: nextCandles.length,
            analysisCandleCount: analysisCandles.length,
            rawKeepCount,
            analysisKeepCount,
            amaWarmupBars,
            kibanaGapRepairCount,
            kibanaBackfillCount,
            unresolvedGapCount,
            nativeRecentTradeSequences,
            nativeLastTradeTs,
            nativeOverlapCount,
            nativePagesFetched,
            amaPrice,
            previousCenterPrice,
            deltaPercent,
            thresholdPercent: botThreshold,
            referencePrice,
            amaComparison,
            triggered,
            triggerPath,
            staleData,
            staleAgeHours,
            triggerCallbackError,
            triggerSuppressedReason,
            weights,
            collateralRecommendation,
            amaSlope: amaSlope || botState.amaSlope || null,
            amaSlopeDeltaPercent: Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null,
            amaSlopeThresholdPercent: amaSlopeThresholdPercent ?? botState.amaSlopeThresholdPercent ?? null,
            dynamicWeightWhitelisted: isDynamicWeightWhitelisted,
            asymmetricBoundsWhitelisted: isAsymmetricBoundsWhitelisted,
            gridRangeScalingWhitelisted: isGridRangeScalingWhitelisted,
            dynamicWeightReady: dynamicWeightsPayload?.isReady ?? false,
            dynamicWeightProfile: weights?.profile || null,
            dynamicWeightApplied: snapshotPersistedThisCycle && canApplyDynamicWeights,
            hasExplicitBaseWeights,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            lastCandleTs: rawLastCandleTs,
            rawLastCandleTs,
            lastClosedCandleTs: consumedClosedCandleTs,
            lastClosedCandleClose: Number(latestClosedCandle?.[4]),
            centerPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            atr,
            weightVariance,
            pendingClosedCandle: false,
        };
    }
}

module.exports = { MarketAdapterService };
