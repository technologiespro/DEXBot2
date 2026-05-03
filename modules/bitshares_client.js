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
 * EXPORTS (8 items)
 * ===============================================================================
 *
 * 1. BitShares - Shared BitShares class for database operations
 *    Used for: querying accounts, assets, orders, subscriptions
 *    Never use for signing transactions
 *
 * 2. waitForConnected(timeoutMs) - Wait for connection to ready state (async)
 *    Call before any chain operations
 *    Returns promise that resolves when connected
 *
 * 3. createAccountClient(name, key) - Create per-account client for signing
 *    Returns client instance with sign() and broadcast() methods
 *    Used for: createOrder, updateOrder, cancelOrder operations
 *
 * 4. setSuppressConnectionLog(bool) - Suppress/restore connection log output
 * 5. getNodeManager() - Get the NodeManager instance
 * 6. getNodeStats() - Get node health statistics
 * 7. getNodeSummary() - Get node summary
 * 8. _internal - Internal state (connected flag) for testing
 *
 * ===============================================================================
 *
 * ARCHITECTURE:
 * - Single shared connection: Reduces resource usage, centralized subscriptions
 * - Per-account clients: Enables multi-account signing without connection overhead
 * - Separation of concerns: Read ops on shared connection, write ops on account clients
 *
 * USAGE:
 * - Database queries: await BitShares.db.call("get_accounts", [[accountId]])
 * - Subscribe to events: BitShares.subscribe("connected", callback)
 * - Create/update orders: const client = createAccountClient(name, key); client.broadcast(op)
 *
 * ===============================================================================
 */

const BitSharesLib = require('btsdex');
const BitSharesApi = require('btsdex-api');
const btsdexEventPatch = require('./btsdex_event_patch');
const { TIMING, NODE_MANAGEMENT } = require('./constants');
const NodeManager = require('./node_manager');
const { readGeneralSettings } = require('./general_settings');
const { sleep } = require('./order/utils/system');
const eventModule = require('btsdex/lib/event');
const EventClass = eventModule && (eventModule.default || eventModule);

// Shared connection state for the process. Modules should use waitForConnected()
// to ensure the shared BitShares client is connected before making DB calls.
let connected = false;
let suppressConnectionLog = false;
const connectedCallbacks = new Set();
let lastConnectionError = null;
let intentionalDisconnect = false;

// Node Manager for multi-node support
let nodeManager = null;
let nodeConfig = null;
let startupNodeRefreshPromise = null;
let failoverAssessmentPromise = null;
let reconnectInProgress = false;

// Load node configuration from settings file
const settings = readGeneralSettings({
    fallback: null,
    onError: (err) => {
        console.warn('[NodeManager] Config load failed, continuing with defaults:', err.message);
    }
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
    BitSharesLib.node = Array.isArray(nodeConfig.list) ? nodeConfig.list.slice() : nodeConfig.list;
    console.log(`[NodeManager] Loaded config for ${nodeConfig.list.length} nodes`);
}

/**
 * Allow suppressing the connection log message.
 * @param {boolean} suppress - Whether to suppress the log message.
 */
function setSuppressConnectionLog(suppress) {
    suppressConnectionLog = suppress;
}

async function restartBitsharesConnection(serverList, reason = 'startup') {
    const servers = Array.isArray(serverList)
        ? serverList.filter((server) => typeof server === 'string' && server.trim())
        : [];
    if (servers.length === 0) {
        return false;
    }

    try {
        reconnectInProgress = true;
        connected = false;
        try {
            await BitSharesLib.disconnect();
        } catch (_) {
            // Fall through to the direct API disconnect below.
        }
        try {
            await BitSharesApi.disconnect().catch(() => {});
        } catch (_) {}
        BitSharesLib.autoreconnect = true;
        BitSharesLib.connectPromise = undefined;
        BitSharesLib.node = servers.slice();
        await BitSharesLib.connect(servers, true);
        if (!suppressConnectionLog) {
            console.log(`[NodeManager] ${reason}: reconnect requested across ${servers.length} node(s)`);
        }
        return true;
    } catch (err) {
        lastConnectionError = err;
        if (!suppressConnectionLog) {
            console.warn(`[NodeManager] ${reason}: reconnect request failed: ${err.message || err}`);
        }
        return false;
    } finally {
        reconnectInProgress = false;
    }
}

async function assessFailover(reason = 'status change') {
    if (!nodeManager || nodeConfig?.healthCheck?.enabled === false) {
        return false;
    }
    if (reconnectInProgress) {
        return false;
    }
    if (failoverAssessmentPromise) {
        return failoverAssessmentPromise;
    }

    failoverAssessmentPromise = (async () => {
        console.warn(`[NodeManager] ${reason}, triggering failover assessment`);
        try {
            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const nextNodes = healthyNodes.length > 0 ? healthyNodes : getConfiguredOrDefaultNodes();
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

    if (status === 'open') {
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
            // Disconnect was deliberate; suppress both NodeManager failover
            // and btsdex-api's parallel auto-reconnect.
            return true;
        }
        assessFailover('Connection closed').catch(() => {});
        // NodeManager owns reconnect selection; suppress btsdex-api's parallel auto-reconnect.
        return true;
    }
    return false;
}

try {
    if (EventClass?.connected && typeof EventClass.connected.subFunc === 'function') {
        const originalConnect = EventClass.connected.subFunc.bind(EventClass.connected);
        EventClass.connected.subFunc = (...args) => {
            try {
                const promise = originalConnect(...args);
                if (promise && typeof promise.catch === 'function') {
                    promise.catch((err) => {
                        lastConnectionError = err;
                        if (!suppressConnectionLog) {
                            console.warn('[BitShares] Connection failed:', err?.message || err);
                        }
                    });
                }
                return promise;
            } catch (err) {
                lastConnectionError = err;
                if (!suppressConnectionLog) {
                    console.warn('[BitShares] Connection failed:', err?.message || err);
                }
                throw err;
            }
        };
    }

    if (typeof btsdexEventPatch.addStatusCallback === 'function') {
        btsdexEventPatch.addStatusCallback(handleConnectionStatus);
    } else if (typeof BitSharesApi.setNotifyStatusCallback === 'function') {
        BitSharesApi.setNotifyStatusCallback(handleConnectionStatus);
    }

} catch (e) {
    // Some environments may not have subscribe available at require time; that's okay
}

/**
 * Wait for the shared BitShares client to establish a connection.
 * Polls connection state until connected or timeout, refreshing node health
 * and rotating server lists during startup if node management is enabled.
 * @param {number} timeoutMs - Maximum wait time in milliseconds (default: 30000)
 * @param {Object} [options={}] - Startup retry options
 * @param {number} [options.retryDelayMs] - Initial backoff delay
 * @param {number} [options.maxRetryDelayMs] - Maximum backoff delay
 * @param {number} [options.refreshNodesEveryMs] - How often to refresh node health
 * @throws {Error} If connection times out
 */
async function refreshStartupNodeServers(reason = 'startup') {
    if (!nodeManager || !nodeConfig?.list?.length) {
        return Array.isArray(nodeConfig?.list) ? nodeConfig.list : [];
    }

    if (startupNodeRefreshPromise) {
        return startupNodeRefreshPromise;
    }

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
        if (elapsedMs >= timeoutMs) {
            break;
        }

        if (nodeManagerEnabled && Date.now() >= nextNodeRefreshAt) {
            await refreshStartupNodeServers(elapsedMs === 0 ? 'initial' : 'retry');
            nextNodeRefreshAt = Date.now() + refreshNodesEveryMs;
        }

        if (connected) {
            break;
        }

        const remainingMs = timeoutMs - (Date.now() - start);
        const sleepMs = Math.min(retryDelayMs, Math.max(0, remainingMs));
        if (sleepMs > 0) {
            await sleep(sleepMs);
        }
        retryDelayMs = Math.min(maxDelayMs, retryDelayMs > 0 ? retryDelayMs * 2 : maxDelayMs);
    }

    if (!connected) {
        const suffix = lastConnectionError?.message
            ? ` Last error: ${lastConnectionError.message}`
            : '';
        throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms.${suffix}`);
    }

    return true;
}

/**
 * Create a per-account client for signing and broadcasting transactions.
 * Each account needs its own client instance with the private key.
 * @param {string} accountName - BitShares account name
 * @param {string} privateKey - WIF-encoded private key
 * @returns {Object} btsdex client instance for this account
 */
function createAccountClient(accountName, privateKey) {
    // Instantiate a per-account client used for signing/broadcasting transactions.
    return new BitSharesLib(accountName, privateKey);
}

function getConnectionStatus() {
    try {
        return BitSharesApi.getStatus();
    } catch (_) {
        return 'unknown';
    }
}

async function disconnectClient() {
    intentionalDisconnect = true;
    connected = false;
    try {
        try { await BitSharesLib.disconnect(); } catch (_) {}
        try { await BitSharesApi.disconnect(); } catch (_) {}
    } finally {
        intentionalDisconnect = false;
    }
}

/**
 * Reconnect using the NodeManager's already-known node stats without
 * running a full checkAllNodes probe.  Prefers healthy/slow/unchecked
 * nodes from the last periodic health check (every 4 h by default) and
 * falls back to the configured node list if NodeManager hasn't run yet.
 * 
 * This is the intended entry point for the market adapter's per-cycle
 * connect + disconnect pattern — cheap reconnects, not full fleet probes.
 */
async function reconnectForCycle(reason = 'adapter-cycle') {
    const nodes = nodeManager && nodeConfig?.healthCheck?.enabled !== false
        ? nodeManager.getHealthyNodes()
        : [];
    const effective = nodes.length > 0 ? nodes : getConfiguredOrDefaultNodes();
    return restartBitsharesConnection(effective, reason);
}

module.exports = {
    BitShares: BitSharesLib,
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
    _refreshStartupNodeServers: refreshStartupNodeServers,
    _assessFailover: assessFailover,
};
