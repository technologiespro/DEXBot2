'use strict';

const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot maintenance runtime dynamic weight tests');

const runtimePath = require.resolve('../modules/dexbot_maintenance_runtime');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainOrdersPath = require.resolve('../modules/chain_orders');
const gridPath = require.resolve('../modules/order/grid');
const constantsPath = require.resolve('../modules/constants');
const systemPath = require.resolve('../modules/order/utils/system');
const formatPath = require.resolve('../modules/order/format');
const orderUtilsPath = require.resolve('../modules/order/utils/order');
const accountBotsPath = require.resolve('../modules/account_bots');

const originals = new Map([
    [runtimePath, require.cache[runtimePath]],
    [bitsharesClientPath, require.cache[bitsharesClientPath]],
    [chainOrdersPath, require.cache[chainOrdersPath]],
    [gridPath, require.cache[gridPath]],
    [constantsPath, require.cache[constantsPath]],
    [systemPath, require.cache[systemPath]],
    [formatPath, require.cache[formatPath]],
    [orderUtilsPath, require.cache[orderUtilsPath]],
    [accountBotsPath, require.cache[accountBotsPath]],
]);

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalUnlinkSync = fs.unlinkSync;
let dynamicWeightSnapshotMode = 'live';

async function testPerformGridResyncAppliesVolatilityOnlyDynamicWeights() {
    const logs = [];
    let recalculateCalled = false;
    let persistCalled = false;
    let startCalled = false;
    let finishCalled = false;

    delete require.cache[runtimePath];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) return true;
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) return true;
        if (text.endsWith('/tmp/nonexistent-dw.trigger')) return false;
        return originalExistsSync(filePath);
    };

    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Volatility Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    'volatility-bot-0': { ama: true, dynamicWeight: true },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    fs.unlinkSync = () => {};

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(chainOrdersPath, {
        readOpenOrders: async () => [],
    });
    setCachedModule(gridPath, {
        recalculateGrid: async (manager, opts) => {
            recalculateCalled = true;
            assert.deepStrictEqual(
                manager.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'manager config should receive the volatility-only dynamic weights before recalculation'
            );
            assert.deepStrictEqual(
                opts.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'recalculateGrid should receive the updated weight distribution'
            );
        },
    });
    setCachedModule(constantsPath, {
        ORDER_STATES: {},
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
    });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async () => {},
        loadAmaCenterSnapshot: () => ({
            centerPrice: 100,
            dynamicWeights: {
                isReady: dynamicWeightSnapshotMode === 'live',
                trend: 'NEUTRAL',
                confidence: 0,
                effectiveWeights: { sell: 0.42, buy: 0.22 },
            },
        }),
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {
        parseJsonWithComments: (text) => JSON.parse(text),
    });

    const { performGridResync } = require(runtimePath);

    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        manager: {
            config: {
                name: 'Volatility Bot',
                botKey: 'volatility-bot-0',
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 5 },
            startBootstrap: () => { startCalled = true; },
            finishBootstrap: () => { finishCalled = true; },
            persistGrid: async () => { persistCalled = true; },
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile: '/tmp/nonexistent-dw.trigger',
    };

    const ok = await performGridResync.call(self);

    assert.strictEqual(ok, true, 'performGridResync should succeed');
    assert.strictEqual(startCalled, true, 'bootstrap should start');
    assert.strictEqual(finishCalled, true, 'bootstrap should finish');
    assert.strictEqual(recalculateCalled, true, 'grid recalculation should run');
    assert.strictEqual(persistCalled, true, 'grid state should persist after resync');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.strictEqual(self.manager.funds.btsFeesOwed, 0, 'fee accumulator should reset after resync');
    assert.ok(
        logs.some((msg) => String(msg).includes('Applied live dynamic weights (grid resync): sell=0.42 buy=0.22')),
        'resync should log that it applied the dynamic weights'
    );
}

function testRefreshDynamicWeightDistributionAppliesAndFallsBack() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    dynamicWeightSnapshotMode = 'live';
    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: () => {},
    };

    const applied = refreshDynamicWeightDistribution.call(self, 'unit-test-live');
    assert.strictEqual(applied.applied, true, 'ready dynamic weights should be applied');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });

    dynamicWeightSnapshotMode = 'stale';
    const reverted = refreshDynamicWeightDistribution.call(self, 'unit-test-stale');
    assert.strictEqual(reverted.applied, false, 'stale dynamic weights should not be applied');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
}

function testRefreshDynamicWeightDistributionReloadsWhitelistFlags() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    let whitelistEnabled = true;
    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) return true;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    'volatility-bot-0': { ama: true, dynamicWeight: whitelistEnabled },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    dynamicWeightSnapshotMode = 'live';
    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: () => {},
    };

    const applied = refreshDynamicWeightDistribution.call(self, 'unit-test-live-whitelist');
    assert.strictEqual(applied.applied, true, 'whitelisted bot should apply live weights');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });

    whitelistEnabled = false;
    const reverted = refreshDynamicWeightDistribution.call(self, 'unit-test-whitelist-removed');
    assert.strictEqual(reverted.applied, false, 'refresh should pick up whitelist removal without restart');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
}

async function main() {
    try {
        await testPerformGridResyncAppliesVolatilityOnlyDynamicWeights();
        testRefreshDynamicWeightDistributionAppliesAndFallsBack();
        testRefreshDynamicWeightDistributionReloadsWhitelistFlags();
        console.log('dexbot maintenance runtime dynamic weight tests passed');
    } finally {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        fs.unlinkSync = originalUnlinkSync;
        for (const [modulePath, original] of originals.entries()) {
            restoreCachedModule(modulePath, original);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
