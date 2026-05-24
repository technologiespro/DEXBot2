'use strict';

/**
 * market_adapter/utils/ws_client.js — Compatibility wrapper for read-only client
 *
 * Kept for older imports, but the implementation is consolidated on
 * modules/bitshares-native/createReadOnlyClient so market_adapter uses the
 * same transport, failover, timeout, and RPC behavior as the rest of DEXBot2.
 */

const { createReadOnlyClient } = require('../../modules/bitshares-native');

function createWsClient() {
    return createReadOnlyClient({});
}

module.exports = { createWsClient };
