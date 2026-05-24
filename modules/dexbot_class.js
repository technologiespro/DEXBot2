'use strict';

const { loadDistWithMirrors } = require('./load_dist_with_mirrors');

module.exports = loadDistWithMirrors(__dirname, '../dist/modules/dexbot_class.js', [
    ['./bitshares_client.js', '../dist/modules/bitshares_client.js'],
    ['./chain_orders.js', '../dist/modules/chain_orders.js'],
    ['./dexbot_maintenance_runtime.js', '../dist/modules/dexbot_maintenance_runtime.js'],
    ['./credit_runtime.js', '../dist/modules/credit_runtime.js'],
    ['./order/startup_reconcile.js', '../dist/modules/order/startup_reconcile.js'],
]);
