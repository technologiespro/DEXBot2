const assert = require('assert');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Testing BitShares client node-manager defaults...\n');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.js');
const btsdexPath = require.resolve('btsdex');
const btsdexEventPath = require.resolve('btsdex/lib/event');
const btsdexAccountPath = require.resolve('btsdex/lib/account');
const btsdexApiPath = require.resolve('btsdex-api');

const originalBitshares = setCachedModule(btsdexPath, {
    subscribe() {},
    _api: { connection: { setServers() {} } },
});
const originalEvent = setCachedModule(btsdexEventPath, { default: {}, connected: {} });
const originalAccount = setCachedModule(btsdexAccountPath, { default: {} });
const originalApi = setCachedModule(btsdexApiPath, {
    history: {},
    setNotifyStatusCallback() {},
});

try {
    delete require.cache[bitsharesClientPath];
    const bsModule = require('../modules/bitshares_client');

    const nodeManager = bsModule.getNodeManager();
    const stats = bsModule.getNodeStats();
    const summary = bsModule.getNodeSummary();

    assert.ok(nodeManager, 'NodeManager should be enabled by default');
    assert.ok(Array.isArray(stats), 'Node stats should be available');
    assert.ok(stats.length > 0, 'Default node list should be populated');
    assert.ok(summary && summary.counts && summary.counts.total > 0, 'Node summary should report configured nodes');

    console.log('✓ BitShares client node-manager default test passed\n');
} finally {
    restoreCachedModule(btsdexPath, originalBitshares);
    restoreCachedModule(btsdexEventPath, originalEvent);
    restoreCachedModule(btsdexAccountPath, originalAccount);
    restoreCachedModule(btsdexApiPath, originalApi);
    delete require.cache[bitsharesClientPath];
}
