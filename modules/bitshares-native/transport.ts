'use strict';

// Ambient WebSocket declaration for the ws module (no @types/ws installed)
declare class _WebSocket {
    readyState: number;
    onopen: ((evt: any) => void) | null;
    onmessage: ((evt: any) => void) | null;
    onclose: ((evt: any) => void) | null;
    onerror: ((evt: any) => void) | null;
    send(data: string): void;
    close(): void;
    constructor(url: string);
}

type WebSocketLike = _WebSocket;

const WebSocketConstructor: new (url: string) => WebSocketLike =
    (globalThis as any).WebSocket || require('ws');

const { NATIVE_CLIENT } = require('../constants');
const { TRANSPORT } = NATIVE_CLIENT;

const Logger = require('../logger');
const transportLogger = new Logger('Transport');

const CONNECT_TIMEOUT_MS: number = TRANSPORT.CONNECT_TIMEOUT_MS;
const RPC_TIMEOUT_MS: number = TRANSPORT.RPC_TIMEOUT_MS;
const KEEPALIVE_INTERVAL_MS: number = TRANSPORT.KEEPALIVE_INTERVAL_MS;

let _rpcId = 0;

class RpcTimeoutError extends Error {
    code: string;
    method: string;
    constructor(method: string, timeoutMs: number) {
        super(`RPC timeout ${timeoutMs}ms for ${method}`);
        this.code = 'RPC_TIMEOUT';
        this.method = method;
    }
}

class ConnectionError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'CONNECTION_ERROR';
    }
}

class AllNodesFailed extends Error {
    code: string;
    errors: Error[];
    constructor(errors: Error[]) {
        const msgs = errors.map(e => e.message).join('; ');
        super(`All nodes unreachable: ${msgs}`);
        this.code = 'ALL_NODES_FAILED';
        this.errors = errors;
    }
}

class RpcError extends Error {
    code: string;
    method: string;
    params: any[];
    constructor(message: string, code: string | undefined, method: string, params: any[]) {
        super(message);
        this.code = code || 'RPC_ERROR';
        this.method = method;
        this.params = params;
    }
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    params: any[];
}

type TransportStatus = 'closed' | 'connecting' | 'connected';

interface TransportConfig {
    connectTimeoutMs?: number;
    rpcTimeoutMs?: number;
    onStatusChange?: ((status: string, nodeUrl: string | null) => void) | null;
    onReconnect?: ((nodeUrl: string) => Promise<void>) | null;
    validateNode?: (() => Promise<void>) | null;
    keepAliveIntervalMs?: number;
}

function createTransport(config: TransportConfig = {}) {
    const {
        connectTimeoutMs = CONNECT_TIMEOUT_MS,
        rpcTimeoutMs = RPC_TIMEOUT_MS,
        onStatusChange = null,
        onReconnect = null,
        validateNode = null,
        keepAliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    } = config;

    let ws: WebSocketLike | null = null;
    let nodeUrl: string | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let keepAliveInFlight = false;
    let nodeList: string[] = [];
    let nodeIndex = 0;
    let autoreconnect = false;
    let intentionalClose = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 20;
    let pendingRequests = new Map<string, PendingRequest>();
    let onMessageHandlers: Array<(params: any) => void> = [];
    let status: TransportStatus = 'closed';

    function setStatus(newStatus: TransportStatus): void {
        if (status !== newStatus) {
            const prevStatus = status;
            status = newStatus;
            transportLogger.info(`status change: ${prevStatus} -> ${newStatus} (node=${nodeUrl})`);
            if (onStatusChange) {
                try { onStatusChange(newStatus, nodeUrl); } catch (_: any) {}
            }
        }
    }

    function cleanup(): void {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        keepAliveInFlight = false;
        onMessageHandlers = [];
        for (const [, req] of pendingRequests) {
            if (req.timer) clearTimeout(req.timer);
            req.reject(new ConnectionError('Connection closed'));
        }
        pendingRequests.clear();
    }

    function scheduleReconnect(): void {
        if (intentionalClose || !autoreconnect || nodeList.length === 0 || reconnectTimer) return;
        if (reconnectAttempts >= maxReconnectAttempts) {
            transportLogger.warn(`Max reconnection attempts (${maxReconnectAttempts}) reached, giving up`);
            setStatus('closed');
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts) + Math.random() * 1000, 30000);
        reconnectAttempts++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            tryConnect().catch(() => scheduleReconnect());
        }, delay);
    }

    function startKeepAlive(): void {
        if (!Number.isFinite(keepAliveIntervalMs) || keepAliveIntervalMs <= 0 || keepAliveTimer) return;
        keepAliveTimer = setInterval(() => {
            if (!ws || ws.readyState !== 1) return;
            if (keepAliveInFlight) return;
            keepAliveInFlight = true;
            const safe = setTimeout(() => {
                keepAliveInFlight = false;
            }, Math.min(rpcTimeoutMs, 15000));
            call('call', [1, 'login', ['', '']], Math.min(rpcTimeoutMs, 10000))
                .catch(() => {})
                .finally(() => {
                    clearTimeout(safe);
                    keepAliveInFlight = false;
                });
        }, keepAliveIntervalMs);
        if (typeof keepAliveTimer!.unref === 'function') {
            keepAliveTimer!.unref();
        }
    }

    function connectOne(url: string): Promise<WebSocketLike> {
        return new Promise((resolve, reject) => {
            try {
                const socket = new WebSocketConstructor(url);
                const timer = setTimeout(() => {
                    try { socket.close(); } catch (_: any) {}
                    reject(new ConnectionError(`handshake timeout ${connectTimeoutMs}ms for ${url}`));
                }, connectTimeoutMs);

                socket.onopen = () => {
                    clearTimeout(timer);
                    resolve(socket);
                };
                socket.onerror = (evt: any) => {
                    clearTimeout(timer);
                    const msg = evt && evt.message ? evt.message : 'WebSocket connection error';
                    reject(new ConnectionError(msg));
                };
                socket.onclose = (evt: any) => {
                    clearTimeout(timer);
                    reject(new ConnectionError(`handshake closed code=${evt.code} for ${url}`));
                };
            } catch (err: any) {
                reject(new ConnectionError(`Failed to create WebSocket for ${url}: ${err.message}`));
            }
        });
    }

    function setupMessageHandler(socket: WebSocketLike): void {
        socket.onmessage = (raw: any) => {
            let msg: any;
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

        socket.onclose = (evt: any) => {
            const code = evt?.code;
            const reason = evt?.reason || '';
            const wasClean = evt?.wasClean !== false;
            transportLogger.warn(`WebSocket closed on ${nodeUrl}: code=${code}, wasClean=${wasClean}, reason="${reason}"`);
            setStatus('closed');
            cleanup();

            scheduleReconnect();
        };

        socket.onerror = (evt: any) => {
            const msg = evt && evt.message ? evt.message : 'WebSocket connection error';
            transportLogger.warn(`WebSocket error on ${nodeUrl}: ${msg}`);
        };
    }

    async function tryConnect(): Promise<void> {
        intentionalClose = false;
        const list = [...nodeList];
        if (list.length === 0) {
            setStatus('closed');
            return;
        }

        const errors: Error[] = [];

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
                    try {
                        await onReconnect(nodeUrl);
                    } catch (err: any) {
                        transportLogger.warn(`Reconnect callback (subscription re-establishment) failed: ${err?.message || err}`);
                    }
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

    async function connect(servers?: string[], autoReconnect = false): Promise<void> {
        if (Array.isArray(servers)) {
            nodeList = servers.filter(s => s && typeof s === 'string');
        }
        if (nodeList.length === 0) {
            throw new ConnectionError('No servers provided');
        }
        nodeIndex = 0;
        reconnectAttempts = 0;

        disconnect();
        autoreconnect = autoReconnect;
        intentionalClose = false;
        await tryConnect();
    }

    function disconnect(): void {
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

    function call(method: string, params: any[], timeoutMs: number = rpcTimeoutMs): Promise<any> {
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
                ws!.send(JSON.stringify({
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

    function addMessageHandler(handler: (params: any) => void): (() => void) & { isActive: () => boolean } {
        onMessageHandlers.push(handler);
        const unsubscribe = (() => {
            const idx = onMessageHandlers.indexOf(handler);
            if (idx !== -1) onMessageHandlers.splice(idx, 1);
        }) as (() => void) & { isActive: () => boolean };
        unsubscribe.isActive = () => onMessageHandlers.includes(handler);
        return unsubscribe;
    }

    function getStatus(): string {
        return ws && ws.readyState === 1 ? 'connected' : status;
    }

    function getNodeUrl(): string | null { return nodeUrl; }
    function _setNodes(nodes: string[]): void { nodeList = Array.isArray(nodes) ? [...nodes] : []; }
    function _getNodes(): string[] { return [...nodeList]; }
    function _setAutoReconnect(flag: boolean): void { autoreconnect = !!flag; }
    function isConnected(): boolean { return !!(ws && ws.readyState === 1); }

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
