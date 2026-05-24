// @ts-nocheck
'use strict';

const WebSocket = globalThis.WebSocket || require('ws');
const { NATIVE_CLIENT } = require('../constants');
const { TRANSPORT } = NATIVE_CLIENT;

const CONNECT_TIMEOUT_MS = TRANSPORT.CONNECT_TIMEOUT_MS;
const RPC_TIMEOUT_MS = TRANSPORT.RPC_TIMEOUT_MS;
const KEEPALIVE_INTERVAL_MS = TRANSPORT.KEEPALIVE_INTERVAL_MS;

let _rpcId = 0;

class RpcTimeoutError extends Error {
    constructor(method, timeoutMs) {
        super(`RPC timeout ${timeoutMs}ms for ${method}`);
        this.code = 'RPC_TIMEOUT';
        this.method = method;
    }
}

class ConnectionError extends Error {
    constructor(message) {
        super(message);
        this.code = 'CONNECTION_ERROR';
    }
}

class AllNodesFailed extends Error {
    constructor(errors) {
        const msgs = errors.map(e => e.message).join('; ');
        super(`All nodes unreachable: ${msgs}`);
        this.code = 'ALL_NODES_FAILED';
        this.errors = errors;
    }
}

class RpcError extends Error {
    constructor(message, code, method, params) {
        super(message);
        this.code = code || 'RPC_ERROR';
        this.method = method;
        this.params = params;
    }
}

function createTransport(config = {}) {
    const {
        connectTimeoutMs = CONNECT_TIMEOUT_MS,
        rpcTimeoutMs = RPC_TIMEOUT_MS,
        onStatusChange = null,
        onReconnect = null,
        validateNode = null,
        keepAliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    } = config;

    let ws = null;
    let nodeUrl = null;
    let reconnectTimer = null;
    let keepAliveTimer = null;
    let keepAliveInFlight = false;
    let nodeList = [];
    let nodeIndex = 0;
    let autoreconnect = false;
    let intentionalClose = false;
    let reconnectAttempts = 0;
    let pendingRequests = new Map();
    let onMessageHandlers = [];
    let status = 'closed';

    function setStatus(newStatus) {
        if (status !== newStatus) {
            status = newStatus;
            if (onStatusChange) {
                try { onStatusChange(newStatus, nodeUrl); } catch (_: any) {}
            }
        }
    }

    function cleanup() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        keepAliveInFlight = false;
        for (const [, req] of pendingRequests) {
            if (req.timer) clearTimeout(req.timer);
            req.reject(new ConnectionError('Connection closed'));
        }
        pendingRequests.clear();
    }

    function scheduleReconnect() {
        if (intentionalClose || !autoreconnect || nodeList.length === 0 || reconnectTimer) return;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts) + Math.random() * 1000, 30000);
        reconnectAttempts++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            tryConnect().catch(() => scheduleReconnect());
        }, delay);
    }

    function startKeepAlive() {
        if (!Number.isFinite(keepAliveIntervalMs) || keepAliveIntervalMs <= 0 || keepAliveTimer) return;
        keepAliveTimer = setInterval(() => {
            if (!ws || ws.readyState !== 1 || keepAliveInFlight) return;
            keepAliveInFlight = true;
            call('call', [1, 'login', ['', '']], Math.min(rpcTimeoutMs, 10000))
                .catch(() => {})
                .finally(() => {
                    keepAliveInFlight = false;
                });
        }, keepAliveIntervalMs);
        if (typeof keepAliveTimer.unref === 'function') {
            keepAliveTimer.unref();
        }
    }

    function connectOne(url) {
        return new Promise((resolve, reject) => {
            try {
                const socket = new WebSocket(url);
                const timer = setTimeout(() => {
                    try { socket.close(); } catch (_: any) {}
                    reject(new ConnectionError(`handshake timeout ${connectTimeoutMs}ms for ${url}`));
                }, connectTimeoutMs);

                socket.onopen = () => {
                    clearTimeout(timer);
                    resolve(socket);
                };
                socket.onerror = () => {};
                socket.onclose = (evt) => {
                    clearTimeout(timer);
                    reject(new ConnectionError(`handshake closed code=${evt.code} for ${url}`));
                };
            } catch (err: any) {
                reject(new ConnectionError(`Failed to create WebSocket for ${url}: ${err.message}`));
            }
        });
    }

    function setupMessageHandler(socket) {
        socket.onmessage = (raw) => {
            let msg;
            try { msg = JSON.parse(raw.data); } catch (_: any) { return; }

            if (typeof msg.id !== 'undefined') {
                const id = String(msg.id);
                const req = pendingRequests.get(id);
                if (req) {
                    if (req.timer) clearTimeout(req.timer);
                    pendingRequests.delete(id);
                    if (msg.error) {
                        req.reject(new RpcError(
                            msg.error.message || JSON.stringify(msg.error),
                            msg.error.code,
                            req.method,
                            req.params
                        ));
                    } else {
                        req.resolve(msg.result);
                    }
                }
            }

            if (typeof msg.method === 'string' && msg.method === 'notice') {
                for (const handler of onMessageHandlers) {
                    try { handler(msg.params); } catch (_: any) {}
                }
            }
        };

        socket.onclose = (evt) => {
            setStatus('closed');
            cleanup();

            scheduleReconnect();
        };

        socket.onerror = () => {};
    }

    async function tryConnect() {
        intentionalClose = false;
        const list = [...nodeList];
        if (list.length === 0) {
            setStatus('closed');
            return;
        }

        const errors = [];

        for (let i = 0; i < list.length; i++) {
            const idx = (nodeIndex + i) % list.length;
            const url = list[idx];
            try {
                setStatus('connecting');
                const socket = await connectOne(url);
                if (ws) {
                    ws.onclose = null;
                    try { ws.close(); } catch (_: any) {}
                }
                ws = socket;
                nodeUrl = url;
                nodeIndex = idx;
                const wasReconnect = reconnectAttempts > 0;
                reconnectAttempts = 0;
                setupMessageHandler(socket);
                if (validateNode) {
                    await validateNode();
                }
                setStatus('connected');
                startKeepAlive();
                if (wasReconnect && onReconnect) {
                    Promise.resolve(onReconnect(nodeUrl)).catch(() => {});
                }
                return;
            } catch (err: any) {
                if (ws) {
                    ws.onclose = null;
                    try { ws.close(); } catch (_: any) {}
                    ws = null;
                }
                errors.push(err);
            }
        }

        nodeIndex = 0;
        setStatus('closed');
        throw new AllNodesFailed(errors);
    }

    async function connect(servers, autoReconnect = false) {
        if (Array.isArray(servers)) {
            nodeList = servers.filter(s => s && typeof s === 'string');
        }
        if (nodeList.length === 0) {
            throw new ConnectionError('No servers provided');
        }
        reconnectAttempts = 0;

        disconnect();
        autoreconnect = autoReconnect;
        intentionalClose = false;
        await tryConnect();
    }

    function disconnect() {
        intentionalClose = true;
        autoreconnect = false;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        cleanup();

        if (ws) {
            try { ws.close(); } catch (_: any) {}
            ws = null;
        }
        nodeUrl = null;
        setStatus('closed');
    }

    function call(method, params, timeoutMs = rpcTimeoutMs) {
        if (!ws || ws.readyState !== 1) {
            return Promise.reject(new ConnectionError('WebSocket not open'));
        }

        const id = String(_rpcId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(id);
                reject(new RpcTimeoutError(method, timeoutMs));
            }, timeoutMs);

            pendingRequests.set(id, {
                resolve,
                reject,
                timer,
                method,
                params,
            });

            try {
                ws.send(JSON.stringify({
                    id: Number(id),
                    jsonrpc: '2.0',
                    method,
                    params,
                }));
            } catch (err: any) {
                clearTimeout(timer);
                pendingRequests.delete(id);
                reject(new ConnectionError(`Failed to send: ${err.message}`));
            }
        });
    }

    function addMessageHandler(handler) {
        onMessageHandlers.push(handler);
        return () => {
            const idx = onMessageHandlers.indexOf(handler);
            if (idx !== -1) onMessageHandlers.splice(idx, 1);
        };
    }

    function getStatus() {
        return ws && ws.readyState === 1 ? 'connected' : status;
    }

    function getNodeUrl() { return nodeUrl; }
    function _setNodes(nodes) { nodeList = Array.isArray(nodes) ? [...nodes] : []; }
    function _getNodes() { return [...nodeList]; }
    function _setAutoReconnect(flag) { autoreconnect = !!flag; }
    function isConnected() { return !!(ws && ws.readyState === 1); }

    return {
        connect,
        disconnect,
        call,
        addMessageHandler,
        getStatus,
        getNodeUrl,
        isConnected,
        _setNodes,
        _getNodes,
        _setAutoReconnect,
    };
}

export = {
    createTransport,
    ConnectionError,
    AllNodesFailed,
    RpcError,
    RpcTimeoutError,
};
