'use strict';

const { createTransport, ConnectionError } = require('./transport');
const { GRAPHENE_CHAIN_ID, GRAPHENE_ADDRESS_PREFIX } = require('./serial/chain_constants');

class ChainConfigError extends Error {
    constructor(message) {
        super(message);
        this.code = 'CHAIN_CONFIG_ERROR';
    }
}

function toRpcMethodName(method) {
    return String(method).replace(/([A-Z])/g, (_, ch) => `_${ch.toLowerCase()}`);
}

function createChainClient(config = {}) {
    const {
        nodes = [],
        onStatusChange = null,
        rpcTimeoutMs,
        connectTimeoutMs,
        autoreconnect = true,
        validateChainId = true,
        expectedChainId = GRAPHENE_CHAIN_ID,
    } = config;

    const wrappedOnStatusChange = (status, nodeUrl) => {
        if (status === 'closed' || status === 'closing') {
            _dbApiId = null;
            _historyApiId = null;
            _broadcastApiId = null;
            _chainConfig = null;
        }
        if (onStatusChange) onStatusChange(status, nodeUrl);
    };

    const transport = createTransport({
        onStatusChange: wrappedOnStatusChange,
        rpcTimeoutMs,
        connectTimeoutMs,
        validateNode: validateChainId ? async () => {
            await login();
        } : null,
        onReconnect: async () => {
            _dbApiId = null;
            _historyApiId = null;
            _broadcastApiId = null;
            _chainConfig = null;
            await login();
            if (typeof client.onReconnect === 'function') {
                await client.onReconnect();
            }
        },
    });
    let _dbApiId = null;
    let _historyApiId = null;
    let _broadcastApiId = null;
    let _chainConfig = null;
    let _loginPromise = null;
    if (Array.isArray(nodes) && nodes.length > 0) {
        transport._setNodes(nodes);
    }

    async function login() {
        if (_loginPromise) return _loginPromise;

        _loginPromise = (async () => {
            const result = await transport.call('call', [1, 'login', ['', '']]);
            if (!result) {
                throw new ConnectionError('Login error');
            }

            if (_dbApiId == null) {
                _dbApiId = await registerApi('database');
            }

            const chainId = await transport.call('call', [_dbApiId, 'get_chain_id', []]);
            let addressPrefix = GRAPHENE_ADDRESS_PREFIX;
            let coreAsset = '1.3.0';

            try {
                const props = await transport.call('call', [_dbApiId, 'get_chain_properties', []]);
                if (props && props.address_prefix) addressPrefix = props.address_prefix;
            } catch (_) {}

            try {
                const globals = await transport.call('call', [_dbApiId, 'get_global_properties', []]);
                if (globals && globals.parameters && globals.parameters.core_asset) {
                    coreAsset = globals.parameters.core_asset;
                }
            } catch (_) {}

            if (validateChainId && chainId !== expectedChainId) {
                _dbApiId = null;
                throw new ChainConfigError(
                    `Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`
                );
            }

            _chainConfig = {
                chainId,
                addressPrefix,
                coreAsset,
            };

            return _chainConfig;
        })().finally(() => {
            _loginPromise = null;
            return undefined;
        });

        return _loginPromise;
    }

    async function registerApi(apiName) {
        const apiId = await transport.call('call', [1, apiName, []]);
        return apiId;
    }

    async function dbCall(method, args) {
        if (_dbApiId == null) {
            _dbApiId = await registerApi('database');
        }
        return transport.call('call', [_dbApiId, toRpcMethodName(method), args || []]);
    }

    async function historyCall(method, args) {
        if (_historyApiId == null) {
            _historyApiId = await registerApi('history');
        }
        return transport.call('call', [_historyApiId, toRpcMethodName(method), args || []]);
    }

    async function broadcastCall(method, args) {
        if (_broadcastApiId == null) {
            _broadcastApiId = await registerApi('network_broadcast');
        }
        return transport.call('call', [_broadcastApiId, method, args || []]);
    }

    async function broadcastTx(signedTx) {
        return broadcastCall('broadcast_transaction', [signedTx]);
    }

    async function connect(servers) {
        if (Array.isArray(servers)) {
            setNodes(servers);
        } else if (transport._getNodes().length === 0 && Array.isArray(nodes) && nodes.length > 0) {
            setNodes(nodes);
        }
        await transport.connect(undefined, autoreconnect);
    }

    function disconnect() {
        _dbApiId = null;
        _historyApiId = null;
        _broadcastApiId = null;
        _chainConfig = null;
        transport.disconnect();
    }

    function setNodes(servers) {
        transport._setNodes(servers);
    }

    function getNodes() { return transport._getNodes(); }
    function getStatus() { return transport.getStatus(); }
    function getConfig() { return _chainConfig; }
    function getCoreAsset() { return _chainConfig ? _chainConfig.coreAsset : '1.3.0'; }

    const db = {};

    const DB_METHODS = [
        'get_assets', 'getAssets', 'lookup_asset_symbols', 'lookupAssetSymbols',
        'get_full_accounts', 'getFullAccounts', 'get_order_book', 'getOrderBook', 'get_ticker', 'getTicker',
        'get_objects', 'getObjects', 'getGlobalProperties', 'get_global_properties', 'get_dynamic_global_properties',
        'get_liquidity_pool_by_asset_ids', 'get_liquidity_pools_by_share_asset',
        'list_liquidity_pools', 'get_call_orders', 'list_assets',
        'get_account_count', 'get_block', 'get_account_balances',
        'get_key_references', 'get_block_header',
    ];

    for (const method of DB_METHODS) {
        db[method] = (...args) => dbCall(method, args);
    }

    db.call = dbCall;

    const history = {};

    const HISTORY_METHODS = [
        'getMarketHistory', 'get_market_history', 'getMarketHistoryBuckets', 'get_market_history_buckets',
        'get_account_history_by_operations', 'getAccountHistory', 'get_account_history',
        'get_liquidity_pool_history', 'get_liquidity_pool_history_by_sequence',
        'get_relative_account_history',
    ];

    for (const method of HISTORY_METHODS) {
        history[method] = (...args) => historyCall(method, args);
    }

    history.call = historyCall;

    const broadcast = {
        call: broadcastCall,
        broadcast_transaction: (tx) => broadcastTx(tx),
    };

    const client = {
        transport,
        connect,
        disconnect,
        setNodes,
        getNodes,
        getStatus,
        getConfig,
        getCoreAsset,
        db,
        history,
        broadcast,
        login,
    };

    return client;
}

function createReadOnlyClient(config = {}) {
    const { nodes = [] } = config;

    const transport = createTransport({
        rpcTimeoutMs: config.rpcTimeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
    });

    let _dbApiId = null;
    let _historyApiId = null;

    async function connect(servers) {
        const effectiveNodes = Array.isArray(servers) && servers.length > 0
            ? servers
            : nodes;
        await transport.connect(effectiveNodes, false);
        const loginOk = await transport.call('call', [1, 'login', ['', '']]);
        if (!loginOk) throw new ConnectionError('Login error');
        _dbApiId = await transport.call('call', [1, 'database', []]);
        _historyApiId = await transport.call('call', [1, 'history', []]);
    }

    function disconnect() {
        _dbApiId = null;
        _historyApiId = null;
        transport.disconnect();
    }

    async function db(method, args) {
        if (_dbApiId == null) throw new Error('Not connected');
        return transport.call('call', [_dbApiId, toRpcMethodName(method), args || []]);
    }

    async function history(method, args) {
        if (_historyApiId == null) throw new Error('Not connected');
        return transport.call('call', [_historyApiId, toRpcMethodName(method), args || []]);
    }

    function setNodes(servers) {
        transport._setNodes(servers);
    }

    function getNodes() {
        return transport._getNodes();
    }

    return {
        connect,
        disconnect,
        db,
        history,
        setNodes,
        getNodes,
        getNodeUrl: () => transport.getNodeUrl(),
        isConnected: () => transport.isConnected(),
    };
}

module.exports = { createChainClient, createReadOnlyClient, ChainConfigError };
