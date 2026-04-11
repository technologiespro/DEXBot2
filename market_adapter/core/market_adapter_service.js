'use strict';

const { TrendDetectionService } = require('./strategies/trend_detection/analyzer');
const { calculateATR } = require('./strategies/atr/calculator');
const { computeDynamicWeights } = require('./strategies/dynamic_weights');
const { adjustCollateralRatio } = require('./strategies/collateral_manager');
const { DEFAULT_CONFIG } = require('../../modules/constants');
const { resolveConfiguredPriceBound } = require('../../modules/order/utils/order');
const { applyGridPriceOffset } = require('../../modules/order/utils/system');


class MarketAdapterService {
    constructor(deps = {}) {
        this.deps = deps;
        // Per-bot trend analyzers to prevent cross-bot state contamination
        this.trendServices = new Map();
    }

    /**
     * Get or create a TrendDetectionService for a specific bot.
     * Each bot gets its own analyzer so accumulated AMA/oscillation
     * state is independent.
     */
    _getTrendService(botKey) {
        if (!this.trendServices.has(botKey)) {
            this.trendServices.set(botKey, new TrendDetectionService());
        }
        return this.trendServices.get(botKey);
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
        const botOffset = typeof deps.resolveOffsetForBot === 'function'
            ? deps.resolveOffsetForBot(bot, ctx)
            : { devThreshold: 10, maxPct: 5 };

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
        
        const amaPrice = deps.calcAmaPrice(nextCandles, botAma);
        const lastCandle = nextCandles[nextCandles.length - 1] || [0,0,0,0,0];
        
        // 1. Trend analysis (price_candles -> trend_detection)
        //    Feed ALL candles through the per-bot analyzer so it accumulates
        //    enough history for isReady/confidence to be meaningful.
        //    Use AMA price as the feed reference (LP pairs have no on-chain feed).
        const trendService = this._getTrendService(bot.botKey);
        trendService.reset();
        const feedRef = Number.isFinite(amaPrice) && amaPrice > 0 ? amaPrice : 0;
        let trendData = { isReady: false, trend: 'NEUTRAL', confidence: 0 };
        for (let i = 0; i < nextCandles.length; i++) {
            const close = nextCandles[i][4] || 0;
            trendData = trendService.update(close, feedRef);
        }

        // 2. ATR Calculation (price_candles -> ATR -> weight_variance)
        const atr = calculateATR(nextCandles, 14);
        const weightVariance = amaPrice > 0 ? (atr / amaPrice) : 0;
        
        // 3. Dynamic Weights (trend_detection -> weight_offset, combine weight_variance)
        const weights = computeDynamicWeights(trendData, { oscillationRatio: weightVariance * 100 });
        
        // 4. Collateral Strategy
        const collateral = adjustCollateralRatio(trendData, 1.5, 2.0);

        // 5. Grid Price Offset Calculation
        // trend_detection -> price_offset

        // Inventory danger gate: only activate offset when price has deviated
        // >= devThreshold % from AMA (grid center). Below this the grid
        // is still well-centered and no correction is needed.
        // Ramp: linearly scales 0→100 between threshold and 2x threshold.
        // Below devThreshold → silent. At devThreshold → 0%. At 2x → full 100%. Above 2x → capped at 100%.
        const currentClose = lastCandle[4] || 0;
        const deviationPct = amaPrice > 0 ? Math.abs(currentClose - amaPrice) / amaPrice * 100 : 0;
        const { devThreshold, maxPct: offsetMaxPct } = botOffset;
        const effectiveConfidence = deviationPct < devThreshold ? 0 :
            Math.min(100, Math.round(((deviationPct - devThreshold) / devThreshold) * 100));

        let dynamicTrendOffset = 0;
        if (trendData.trend === 'UP')        dynamicTrendOffset =  (effectiveConfidence / 100) * offsetMaxPct;
        else if (trendData.trend === 'DOWN') dynamicTrendOffset = -(effectiveConfidence / 100) * offsetMaxPct;
        
        const gridPriceOffsetPct = dynamicTrendOffset;

        // AMA + price_offset -> Gridprice
        // ---------------------------------------------------------------
        
        const amaComparison = deps.calcAmaComparison(nextCandles, bot, ctx);
        const lastCandleTs = lastCandle[0] || null;
        const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastCandleTs, cfg.maxStaleHours);
        
        const referencePrice = amaPrice;
        let effectiveCenterPrice = applyGridPriceOffset(amaPrice, gridPriceOffsetPct);
        const clampedCenterPrice = this.clampGridPriceToBounds(effectiveCenterPrice, amaPrice, bot);
        effectiveCenterPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0 ? clampedCenterPrice : effectiveCenterPrice;

        const botState = { ...(state.bots[bot.botKey] || {}) };
        delete botState.gridPriceOffsetClampToBounds;
        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;

        if (!staleData && Number.isFinite(referencePrice) && referencePrice > 0) {
            const centerPrice = Number(botState.centerPrice || 0);
            const previousGridPriceOffsetPct = Number(botState.gridPriceOffsetPct || 0);
            const offsetPctChanged = Number.isFinite(previousGridPriceOffsetPct)
                ? Math.abs(previousGridPriceOffsetPct - gridPriceOffsetPct) > 1e-9
                : false;
            const effectiveCenterMoved = centerPrice > 0
                && Math.abs(Number(effectiveCenterPrice || 0) - centerPrice) > 1e-8;
            const offsetChanged = offsetPctChanged && effectiveCenterMoved;

            if (!Number.isFinite(centerPrice) || centerPrice <= 0) {
                const bootstrapCenterPrice = Number.isFinite(effectiveCenterPrice) && effectiveCenterPrice > 0
                    ? effectiveCenterPrice
                    : referencePrice;
                let amaCenterPersisted = true;
                if (!isDryRun && typeof deps.writeBotGridPriceCenter === 'function') {
                    amaCenterPersisted = deps.writeBotGridPriceCenter(bot.botKey, referencePrice, {
                        amaCenterPrice: amaPrice,
                        gridPriceOffsetPct,
                        effectiveCenterPrice: bootstrapCenterPrice,
                    }) !== false;
                } else if (isDryRun) {
                    dryRunMessages.push(`[DRY RUN] Would write grid price center for ${bot.botKey}: ${bootstrapCenterPrice}`);
                }

                if (amaCenterPersisted) {
                    botState.centerPrice = bootstrapCenterPrice;
                    botState.amaCenterPrice = amaPrice;
                    botState.gridPriceOffsetPct = gridPriceOffsetPct;
                    botState.lastGridResetAt = nowIso;
                } else {
                    triggerSuppressedReason = 'ama_center_persist_failed';
                }
            } else {
                deltaPercent = Math.abs((effectiveCenterPrice - centerPrice) / centerPrice) * 100;
                if (deltaPercent >= botThreshold) {
                    let amaCenterPersisted = true;

                    if (!isDryRun && typeof deps.writeBotGridPriceCenter === 'function') {
                        amaCenterPersisted = deps.writeBotGridPriceCenter(bot.botKey, referencePrice, {
                            amaCenterPrice: amaPrice,
                            gridPriceOffsetPct,
                            effectiveCenterPrice,
                            previousCenterPrice: centerPrice,
                        }) !== false;
                    } else if (isDryRun) {
                        dryRunMessages.push(`[DRY RUN] Would write grid price center for ${bot.botKey}: ${effectiveCenterPrice}`);
                    }

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        if (!isDryRun) {
                            triggerPath = deps.writeGridResetTrigger(bot, {
                                reason: offsetChanged
                                    ? 'price_adapter_gridprice_offset_change'
                                    : 'price_adapter_delta_threshold',
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice: centerPrice,
                                newCenterPrice: effectiveCenterPrice,
                                referencePrice,
                                rawAmaPrice: amaPrice,
                                gridPriceOffsetPct,
                                poolId: ctx.poolId,
                            });
                        } else {
                            dryRunMessages.push(`[DRY RUN] Would write grid reset trigger for ${bot.botKey}`);
                        }
                        botState.centerPrice = effectiveCenterPrice;
                        botState.amaCenterPrice = amaPrice;
                        botState.gridPriceOffsetPct = gridPriceOffsetPct;
                        botState.lastGridResetAt = nowIso;
                        botState.triggerCount = Number(botState.triggerCount || 0) + 1;
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
                                    previousCenterPrice: centerPrice,
                                    newCenterPrice: effectiveCenterPrice,
                                    referencePrice,
                                    rawAmaPrice: amaPrice,
                                    gridPriceOffsetPct,
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
            gridPriceOffsetPct,
            effectiveCenterPrice,
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
            trend: trendData.trend,
            atr,
            weightVariance,
            effectiveConfidence,
            deviationPct
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
            trend: trendData.trend,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            lastCandleTs,
            gridPriceOffsetPct,
            effectiveCenterPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            atr,
            weightVariance,
            effectiveConfidence,
            deviationPct
        };
    }
}

module.exports = { MarketAdapterService };
