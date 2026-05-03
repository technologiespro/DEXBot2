'use strict';

/**
 * market_adapter/utils/ws_client.js — Lightweight BitShares JSON-RPC client
 *
 * Replaces btsdex for the market adapter's read-only chain queries.
 * No subscriptions, no events, no auto-reconnect — just a raw WebSocket
 * with JSON-RPC 2.0 call() and a simple connect/disconnect lifecycle.
 *
 * Usage:
 *   const client = createWsClient();
 *   await client.connect(['wss://node1/ws', 'wss://node2/ws']);
 *   const assets = await client.db('lookup_asset_symbols', [['BTS']]);
 *   const history = await client.history('get_market_history', [...]);
 *   client.disconnect();
 */

const WebSocket = require('isomorphic-ws');

const CONNECT_TIMEOUT_MS = 10000;
const RPC_TIMEOUT_MS = 15000;
let _rpcId = 1;

function createWsClient() {
    let ws = null;
    let connected = false;
    let nodeUrl = null;
    let _dbApiId = null;
    let _historyApiId = null;

    // ── WebSocket helpers ────────────────────────────────────────────────

    function connectOne(url, timeoutMs = CONNECT_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url);
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error(`handshake timeout ${timeoutMs}ms`));
            }, timeoutMs);
            socket.onopen = () => {
                clearTimeout(timer);
                resolve(socket);
            };
            socket.onerror = () => {};
            socket.onclose = (evt) => {
                clearTimeout(timer);
                reject(new Error(`handshake closed code=${evt.code}`));
            };
        });
    }

    function rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
        if (!ws || ws.readyState !== 1) {
            return Promise.reject(new Error('WebSocket not open'));
        }
        const id = _rpcId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`RPC timeout ${timeoutMs}ms`));
            }, timeoutMs);
            const handler = (raw) => {
                try {
                    const msg = JSON.parse(raw.data);
                    if (String(msg.id) !== String(id)) return;
                    clearTimeout(timer);
                    ws.removeEventListener('message', handler);
                    if (msg.error) {
                        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                        resolve(msg.result);
                    }
                } catch (_) {}
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
        });
    }

    // ── Public API ───────────────────────────────────────────────────────

    async function connect(servers) {
        const list = Array.isArray(servers) ? servers.filter((s) => s && typeof s === 'string') : [];
        if (list.length === 0) throw new Error('No servers provided');

        disconnect();

        // Try each server in order
        let lastErr = null;
        for (const url of list) {
            try {
                ws = await connectOne(url);
                nodeUrl = url;
                break;
            } catch (err) {
                lastErr = err;
                continue;
            }
        }
        if (!ws) throw lastErr || new Error('All servers unreachable');

        // Login + register APIs
        await rpc('call', [1, 'login', ['', '']]);
        _dbApiId = await rpc('call', [1, 'database', []]);
        _historyApiId = await rpc('call', [1, 'history', []]);

        connected = true;
        return true;
    }

    function disconnect() {
        connected = false;
        if (ws) {
            try { ws.close(); } catch (_) {}
            ws = null;
        }
        _dbApiId = null;
        _historyApiId = null;
        nodeUrl = null;
    }

    function isConnected() {
        return connected && ws && ws.readyState === 1;
    }

    function getNodeUrl() {
        return nodeUrl;
    }

    // ── JSON-RPC proxies (matching btsdex's BitShares.db / BitShares.history interface)

    function db(method, args) {
        if (_dbApiId == null) return Promise.reject(new Error('Not connected'));
        return rpc('call', [_dbApiId, method, args]);
    }

    function history(method, args) {
        if (_historyApiId == null) return Promise.reject(new Error('Not connected'));
        return rpc('call', [_historyApiId, method, args]);
    }

    return { connect, disconnect, isConnected, getNodeUrl, db, history };
}

module.exports = { createWsClient };
