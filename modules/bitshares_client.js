'use strict';

const { loadDistWithMirrors } = require('./load_dist_with_mirrors');

module.exports = loadDistWithMirrors(__dirname, '../dist/modules/bitshares_client.js', [
    ['./node_manager.js', '../dist/modules/node_manager.js'],
]);
