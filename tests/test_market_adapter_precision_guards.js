const assert = require('assert');
const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { rawToHuman } = require('../market_adapter/candle_utils');

console.log('Running market adapter precision guard tests');

// 1. Test rawToHuman MAX_SAFE_INTEGER warning
{
    console.log('  Testing rawToHuman precision warning...');
    let warningLogged = false;
    const originalWarn = console.warn;
    console.warn = (msg) => {
        if (msg.includes('[PRECISION-WARNING]')) {
            warningLogged = true;
        }
    };

    try {
        const safe = rawToHuman('1000000000', 8);
        assert.strictEqual(safe, 10, 'safe value should be converted correctly');
        assert.strictEqual(warningLogged, false, 'safe value should not trigger warning');

        const unsafe = rawToHuman('9007199254740993', 0);
        assert.strictEqual(warningLogged, true, 'value exceeding MAX_SAFE_INTEGER should trigger warning');
    } finally {
        console.warn = originalWarn;
    }
}

// 2. Test MarketAdapterService center price rounding
async function testServiceRounding() {
    console.log('  Testing MarketAdapterService 8-decimal rounding...');
    
    let persistedSnapshotPrice = null;
    let persistedAmaPrice = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'A' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'B' },
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: () => '/tmp/test_candles.json',
        loadJson: () => null,
        saveJson: () => {},
        calculateBotThreshold: () => 0.1,
        computeCandleStaleness: () => ({ staleData: false }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                const price = 1.23456789123;
                const candles = [];
                const baseTs = 1700000000000;
                for (let i = 0; i < 200; i++) {
                    candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
                }
                return candles;
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [] }),
        mergeCandles: (a, b) => [...a, ...b],
        pruneCandles: (c) => c,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/trigger',
        writeBotDynamicGrid: (key, price, options) => {
            persistedSnapshotPrice = price;
            persistedAmaPrice = options.amaCenterPrice;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: '/tmp',
        path: require('path'),
    });

    const bot = { botKey: 'test-bot', gridPrice: 'ama', assetA: 'A', assetB: 'B' };
    const state = { bots: {} };
    const cfg = { intervalSeconds: 3600, maxStaleHours: 6 };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    if (!result.ok) {
        throw new Error(`processBot failed: ${result.error || result.reason || JSON.stringify(result)}`);
    }

    const expected = 1.23456789; // Rounded to 8 decimals
    
    // Check internal state
    const botState = state.bots['test-bot'];
    if (!botState) {
        console.log('Result:', result);
        console.log('State:', state);
        throw new Error('botState was not populated in state.bots');
    }
    assert.strictEqual(botState.centerPrice, expected, 'internal centerPrice should be rounded to 8 decimals');
    assert.strictEqual(botState.amaCenterPrice, expected, 'internal amaCenterPrice should be rounded to 8 decimals');
    
    // Check persisted snapshot
    assert.strictEqual(persistedSnapshotPrice, expected, 'persisted snapshot price should be rounded');
    assert.strictEqual(persistedAmaPrice, expected, 'persisted amaCenterPrice should be rounded');
}

testServiceRounding().then(() => {
    console.log('All precision guard tests passed');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
