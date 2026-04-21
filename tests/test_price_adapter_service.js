const assert = require('assert');
const path = require('path');

console.log('Running price adapter service tests');

const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { detectMissingCandleTimestamps } = require('../market_adapter/candle_utils');

function generateCandles(count, price) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateVolatileFlatCandles(count, close = 100, high = 110, low = 90) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, close, high, low, close, 1]);
    }
    return candles;
}

function generateTrendingCandles(count, start = 100, step = 0.2) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        const price = start + i * step;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

async function testTriggerHookCalledOnThreshold() {
    let triggerHookCalls = 0;

    const service = new MarketAdapterService({
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
            getLpCandlesForPool: async () => generateCandles(30, 105),
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
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

    const service = new MarketAdapterService({
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
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

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: () => {
            writeAmaCenterCalls += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
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
                amaCenterPrice: 100,
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

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: () => false,
        isBotDynamicWeightWhitelisted: () => false,
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
                amaCenterPrice: 100,
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
    assert.strictEqual(state.bots['xrp-bts-0'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the persisted snapshot');
}

async function testBootstrapCenterDoesNotAdvanceWhenPersistFails() {
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-bootstrap.trigger';
        },
        writeBotDynamicGrid: () => false,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-bootstrap',
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

    assert.strictEqual(result.ok, true, 'processBot should still complete on bootstrap persistence failure');
    assert.strictEqual(result.triggered, false, 'bootstrap persistence failure should not produce a trigger');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_center_persist_failed', 'bootstrap failure should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written during bootstrap persistence failure');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].centerPrice, undefined, 'bootstrap baseline should remain unset so the next cycle retries');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].amaCenterPrice, undefined, 'bootstrap raw AMA center should remain unset when snapshot persistence fails');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].lastGridResetAt, undefined, 'bootstrap state should not pretend a reset happened');
}

// Center remains AMA when there is no offset. Trigger fires from AMA delta.
async function testCenterEqualsAmaTriggeredByAmaDelta() {
    let triggerWrites = 0;
    let writeArgs = null;

    const service = new MarketAdapterService({
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
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            writeArgs = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    // Previous center 95 → AMA moved to 100 → delta = 5.26% > threshold 0.25% → triggered
    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 95,
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
    assert.strictEqual(result.triggered, true, 'AMA movement should trigger recenter');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
    assert.ok(Array.isArray(writeArgs), 'writeBotDynamicGrid should be called');
    assert.strictEqual(writeArgs[0], 'xrp-bts-0');
    assert.strictEqual(writeArgs[1], 100, 'written center should be the AMA center');
    assert.strictEqual(writeArgs[2].amaCenterPrice, 100, 'raw AMA center should be persisted separately');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'center updates to new AMA');
    assert.strictEqual(state.bots['xrp-bts-0'].amaCenterPrice, 100, 'raw AMA center tracked separately');
}

// When AMA equals previous center, the center is unchanged → no trigger even with low threshold.
async function testNoTriggerWhenCenterMatchesAma() {
    let triggerWrites = 0;
    let writeCalls = 0;

    const service = new MarketAdapterService({
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
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: () => {
            writeCalls += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    // Previous center = AMA → center unchanged → no trigger
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
    assert.strictEqual(result.deltaPercent, 0, 'delta should be zero when center is unchanged');
    assert.strictEqual(result.triggered, false, 'no trigger when effective center equals previous center');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written');
    assert.strictEqual(writeCalls, 0, 'center must not be persisted when unchanged');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'stored center should remain unchanged');
}

// Center is clamped to bot.minPrice/maxPrice bounds when AMA drifts outside them.
async function testCenterClampedByBotBounds() {
    let triggerWrites = 0;
    let lastWrite = null;

    // AMA = 110, bot bounds [99, 101] → center = 101 (clamped to maxPrice)
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 110),
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-1.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

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

    // AMA=110 is above maxPrice=101 → clamped to 101. Previous center=110 → delta = 8.2% > 0.5% → triggered.
    const clampedBot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        minPrice: 99,
        maxPrice: 101,
        incrementPercent: 0.4,
    };
    const clampedState = {
        bots: {
            'xrp-bts-1': {
                centerPrice: 110,
            },
        },
    };

    const clampedResult = await service.processBot(clampedBot, clampedState, cfg, new Map(), {});
    assert.strictEqual(clampedResult.ok, true);
    assert.strictEqual(clampedResult.triggered, true, 'clamped center change should trigger recenter');
    assert.strictEqual(clampedState.bots['xrp-bts-1'].centerPrice, 101, 'center should be clamped to maxPrice');
    assert.strictEqual(lastWrite[1], 101, 'written center should match clamped value');
    assert.strictEqual(lastWrite[2].amaCenterPrice, 110, 'raw AMA center should be persisted separately');

    // AMA=110, previous=101 (already at clamp boundary) → no center change → no trigger.
    const noOpBot = { ...clampedBot, botKey: 'xrp-bts-3' };
    const noOpState = {
        bots: {
            'xrp-bts-3': {
                centerPrice: 101,
            },
        },
    };
    const noOpResult = await service.processBot(noOpBot, noOpState, cfg, new Map(), {});
    assert.strictEqual(noOpResult.ok, true);
    assert.strictEqual(noOpResult.triggered, false, 'no trigger when clamping keeps center unchanged');
    assert.strictEqual(noOpState.bots['xrp-bts-3'].centerPrice, 101, 'center should remain at clamp boundary');
    assert.strictEqual(triggerWrites, 1, 'only the initial clamp move should have triggered');
}

async function testContextCacheInvalidatesOnPoolChange() {
    let resolveCalls = 0;

    const service = new MarketAdapterService({
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
            candles: generateCandles(30, 101),
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
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
        gridPrice: 'ama',
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
    let kibanaCalls = 0;
    let kibanaTimeRange = null;

    const service = new MarketAdapterService({
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
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
        savedPayload.candles,
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

    const service = new MarketAdapterService({
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
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
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

async function testIdOnlyBotIsNotRejected() {
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
        }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.id-bot.trigger',
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    // Bot with only assetAId/assetBId (no assetA/assetB symbols)
    const bot = {
        name: 'ID-Only-Bot',
        botKey: 'id-only-bot-0',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
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
    assert.strictEqual(result.ok, true, 'ID-only bot should not be rejected by processBot');
    assert.notStrictEqual(result.reason, 'missing asset pair', 'should not fail with missing asset pair');
}

// Flat candles → finalOff = 0, which is below the default 0.25 threshold.
// Bot side should receive isReady=false and effectiveWeights == baseWeights.
// Requires 1000 candles so slopeResult.isReady=true (AMA3 erPeriod=781, lookback=72 → needs 854+).
async function testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-0.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-0': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called via weight-only update path');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles produce finalOff=0 < default threshold 0.25');
    assert.strictEqual(dw.isReady, false, 'isReady should be false when below min output threshold');
    assert.strictEqual(dw.effectiveWeights.sell, 0.6, 'effectiveWeights.sell should equal static sell when below threshold');
    assert.strictEqual(dw.effectiveWeights.buy, 0.4, 'effectiveWeights.buy should equal static buy when below threshold');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effectiveWeights should equal baseWeights when below threshold');
    assert.strictEqual(dw.minOutputThreshold, 0.25, 'minOutputThreshold should be the default 0.25');
}

// With minOutputThreshold=0 the gate is disabled: even finalOff=0 passes, isReady reflects
// slopeResult.isReady (true with enough flat candles), and belowMinOutputThreshold is false.
async function testDynamicWeightMinOutputThresholdZeroDisablesGate() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-1.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-1': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, false, 'minOutputThreshold=0 disables the gate');
    assert.strictEqual(dw.isReady, true, 'isReady should be true when gate is disabled and slopeResult is ready');
    assert.strictEqual(dw.minOutputThreshold, 0, 'cfg.minOutputThreshold=0 should be reflected in payload');
}

async function testDynamicWeightVolatilityOnlyPathRemainsReady() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-vol.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-vol',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-vol': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.profile, 'volatility', 'volatility-only path should identify its profile');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'volatility penalty should reduce weights');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend component should remain gated off');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles should still fail the trend threshold');
    assert.strictEqual(dw.isReady, true, 'volatility-only payload should remain ready');
    assert.ok(dw.volatilityPenalty < 0, 'payload should expose a negative volatility penalty');
    assert.ok(dw.effectiveWeights.sell < dw.baseWeights.sell, 'sell weight should be reduced by volatility');
    assert.ok(dw.effectiveWeights.buy < dw.baseWeights.buy, 'buy weight should be reduced by volatility');
    assert.notDeepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'volatility-only weights should differ from the static baseline');
}

async function testDynamicWeightVolatilityOverridesFlowIntoService() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-override.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-override',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-override': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        volatilityExponent: 1.0,
        volatilityScaleX: 0.2,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.volatilityPenalty, -0.2, 'service should clamp volatility scaleX to the live/research minimum');
    assert.strictEqual(dw.effectiveWeights.sell, 0.4, 'sell weight should reflect the clamped volatility penalty');
    assert.strictEqual(dw.effectiveWeights.buy, 0.2, 'buy weight should reflect the clamped volatility penalty');
    assert.strictEqual(result.weights.meta.volatilityPenalty, -0.2, 'service metadata should reflect the clamped volatility penalty');
}

async function testDynamicWeightSuppressedTrendUsesFlatProfile() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.2) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-flat-profile.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-flat-profile',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-flat-profile': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        gain: 0.1,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.trend, 'UP', 'raw trend should remain available in metadata');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend output should be gated off by threshold');
    assert.strictEqual(result.weights.meta.trendOffset, 0, 'no trend offset should be applied when threshold suppresses it');
    assert.strictEqual(result.weights.profile, 'flat', 'profile should reflect the applied weighting mode');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.isReady, false, 'suppressed trend without volatility should not be ready');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effective weights should fall back to the static baseline');
}

async function testDynamicWeightWeightOnlyWritesPersistEveryCycle() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-persist.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-persist',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-persist': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    await service.processBot(bot, state, cfg, new Map(), {});
    const firstWeights = { ...lastPayload.dynamicWeights.effectiveWeights };
    await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(writeCount, 2, 'weight-only dynamic weights should be persisted on every no-trigger cycle');
    assert.deepStrictEqual(lastPayload.dynamicWeights.effectiveWeights, firstWeights, 'successive writes may carry identical effective weights');
}

async function testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState() {
    let writeCount = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-fail.trigger',
        writeBotDynamicGrid: () => {
            writeCount += 1;
            return false;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-fail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-dw-fail': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete when weight-only persistence fails');
    assert.strictEqual(result.triggered, false, 'weight-only persistence failure should not create a trigger');
    assert.strictEqual(result.triggerSuppressedReason, 'dynamic_weight_persist_failed', 'failed weight-only write should be surfaced');
    assert.strictEqual(writeCount, 1, 'weight-only persistence should still be attempted');
    assert.strictEqual(state.bots['xrp-bts-dw-fail'].effectiveWeights, null, 'effective weights should not advance when snapshot write fails');
    assert.strictEqual(state.bots['xrp-bts-dw-fail'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
}

async function testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData() {
    let writeCount = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 12.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-stale.trigger',
        writeBotDynamicGrid: () => {
            writeCount += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-stale',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-dw-stale': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete with stale data');
    assert.strictEqual(result.staleData, true, 'stale flag should be surfaced');
    assert.strictEqual(result.triggered, false, 'stale data should not create a trigger');
    assert.strictEqual(writeCount, 0, 'stale data should suppress weight-only snapshot writes');
    assert.strictEqual(state.bots['xrp-bts-dw-stale'].effectiveWeights, null, 'stale cycles should not update effective weights');
    assert.strictEqual(state.bots['xrp-bts-dw-stale'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
}

async function testDynamicWeightInvalidAtrPeriodAndClampAreSanitized() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `price_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        requiredCandlesForAma: () => 80,
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-sanitized.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-sanitized',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-sanitized': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        atrPeriod: 0,
        maxVolatilityOffset: -0.25,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.atrPeriod, 14, 'invalid ATR periods should fall back to the default window');
    assert.strictEqual(result.weights.meta.maxVolatilityOffset, 0.5, 'invalid volatility clamps should fall back to the default cap');
    assert.ok(Number.isFinite(result.weights.meta.volatilityPenalty), 'sanitized volatility penalty should stay finite');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'sanitized volatility penalty should remain downward-only');
}

async function run() {
    await testTriggerHookCalledOnThreshold();
    await testIdOnlyBotIsNotRejected();
    await testBootstrapFallsBackWhenKibanaIsEmpty();
    await testAmaGridPriceIsCaseInsensitive();
    await testAmaTriggerSuppressedWhenCenterPersistFails();
    await testBootstrapCenterDoesNotAdvanceWhenPersistFails();
    await testCenterEqualsAmaTriggeredByAmaDelta();
    await testNoTriggerWhenCenterMatchesAma();
    await testCenterClampedByBotBounds();
    await testContextCacheInvalidatesOnPoolChange();
    await testKibanaGapRepairPatchesMissingCandles();
    await testRemainingGapsAreReportedWhenKibanaHasNoPatchData();
    await testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights();
    await testDynamicWeightMinOutputThresholdZeroDisablesGate();
    await testDynamicWeightVolatilityOnlyPathRemainsReady();
    await testDynamicWeightVolatilityOverridesFlowIntoService();
    await testDynamicWeightSuppressedTrendUsesFlatProfile();
    await testDynamicWeightWeightOnlyWritesPersistEveryCycle();
    await testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState();
    await testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData();
    await testDynamicWeightInvalidAtrPeriodAndClampAreSanitized();
}

run()
    .then(() => {
        console.log('price adapter service tests passed');
    })
    .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
