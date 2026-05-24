'use strict';

const { loadDistWithMirrors } = require('./load_dist_with_mirrors');

module.exports = loadDistWithMirrors(__dirname, '../dist/modules/credit_runtime.js', [
    ['./bitshares_client.js', '../dist/modules/bitshares_client.js'],
    ['./chain_orders.js', '../dist/modules/chain_orders.js'],
]);
