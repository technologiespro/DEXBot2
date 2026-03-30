'use strict';

const { DEFAULT_CONFIG } = require('../../modules/constants');
const { resolveConfiguredPriceBound } = require('../../modules/order/utils/order');

function createPriceAdapterService(deps = {}) {
    const {
        resolveBotContext,
        resolveAmaForBot,
        candleFileForBot,
        loadJson,
        saveJson,
        requiredCandlesForAma,
        calculateBotThreshold,
        computeCandleStaleness,
        withRetries,
        kibanaSource,
        fetchNativeTradesSince,
        tradesToCandles,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles,
        calcAmaPrice,
        calcAmaComparison,
        writeGridResetTrigger,
        writeBotAmaCenter,
        root,
        path,
    } = deps;

    function buildBotContextSignature(bot) {
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

    function buildGapRepairTimeRange(missingTimestamps, intervalSeconds) {
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

    function applyGridPriceOffset(centerPrice, offsetPct) {
        const base = Number(centerPrice);
        const offset = Number(offsetPct);
        if (!Number.isFinite(base) || base <= 0) return null;
        const signedOffset = Number.isFinite(offset) ? offset : 0;
        const adjusted = base * (1 + (signedOffset / 100));
        const rounded = Math.round(adjusted * 1e8) / 1e8;
        return Number.isFinite(rounded) && rounded > 0 ? rounded : base;
    }

    function clampGridPriceToBounds(centerPrice, referencePrice, bot) {
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

    async function processBot(bot, state, cfg, contextCache, hooks = {}) {
        if (!bot.assetA || !bot.assetB) {
            return { ok: false, reason: 'missing asset pair' };
        }

        const gridPriceMode = (typeof bot.gridPrice === 'string')
            ? bot.gridPrice.trim().toLowerCase()
            : null;
        const usesAmaGridPrice = /^ama(?:[1-4])?$/.test(gridPriceMode || '');

        const contextSignature = buildBotContextSignature(bot);
        const cached = contextCache.get(bot.botKey);
        const cachedCtx = cached && typeof cached === 'object' && cached.ctx ? cached.ctx : cached;
        const cachedSignature = cached && typeof cached === 'object' && cached.signature ? cached.signature : null;
        let ctx = cachedCtx;
        if (!ctx || cachedSignature !== contextSignature) {
            ctx = await resolveBotContext(bot);
            contextCache.set(bot.botKey, {
                signature: contextSignature,
                ctx,
            });
        }

        const botAma = resolveAmaForBot(bot, ctx);
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }

        const filePath = candleFileForBot(bot.botKey);
        const existing = loadJson(filePath, null);
        const existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];

        const needBootstrap = existingCandles.length === 0;
        const keepCount = requiredCandlesForAma(botAma);
        const nowIso = new Date().toISOString();
        const botThreshold = calculateBotThreshold(cfg);
        if (!Number.isFinite(botThreshold) || botThreshold <= 0) {
            throw new Error(`deltaThresholdPercent missing/invalid for bot ${bot.name}`);
        }

        let nextCandles = existingCandles;
        let sourceLabel = 'native-incremental';

        if (needBootstrap) {
            const lookbackHours = Math.max(cfg.bootstrapLookbackHours, keepCount * 2);
            let kibanaCandles = null;
            try {
                kibanaCandles = await withRetries(() => kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, {
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
                const trades = await withRetries(
                    () => fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                    cfg.sourceRetries,
                    cfg.retryDelayMs,
                    'native bootstrap fallback failed'
                );
                nextCandles = tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
                sourceLabel = 'native-bootstrap-fallback';
            }
        } else {
            const lastTs = existingCandles[existingCandles.length - 1]?.[0] || 0;
            const sinceMs = lastTs - (cfg.nativeBackfillHours * 3600 * 1000);
            const trades = await withRetries(
                () => fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                cfg.sourceRetries,
                cfg.retryDelayMs,
                'native incremental fetch failed'
            );
            const incomingCandles = tradesToCandles(trades, ctx.assetA, ctx.assetB, cfg.intervalSeconds);
            nextCandles = mergeCandles(existingCandles, incomingCandles);
        }

        let kibanaGapRepairTimestamps = [];
        let gapAnalysis = typeof detectMissingCandleTimestamps === 'function'
            ? detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
            : { gapCount: 0, missingTimestamps: [] };

        if (gapAnalysis.gapCount > 0 && kibanaSource && typeof kibanaSource.getLpCandlesForPool === 'function') {
            const timeRange = buildGapRepairTimeRange(gapAnalysis.missingTimestamps, cfg.intervalSeconds);
            if (timeRange) {
                try {
                    const kibanaGapCandles = await withRetries(() => kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, {
                        intervalSeconds: cfg.intervalSeconds,
                        consolidateByTimestamp: true,
                        apiKey: null,
                        timeRange,
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana gap repair failed');

                    if (Array.isArray(kibanaGapCandles) && kibanaGapCandles.length > 0) {
                        const beforeTimestamps = new Set(nextCandles.map((c) => c[0]));
                        nextCandles = mergeCandles(nextCandles, kibanaGapCandles);
                        const afterTimestamps = new Set(nextCandles.map((c) => c[0]));
                        kibanaGapRepairTimestamps = gapAnalysis.missingTimestamps.filter((ts) => !beforeTimestamps.has(ts) && afterTimestamps.has(ts));
                    }
                } catch (_) {}
            }
            gapAnalysis = typeof detectMissingCandleTimestamps === 'function'
                ? detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
                : { gapCount: 0, missingTimestamps: [] };
        }

        nextCandles = pruneCandles(nextCandles, keepCount);
        const retainedTimestamps = new Set(nextCandles.map((c) => c[0]));
        const kibanaGapRepairCount = kibanaGapRepairTimestamps.filter((ts) => retainedTimestamps.has(ts)).length;
        const retainedGapAnalysis = typeof detectMissingCandleTimestamps === 'function'
            ? detectMissingCandleTimestamps(nextCandles, cfg.intervalSeconds)
            : { gapCount: 0, missingTimestamps: [] };
        const unresolvedGapCount = retainedGapAnalysis.gapCount;
        const amaPrice = calcAmaPrice(nextCandles, botAma);
        const amaComparison = calcAmaComparison(nextCandles, bot, ctx);
        const lastCandleTs = nextCandles[nextCandles.length - 1]?.[0] || null;
        const { staleData, staleAgeHours } = computeCandleStaleness(lastCandleTs, cfg.maxStaleHours);
        const gridPriceOffsetEnabled = bot.gridPriceOffsetEnabled !== false;
        const gridPriceOffsetPct = usesAmaGridPrice && gridPriceOffsetEnabled ? Number(bot.gridPriceOffsetPct || 0) : 0;
        let effectiveCenterPrice = usesAmaGridPrice
            ? applyGridPriceOffset(amaPrice, gridPriceOffsetPct)
            : amaPrice;
        const clampedCenterPrice = usesAmaGridPrice
            ? clampGridPriceToBounds(effectiveCenterPrice, amaPrice, bot)
            : effectiveCenterPrice;
        effectiveCenterPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0 ? clampedCenterPrice : effectiveCenterPrice;

        const botState = { ...(state.bots[bot.botKey] || {}) };
        delete botState.gridPriceOffsetClampToBounds;
        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;

        if (!staleData && Number.isFinite(amaPrice) && amaPrice > 0) {
            const centerPrice = Number(botState.centerPrice || 0);
            const previousGridPriceOffsetPct = Number(botState.gridPriceOffsetPct || 0);
            const offsetPctChanged = usesAmaGridPrice && Number.isFinite(previousGridPriceOffsetPct)
                ? Math.abs(previousGridPriceOffsetPct - gridPriceOffsetPct) > 1e-9
                : false;
            const effectiveCenterMoved = centerPrice > 0
                && Math.abs(Number(effectiveCenterPrice || 0) - centerPrice) > 1e-8;
            const offsetChanged = offsetPctChanged && effectiveCenterMoved;

            if (!Number.isFinite(centerPrice) || centerPrice <= 0) {
                // First run: record the effective center as the delta-comparison baseline.
                // Also persist the effective center for bots using AMA gridPrice keywords so that
                // initializeGrid() can read it via loadAmaCenterPrice() on first reset.
                botState.centerPrice = Number.isFinite(effectiveCenterPrice) && effectiveCenterPrice > 0 ? effectiveCenterPrice : amaPrice;
                botState.amaCenterPrice = amaPrice;
                botState.gridPriceOffsetPct = gridPriceOffsetPct;
                botState.gridPriceOffsetEnabled = gridPriceOffsetEnabled;
                botState.lastGridResetAt = nowIso;
                if (usesAmaGridPrice && typeof writeBotAmaCenter === 'function') {
                    writeBotAmaCenter(bot.botKey, amaPrice, {
                        amaCenterPrice: amaPrice,
                        gridPriceOffsetPct,
                        gridPriceOffsetEnabled,
                        effectiveCenterPrice: botState.centerPrice,
                    });
                }
            } else {
                deltaPercent = Math.abs((effectiveCenterPrice - centerPrice) / centerPrice) * 100;
                if (offsetChanged || deltaPercent >= botThreshold) {
                    let amaCenterPersisted = true;

                    // For AMA gridPrice bots — write the effective center to
                    // profiles/orders/<botKey>.gridprice.json BEFORE writing the trigger file,
                    // so initializeGrid() always finds a fresh value when it reacts.
                    if (usesAmaGridPrice && typeof writeBotAmaCenter === 'function') {
                        amaCenterPersisted = writeBotAmaCenter(bot.botKey, amaPrice, {
                            amaCenterPrice: amaPrice,
                            gridPriceOffsetPct,
                            gridPriceOffsetEnabled,
                            effectiveCenterPrice,
                            previousCenterPrice: centerPrice,
                        }) !== false;
                    }

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        triggerPath = writeGridResetTrigger(bot, {
                            reason: offsetChanged
                                ? 'price_adapter_gridprice_offset_change'
                                : 'price_adapter_delta_threshold',
                            thresholdPercent: botThreshold,
                            deltaPercent,
                            previousCenterPrice: centerPrice,
                            newCenterPrice: effectiveCenterPrice,
                            rawAmaPrice: amaPrice,
                            gridPriceOffsetPct,
                            gridPriceOffsetEnabled,
                            poolId: ctx.poolId,
                        });
                        botState.centerPrice = effectiveCenterPrice;
                        botState.amaCenterPrice = amaPrice;
                        botState.gridPriceOffsetPct = gridPriceOffsetPct;
                        botState.gridPriceOffsetEnabled = gridPriceOffsetEnabled;
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
                                    rawAmaPrice: amaPrice,
                                    gridPriceOffsetPct,
                                    gridPriceOffsetEnabled,
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
        saveJson(filePath, candlePayload);

        state.bots[bot.botKey] = {
            ...botState,
            botName: bot.name,
            botKey: bot.botKey,
            poolId: ctx.poolId,
            candleFile: path.relative(root, filePath),
            candleCount: nextCandles.length,
            kibanaGapRepairCount,
            unresolvedGapCount,
            lastCandleTs,
            lastAmaPrice: amaPrice,
            amaCenterPrice: amaPrice,
            gridPriceOffsetPct,
            gridPriceOffsetEnabled,
            effectiveCenterPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            amaComparison,
            lastDeltaPercent: deltaPercent,
            thresholdPercent: botThreshold,
            lastCycleSource: sourceLabel,
            lastCycleAt: nowIso,
            staleData,
            staleAgeHours,
            lastTriggerFile: triggerPath || botState.lastTriggerFile || null,
            lastTriggerSuppressedReason: triggerSuppressedReason,
        };

        return {
            ok: true,
            source: sourceLabel,
            candleCount: nextCandles.length,
            kibanaGapRepairCount,
            unresolvedGapCount,
            amaPrice,
            deltaPercent,
            thresholdPercent: botThreshold,
            amaComparison,
            triggered,
            triggerPath,
            staleData,
            staleAgeHours,
            triggerCallbackError,
            triggerSuppressedReason,
        };
    }

    async function runCycle(bots, state, cfg, contextCache, hooks = {}) {
        const out = [];
        for (const bot of bots) {
            try {
                const result = await processBot(bot, state, cfg, contextCache, hooks);
                out.push({ botName: bot.name, botKey: bot.botKey, ...result });
            } catch (err) {
                out.push({ botName: bot.name, botKey: bot.botKey, ok: false, reason: err.message });
            }
        }
        return out;
    }

    return {
        processBot,
        runCycle,
    };
}

module.exports = {
    createPriceAdapterService,
};
