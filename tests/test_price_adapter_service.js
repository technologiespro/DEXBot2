const assert = require('assert');
const path = require('path');

console.log('Running price adapter service tests');

const { createPriceAdapterService } = require('../market_adapter/core/price_adapter_service');

async function testTriggerHookCalledOnThreshold() {
    let triggerHookCalls = 0;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => ([
                [1700000000000, 100, 100, 100, 100, 1],
                [1700003600000, 100, 101, 99, 101, 1],
            ]),
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 105,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {
        onTrigger: async (payload) => {
            triggerHookCalls += 1;
            assert.strictEqual(payload.botKey, 'xrp-bts-0');
            assert.strictEqual(payload.triggerPath, '/tmp/recalculate.xrp-bts-0.trigger');
        },
    });

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire when delta exceeds threshold');
    assert.strictEqual(triggerHookCalls, 1, 'onTrigger hook should be called exactly once');
}

async function testBootstrapFallsBackWhenKibanaIsEmpty() {
    let kibanaCalls = 0;
    let nativeCalls = 0;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                kibanaCalls += 1;
                return [];
            },
        },
        fetchNativeTradesSince: async () => {
            nativeCalls += 1;
            return [{
                tsMs: 1700000000000,
                sell: { asset_id: '1.3.1', amount: 10000 },
                received: { asset_id: '1.3.0', amount: 100000 },
            }];
        },
        tradesToCandles: () => [[1700000000000, 100, 100, 100, 100, 1]],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 105,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with fallback source');
    assert.strictEqual(result.source, 'native-bootstrap-fallback', 'bootstrap should fallback to native when Kibana is empty');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be attempted once');
    assert.strictEqual(nativeCalls, 1, 'native fallback should be called once');
}

async function testContextCacheInvalidatesOnPoolChange() {
    let resolveCalls = 0;

    const service = createPriceAdapterService({
        resolveBotContext: async (bot) => {
            resolveCalls += 1;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: bot.poolId,
            };
        },
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700003600000, 101, 101, 101, 101, 1],
            ],
        }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 100,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        root: process.cwd(),
        path,
    });

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };
    const contextCache = new Map();

    const firstBot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        poolId: '1.19.133',
    };

    const secondBot = {
        ...firstBot,
        poolId: '1.19.999',
    };

    await service.processBot(firstBot, state, cfg, contextCache, {});
    await service.processBot(secondBot, state, cfg, contextCache, {});

    assert.strictEqual(resolveCalls, 2, 'context should be re-resolved after pool change');
    assert.strictEqual(state.bots['xrp-bts-0'].poolId, '1.19.999', 'state should store refreshed pool context');
}

async function run() {
    await testTriggerHookCalledOnThreshold();
    await testBootstrapFallsBackWhenKibanaIsEmpty();
    await testContextCacheInvalidatesOnPoolChange();
}

run()
    .then(() => {
        console.log('price adapter service tests passed');
    })
    .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
