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

    static isRetryableClosedCandleFailure(reason) {
        return reason === 'ama_center_persist_failed' || reason === 'dynamic_weight_persist_failed';
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
        const forceWhitelistAll = !!hooks.forceWhitelistAll;
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

        const botAma = deps.resolveAmaForBot(bot, ctx, cfg);
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }
        const lookbackBars = cfg.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
        const filePath = deps.candleFileForBot(bot.botKey, cfg.intervalSeconds);
        const existing = deps.loadJson(filePath, null);
        let existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];

        // Prune stale trailing candles from a previous run before any processing.
        // Prevents gap-fill from carrying a frozen price forward indefinitely.
        if (existingCandles.length > 0 && typeof deps.pruneStaleTail === 'function') {
            const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                ? cfg.staleTailThreshold
                : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
            const pruned = deps.pruneStaleTail(existingCandles, staleThreshold);
            if (pruned.length < existingCandles.length) {
                existingCandles = pruned;
            }
        }

        const needBootstrap = existingCandles.length === 0;
        const analysisKeepCount = Math.max(
            deps.requiredCandlesForAma(botAma),
            getAmaWarmupBars(botAma.erPeriod, botAma.slowPeriod, lookbackBars) + 1
        );
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

            if (needBootstrap) {
                const lookbackHours = Math.max(cfg.bootstrapLookbackHours, analysisKeepCount * 2);
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
                    kibanaBootstrapEmpty = true;
                    const sinceMs = Date.now() - (lookbackHours * 3600 * 1000);
                    const trades = await deps.withRetries(
                        () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                        cfg.sourceRetries,
                        cfg.retryDelayMs,
                        'native bootstrap failed'
                    );
                    nextCandles = deps.tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
                    // Fill internal gaps within the fetched bootstrap range so AMA has a continuous series.
                    if (nextCandles.length > 0 && typeof deps.fillCandleGaps === 'function') {
                        const earliestTs = nextCandles[0][0];
                        const latestTs = nextCandles[nextCandles.length - 1][0];
                        nextCandles = deps.fillCandleGaps(nextCandles, cfg.intervalSeconds, earliestTs, latestTs);
                    }
                    sourceLabel = 'native-bootstrap';
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

                // Only auto-fill small gaps from native incremental fetch. Large gaps usually
                // mean fetchNativeTradesSince exhausted maxPages before reaching the prior tail,
                // so we leave them visible for Kibana repair instead of carrying stale prices.
                const bucketMs = Number(cfg.intervalSeconds) * 1000;
                const earliestIncomingTs = incomingCandles.length > 0 ? incomingCandles[0][0] : null;
                const gapBuckets = Number.isFinite(earliestIncomingTs) && earliestIncomingTs > lastTs
                    ? Math.round((earliestIncomingTs - lastTs) / bucketMs) - 1
                    : 0;
                const maxNativeGapFill = Number.isFinite(cfg.maxNativeGapFillCandles) ? cfg.maxNativeGapFillCandles : 3;
                if (gapBuckets <= maxNativeGapFill) {
                    nextCandles = this.fillNativeIncrementalClosedGaps(nextCandles, lastTs, cfg.intervalSeconds);
                }

                // After incremental merge, prune any stale tail that may have been
                // carried forward when the pool had no activity.
                if (typeof deps.pruneStaleTail === 'function') {
                    const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                        ? cfg.staleTailThreshold
                        : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                    nextCandles = deps.pruneStaleTail(nextCandles, staleThreshold);
                }
            }

            let kibanaGapRepairTimestamps = [];
            let kibanaGapRepairAttempted = false;
            let gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                ? deps.detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
                : { gapCount: 0, missingTimestamps: [] };

            if (gapAnalysis.gapCount > 0 && deps.kibanaSource && typeof deps.kibanaSource.getLpCandlesForPool === 'function') {
                const timeRange = this.buildGapRepairTimeRange(gapAnalysis.missingTimestamps, cfg.intervalSeconds, cfg.nativeBackfillHours);
                if (timeRange) {
                    kibanaGapRepairAttempted = true;
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

            // ── Historical backfill: if candle count is still insufficient for AMA warmup,
            //    fetch older history from Kibana using a targeted timeRange. This handles
            //    cases where native bootstrap fell short or the file was truncated.
            const candleShortfall = rawKeepCount - nextCandles.length;
            let kibanaBackfillCount = 0;
            if (!kibanaBootstrapEmpty && !kibanaGapRepairAttempted && candleShortfall > 0 && nextCandles.length > 0 && deps.kibanaSource && typeof deps.kibanaSource.getLpCandlesForPool === 'function') {
                const oldestTs = nextCandles[0][0];
                const shortfallMs = candleShortfall * cfg.intervalSeconds * 1000;
                const bufferMs = 24 * 3600 * 1000; // 24h buffer
                const backfillStartMs = Math.max(0, oldestTs - shortfallMs - bufferMs);
                const backfillEndMs = oldestTs + cfg.intervalSeconds * 1000;
                try {
                    const historicalCandles = await deps.withRetries(() => deps.kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, {
                        intervalSeconds: cfg.intervalSeconds,
                        consolidateByTimestamp: true,
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

        const loadResult = await loadCandles();
        nextCandles = loadResult.nextCandles;
        sourceLabel = loadResult.sourceLabel;
        kibanaGapRepairCount = loadResult.kibanaGapRepairCount;
        kibanaBackfillCount = loadResult.kibanaBackfillCount || 0;
        unresolvedGapCount = loadResult.unresolvedGapCount;

        const nowMs = this.getNowMs();
        ({ closedCandles, currentBucketStartMs } = this.selectClosedCandles(nextCandles, cfg.intervalSeconds, nowMs));
        rawLastCandle = nextCandles[nextCandles.length - 1] || [0, 0, 0, 0, 0];
        rawLastCandleTs = rawLastCandle[0] || null;
        latestClosedCandle = closedCandles[closedCandles.length - 1] || null;
        lastClosedCandleTs = latestClosedCandle ? latestClosedCandle[0] : null;
        botState = { ...(state.bots[bot.botKey] || {}) };
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
                assetA: ctx.assetA,
                assetB: ctx.assetB,
                intervalSeconds: cfg.intervalSeconds,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                currentBucketStartMs,
                lastClosedCandleTs,
                rawLastCandleTs,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
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
                candleFile: deps.path.relative(deps.root, filePath),
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
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
            return {
                ok: true,
                dryRunMessages,
                source: sourceLabel,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                amaPrice: null,
                deltaPercent: null,
                thresholdPercent: botThreshold,
                referencePrice: null,
                amaComparison: [],
                triggered: false,
                triggerPath: null,
                staleData,
                staleAgeHours,
                triggerCallbackError: null,
                triggerSuppressedReason,
                weights: null,
                collateralRecommendation: null,
                amaSlope: null,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                centerPrice: null,
                amaConfig: {
                    erPeriod: botAma.erPeriod,
                    fastPeriod: botAma.fastPeriod,
                    slowPeriod: botAma.slowPeriod,
                },
                atr: null,
                weightVariance: null,
                pendingClosedCandle,
            };
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
        const amaWarmupBars = getAmaWarmupBars(botAma.erPeriod, botAma.slowPeriod, lookbackBars);
        if (closes.length < amaWarmupBars) {
            const triggerSuppressedReason = 'ama_warmup_insufficient';
            const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastClosedCandleTs, cfg.maxStaleHours);
            state.bots[bot.botKey] = {
                ...botState,
                botName: bot.name,
                botKey: bot.botKey,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
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
            return {
                ok: true,
                dryRunMessages,
                source: sourceLabel,
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                amaPrice: null,
                deltaPercent: null,
                thresholdPercent: botThreshold,
                referencePrice: null,
                amaComparison: [],
                triggered: false,
                triggerPath: null,
                staleData,
                staleAgeHours,
                triggerCallbackError: null,
                triggerSuppressedReason,
                weights: null,
                collateralRecommendation: null,
                amaSlope: null,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                lastCandleTs: rawLastCandleTs,
                rawLastCandleTs,
                lastClosedCandleTs: consumedClosedCandleTs,
                centerPrice: null,
                amaConfig: {
                    erPeriod: botAma.erPeriod,
                    fastPeriod: botAma.fastPeriod,
                    slowPeriod: botAma.slowPeriod,
                },
                atr: null,
                weightVariance: null,
                pendingClosedCandle: false,
            };
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
        const hasExplicitBaseWeights = Number.isFinite(bot.weightDistribution?.sell)
            && Number.isFinite(bot.weightDistribution?.buy);
        if (isDynamicWeightWhitelisted && !hasExplicitBaseWeights) {
            warn(`[market_adapter] ${bot.botKey} is missing explicit weightDistribution; skipping dynamic volatility weights for this cycle.`);
        }
        const isDynamic = isDynamicWeightWhitelisted && hasExplicitBaseWeights;

        const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const amaMaxS = cfg.amaSlope?.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
        const kalMaxS = cfg.kalmanSlope?.maxSlopePct
            ?? cfg.kalmanMaxSlopePct
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
        const mo = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);

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
            erPeriod:              botAma.erPeriod,
            slowPeriod:            botAma.slowPeriod,
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

                // Compute Kalman clip threshold from the research-chart filtered velocity distribution.
                // Skip the analyzer warm-up period so the percentile is not contaminated by startup noise.
                kalClipThreshold = useClipThreshold
                    ? computeAbsolutePercentileThreshold(
                        kalmanSmoothedVelocityPct.slice(kalmanWarmupBars),
                        clipPercentile,
                        Infinity
                    )
                    : Infinity;

                // Build Kalman offset array using the research-chart filtered velocity series.
                for (let i = 0; i < kalmanHistory.length; i++) {
                    const kr = kalmanHistory[i];
                    const vp = kalmanSmoothedVelocityPct[i];
                    // kr.displacementRawPct provides higher precision than the rounded displacementPct
                    if (!kr.isReady || vp == null || kr.displacementRawPct == null) {
                        continue;
                    }

                    const dp = kr.displacementRawPct;
                    const clippedV = Math.max(-kalClipThreshold, Math.min(kalClipThreshold, vp));

                    if (useNeutralZone && Math.abs(clippedV) < nz) {
                        continue;
                    }

                    const dispScale = Math.max(1e-6, dispScaleMinPct);
                    const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
                    const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
                    const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                    // Convert to offset: (composite / kalMaxS) * mo, capped at mo
                    kalmanOffsets[i] = Math.max(-mo, Math.min(mo, (composite / kalMaxS) * mo));
                }
            }

            if (useAmaBlend) {
                // Build AMA offset array — compute slopeOffset directly from AMA values per bar.
                // computeAmaSlopeWeights only reads amaValues[i] and amaValues[i-lookbackBars],
                // so there is no need to slice the full series for each bar.
                for (let i = 0; i < closes.length; i++) {
                    if (!slopeResult.isReady || i < amaWarmupBars) {
                        continue;
                    }
                    const last = amaValues[i];
                    const past = amaValues[i - lookbackBars];
                    if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) {
                        continue;
                    }
                    const sp  = (last - past) / past * 100;
                    const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
                    amaOffsets[i] = (!useNeutralZone || Math.abs(csp) >= nz)
                        ? Math.max(-mo, Math.min(mo, (csp / amaMaxS) * mo))
                        : 0;
                }
            }

            // Parity rule with the research chart:
            // 1. Normalize AMA/Kalman rails by the runtime clamp so alpha only changes the blend ratio.
            // 2. Decide regime/dead-band in pre-gain space so gain cannot reshape the signal.
            // 3. Apply gain as the final scale factor, then clamp to the runtime offset cap.
            const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
            const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
            const outputThreshold = minOutputThreshold;
            const outputThresholdIsZero = zeroOutputThreshold;

            // Build the same per-bar combined output series as the research chart, then
            // optionally latch it with signalConfirmBars before taking the last live value.
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
                    if (sign === 0) {
                        echoedOffSeries[i] = latchedOff;
                        echoedGatedOffSeries[i] = latchedGatedOff;
                        continue;
                    }
                    if (latchedSign === 0) {
                        // For the initial latch, we also require consistency over confirmBars.
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
            const lastAmaOffset = useAmaBlend ? (amaOffsets[amaOffsets.length - 1] ?? 0) : 0;
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
            const staticSell = bot.weightDistribution.sell;
            const staticBuy = bot.weightDistribution.buy;

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

            // Payload written to dynamicgrid.json — bot re-reads this before every rebalance
            // (fill processing, spread correction, divergence correction, etc.) so new orders
            // always use the latest live weights. When belowMinOutputThreshold, effectiveWeights
            // equal baseWeights so the bot applies no dynamic offset and isReady is set to false
            // to prevent stale application.
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

        // 4. Advisory collateral-ratio hint only; execution is owned by the debt runtime.
        const collateralRecommendation = isDynamic ? adjustCollateralRatio(slopeResult, 1.5, 2.0) : null;

        const amaComparison = deps.calcAmaComparison(analysisCandles, bot, ctx);
        const closedCandleTs = lastCandle[0] || null;
        const { staleData, staleAgeHours } = deps.computeCandleStaleness(closedCandleTs, cfg.maxStaleHours);

        const referencePrice = amaPrice;
        const clampedCenterPrice = this.clampGridPriceToBounds(referencePrice, referencePrice, bot);
        const centerPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0
            ? clampedCenterPrice
            : referencePrice;

        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;
        let snapshotPersistedThisCycle = false;
        const previousCenterPrice = Number(botState.centerPrice || 0);

        if (!staleData && Number.isFinite(referencePrice) && referencePrice > 0) {
            if (!Number.isFinite(previousCenterPrice) || previousCenterPrice <= 0) {
                const bootstrapCenterPrice = Number.isFinite(centerPrice) && centerPrice > 0
                    ? centerPrice
                    : referencePrice;
                let amaCenterPersisted = true;
                if (!isDryRun && typeof deps.writeBotDynamicGrid === 'function') {
                    amaCenterPersisted = deps.writeBotDynamicGrid(bot.botKey, bootstrapCenterPrice, {
                        amaCenterPrice: amaPrice,
                        ...(isDynamicWeightWhitelisted && dynamicWeightsPayload
                            ? { dynamicWeights: dynamicWeightsPayload }
                            : {}),
                    }) !== false;
                } else if (isDryRun) {
                    dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${bootstrapCenterPrice}`);
                }

                if (amaCenterPersisted) {
                    botState.centerPrice = bootstrapCenterPrice;
                    botState.amaCenterPrice = amaPrice;
                    botState.lastGridResetAt = nowIso;
                    snapshotPersistedThisCycle = true;
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
                            ...(isDynamicWeightWhitelisted && dynamicWeightsPayload
                                ? { dynamicWeights: dynamicWeightsPayload }
                                : {}),
                        }) !== false;
                    } else if (isDryRun) {
                        dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${centerPrice}`);
                    }

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        snapshotPersistedThisCycle = true;
                        if (!isDryRun) {
                            triggerPath = deps.writeGridResetTrigger(bot, {
                                reason: 'market_adapter_delta_threshold',
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
                        // Grid reset only syncs live weights when the dynamic-weight whitelist permits it.
                        if (isDynamicWeightWhitelisted && dynamicWeightsPayload) {
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

        const persistedCenterPrice = Number(botState.centerPrice || 0) > 0
            ? Number(botState.centerPrice)
            : undefined;

        // Weight-only update path: persist fresh weights to dynamicgrid.json without a grid reset.
        // The bot will pick these up on the next recalculation cycle after fills or config reload.
        if (!snapshotPersistedThisCycle && !triggered && !isDryRun && !staleData && isDynamicWeightWhitelisted
                && dynamicWeightsPayload && persistedCenterPrice > 0
                && typeof deps.writeBotDynamicGrid === 'function') {
            const dynamicWeightsPersisted = deps.writeBotDynamicGrid(bot.botKey, persistedCenterPrice, {
                amaCenterPrice: amaPrice,
                dynamicWeights: dynamicWeightsPayload,
            }) !== false;
            if (dynamicWeightsPersisted) {
                botState.amaCenterPrice = amaPrice;
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

        state.bots[bot.botKey] = {
            ...botState,
            botName: bot.name,
            botKey: bot.botKey,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            candleCount: nextCandles.length,
            analysisCandleCount: analysisCandles.length,
            kibanaGapRepairCount,
            kibanaBackfillCount,
            unresolvedGapCount,
            lastCandleTs: rawLastCandleTs,
            rawLastCandleTs,
            lastClosedCandleTs: consumedClosedCandleTs,
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
            lastTriggerSuppressedReason: triggerSuppressedReason || null,
            weights,
            collateralRecommendation,
            atr,
            weightVariance,
            amaSlope,
            effectiveWeights:         botState.effectiveWeights || null,
            pendingClosedCandle: false,
        };

        return {
            ok: true,
            dryRunMessages,
            source: sourceLabel,
            candleCount: nextCandles.length,
            analysisCandleCount: analysisCandles.length,
            kibanaGapRepairCount,
            kibanaBackfillCount,
            unresolvedGapCount,
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
            amaSlope,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            lastCandleTs: rawLastCandleTs,
            rawLastCandleTs,
            lastClosedCandleTs: consumedClosedCandleTs,
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
