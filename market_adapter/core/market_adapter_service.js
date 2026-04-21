'use strict';

const { calculateATR } = require('./strategies/atr/calculator');
const { computeAmaSlopeWeights } = require('./strategies/ama_slope_model');
const {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} = require('./config_normalizers');
const { computeRegimeMultiplier } = require('./strategies/regime_gate');
const { calculateAMA, getAmaWarmupBars } = require('../../analysis/ama_fitting/ama');
const { KalmanTrendAnalyzer } = require('../../analysis/trend_detection/kalman_trend_analyzer');
const {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
} = require('../../analysis/trend_detection/kalman_velocity_smoothing');
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
        const amaErPeriod = cfg.amaSlope?.erPeriod ?? botAma.erPeriod;
        const amaSlowPeriod = cfg.amaSlope?.slowPeriod ?? botAma.slowPeriod;
        const lookbackBars = cfg.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
        const filePath = deps.candleFileForBot(bot.botKey);
        const existing = deps.loadJson(filePath, null);
        const existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];

        const needBootstrap = existingCandles.length === 0;
        const keepCount = Math.max(
            deps.requiredCandlesForAma(botAma),
            getAmaWarmupBars(amaErPeriod, amaSlowPeriod, lookbackBars) + 1
        );
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
        const atrPeriod = normalizeAtrPeriod(cfg.atrPeriod);
        const atr = calculateATR(nextCandles, atrPeriod);
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
        const isDynamic = typeof deps.isBotDynamicWeightWhitelisted === 'function'
            && deps.isBotDynamicWeightWhitelisted(bot.botKey);

        const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const amaMaxS = cfg.amaSlope?.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
        const kalMaxS = cfg.kalmanSlope?.maxSlopePct
            ?? cfg.kalmanMaxSlopePct
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
        const mo = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
        const amaWarmupBars = getAmaWarmupBars(amaErPeriod, amaSlowPeriod, lookbackBars);

        // Compute separate clip thresholds for AMA (slopes) and Kalman (velocities)
        let amaClipThreshold = Infinity;
        let kalClipThreshold = Infinity;

        if (clipPercentile > 0 && amaValues.length > amaWarmupBars) {
            // AMA clip threshold from slope distribution — skip initialization period
            const amaSlopes = [];
            for (let i = amaWarmupBars; i < amaValues.length; i++) {
                const last = amaValues[i];
                const past = amaValues[i - lookbackBars];
                if (past > 0) amaSlopes.push(Math.abs((last - past) / past * 100));
            }
            if (amaSlopes.length > 0) {
                const sorted = amaSlopes.sort((a, b) => a - b);
                const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * sorted.length), sorted.length - 1);
                amaClipThreshold = sorted[idx];
            }
        }

        const slopeCfg = {
            ...(cfg.amaSlope || {}),
            erPeriod:              amaErPeriod,
            slowPeriod:            amaSlowPeriod,
            maxSlopeOffset:        cfg.maxSlopeOffset,
            maxVolatilityOffset:   volatilityClamp,
            volatilityExponent:    cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
            volatilityScaleX:      cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
            volatilityThreshold:   normalizeVolatilityThreshold(cfg.volatilityThreshold),
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

            // Research tool parameters
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

            const kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanHistory, {
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
            });

            // Compute Kalman clip threshold from the research-chart filtered velocity distribution.
            // Skip the analyzer warm-up period so the percentile is not contaminated by startup noise.
            kalClipThreshold = computeAbsolutePercentileThreshold(
                kalmanSmoothedVelocityPct.slice(kalmanWarmupBars),
                clipPercentile,
                Infinity
            );

            // Build AMA offset array — compute slopeOffset directly from AMA values per bar.
            // computeAmaSlopeWeights only reads amaValues[i] and amaValues[i-lookbackBars],
            // so there is no need to slice the full series for each bar.
            const amaOffsets = [];
            for (let i = 0; i < closes.length; i++) {
                if (!slopeResult.isReady || i < amaWarmupBars) {
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
                    : Math.max(-mo, Math.min(mo, (csp / amaMaxS) * mo));
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
                    const dispScale = Math.max(1.0, dispScaleMinPct);
                    const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
                    const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
                    const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                    // Convert to offset: (composite / kalMaxS) * mo, capped at mo
                    kalmanOffsets.push(Math.max(-mo, Math.min(mo, (composite / kalMaxS) * mo)));
                }
            }

            // Pad kalmanOffsets if shorter than closes
            while (kalmanOffsets.length < closes.length) {
                kalmanOffsets.push(0);
            }

            // Parity rule with the research chart:
            // 1. Normalize AMA/Kalman rails by the runtime clamp so alpha only changes the blend ratio.
            // 2. Decide regime/dead-band in pre-gain space so gain cannot reshape the signal.
            // 3. Apply gain as the final scale factor, then clamp to the runtime offset cap.
            const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
            const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
            const outputThreshold = minOutputThreshold;

            // Build the same per-bar combined output series as the research chart, then
            // optionally latch it with signalConfirmBars before taking the last live value.
            const combinedOffSeries = new Array(closes.length).fill(0);
            const gatedOffSeries = new Array(closes.length).fill(0);
            for (let i = 0; i < closes.length; i++) {
                const blendedOff = (alpha * (amaOffsets[i] / channelNorm) + (1 - alpha) * (kalmanOffsets[i] / channelNorm));
                const gatedOff = Math.abs(blendedOff * regimeMultipliers[i]) < outputThreshold ? 0 : (blendedOff * regimeMultipliers[i]);
                const off = Math.max(-offsetClamp, Math.min(offsetClamp, gatedOff * gain));
                gatedOffSeries[i] = gatedOff;
                combinedOffSeries[i] = Math.round(off * 1000) / 1000;
            }

            const confirmBars = Math.max(0, Math.min(5, Math.round(signalConfirmBars)));
            const echoedOffSeries = new Array(closes.length).fill(0);
            const echoedGatedOffSeries = new Array(closes.length).fill(0);
            if (confirmBars === 0) {
                for (let i = 0; i < closes.length; i++) {
                    echoedOffSeries[i] = combinedOffSeries[i];
                    echoedGatedOffSeries[i] = gatedOffSeries[i];
                }
            } else {
                let latchedSign = 0;
                let pendingSign = 0;
                let pendingCount = 0;
                let latchedOff = 0;
                let latchedGatedOff = 0;
                for (let i = 0; i < closes.length; i++) {
                    const raw = combinedOffSeries[i];
                    const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
                    if (sign === 0) {
                        echoedOffSeries[i] = latchedOff;
                        echoedGatedOffSeries[i] = latchedGatedOff;
                        continue;
                    }
                    if (latchedSign === 0) {
                        latchedSign = sign;
                        pendingSign = 0;
                        pendingCount = 0;
                        latchedOff = raw;
                        latchedGatedOff = gatedOffSeries[i];
                    } else if (sign === latchedSign) {
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

            // Store for metadata.
            // amaSlopeGated tracks the AMA channel contribution after the live normalization
            // and regime gate, so the diagnostic aligns with the actual signal path.
            const lastAmaOffset = amaOffsets[amaOffsets.length - 1] ?? 0;
            const amaSlopeGated = slopeResult.isReady
                ? Math.round((alpha * (lastAmaOffset / channelNorm) * gain * regimeMultiplier) * 1000) / 1000
                : 0;

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
                atrPeriod,
                maxSlopeOffset: mo,
                amaMaxSlopePct: amaMaxS,
                kalmanMaxSlopePct: kalMaxS,
                maxVolatilityOffset: volatilityClamp,
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
                signalConfirmBars,
            };

            // Apply to bot weights. Dynamic weight requires explicit bot midpoint settings.
            const staticSell = Number.isFinite(bot.weightDistribution?.sell)
                ? bot.weightDistribution.sell
                : DEFAULT_CONFIG.weightDistribution.sell;
            const staticBuy = Number.isFinite(bot.weightDistribution?.buy)
                ? bot.weightDistribution.buy
                : DEFAULT_CONFIG.weightDistribution.buy;
            if (!Number.isFinite(bot.weightDistribution?.sell) || !Number.isFinite(bot.weightDistribution?.buy)) {
                warn(`[market_adapter] ${bot.botKey} is missing weightDistribution; falling back to DEFAULT_CONFIG.weightDistribution.`);
            }

            const MIN_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
            const MAX_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

            // Min-output threshold: evaluate the same confirmed pre-gain state that drives
            // the latched live output so signalConfirmBars affects gating and application consistently.
            const belowMinOutputThreshold = Math.abs(finalPreGainOff) < outputThreshold;

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
                    atrPeriod,
                    maxSlopeOffset: mo,
                    amaMaxSlopePct: amaMaxS,
                    kalmanMaxSlopePct: kalMaxS,
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
                atrPeriod,
                maxSlopeOffset: mo,
                amaMaxSlopePct: amaMaxS,
                kalmanMaxSlopePct: kalMaxS,
                maxVolatilityOffset: volatilityClamp,
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
                signalConfirmBars,
                rawFinalOffset:      rawFinalOff,
                amaChannelContribution: amaSlopeGated,
                trend:                   slopeResult.trend,
                confidence:              slopeResult.confidence,
                slopePct:                slopeResult.slopePct,
                regimeMultiplier,
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
        if (isDynamic && !triggered && !isDryRun && !staleData && dynamicWeightsPayload && persistedCenterPrice > 0
                && typeof deps.writeBotDynamicGrid === 'function') {
            const dynamicWeightsPersisted = deps.writeBotDynamicGrid(bot.botKey, persistedCenterPrice, {
                amaCenterPrice: amaPrice,
                dynamicWeights: dynamicWeightsPayload,
            }) !== false;
            if (dynamicWeightsPersisted) {
                botState.amaCenterPrice = amaPrice;
                botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
            } else if (!triggerSuppressedReason) {
                triggerSuppressedReason = 'dynamic_weight_persist_failed';
            }
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
            amaCenterPrice: Number(botState.amaCenterPrice || 0) > 0
                ? Number(botState.amaCenterPrice)
                : undefined,
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
