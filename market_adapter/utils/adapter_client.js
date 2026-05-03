'use strict';

/**
 * market_adapter/utils/adapter_client.js — Singleton BitShares WS client
 *
 * Provides the same interface as bitshares_client.js but backed by a raw
 * WebSocket + JSON-RPC 2.0 client instead of the btsdex library.  No
 * cached promises, no auto-reconnect, no event subscriptions — just
 * connect, query, disconnect.
 *
 * Exported interface (mirrors bitshares_client.js):
 *   BitShares    — { db, history } JSON-RPC proxies
 *   connectClient(servers)  — connect to a list of WSS nodes
 *   disconnectClient()      — tear down the WebSocket
 *   isConnected()           — check if the WS is open
 *   getNodeUrl()            — currently connected node URL
 *   getConnectionStatus()   — 'open' | 'closed' | 'connecting'
 */

const { createWsClient } = require('./ws_client');
const { NODE_MANAGEMENT } = require('../../modules/constants');

let _client = null;

function _getClient() {
    if (!_client) {
        _client = createWsClient();
    }
    return _client;
}

async function connectClient(servers) {
    const c = _getClient();
    const list = Array.isArray(servers) && servers.length > 0
        ? servers
        : NODE_MANAGEMENT.DEFAULT_NODES;
    return c.connect(list);
}

function disconnectClient() {
    if (_client) _client.disconnect();
}

function isConnected() {
    return _client ? _client.isConnected() : false;
}

function getNodeUrl() {
    return _client ? _client.getNodeUrl() : null;
}

function getConnectionStatus() {
    return isConnected() ? 'open' : 'closed';
}

// ── BitShares-compatible proxy ───────────────────────────────────────────
// Provides db.method(args) and history.method(args) matching the btsdex API.

function _call(api, method, args) {
    const c = _getClient();
    if (!c.isConnected()) {
        return Promise.reject(new Error('WebSocket is not open'));
    }
    return c[api](method, args);
}

const BitShares = {
    db: new Proxy({}, {
        get(_target, method) {
            return (...args) => _call('db', method, args);
        }
    }),
    history: new Proxy({}, {
        get(_target, method) {
            return (...args) => _call('history', method, args);
        }
    }),
};

function _resetForTests() {
    if (_client) _client.disconnect();
    _client = null;
}

module.exports = {
    BitShares,
    connectClient,
    disconnectClient,
    isConnected,
    getNodeUrl,
    getConnectionStatus,
    _resetForTests,
};
