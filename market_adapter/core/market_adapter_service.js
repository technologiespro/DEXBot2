'use strict';

const { calculateATR } = require('./strategies/atr/calculator');
const { computeAmaSlopeWeights } = require('./strategies/ama_slope_model');
const { computeRegimeMultiplier, bilinearInterpolate } = require('./strategies/regime_gate');
const { calculateAMA } = require('../../analysis/ama_fitting/ama');
const { KalmanTrendAnalyzer } = require('../../analysis/trend_detection/kalman_trend_analyzer');
const { HurstAnalyzer } = require('../../analysis/trend_detection/hurst_analyzer');
const { PermutationEntropyAnalyzer } = require('../../analysis/trend_detection/permutation_entropy_analyzer');
const {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
} = require('../../analysis/trend_detection/kalman_velocity_smoothing');
const { HURST_CONFIG, PE_CONFIG } = require('../../analysis/trend_detection/regime_defaults');
const { adjustCollateralRatio } = require('./strategies/collateral_manager');
const { DEFAULT_CONFIG, MARKET_ADAPTER } = require('../../modules/constants');
const { resolveConfiguredPriceBound } = require('../../modules/order/utils/order');


class MarketAdapterService {
    constructor(deps = {}) {
        this.deps = deps;
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
        ].map((v) => String(v ?? '')).join('|');
    }

    buildGapRepairTimeRange(missingTimestamps, intervalSeconds) {
        const bucketMs = Number(intervalSeconds) * 1000;
        if (!Array.isArray(missingTimestamps) || missingTimestamps.length === 0) return null;
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;

        const startTs = Math.max(0, missingTimestamps[0] - bucketMs);
        const endTs = missingTimestamps[missingTimestamps.length - 1] + (bucketMs * 2) - 1;
        return {
            gte: new Date(startTs).toISOString(),
            lte: new Date(endTs).toISOString(),
        };
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

    async processBot(bot, state, cfg, contextCache, hooks = {}) {
        const deps = this.deps;
        const isDryRun = !!hooks.isDryRun;
        let dryRunMessages = [];
        
        if ((!bot.assetA && !bot.assetAId) || (!bot.assetB && !bot.assetBId)) {
            return { ok: false, reason: 'missing asset pair' };
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

        const botAma = deps.resolveAmaForBot(bot, ctx);
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }
        const filePath = deps.candleFileForBot(bot.botKey);
        const existing = deps.loadJson(filePath, null);
        const existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];

        const needBootstrap = existingCandles.length === 0;
        const keepCount = deps.requiredCandlesForAma(botAma);
        const nowIso = new Date().toISOString();
        const botThreshold = deps.calculateBotThreshold(cfg);
        if (!Number.isFinite(botThreshold) || botThreshold <= 0) {
            throw new Error(`deltaThresholdPercent missing/invalid for bot ${bot.name}`);
        }

        let nextCandles = existingCandles;
        let sourceLabel = 'native-incremental';

        if (needBootstrap) {
            const lookbackHours = Math.max(cfg.bootstrapLookbackHours, keepCount * 2);
            let kibanaCandles = null;
            try {
                kibanaCandles = await deps.withRetries(() => deps.kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, {
                    intervalSeconds: cfg.intervalSeconds,
                    lookbackHours,
                    consolidateByTimestamp: true,
                    apiKey: null,
                }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana bootstrap failed');
            } catch (_) {
                kibanaCandles = null;
            }

            if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                nextCandles = kibanaCandles;
                sourceLabel = 'kibana-bootstrap';
            } else {
                const sinceMs = Date.now() - (lookbackHours * 3600 * 1000);
                const trades = await deps.withRetries(
                    () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                    cfg.sourceRetries,
                    cfg.retryDelayMs,
                    'native bootstrap fallback failed'
                );
                nextCandles = deps.tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
                sourceLabel = 'native-bootstrap-fallback';
            }
        } else {
            const lastTs = existingCandles[existingCandles.length - 1]?.[0] || 0;
            const sinceMs = lastTs - (cfg.nativeBackfillHours * 3600 * 1000);
            const trades = await deps.withRetries(
                () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                cfg.sourceRetries,
                cfg.retryDelayMs,
                'native incremental fetch failed'
            );
            const incomingCandles = deps.tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
            nextCandles = deps.mergeCandles(existingCandles, incomingCandles);
        }

        let kibanaGapRepairTimestamps = [];
        let gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
            ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
            : { gapCount: 0, missingTimestamps: [] };

        if (gapAnalysis.gapCount > 0 && deps.kibanaSource && typeof deps.kibanaSource.getLpCandlesForPool === 'function') {
            const timeRange = this.buildGapRepairTimeRange(gapAnalysis.missingTimestamps, cfg.intervalSeconds);
            if (timeRange) {
                try {
                    const kibanaGapCandles = await deps.withRetries(() => deps.kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, {
                        intervalSeconds: cfg.intervalSeconds,
                        consolidateByTimestamp: true,
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

        nextCandles = deps.pruneCandles(nextCandles, keepCount);
        const retainedTimestamps = new Set(nextCandles.map((c) => c[0]));
        const kibanaGapRepairCount = kibanaGapRepairTimestamps.filter((ts) => retainedTimestamps.has(ts)).length;
        const retainedGapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
            ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
            : { gapCount: 0, missingTimestamps: [] };
        const unresolvedGapCount = retainedGapAnalysis.gapCount;
        
        // ------------------ MARKET ADAPTER STRATEGIES ------------------

        // 1. AMA series and closes — used for price reference and signal computation
        const closes = nextCandles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);
        const amaValues = calculateAMA(closes, botAma);

        // amaPrice is the last value of the full AMA series
        const amaPrice = amaValues.length > 0 ? amaValues[amaValues.length - 1] : null;
        const lastCandle = nextCandles[nextCandles.length - 1] || [0,0,0,0,0];

        // 2. ATR — used only for the symmetric volatility shift. The asymmetrical
        //    trend/Kalman branch stays ATR-free to match the research HTML.
        const atr = calculateATR(nextCandles, 14);
        const weightVariance = amaPrice > 0 ? (atr / amaPrice) : 0;

        // 3. Dynamic weight computation — live path uses AMA + Kalman + regime gate,
        //    with ATR applied only as a separate symmetric penalty.
        const isDynamic = typeof deps.isBotDynamicWeightWhitelisted === 'function'
            && deps.isBotDynamicWeightWhitelisted(bot.botKey);

        const lookbackBars = cfg.amaSlope?.lookbackBars ?? 72;
        const clipPercentile = cfg.clipPercentile ?? 0;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const maxS = cfg.amaSlope?.maxSlopePct ?? 3.0;
        const mo = cfg.maxSlopeOffset ?? 0.5;

        // Compute separate clip thresholds for AMA (slopes) and Kalman (velocities)
        let amaClipThreshold = Infinity;
        let kalClipThreshold = Infinity;

        if (clipPercentile > 0 && amaValues.length > lookbackBars) {
            // AMA clip threshold from slope distribution
            const amaSlopes = [];
            for (let i = lookbackBars; i < amaValues.length; i++) {
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                if (past > 0) amaSlopes.push(Math.abs((last - past) / past * 100));
            }
            if (amaSlopes.length > 0) {
                const sorted = amaSlopes.sort((a, b) => a - b);
                const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * sorted.length), sorted.length - 1);
                amaClipThreshold = sorted[idx];
            }

            // Kalman clip threshold from velocity distribution (computed after Kalman run)
        }

        const slopeCfg = {
            ...(cfg.amaSlope || {}),
            maxSlopeOffset:        cfg.maxSlopeOffset,
            volatilityExponent:    cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
            volatilityScalePct:    cfg.volatilityScalePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_PCT,
            volatilityThreshold:   cfg.volatilityThreshold
                ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD
                ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD,
            neutralZonePct:        nz,
            clipPercentile,
            clipThreshold:         amaClipThreshold,
        };

        let slopeResult = null;
        let amaSlope = null;
        let weights = null;
        let dynamicWeightsPayload = null;

        if (isDynamic) {
            // AMA slope computation (final state). The trend branch stays ATR-free;
            // symmetricDelta still uses weightVariance from the ATR/price ratio.
            slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

            // Kalman filter computation - collect per-bar results in single pass
            const kalman = new KalmanTrendAnalyzer({
                rNoise: cfg.kalman?.rNoise ?? 0.05,
                qTactical: cfg.kalman?.qTactical ?? 0.01,
                qModal: cfg.kalman?.qModal ?? 0.0001,
            });

            const kalmanHistory = [];
            for (const price of closes) {
                const kr = kalman.update(price);
                kalmanHistory.push(kr);
            }

            const kalmanResult = kalmanHistory[kalmanHistory.length - 1];

            // Regime gate (Hurst + PE bilinear multiplier)
            const regimeSensitivity = cfg.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY ?? 0;
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
                regimeMultiplier = regimeResult.isReady ? regimeResult.multiplier : 1.0;

                const hurstAnalyzer = new HurstAnalyzer(HURST_CONFIG);
                const peAnalyzer = new PermutationEntropyAnalyzer(PE_CONFIG);
                for (let i = 0; i < closes.length; i++) {
                    const h = hurstAnalyzer.update(closes[i]);
                    const pe = peAnalyzer.update(closes[i]);
                    if (!h?.isReady || !pe?.isReady) {
                        regimeMultipliers[i] = 1.0;
                        continue;
                    }
                    const baseMult = bilinearInterpolate(h.hurst, pe.normalizedEntropy, cfg.regimeTable, {
                        hurstZoneBand: cfg.hurstZoneBand,
                        peNodes: cfg.peNodes,
                    });
                    regimeMultipliers[i] = Math.min(Math.pow(baseMult, regimeSensitivity), 1.0);
                }
            }

            // Research tool parameters
            const alpha = cfg.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA ?? 0.5;
            const dw = cfg.dw ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW ?? 1.0;
            const gain = cfg.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN ?? 1.0;
            const kalmanSmoothPct = cfg.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT;
            const kalmanDispScaleMult = cfg.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT;
            const kalmanDispThresholdMult = cfg.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT;
            const kalmanSmoothSpanPct = cfg.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT;
            const signalConfirmBars = cfg.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT;
            const dispScaleMinPct  = cfg.dispScaleMinPct  ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;

            const kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanHistory, {
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
            });

            // Compute Kalman clip threshold from the research-chart filtered velocity distribution.
            kalClipThreshold = computeAbsolutePercentileThreshold(
                kalmanSmoothedVelocityPct,
                clipPercentile,
                Infinity
            );

            // Build AMA offset array — compute slopeOffset directly from AMA values per bar.
            // computeAmaSlopeWeights only reads amaValues[i] and amaValues[i-lookbackBars],
            // so there is no need to slice the full series for each bar.
            const amaErPeriod = slopeCfg.erPeriod ?? botAma.erPeriod;
            const amaOffsets = [];
            for (let i = 0; i < closes.length; i++) {
                if (!slopeResult.isReady || i < amaErPeriod + lookbackBars) {
                    amaOffsets.push(0);
                    continue;
                }
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) {
                    amaOffsets.push(0);
                    continue;
                }
                const sp  = (last - past) / past * 100;
                const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
                const offset = Math.abs(csp) < nz ? 0
                    : Math.max(-mo, Math.min(mo, (csp / maxS) * mo));
                amaOffsets.push(offset);
            }

            // Build Kalman offset array using the research-chart filtered velocity series.
            const kalmanOffsets = [];
            for (let i = 0; i < kalmanHistory.length; i++) {
                const kr = kalmanHistory[i];
                const vp = kalmanSmoothedVelocityPct[i];
                if (!kr.isReady || vp == null || kr.displacementPct == null) {
                    kalmanOffsets.push(0);
                    continue;
                }

                const dp = kr.displacementPct;
                const clippedV = Math.max(-kalClipThreshold, Math.min(kalClipThreshold, vp));

                if (Math.abs(clippedV) < nz) {
                    kalmanOffsets.push(0);
                } else {
                    const dispScale = dispScaleMinPct;
                    const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
                    const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
                    const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                    // Convert to offset: (composite / maxS) * mo, capped at mo
                    kalmanOffsets.push(Math.max(-mo, Math.min(mo, (composite / maxS) * mo)));
                }
            }

            // Pad kalmanOffsets if shorter than closes
            while (kalmanOffsets.length < closes.length) {
                kalmanOffsets.push(0);
            }

            // Normalize each channel to its peak (avoid division by zero).
            // Use a loop instead of spread to avoid call-stack overflow on large candle sets.
            let aMax = 0.001;
            for (const v of amaOffsets)   { const a = Math.abs(v); if (a > aMax) aMax = a; }
            let kMax = 0.001;
            for (const v of kalmanOffsets) { const a = Math.abs(v); if (a > kMax) kMax = a; }

            // Build the same per-bar combined output series as the research chart, then
            // optionally latch it with signalConfirmBars before taking the last live value.
            const combinedOffSeries = new Array(closes.length).fill(0);
            const offsetClamp = MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
            for (let i = 0; i < closes.length; i++) {
                const rawOff = (alpha * (amaOffsets[i] / aMax) + (1 - alpha) * (kalmanOffsets[i] / kMax)) * gain;
                const off = Math.max(-offsetClamp, Math.min(offsetClamp, rawOff * regimeMultipliers[i]));
                combinedOffSeries[i] = Math.round(off * 1000) / 1000;
            }

            const confirmBars = Math.max(0, Math.min(5, Math.round(signalConfirmBars)));
            const echoedOffSeries = new Array(closes.length).fill(0);
            if (confirmBars === 0) {
                for (let i = 0; i < closes.length; i++) echoedOffSeries[i] = combinedOffSeries[i];
            } else {
                let latchedSign = 0;
                let pendingSign = 0;
                let pendingCount = 0;
                let latchedOff = 0;
                for (let i = 0; i < closes.length; i++) {
                    const raw = combinedOffSeries[i];
                    const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
                    if (sign === 0) {
                        echoedOffSeries[i] = latchedOff;
                        continue;
                    }
                    if (latchedSign === 0) {
                        latchedSign = sign;
                        pendingSign = 0;
                        pendingCount = 0;
                        latchedOff = raw;
                    } else if (sign === latchedSign) {
                        pendingSign = 0;
                        pendingCount = 0;
                        latchedOff = raw;
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
                        }
                    }
                    echoedOffSeries[i] = latchedOff;
                }
            }

            const rawFinalOff = combinedOffSeries[combinedOffSeries.length - 1] ?? 0;
            const finalOff = echoedOffSeries[echoedOffSeries.length - 1] ?? rawFinalOff;

            // Store for metadata.
            // amaSlopeGated is the raw AMA slope component after regime gating — a diagnostic
            // value for the AMA signal alone. The actual weight offset applied is finalOff (below),
            // which is the normalized blend of AMA + Kalman × gain × regimeMultiplier.
            const amaSlopeGated = slopeResult.isReady ? slopeResult.slopeOffset * regimeMultiplier : 0;

            amaSlope = {
                trend:          slopeResult.trend,
                confidence:     slopeResult.confidence,
                slopePct:       slopeResult.slopePct,
                slopeOffset:    slopeResult.slopeOffset,
                amaSlopeGated,
                regimeMultiplier,
                symmetricDelta: slopeResult.symmetricDelta,
                weightVariance,
                isReady:        slopeResult.isReady,
                kalmanReady:    kalmanResult?.isReady ?? false,
                alpha,
                dw,
                gain,
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
                signalConfirmBars,
            };

            // Apply to bot weights. Dynamic weight requires explicit bot midpoint settings.
            const staticSell = bot.weightDistribution?.sell;
            const staticBuy  = bot.weightDistribution?.buy;
            if (!Number.isFinite(staticSell) || !Number.isFinite(staticBuy)) {
                throw new Error('Dynamic weight requires bot weightDistribution.sell and buy settings.');
            }

            const MIN_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
            const MAX_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

            // Min-output threshold: if |finalOff| is below threshold, the trend component is
            // suppressed. The volatility penalty (symmetricDelta) is always applied independently.
            const minOutputThreshold = cfg.minOutputThreshold
                ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD
                ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_TREND_THRESHOLD
                ?? 0.25;
            const belowMinOutputThreshold = Math.abs(finalOff) < minOutputThreshold;

            // Volatility penalty is the separate symmetric ATR shift. It is independent of
            // the trend gate so volatile markets reduce both sides even when trend is flat.
            const volPenalty = slopeResult.isReady ? (slopeResult.symmetricDelta ?? 0) : 0;
            const trendOff   = belowMinOutputThreshold ? 0 : finalOff;

            const effectiveSell = Math.round(clamp(staticSell + trendOff + volPenalty, MIN_W, MAX_W) * 100) / 100;
            const effectiveBuy  = Math.round(clamp(staticBuy  - trendOff + volPenalty, MIN_W, MAX_W) * 100) / 100;

            weights = {
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
                    amaSlopeGated,
                    regimeMultiplier,
                    volatilityPenalty:       volPenalty,
                    alpha,
                    dw,
                    gain,
                    kalmanSmoothPct,
                    kalmanDispScaleMult,
                    kalmanDispThresholdMult,
                    kalmanSmoothSpanPct,
                    signalConfirmBars,
                    rawFinalOffset:          rawFinalOff,
                    trendOffset:             trendOff,
                    finalOffset:             finalOff,
                    minOutputThreshold,
                    belowMinOutputThreshold,
                    kalmanReady:             kalmanResult?.isReady ?? false,
                    isReady:                 slopeResult.isReady,
                },
            };

            // Payload written to dynamicgrid.json — bot reads this at grid reset.
            // When belowMinOutputThreshold, effectiveWeights equal baseWeights so the bot
            // applies no dynamic offset and isReady is set to false to prevent stale application.
            dynamicWeightsPayload = {
                effectiveWeights: { sell: effectiveSell, buy: effectiveBuy },
                baseWeights:      { sell: staticSell,    buy: staticBuy },
                slopeOffset:      slopeResult.slopeOffset,
                amaSlopeGated,
                volatilityPenalty: volPenalty,
                finalOffset:      finalOff,
                alpha,
                dw,
                gain,
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
                signalConfirmBars,
                rawFinalOffset:      rawFinalOff,
                trend:                   slopeResult.trend,
                confidence:              slopeResult.confidence,
                slopePct:                slopeResult.slopePct,
                regimeMultiplier,
                minOutputThreshold,
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
        }

        // 4. Collateral Strategy — uses derived confidence (proportional to slope magnitude)
        const collateral = isDynamic ? adjustCollateralRatio(slopeResult, 1.5, 2.0) : null;

        const amaComparison = deps.calcAmaComparison(nextCandles, bot, ctx);
        const lastCandleTs = lastCandle[0] || null;
        const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastCandleTs, cfg.maxStaleHours);

        const referencePrice = amaPrice;
        const clampedCenterPrice = this.clampGridPriceToBounds(referencePrice, referencePrice, bot);
        const centerPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0
            ? clampedCenterPrice
            : referencePrice;

        const botState = { ...(state.bots[bot.botKey] || {}) };
        delete botState.gridPriceOffsetPct;
        delete botState.gridPriceOffsetClampToBounds;
        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;

        if (!staleData && Number.isFinite(referencePrice) && referencePrice > 0) {
            const previousCenterPrice = Number(botState.centerPrice || 0);

            if (!Number.isFinite(previousCenterPrice) || previousCenterPrice <= 0) {
                const bootstrapCenterPrice = Number.isFinite(centerPrice) && centerPrice > 0
                    ? centerPrice
                    : referencePrice;
                let amaCenterPersisted = true;
                if (!isDryRun && typeof deps.writeBotDynamicGrid === 'function') {
                    amaCenterPersisted = deps.writeBotDynamicGrid(bot.botKey, bootstrapCenterPrice, {
                        amaCenterPrice: amaPrice,
                        dynamicWeights: dynamicWeightsPayload,
                    }) !== false;
                } else if (isDryRun) {
                    dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${bootstrapCenterPrice}`);
                }

                if (amaCenterPersisted) {
                    botState.centerPrice = bootstrapCenterPrice;
                    botState.amaCenterPrice = amaPrice;
                    botState.lastGridResetAt = nowIso;
                } else {
                    triggerSuppressedReason = 'ama_center_persist_failed';
                }
            } else {
                deltaPercent = Math.abs((centerPrice - previousCenterPrice) / previousCenterPrice) * 100;
                if (deltaPercent >= botThreshold) {
                    let amaCenterPersisted = true;

                    if (!isDryRun && typeof deps.writeBotDynamicGrid === 'function') {
                        amaCenterPersisted = deps.writeBotDynamicGrid(bot.botKey, centerPrice, {
                            amaCenterPrice: amaPrice,
                            previousCenterPrice,
                            dynamicWeights: dynamicWeightsPayload,
                        }) !== false;
                    } else if (isDryRun) {
                        dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${centerPrice}`);
                    }

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        if (!isDryRun) {
                            triggerPath = deps.writeGridResetTrigger(bot, {
                                reason: 'price_adapter_delta_threshold',
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice,
                                newCenterPrice: centerPrice,
                                referencePrice,
                                rawAmaPrice: amaPrice,
                                poolId: ctx.poolId,
                            });
                        } else {
                            dryRunMessages.push(`[DRY RUN] Would write grid reset trigger for ${bot.botKey}`);
                        }
                        botState.centerPrice = centerPrice;
                        botState.amaCenterPrice = amaPrice;
                        botState.lastGridResetAt = nowIso;
                        botState.triggerCount = Number(botState.triggerCount || 0) + 1;
                        // Grid reset always carries fresh weights — sync the weight state
                        if (dynamicWeightsPayload) {
                            botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
                        }
                        triggered = true;

                        if (typeof hooks.onTrigger === 'function') {
                            try {
                                await hooks.onTrigger({
                                    bot,
                                    botKey: bot.botKey,
                                    botName: bot.name,
                                    poolId: ctx.poolId,
                                    thresholdPercent: botThreshold,
                                    deltaPercent,
                                    previousCenterPrice,
                                    newCenterPrice: centerPrice,
                                    referencePrice,
                                    rawAmaPrice: amaPrice,
                                    triggerPath,
                                });
                            } catch (err) {
                                triggerCallbackError = err.message;
                            }
                        }
                    }
                }
            }
        }

        const candlePayload = {
            meta: {
                updatedAt: nowIso,
                source: sourceLabel,
                pool: ctx.poolId,
                assetA: ctx.assetA,
                assetB: ctx.assetB,
                intervalSeconds: cfg.intervalSeconds,
                candleCount: nextCandles.length,
                kibanaGapRepairCount,
                unresolvedGapCount,
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles: nextCandles,
        };
        deps.saveJson(filePath, candlePayload);

        const persistedCenterPrice = Number(botState.centerPrice || 0) > 0
            ? Number(botState.centerPrice)
            : undefined;

        // Weight-only update path: persist fresh weights to dynamicgrid.json without a grid reset.
        // The bot will pick these up on the next recalculation cycle after fills or config reload.
        if (isDynamic && !triggered && !isDryRun && dynamicWeightsPayload && persistedCenterPrice > 0
                && typeof deps.writeBotDynamicGrid === 'function') {
            deps.writeBotDynamicGrid(bot.botKey, persistedCenterPrice, {
                amaCenterPrice: amaPrice,
                dynamicWeights: dynamicWeightsPayload,
            });
            botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
        }

        state.bots[bot.botKey] = {
            ...botState,
            botName: bot.name,
            botKey: bot.botKey,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            candleCount: nextCandles.length,
            kibanaGapRepairCount,
            unresolvedGapCount,
            lastCandleTs,
            lastAmaPrice: amaPrice,
            amaCenterPrice: amaPrice,
            centerPrice: persistedCenterPrice,
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
            lastTriggerSuppressedReason: triggerSuppressedReason,
            weights,
            collateral,
            atr,
            weightVariance,
            amaSlope,
            effectiveWeights:         botState.effectiveWeights || null,
        };

        return {
            ok: true,
            dryRunMessages,
            source: sourceLabel,
            candleCount: nextCandles.length,
            kibanaGapRepairCount,
            unresolvedGapCount,
            amaPrice,
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
            collateral,
            amaSlope,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            lastCandleTs,
            centerPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            atr,
            weightVariance,
        };
    }
}

module.exports = { MarketAdapterService };
