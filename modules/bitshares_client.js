/**
 * modules/bitshares_client.js - BitShares Connection Manager
 *
 * Centralized BitShares client connection and account client factory.
 *
 * Features:
 * - Single shared connection for all database queries
 * - Connection state tracking with waitForConnected() helper
 * - Per-account client factory for signing/broadcasting transactions
 * - Subscription and event handling
 *
 * ===============================================================================
 * EXPORTS (13 items)
 * ===============================================================================
 *
 * 1. BitShares - Shared BitShares class for database operations
 *    Used for: querying accounts, assets, orders, subscriptions
 *    Never use for signing transactions
 *
 * 2. waitForConnected(timeoutMs) - Wait for connection to ready state (async)
 * 3. createAccountClient(name, key) - Create per-account client for signing
 * 4. setSuppressConnectionLog(bool) - Suppress/restore connection log output
 * 5. getNodeManager() - Get the NodeManager instance
 * 6. getNodeStats() - Get node health statistics
 * 7. getNodeSummary() - Get node summary
 * 8. _internal - Internal state (connected flag) for testing
 * ===============================================================================
 */

const { TIMING, NODE_MANAGEMENT } = require('./constants');
const NodeManager = require('./node_manager');
const { readGeneralSettings } = require('./general_settings');
const { sleep } = require('./order/utils/system');

let connected = false;
let suppressConnectionLog = false;
const connectedCallbacks = new Set();
let lastConnectionError = null;
let intentionalDisconnect = false;
let nodeManager = null;
let nodeConfig = null;
let startupNodeRefreshPromise = null;
let failoverAssessmentPromise = null;
let reconnectInProgress = false;

// Native client references
let _nativeClient = null;
let _subscriptionManager = null;
let _nativeBitSharesProxy = null;

const native = require('./bitshares-native');
const { createSubscriptionManager, createResolvers } = native;
_nativeClient = native.createChainClient({
    onStatusChange: handleConnectionStatus,
    rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
});
_subscriptionManager = createSubscriptionManager(_nativeClient);
_nativeClient.onReconnect = () => _subscriptionManager.onReconnect();
const _resolvers = createResolvers(_nativeClient);

_nativeBitSharesProxy = {
    get connect() {
        return (servers, autoreconnect) => {
            if (Array.isArray(servers)) _nativeClient.setNodes(servers);
            return _nativeClient.connect();
        };
    },
    get disconnect() { return () => _nativeClient.disconnect(); },
    get node() { return _nativeClient.getNodes(); },
    set node(v) { _nativeClient.setNodes(Array.isArray(v) ? v : []); },
    get autoreconnect() { return true; },
    set autoreconnect(v) {},
    get connectPromise() { return undefined; },
    set connectPromise(v) {},
    get subscribe() {
        return (eventType, callback, accountName) => {
            if (eventType === 'account') {
                return _subscriptionManager.subscribe(accountName, callback);
            }
            if (_nativeClient && _nativeClient.subscribe) {
                return _nativeClient.subscribe(eventType, callback, accountName);
            }
        };
    },
    get unsubscribe() {
        return (eventType, callback, accountName) => {
            if (eventType === 'account') {
                return _subscriptionManager.unsubscribe(accountName, callback);
            }
            if (_nativeClient && _nativeClient.unsubscribe) {
                return _nativeClient.unsubscribe(eventType, callback, accountName);
            }
        };
    },
    get assets() {
        return new Proxy({}, {
            get(_target, prop) {
                if (typeof prop !== 'string') return undefined;
                return _resolvers.resolveAsset(prop);
            },
        });
    },
    get accounts() {
        return new Proxy({}, {
            get(_target, prop) {
                if (typeof prop !== 'string') return undefined;
                return _resolvers.resolveAccount(prop).then((acc) => acc || null);
            },
        });
    },
    get chain() { return { get coreAsset() { return _nativeClient.getCoreAsset(); } }; },
    get db() {
        return new Proxy(_nativeClient.db, {
            get(target, prop) {
                if (typeof target[prop] === 'function') {
                    return (...args) => target[prop](...args);
                }
                return (...args) => target.call(prop, args);
            },
        });
    },
    get history() {
        const hist = _nativeClient.history;
        return new Proxy(hist, {
            get(target, prop) {
                if (typeof target[prop] === 'function') {
                    return (...args) => target[prop](...args);
                }
                return (...args) => hist.call(prop, args);
            },
        });
    },
};

const settings = readGeneralSettings({
    fallback: null,
    onError: (err) => {
        console.warn('[NodeManager] Config load failed, continuing with defaults:', err.message);
    },
});

const nodeSettings = settings?.NODES;
const configuredNodes = Array.isArray(nodeSettings?.list)
    ? nodeSettings.list.filter((node) => typeof node === 'string' && node.trim())
    : [];
const nodeManagerEnabled = nodeSettings?.enabled ?? NODE_MANAGEMENT.DEFAULT_ENABLED;

    if (nodeManagerEnabled) {
        nodeConfig = {
            ...nodeSettings,
            enabled: nodeManagerEnabled,
            list: configuredNodes.length > 0 ? configuredNodes : NODE_MANAGEMENT.DEFAULT_NODES,
        };
        nodeManager = new NodeManager(nodeConfig);
        _nativeClient.setNodes(Array.isArray(nodeConfig.list) ? nodeConfig.list.slice() : nodeConfig.list);
        console.log(`[NodeManager] Loaded config for ${nodeConfig.list.length} nodes`);
    }

function setSuppressConnectionLog(suppress) {
    suppressConnectionLog = suppress;
}

async function restartBitsharesConnection(serverList, reason = 'startup') {
    const servers = Array.isArray(serverList)
        ? serverList.filter((server) => typeof server === 'string' && server.trim())
        : [];
    if (servers.length === 0) return false;

    try {
        reconnectInProgress = true;
        connected = false;

        try { _nativeClient.disconnect(); } catch (_) {}
        _nativeClient.setNodes(servers);
        await _nativeClient.connect();
        if (_subscriptionManager) {
            try { await _subscriptionManager.onReconnect(); } catch (_) {}
        }

        if (!suppressConnectionLog) {
            console.log(`[NodeManager] ${reason}: reconnect requested across ${servers.length} node(s)`);
        }
        return true;
    } catch (err) {
        lastConnectionError = err;
        try { _nativeClient.disconnect(); } catch (_) {}
        if (!suppressConnectionLog) {
            console.warn(`[NodeManager] ${reason}: reconnect request failed: ${err.message || err}`);
        }
        return false;
    } finally {
        reconnectInProgress = false;
    }
}

async function assessFailover(reason = 'status change') {
    if (!nodeManager || nodeConfig?.healthCheck?.enabled === false) return false;
    if (reconnectInProgress) return false;
    if (failoverAssessmentPromise) return failoverAssessmentPromise;

    failoverAssessmentPromise = (async () => {
        console.warn(`[NodeManager] ${reason}, triggering failover assessment`);
        try {
            const activeNode = _nativeClient?.transport?.getNodeUrl?.();

            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const availableHealthyNodes = activeNode
                ? healthyNodes.filter((node) => node !== activeNode)
                : healthyNodes;
            const fallbackNodes = getConfiguredOrDefaultNodes();
            const availableFallbackNodes = activeNode
                ? fallbackNodes.filter((node) => node !== activeNode)
                : fallbackNodes;
            const nextNodes = availableHealthyNodes.length > 0
                ? availableHealthyNodes
                : (healthyNodes.length > 0 ? healthyNodes : (availableFallbackNodes.length > 0 ? availableFallbackNodes : fallbackNodes));
            return restartBitsharesConnection(nextNodes, reason);
        } catch (err) {
            console.warn('[NodeManager] Failover assessment error:', err.message);
            return false;
        }
    })();

    try {
        return await failoverAssessmentPromise;
    } finally {
        failoverAssessmentPromise = null;
    }
}

function getConfiguredOrDefaultNodes() {
    return Array.isArray(nodeConfig?.list) && nodeConfig.list.length > 0
        ? nodeConfig.list
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

function handleConnectionStatus(status) {
    const canHandleFailover = nodeManager && nodeConfig?.healthCheck?.enabled !== false;

    if (status === 'open' || status === 'connected') {
        connected = true;
        lastConnectionError = null;
        if (nodeManager && nodeConfig?.healthCheck?.enabled !== false && !nodeManager.monitoringActive) {
            nodeManager.start();
        }
        if (!suppressConnectionLog) {
            console.log('modules/bitshares_client: BitShares connected');
        }
        for (const cb of Array.from(connectedCallbacks)) {
            try { cb(); } catch (e) { console.error('connected callback error', e.message); }
        }
        return false;
    }

    if (status === 'closed' || status === 'closing') {
        connected = false;
        lastConnectionError = null;
    }
    if (status === 'closed' && canHandleFailover && !reconnectInProgress) {
        if (intentionalDisconnect) {
            return true;
        }
        assessFailover('Connection closed').catch(() => {});
        return true;
    }
    return false;
}

async function refreshStartupNodeServers(reason = 'startup') {
    if (!nodeManager || !nodeConfig?.list?.length) {
        return Array.isArray(nodeConfig?.list) ? nodeConfig.list : [];
    }
    if (startupNodeRefreshPromise) return startupNodeRefreshPromise;

    startupNodeRefreshPromise = (async () => {
        try {
            if (nodeConfig.healthCheck?.enabled === false) {
                const fallbackNodes = getConfiguredOrDefaultNodes();
                await restartBitsharesConnection(fallbackNodes, `Startup ${reason}`);
                if (!suppressConnectionLog) {
                    console.log(`[NodeManager] Startup ${reason}: using ${fallbackNodes.length} configured node(s) without health probing`);
                }
                return fallbackNodes;
            }
            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const nextNodes = healthyNodes.length > 0 ? healthyNodes : getConfiguredOrDefaultNodes();
            await restartBitsharesConnection(nextNodes, `Startup ${reason}`);
            if (!suppressConnectionLog) {
                console.log(`[NodeManager] Startup ${reason}: using ${nextNodes.length} node(s)`);
            }
            return nextNodes;
        } catch (err) {
            if (!suppressConnectionLog) {
                console.warn(`[NodeManager] Startup ${reason} node refresh failed: ${err.message}`);
            }
            return getConfiguredOrDefaultNodes();
        }
    })();

    try {
        return await startupNodeRefreshPromise;
    } finally {
        startupNodeRefreshPromise = null;
    }
}

async function waitForConnected(timeoutMs = TIMING.CONNECTION_TIMEOUT_MS, options = {}) {
    if (nodeManagerEnabled && nodeConfig?.list?.length) {
        await refreshStartupNodeServers('initial');
    }

    const start = Date.now();
    const initialDelayMs = Number.isFinite(options.retryDelayMs)
        ? Math.max(0, options.retryDelayMs)
        : NODE_MANAGEMENT.STARTUP_RETRY_INITIAL_DELAY_MS;
    const maxDelayMs = Number.isFinite(options.maxRetryDelayMs)
        ? Math.max(initialDelayMs, options.maxRetryDelayMs)
        : NODE_MANAGEMENT.STARTUP_RETRY_MAX_DELAY_MS;
    const refreshNodesEveryMs = Number.isFinite(options.refreshNodesEveryMs)
        ? Math.max(0, options.refreshNodesEveryMs)
        : NODE_MANAGEMENT.STARTUP_REFRESH_INTERVAL_MS;
    let retryDelayMs = initialDelayMs;
    let nextNodeRefreshAt = 0;

    while (!connected) {
        const elapsedMs = Date.now() - start;
        if (elapsedMs >= timeoutMs) break;

        if (nodeManagerEnabled && Date.now() >= nextNodeRefreshAt) {
            await refreshStartupNodeServers(elapsedMs === 0 ? 'initial' : 'retry');
            nextNodeRefreshAt = Date.now() + refreshNodesEveryMs;
        }

        if (connected) break;

        const remainingMs = timeoutMs - (Date.now() - start);
        const sleepMs = Math.min(retryDelayMs, Math.max(0, remainingMs));
        if (sleepMs > 0) await sleep(sleepMs);
        retryDelayMs = Math.min(maxDelayMs, retryDelayMs > 0 ? retryDelayMs * 2 : maxDelayMs);
    }

    if (!connected) {
        const suffix = lastConnectionError?.message ? ` Last error: ${lastConnectionError.message}` : '';
        throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms.${suffix}`);
    }
    return true;
}

async function createAccountClient(accountName, privateKey) {
    await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

    const { createSigningClient } = require('./bitshares-native');
    const signingClient = createSigningClient(_nativeClient, accountName, privateKey);
    return signingClient.client;
}

function getConnectionStatus() {
    return _nativeClient.getStatus();
}

async function disconnectClient() {
    intentionalDisconnect = true;
    connected = false;
    try {
        try { _nativeClient.disconnect(); } catch (_) {}
    } finally {
        intentionalDisconnect = false;
    }
}

async function reconnectForCycle(reason = 'adapter-cycle') {
    const nodes = nodeManager && nodeConfig?.healthCheck?.enabled !== false
        ? nodeManager.getHealthyNodes()
        : [];
    const effective = nodes.length > 0 ? nodes : getConfiguredOrDefaultNodes();
    return restartBitsharesConnection(effective, reason);
}

module.exports = {
    BitShares: _nativeBitSharesProxy,
    createAccountClient,
    waitForConnected,
    getConnectionStatus,
    disconnectClient,
    reconnectForCycle,
    setSuppressConnectionLog,
    getNodeManager: () => nodeManager,
    getNodeStats: () => nodeManager?.getStats(),
    getNodeSummary: () => nodeManager?.getSummary(),
    getConnectionError: () => lastConnectionError,
    _assessFailover: assessFailover,
    _internal: {
        get connected() {
            return connected;
        },
    },
};
