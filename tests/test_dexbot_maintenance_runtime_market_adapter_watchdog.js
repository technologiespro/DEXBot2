const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot maintenance runtime market adapter watchdog tests');

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

function loadRuntimeWithStubs() {
    delete require.cache[runtimePath];

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(chainOrdersPath, {
        readOpenOrders: async () => [],
    });
    setCachedModule(gridPath, {
        recalculateGrid: async () => {},
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
        loadAmaCenterSnapshot: () => null,
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {
        parseJsonWithComments: (text) => JSON.parse(text),
    });

    return require(runtimePath);
}

async function testSnapshotReaderDetectsAMAConfig() {
    const botsFile = '/home/alex/BTS/Git/DEXBot2/profiles/bots.json';

    fs.existsSync = (filePath) => String(filePath) === botsFile;
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath) === botsFile) {
            return JSON.stringify({
                bots: [
                    { name: 'AMA Bot', active: true, gridPrice: 'ama3' },
                    { name: 'Book Bot', active: true, gridPrice: 'book' },
                ],
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    const { loadBotsConfigSnapshot } = loadRuntimeWithStubs();
    const snapshot = loadBotsConfigSnapshot();

    assert.strictEqual(snapshot.exists, true, 'bots.json should be detected');
    assert.strictEqual(snapshot.activeBots.length, 2, 'all active bots should be returned');
    assert.strictEqual(snapshot.needsPriceAdapter, true, 'AMA grid pricing should require the price adapter');
    assert.ok(snapshot.fingerprint, 'fingerprint should be populated');
}

async function testWatchdogStartsAdapterWhenMissing() {
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let started = false;
    let queried = false;
    const logs = [];

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-1',
            activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
            needsPriceAdapter: true,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return [];
        },
        _startPriceAdapterPm2: async () => {
            started = true;
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck.call(self, 'unit-test');

    assert.strictEqual(queried, true, 'watchdog should query PM2 when AMA pricing is active');
    assert.strictEqual(started, true, 'watchdog should start the adapter when it is missing');
    assert.strictEqual(result.changed, true, 'first snapshot should be treated as a change');
    assert.strictEqual(result.required, true, 'AMA pricing should require the adapter');
    assert.strictEqual(result.started, true, 'watchdog should report a successful start');
    assert.ok(
        logs.some((msg) => String(msg).includes('Started dexbot-price-adapter')),
        'watchdog should log the adapter start'
    );
}

async function testWatchdogSkipsLaunchWhenAdapterNotNeeded() {
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let queried = false;
    let started = false;
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsPriceAdapter: false,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return ['dexbot-price-adapter'];
        },
        _startPriceAdapterPm2: async () => {
            started = true;
        },
        _stopPriceAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck.call(self, 'unit-test');

    assert.strictEqual(result.changed, true, 'config fingerprint changes should still be detected');
    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(queried, true, 'PM2 should be queried so stale adapter processes can be stopped');
    assert.strictEqual(started, false, 'adapter start should be skipped when not needed');
    assert.strictEqual(stopped, true, 'running adapter should be stopped when it is no longer needed');
    assert.strictEqual(result.stopped, true, 'watchdog should report the adapter stop');
}

async function testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent() {
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsPriceAdapter: false,
        }),
        _getPm2ProcessNames: async () => [],
        _stopPriceAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck.call(self, 'unit-test');

    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(result.stopped, false, 'watchdog should not stop an adapter that is already absent');
    assert.strictEqual(stopped, false, 'stop should not be attempted when the adapter is already absent');
}

async function testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn() {
    const { setupBlockchainFetchInterval } = loadRuntimeWithStubs();
    let snapshotChecks = 0;
    const logs = [];

    const self = {
        config: { blockchainFetchIntervalMinutes: 0 },
        manager: null,
        accountId: null,
        _blockchainFetchInterval: null,
        _loadBotsConfigSnapshot: async () => {
            snapshotChecks += 1;
            return {
                exists: true,
                fingerprint: 'startup-fingerprint',
                activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
                needsPriceAdapter: true,
            };
        },
        _getPm2ProcessNames: async () => ['dexbot-price-adapter'],
        _startPriceAdapterPm2: async () => {
            throw new Error('should not start when already running');
        },
        _stopBlockchainFetchInterval: () => {},
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    setupBlockchainFetchInterval.call(self);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(snapshotChecks, 1, 'startup path should run the market adapter watchdog immediately');
    assert.ok(
        logs.some((msg) => String(msg).includes('Blockchain fetch interval disabled')),
        'disabled interval should still log the disabled state after the startup watchdog check'
    );
}

async function main() {
    try {
        await testSnapshotReaderDetectsAMAConfig();
        await testWatchdogStartsAdapterWhenMissing();
        await testWatchdogSkipsLaunchWhenAdapterNotNeeded();
        await testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent();
        await testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn();
        console.log('dexbot maintenance runtime market adapter watchdog tests passed');
    } finally {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        for (const [modulePath, original] of originals.entries()) {
            restoreCachedModule(modulePath, original);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
