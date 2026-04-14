'use strict';

const { calculateATR } = require('./strategies/atr/calculator');
const { computeAmaSlopeWeights } = require('./strategies/ama_slope_model');
const { calculateAMA } = require('../../analysis/ama_fitting/ama');
const { adjustCollateralRatio } = require('./strategies/collateral_manager');
const { DEFAULT_CONFIG } = require('../../modules/constants');
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

        // 1. AMA series — used for price reference and slope-based weight offset
        const closes = nextCandles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);
        const amaValues = calculateAMA(closes, botAma);

        // amaPrice is the last value of the full AMA series
        const amaPrice = amaValues.length > 0 ? amaValues[amaValues.length - 1] : null;
        const lastCandle = nextCandles[nextCandles.length - 1] || [0,0,0,0,0];

        // 2. ATR — volatility input for symmetric weight factor
        const atr = calculateATR(nextCandles, 14);
        const weightVariance = amaPrice > 0 ? (atr / amaPrice) : 0;

        // 3. Slope + volatility → weights
        //    slopeOffset (asymmetric) + symmetricDelta (volatility) combined in one call
        const slopeCfg = cfg.amaSlope || {};
        const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

        const amaSlope = {
            trend:          slopeResult.trend,
            confidence:     slopeResult.confidence,
            slopePct:       slopeResult.slopePct,
            slopeOffset:    slopeResult.slopeOffset,
            symmetricDelta: slopeResult.symmetricDelta,
            weightVariance,
            isReady:        slopeResult.isReady,
        };

        const weights = {
            sell: slopeResult.sellW,
            buy:  slopeResult.buyW,
            profile: slopeResult.isReady
                ? (slopeResult.trend === 'NEUTRAL' ? 'flat' : 'slope')
                : 'static',
            meta: {
                source:         'ama_slope',
                trend:          slopeResult.trend,
                confidence:     slopeResult.confidence,
                slopePct:       slopeResult.slopePct,
                slopeOffset:    slopeResult.slopeOffset,
                symmetricDelta: slopeResult.symmetricDelta,
                isReady:        slopeResult.isReady,
            },
        };

        // 4. Collateral Strategy — uses derived confidence (proportional to slope magnitude)
        const collateral = adjustCollateralRatio(slopeResult, 1.5, 2.0);

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
                if (!isDryRun && typeof deps.writeBotGridPriceCenter === 'function') {
                    amaCenterPersisted = deps.writeBotGridPriceCenter(bot.botKey, bootstrapCenterPrice, {
                        amaCenterPrice: amaPrice,
                    }) !== false;
                } else if (isDryRun) {
                    dryRunMessages.push(`[DRY RUN] Would write grid price center for ${bot.botKey}: ${bootstrapCenterPrice}`);
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

                    if (!isDryRun && typeof deps.writeBotGridPriceCenter === 'function') {
                        amaCenterPersisted = deps.writeBotGridPriceCenter(bot.botKey, centerPrice, {
                            amaCenterPrice: amaPrice,
                            previousCenterPrice,
                        }) !== false;
                    } else if (isDryRun) {
                        dryRunMessages.push(`[DRY RUN] Would write grid price center for ${bot.botKey}: ${centerPrice}`);
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
