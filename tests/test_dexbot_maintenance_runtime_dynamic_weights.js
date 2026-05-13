'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
                isReady: dynamicWeightSnapshotMode !== 'stale',
                trend: 'NEUTRAL',
                confidence: 0,
                effectiveWeights: { sell: 0.42, buy: 0.22 },
                baseWeights: dynamicWeightSnapshotMode === 'base-changed'
                    ? { sell: 0.8, buy: 0.2 }
                    : { sell: 0.6, buy: 0.4 },
            },
        }),
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {});

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

async function testManualTriggerResetRefreshesCenterPrice() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `manual-reset-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, JSON.stringify({
        centerPrice: 100,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: 'market_adapter/market_adapter.js',
        updatedAt: '2026-01-01T00:00:00Z',
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(triggerFile, '', 'utf8');

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;
    const logs = [];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Manual Reset Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Manual Reset Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Manual Reset Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        _performGridResync: async (options) => require(runtimePath).performGridResync.call(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset.call(self);
        assert.strictEqual(ok, true, 'manual trigger reset should succeed');

        const updated = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
        assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should refresh centerPrice from amaCenterPrice');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset for the rebuild');
        assert.ok(
            logs.some((msg) => String(msg).includes('Refreshed AMA center snapshot for manual grid reset.')),
            'manual reset should log that the center snapshot was refreshed'
        );
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        originalUnlinkSync(triggerFile);
        originalUnlinkSync(snapshotFile);
    }
}

async function testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `manual-reset-current-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, JSON.stringify({
        gridCenterPrice: 123.45,
        centerPrice: 123.45,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: 'market_adapter/market_adapter.js',
        updatedAt: '2026-01-01T00:00:00Z',
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(triggerFile, '', 'utf8');

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Manual Reset Current Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Manual Reset Current Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Manual Reset Current Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: () => {},
        _warn: () => {},
        _performGridResync: async (options) => require(runtimePath).performGridResync.call(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset.call(self);
        assert.strictEqual(ok, true, 'manual trigger reset should succeed when center already equals AMA');

        const updated = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
        assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should leave the current AMA center intact');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset when center is already current');
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        originalUnlinkSync(triggerFile);
        originalUnlinkSync(snapshotFile);
    }
}

function testRefreshDynamicWeightDistributionRejectsStaleBaseWeights() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    const prevExistsSync = fs.existsSync;
    const prevReadFileSync = fs.readFileSync;

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
                    'volatility-bot-0': { ama: true, dynamicWeight: true },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    dynamicWeightSnapshotMode = 'base-changed';
    const logs = [];
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
        _log: (msg) => logs.push(msg),
    };

    const result = refreshDynamicWeightDistribution.call(self, 'unit-test-base-mismatch');
    assert.strictEqual(result.applied, false, 'stale base weights should cause fallback to static');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.ok(
        logs.some((msg) => String(msg).includes('Skipping stale dynamic weights')),
        'should log a warning about stale dynamic weights'
    );
    assert.ok(
        logs.some((msg) => String(msg).includes('snapshot base (sell=0.8, buy=0.2) != config (sell=0.6, buy=0.4)')),
        'should log the mismatched base vs config values'
    );

    fs.existsSync = prevExistsSync;
    fs.readFileSync = prevReadFileSync;
    dynamicWeightSnapshotMode = 'live';
}

async function main() {
    try {
        await testPerformGridResyncAppliesVolatilityOnlyDynamicWeights();
        testRefreshDynamicWeightDistributionAppliesAndFallsBack();
        testRefreshDynamicWeightDistributionReloadsWhitelistFlags();
        testRefreshDynamicWeightDistributionRejectsStaleBaseWeights();
        await testManualTriggerResetRefreshesCenterPrice();
        await testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent();
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
