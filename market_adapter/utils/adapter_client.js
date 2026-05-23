'use strict';

/**
 * market_adapter/utils/adapter_client.js — Singleton BitShares WS client
 *
 * Provides the same interface as bitshares_client.js but backed by either the
 * native bitshares-native library or a raw WebSocket + JSON-RPC 2.0 client.
 * No cached promises, no auto-reconnect, no event subscriptions — just
 * connect, query, disconnect.
 *
 * Feature flag: DEXBOT_NATIVE_CHAIN=1 uses native library's createReadOnlyClient.
 *
 * Exported interface (mirrors bitshares_client.js):
 *   BitShares    — { db, history } JSON-RPC proxies
 *   connectClient(servers)  — connect to a list of WSS nodes
 *   disconnectClient()      — tear down the WebSocket
 *   isConnected()           — check if the WS is open
 *   getNodeUrl()            — currently connected node URL
 *   getConnectionStatus()   — 'open' | 'closed' | 'connecting'
 */

const { NODE_MANAGEMENT } = require('../../modules/constants');

const USE_NATIVE = process.env.DEXBOT_NATIVE_CHAIN === '1';

let _client = null;
let _nativeClient = null;

function _getClient() {
    if (USE_NATIVE) {
        if (!_nativeClient) {
            const { createReadOnlyClient } = require('../../modules/bitshares-native');
            _nativeClient = createReadOnlyClient({});
        }
        return _nativeClient;
    } else {
        const { createWsClient } = require('./ws_client');
        if (!_client) {
            _client = createWsClient();
        }
        return _client;
    }
}

async function connectClient(servers) {
    const c = _getClient();
    const list = Array.isArray(servers) && servers.length > 0
        ? servers
        : NODE_MANAGEMENT.DEFAULT_NODES;
    return c.connect(list);
}

function disconnectClient() {
    if (USE_NATIVE) {
        if (_nativeClient) { _nativeClient.disconnect(); _nativeClient = null; }
    } else {
        if (_client) _client.disconnect();
    }
}

function isConnected() {
    if (USE_NATIVE) {
        return _nativeClient ? _nativeClient.isConnected() : false;
    }
    return _client ? _client.isConnected() : false;
}

function getNodeUrl() {
    if (USE_NATIVE) {
        return _nativeClient ? _nativeClient.getNodeUrl() : null;
    }
    return _client ? _client.getNodeUrl() : null;
}

function getConnectionStatus() {
    return isConnected() ? 'open' : 'closed';
}

function _call(api, method, args) {
    const c = _getClient();
    if (USE_NATIVE) {
        if (!c.isConnected()) {
            return Promise.reject(new Error('WebSocket is not open'));
        }
        return c[api](method, args);
    } else {
        if (!c.isConnected()) {
            return Promise.reject(new Error('WebSocket is not open'));
        }
        return c[api](method, args);
    }
}

const BitShares = {
    db: new Proxy({}, {
        get(_target, method) {
            return (...args) => _call('db', method, args);
        },
    }),
    history: new Proxy({}, {
        get(_target, method) {
            return (...args) => _call('history', method, args);
        },
    }),
};

function _resetForTests() {
    if (USE_NATIVE) {
        if (_nativeClient) {
            try { _nativeClient.disconnect(); } catch (_) {}
            _nativeClient = null;
        }
    } else {
        if (_client) _client.disconnect();
        _client = null;
    }
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
