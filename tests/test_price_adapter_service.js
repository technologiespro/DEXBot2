const assert = require('assert');
const path = require('path');

console.log('Running price adapter service tests');

const { createPriceAdapterService } = require('../market_adapter/core/price_adapter_service');
const { detectMissingCandleTimestamps } = require('../market_adapter/candle_utils');

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

async function testAmaGridPriceIsCaseInsensitive() {
    let writeAmaCenterCalls = 0;
    let triggerWrites = 0;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
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
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 103,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotAmaCenter: () => {
            writeAmaCenterCalls += 1;
            return true;
        },
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'AMA',
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

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire on threshold breach');
    assert.strictEqual(writeAmaCenterCalls, 1, 'AMA center should be written for uppercase AMA mode');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
}

async function testAmaTriggerSuppressedWhenCenterPersistFails() {
    let triggerWrites = 0;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
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
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 103,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotAmaCenter: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
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

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete');
    assert.strictEqual(result.triggered, false, 'trigger should be suppressed if AMA center cannot be persisted');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_center_persist_failed', 'suppression reason should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written when center persistence fails');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'center price should not advance when trigger is suppressed');
}

async function testAmaGridPriceOffsetTriggersRecenter() {
    let triggerWrites = 0;
    let writeArgs = null;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700003600000, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 5,
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
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotAmaCenter: (...args) => {
            writeArgs = args;
            return true;
        },
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        gridPriceOffsetPct: 0.5,
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
                gridPriceOffsetPct: 0,
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

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'offset changes should recenter the grid');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written for the offset change');
    assert.ok(Array.isArray(writeArgs), 'writeBotAmaCenter should be called');
    assert.strictEqual(writeArgs[0], 'xrp-bts-0');
    assert.strictEqual(writeArgs[1], 100);
    assert.strictEqual(writeArgs[2].gridPriceOffsetPct, 0.5);
    assert.strictEqual(writeArgs[2].effectiveCenterPrice, 100.5);
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100.5, 'effective center should be stored in state');
    assert.strictEqual(state.bots['xrp-bts-0'].amaCenterPrice, 100, 'raw AMA center should be stored separately');
    assert.strictEqual(state.bots['xrp-bts-0'].gridPriceOffsetPct, 0.5, 'offset should be tracked in state');
}

async function testAmaGridPriceOffsetClampAndDisable() {
    let triggerWrites = 0;
    let lastWrite = null;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700003600000, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 5,
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
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotAmaCenter: (...args) => {
            lastWrite = args;
            return true;
        },
        root: process.cwd(),
        path,
    });

    const clampedBot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        gridPriceOffsetPct: 5,
        gridPriceOffsetEnabled: true,
        minPrice: 99,
        maxPrice: 101,
        incrementPercent: 0.4,
    };

    const clampedState = {
        bots: {
            'xrp-bts-1': {
                centerPrice: 100,
                gridPriceOffsetPct: 0,
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

    const clampedResult = await service.processBot(clampedBot, clampedState, cfg, new Map(), {});
    assert.strictEqual(clampedResult.ok, true);
    assert.strictEqual(clampedResult.triggered, true);
    assert.strictEqual(clampedState.bots['xrp-bts-1'].centerPrice, 101, 'effective center should be clamped to maxPrice');
    assert.strictEqual(lastWrite[2].effectiveCenterPrice, 101, 'written center should match the clamped value');

    const disabledBot = {
        ...clampedBot,
        botKey: 'xrp-bts-2',
        gridPriceOffsetEnabled: false,
    };
    const disabledState = {
        bots: {
            'xrp-bts-2': {
                centerPrice: 105,
                gridPriceOffsetPct: 5,
            },
        },
    };

    const disabledResult = await service.processBot(disabledBot, disabledState, cfg, new Map(), {});
    assert.strictEqual(disabledResult.ok, true);
    assert.strictEqual(disabledResult.triggered, true, 'disabling the offset should recenter back to raw AMA once');
    assert.strictEqual(disabledState.bots['xrp-bts-2'].centerPrice, 100, 'disabled offset should fall back to raw AMA');
    assert.strictEqual(disabledState.bots['xrp-bts-2'].gridPriceOffsetPct, 0, 'disabled offset should be persisted as zero in state');

    const noOpState = {
        bots: {
            'xrp-bts-3': {
                centerPrice: 101,
                gridPriceOffsetPct: 4,
            },
        },
    };
    const noOpBot = {
        ...clampedBot,
        botKey: 'xrp-bts-3',
        gridPriceOffsetPct: 5,
    };
    const noOpResult = await service.processBot(noOpBot, noOpState, cfg, new Map(), {});
    assert.strictEqual(noOpResult.ok, true);
    assert.strictEqual(noOpResult.triggered, false, 'no trigger should fire when clamping keeps the effective center unchanged');
    assert.strictEqual(noOpState.bots['xrp-bts-3'].centerPrice, 101, 'effective center should remain unchanged at the clamp boundary');
    assert.strictEqual(triggerWrites, 2, 'only the clamp move and disable reset should have triggered');
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

async function testKibanaGapRepairPatchesMissingCandles() {
    let savedPayload = null;
    let amaCandles = null;
    let kibanaCalls = 0;
    let kibanaTimeRange = null;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700007200000, 102, 102, 102, 102, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                kibanaTimeRange = cfg.timeRange;
                return [
                    [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
                ];
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        calcAmaPrice: (candles) => {
            amaCandles = candles;
            return 100;
        },
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
        gridPrice: 'ama',
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

    assert.strictEqual(result.ok, true, 'processBot should succeed with Kibana gap repair');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be queried once to patch the gap');
    assert.deepStrictEqual(
        kibanaTimeRange,
        {
            gte: '2023-11-14T22:13:20.000Z',
            lte: '2023-11-15T01:13:19.999Z',
        },
        'Kibana repair should fetch slightly more than the missing bucket window'
    );
    assert.strictEqual(result.kibanaGapRepairCount, 1, 'patched gap count should be reported in result');
    assert.strictEqual(result.unresolvedGapCount, 0, 'no gaps should remain after Kibana repair');
    assert.strictEqual(state.bots['xrp-bts-0'].kibanaGapRepairCount, 1, 'state should track retained Kibana repairs');
    assert.strictEqual(state.bots['xrp-bts-0'].unresolvedGapCount, 0, 'state should track remaining gaps');
    assert.strictEqual(savedPayload.meta.kibanaGapRepairCount, 1, 'saved candle payload should include Kibana repair count');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 0, 'saved candle payload should include remaining gap count');
    assert.deepStrictEqual(
        amaCandles,
        [
            [1700000000000, 100, 100, 100, 100, 1],
            [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
            [1700007200000, 102, 102, 102, 102, 1],
        ],
        'AMA should be computed from the Kibana-patched candle series'
    );
}

async function testRemainingGapsAreReportedWhenKibanaHasNoPatchData() {
    let savedPayload = null;

    const service = createPriceAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700007200000, 102, 102, 102, 102, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        calcAmaPrice: () => 100,
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
        gridPrice: 'ama',
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

    assert.strictEqual(result.ok, true, 'processBot should still complete when Kibana cannot patch a gap');
    assert.strictEqual(result.kibanaGapRepairCount, 0, 'no Kibana repairs should be reported when nothing is returned');
    assert.strictEqual(result.unresolvedGapCount, 1, 'remaining gaps should be exposed in the result');
    assert.strictEqual(state.bots['xrp-bts-0'].unresolvedGapCount, 1, 'state should retain unresolved gap count');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 1, 'saved payload should retain unresolved gap count');
}

async function run() {
    await testTriggerHookCalledOnThreshold();
    await testBootstrapFallsBackWhenKibanaIsEmpty();
    await testAmaGridPriceIsCaseInsensitive();
    await testAmaTriggerSuppressedWhenCenterPersistFails();
    await testAmaGridPriceOffsetTriggersRecenter();
    await testAmaGridPriceOffsetClampAndDisable();
    await testContextCacheInvalidatesOnPoolChange();
    await testKibanaGapRepairPatchesMissingCandles();
    await testRemainingGapsAreReportedWhenKibanaHasNoPatchData();
}

run()
    .then(() => {
        console.log('price adapter service tests passed');
    })
    .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
