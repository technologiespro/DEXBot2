'use strict';

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

    async function processBot(bot, state, cfg, contextCache, hooks = {}) {
        if (!bot.assetA || !bot.assetB) {
            return { ok: false, reason: 'missing asset pair' };
        }

        const botAma = resolveAmaForBot(bot);
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }

        const gridPriceMode = (typeof bot.gridPrice === 'string')
            ? bot.gridPrice.trim().toLowerCase()
            : null;
        const usesAmaGridPrice = gridPriceMode === 'ama';

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

        nextCandles = pruneCandles(nextCandles, keepCount);
        const amaPrice = calcAmaPrice(nextCandles, botAma);
        const amaComparison = calcAmaComparison(nextCandles);
        const lastCandleTs = nextCandles[nextCandles.length - 1]?.[0] || null;
        const { staleData, staleAgeHours } = computeCandleStaleness(lastCandleTs, cfg.maxStaleHours);

        const botState = state.bots[bot.botKey] || {};
        let triggered = false;
        let triggerPath = null;
        let deltaPercent = null;
        let triggerCallbackError = null;
        let triggerSuppressedReason = null;

        if (!staleData && Number.isFinite(amaPrice) && amaPrice > 0) {
            const centerPrice = Number(botState.centerPrice || 0);
            if (!Number.isFinite(centerPrice) || centerPrice <= 0) {
                // First run: record AMA as the delta-comparison baseline.
                // Also persist the AMA center for bots using gridPrice: "ama" so that
                // initializeGrid() can read it via loadAmaCenterPrice() on first reset.
                botState.centerPrice = amaPrice;
                botState.lastGridResetAt = nowIso;
                if (usesAmaGridPrice && typeof writeBotAmaCenter === 'function') {
                    writeBotAmaCenter(bot.botKey, amaPrice);
                }
            } else {
                deltaPercent = Math.abs((amaPrice - centerPrice) / centerPrice) * 100;
                if (deltaPercent >= botThreshold) {
                    let amaCenterPersisted = true;

                    // For gridPrice: "ama" bots — write the new AMA center to
                    // profiles/orders/<botKey>.gridprice.json BEFORE writing the trigger file,
                    // so initializeGrid() always finds a fresh value when it reacts.
                    if (usesAmaGridPrice && typeof writeBotAmaCenter === 'function') {
                        amaCenterPersisted = writeBotAmaCenter(bot.botKey, amaPrice) !== false;
                    }

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        triggerPath = writeGridResetTrigger(bot, {
                            reason: 'price_adapter_delta_threshold',
                            thresholdPercent: botThreshold,
                            deltaPercent,
                            previousCenterPrice: centerPrice,
                            newCenterPrice: amaPrice,
                            poolId: ctx.poolId,
                        });
                        botState.centerPrice = amaPrice;
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
                                    newCenterPrice: amaPrice,
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
            lastCandleTs,
            lastAmaPrice: amaPrice,
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
