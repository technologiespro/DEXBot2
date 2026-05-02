const assert = require('assert');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.js');
const nodeManagerPath = path.resolve(__dirname, '../modules/node_manager.js');
const btsdexPath = require.resolve('btsdex');
const btsdexEventPath = require.resolve('btsdex/lib/event');
const btsdexAccountPath = require.resolve('btsdex/lib/account');
const btsdexApiPath = require.resolve('btsdex-api');
const btsdexEventPatchPath = path.resolve(__dirname, '../modules/btsdex_event_patch.js');
const generalSettingsPath = path.resolve(__dirname, '../modules/general_settings.js');

function installStubs(settings = null) {
    delete require.cache[btsdexEventPatchPath];
    let shouldConnectSucceed = false;
    const connectCalls = [];
    const disconnectCalls = [];
    let connectedCallback = null;
    let statusCallback = null;
    const createdManagers = [];

    class FakeNodeManager {
        constructor(config = {}) {
            this.config = config;
            this.checkCalls = 0;
            createdManagers.push(this);
        }

        async checkAllNodes() {
            this.checkCalls += 1;
        }

        start() {
            this.monitoringActive = true;
        }

        getHealthyNodes() {
            return this.checkCalls > 0
                ? ['wss://healthy-node.example/ws']
                : [];
        }

        getStats() {
            return (this.config.list || []).map((url) => ({
                url,
                status: 'healthy',
                latencyMs: 42,
            }));
        }

        getSummary() {
            return {
                counts: {
                    total: (this.config.list || []).length,
                    healthy: (this.config.list || []).length,
                    slow: 0,
                    failed: 0,
                    blacklisted: 0,
                    unchecked: 0,
                },
                bestNode: 'wss://healthy-node.example/ws',
                avgLatency: 42,
            };
        }
    }

    const originalNodeManager = setCachedModule(nodeManagerPath, FakeNodeManager);
    const originalGeneralSettings = setCachedModule(generalSettingsPath, {
        readGeneralSettings: () => settings,
    });
    const originalBitshares = setCachedModule(btsdexPath, {
        node: null,
        autoreconnect: true,
        connectPromise: undefined,
        async connect(servers) {
            connectCalls.push(Array.isArray(servers) ? servers.slice() : servers);
            if (!shouldConnectSucceed) {
                throw new Error('connect failed');
            }
            if (typeof statusCallback === 'function') {
                statusCallback('open');
            }
            return true;
        },
        subscribe() {
            return undefined;
        },
        disconnect() {
            disconnectCalls.push(Date.now());
            return undefined;
        },
    });

    const fakeEvent = {
        connected: {
            subFunc: () => Promise.resolve(true),
        },
        resubscribe: async () => {},
    };

    const originalEvent = setCachedModule(btsdexEventPath, { default: fakeEvent });
    const originalAccount = setCachedModule(btsdexAccountPath, { default: {} });
    const originalApi = setCachedModule(btsdexApiPath, {
        history: {},
        setNotifyStatusCallback(cb) {
            statusCallback = cb;
        },
        async connect(servers) {
            connectCalls.push(Array.isArray(servers) ? servers.slice() : servers);
            return Promise.resolve();
        },
        async disconnect() {
            disconnectCalls.push(Date.now());
            return Promise.resolve();
        },
        getStatus() {
            return 'closed';
        },
    });

    return {
        createdManagers,
        connectCalls,
        disconnectCalls,
        getConnectedCallback: () => connectedCallback,
        getStatusCallback: () => statusCallback,
        setConnectSucceed(value) {
            shouldConnectSucceed = !!value;
        },
        restore() {
            restoreCachedModule(nodeManagerPath, originalNodeManager);
            restoreCachedModule(generalSettingsPath, originalGeneralSettings);
            restoreCachedModule(btsdexPath, originalBitshares);
            restoreCachedModule(btsdexEventPath, originalEvent);
            restoreCachedModule(btsdexAccountPath, originalAccount);
            restoreCachedModule(btsdexApiPath, originalApi);
            delete require.cache[bitsharesClientPath];
            delete require.cache[btsdexEventPatchPath];
        },
    };
}

async function runRecoveryScenario() {
    const stubs = installStubs();
    try {
        delete require.cache[bitsharesClientPath];
        const bsModule = require('../modules/bitshares_client');

        setTimeout(() => {
            stubs.setConnectSucceed(true);
        }, 40);

        await bsModule.waitForConnected(1000, {
            retryDelayMs: 5,
            maxRetryDelayMs: 20,
            refreshNodesEveryMs: 10,
        });

        assert.ok(stubs.createdManagers.length > 0, 'NodeManager should be constructed');
        assert.ok(stubs.createdManagers[0].checkCalls >= 1, 'Startup should probe node health');
        assert.ok(stubs.connectCalls.length >= 1, 'Startup should request a BitShares reconnect');
        assert.ok(stubs.disconnectCalls.length >= 1, 'Startup should clear any stale connection before reconnecting');
        assert.deepStrictEqual(
            stubs.connectCalls[0],
            ['wss://healthy-node.example/ws'],
            'Startup should prefer the healthy server list'
        );
        assert.deepStrictEqual(
            bsModule.BitShares.node,
            ['wss://healthy-node.example/ws'],
            'BitShares node list should be updated centrally'
        );
    } finally {
        stubs.restore();
    }
}

async function runTimeoutScenario() {
    const stubs = installStubs();
    try {
        delete require.cache[bitsharesClientPath];
        const bsModule = require('../modules/bitshares_client');

        let error = null;
        try {
            await bsModule.waitForConnected(120, {
                retryDelayMs: 5,
                maxRetryDelayMs: 20,
                refreshNodesEveryMs: 10,
            });
        } catch (err) {
            error = err;
        }

        assert.ok(error, 'Startup should fail after exhausting the timeout');
        assert.ok(/Timed out waiting for BitShares connection/.test(error.message), 'Timeout error should be explicit');
        assert.ok(stubs.createdManagers.length > 0, 'NodeManager should be constructed');
        assert.ok(stubs.createdManagers[0].checkCalls >= 1, 'Timeout path should still probe node health');
        assert.ok(stubs.connectCalls.length >= 1, 'Timeout path should still request reconnect attempts');
    } finally {
        stubs.restore();
    }
}

async function runStatusClosedScenario() {
    const stubs = installStubs();
    try {
        delete require.cache[bitsharesClientPath];
        const bsModule = require('../modules/bitshares_client');

        stubs.setConnectSucceed(true);
        await bsModule.waitForConnected(1000, {
            retryDelayMs: 5,
            maxRetryDelayMs: 20,
            refreshNodesEveryMs: 10,
        });

        assert.strictEqual(bsModule._internal.connected, true, 'Client should report connected after startup');

        const statusCallback = stubs.getStatusCallback();
        assert.ok(typeof statusCallback === 'function', 'Status callback should be registered');
        const handled = statusCallback('closed');
        assert.strictEqual(handled, true, 'NodeManager should own reconnect and suppress btsdex-api auto-reconnect');
        assert.strictEqual(bsModule._internal.connected, false, 'Closed status should clear the shared connected flag immediately');
        assert.strictEqual(bsModule.getConnectionError(), null, 'Closed status should clear stale connection errors');
        await bsModule._assessFailover('Connection closed');
    } finally {
        stubs.restore();
    }
}

async function runHealthCheckDisabledScenario() {
    const configuredList = ['wss://configured-node.example/ws'];
    const stubs = installStubs({
        NODES: {
            enabled: true,
            list: configuredList,
            healthCheck: { enabled: false },
        },
    });
    try {
        delete require.cache[bitsharesClientPath];
        const bsModule = require('../modules/bitshares_client');

        stubs.setConnectSucceed(true);
        await bsModule.waitForConnected(1000, {
            retryDelayMs: 5,
            maxRetryDelayMs: 20,
            refreshNodesEveryMs: 10,
        });

        assert.ok(stubs.createdManagers.length > 0, 'NodeManager should still be constructed');
        assert.strictEqual(stubs.createdManagers[0].checkCalls, 0, 'Disabled health checks should skip startup probes');
        assert.deepStrictEqual(stubs.connectCalls[0], configuredList, 'Startup should use configured nodes directly');
        assert.notStrictEqual(stubs.createdManagers[0].monitoringActive, true, 'Disabled health checks should not start monitoring');
    } finally {
        stubs.restore();
    }
}

async function main() {
    console.log('Testing BitShares client startup retry behavior...\n');
    await runRecoveryScenario();
    await runTimeoutScenario();
    await runStatusClosedScenario();
    await runHealthCheckDisabledScenario();
    console.log('✓ BitShares client startup retry tests passed\n');
}

main().catch((err) => {
    console.error('BitShares client startup retry test failed:', err.message || err);
    process.exitCode = 1;
});
