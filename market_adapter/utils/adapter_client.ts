'use strict';

/**
 * market_adapter/utils/adapter_client.js — Singleton BitShares WS client
 *
 * Provides the same interface as bitshares_client.js but backed by the native
 * bitshares-native read-only client. No subscriptions — just connect, query,
 * disconnect, with the native transport's node failover and timeout handling.
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

let _nativeClient = null;

function _getClient() {
    if (!_nativeClient) {
        const { createReadOnlyClient } = require('../../modules/bitshares-native');
        _nativeClient = createReadOnlyClient({});
    }
    return _nativeClient;
}

async function connectClient(servers) {
    const c = _getClient();
    const list = Array.isArray(servers) && servers.length > 0
        ? servers
        : NODE_MANAGEMENT.DEFAULT_NODES;
    return c.connect(list);
}

function disconnectClient() {
    if (_nativeClient) { _nativeClient.disconnect(); _nativeClient = null; }
}

function isConnected() {
    return _nativeClient ? _nativeClient.isConnected() : false;
}

function getNodeUrl() {
    return _nativeClient ? _nativeClient.getNodeUrl() : null;
}

function getConnectionStatus() {
    return isConnected() ? 'open' : 'closed';
}

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
        },
    }),
    history: new Proxy({}, {
        get(_target, method) {
            return (...args) => _call('history', method, args);
        },
    }),
};

function _resetForTests() {
    if (_nativeClient) {
        try { _nativeClient.disconnect(); } catch (_: any) {}
        _nativeClient = null;
    }
}

export = {
    BitShares,
    connectClient,
    disconnectClient,
    isConnected,
    getNodeUrl,
    getConnectionStatus,
    _resetForTests,
};
