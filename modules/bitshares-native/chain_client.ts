'use strict';

const { createTransport, ConnectionError } = require('./transport');
const { GRAPHENE_CHAIN_ID, GRAPHENE_ADDRESS_PREFIX } = require('./serial/chain_constants');
const { NATIVE_CLIENT } = require('../constants');
const { CHAIN } = NATIVE_CLIENT;
const DEFAULT_CORE_ASSET: string = CHAIN.CORE_ASSET_ID;

class ChainConfigError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'CHAIN_CONFIG_ERROR';
    }
}

function toRpcMethodName(method: string): string {
    return String(method).replace(/([A-Z])/g, (_: string, ch: string) => `_${ch.toLowerCase()}`);
}

interface ChainClientConfig {
    nodes?: string[];
    onStatusChange?: ((status: string, nodeUrl: string | null) => void) | null;
    rpcTimeoutMs?: number;
    connectTimeoutMs?: number;
    autoreconnect?: boolean;
    validateChainId?: boolean;
    expectedChainId?: string;
}

interface ChainConfig {
    chainId: string;
    addressPrefix: string;
    coreAsset: string;
}

function createChainClient(config: ChainClientConfig = {}) {
    const {
        nodes = [],
        onStatusChange = null,
        rpcTimeoutMs,
        connectTimeoutMs,
        autoreconnect = true,
        validateChainId = true,
        expectedChainId = GRAPHENE_CHAIN_ID,
    } = config;

    const wrappedOnStatusChange = (status: string, nodeUrl: string | null) => {
        if (status === 'closed') {
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
            if (typeof client.onReconnect === 'function') {
                await client.onReconnect();
            }
        },
    });
    let _dbApiId: number | null = null;
    let _historyApiId: number | null = null;
    let _broadcastApiId: number | null = null;
    let _chainConfig: ChainConfig | null = null;
    let _loginPromise: Promise<ChainConfig | undefined> | null = null;
    if (Array.isArray(nodes) && nodes.length > 0) {
        transport._setNodes(nodes);
    }

    async function login(): Promise<ChainConfig | undefined> {
        if (_loginPromise) return _loginPromise;

        _loginPromise = (async () => {
            const result = await transport.call('call', [1, 'login', ['', '']]);
            if (!result) {
                throw new ConnectionError('Login error');
            }

            if (_dbApiId == null) {
                _dbApiId = await registerApi('database');
            }

            const chainId: string = await transport.call('call', [_dbApiId, 'get_chain_id', []]);
            let addressPrefix = GRAPHENE_ADDRESS_PREFIX;
            let coreAsset = CHAIN.CORE_ASSET_ID;

            try {
                const props = await transport.call('call', [_dbApiId, 'get_chain_properties', []]);
                if (props && props.address_prefix) addressPrefix = props.address_prefix;
            } catch (_: any) {}

            try {
                const globals = await transport.call('call', [_dbApiId, 'get_global_properties', []]);
                if (globals && globals.parameters && globals.parameters.core_asset) {
                    coreAsset = globals.parameters.core_asset;
                }
            } catch (_: any) {}

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

    async function registerApi(apiName: string): Promise<number> {
        const apiId = await transport.call('call', [1, apiName, []]);
        return apiId;
    }

    async function dbCall(method: string, args?: any[]): Promise<any> {
        if (_dbApiId == null) {
            _dbApiId = await registerApi('database');
        }
        return transport.call('call', [_dbApiId, toRpcMethodName(method), args || []]);
    }

    async function historyCall(method: string, args?: any[]): Promise<any> {
        if (_historyApiId == null) {
            _historyApiId = await registerApi('history');
        }
        return transport.call('call', [_historyApiId, toRpcMethodName(method), args || []]);
    }

    async function broadcastCall(method: string, args?: any[]): Promise<any> {
        if (_broadcastApiId == null) {
            _broadcastApiId = await registerApi('network_broadcast');
        }
        return transport.call('call', [_broadcastApiId, method, args || []]);
    }

    async function broadcastTx(signedTx: any): Promise<any> {
        return broadcastCall('broadcast_transaction', [signedTx]);
    }

    async function connect(servers?: string[]): Promise<void> {
        if (Array.isArray(servers)) {
            setNodes(servers);
        } else if (transport._getNodes().length === 0 && Array.isArray(nodes) && nodes.length > 0) {
            setNodes(nodes);
        }
        await transport.connect(undefined, autoreconnect);
    }

    function disconnect(): void {
        _dbApiId = null;
        _historyApiId = null;
        _broadcastApiId = null;
        _chainConfig = null;
        transport.disconnect();
    }

    function setNodes(servers: string[]): void {
        transport._setNodes(servers);
    }

    function getNodes(): string[] { return transport._getNodes(); }
    function getStatus(): string { return transport.getStatus(); }
    function getConfig(): ChainConfig | null { return _chainConfig; }
    function getCoreAsset(): string { return _chainConfig ? _chainConfig.coreAsset : CHAIN.CORE_ASSET_ID; }

    const db: Record<string, (...args: any[]) => Promise<any>> = {};

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
        db[method] = (...args: any[]) => dbCall(method, args);
    }

    db.call = dbCall;

    const history: Record<string, (...args: any[]) => Promise<any>> = {};

    const HISTORY_METHODS = [
        'getMarketHistory', 'get_market_history', 'getMarketHistoryBuckets', 'get_market_history_buckets',
        'get_account_history_by_operations', 'getAccountHistory', 'get_account_history',
        'getAccountHistoryOperations', 'get_account_history_operations',
        'get_liquidity_pool_history', 'get_liquidity_pool_history_by_sequence',
        'get_relative_account_history',
    ];

    for (const method of HISTORY_METHODS) {
        history[method] = (...args: any[]) => historyCall(method, args);
    }

    history.call = historyCall;

    const broadcast: Record<string, (...args: any[]) => Promise<any>> = {
        call: broadcastCall,
        broadcast_transaction: (tx: any) => broadcastTx(tx),
        broadcast_transaction_synchronous: (tx: any) => broadcastCall('broadcast_transaction_synchronous', [tx]),
    };

    const client: any = {
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
        onReconnect: null as (() => Promise<void>) | null,
    };

    return client;
}

interface ReadOnlyClientConfig {
    nodes?: string[];
    rpcTimeoutMs?: number;
    connectTimeoutMs?: number;
    validateChainId?: boolean;
    expectedChainId?: string;
}

function createReadOnlyClient(config: ReadOnlyClientConfig = {}) {
    const {
        nodes = [],
        validateChainId = true,
        expectedChainId = GRAPHENE_CHAIN_ID,
    } = config;

    const transport = createTransport({
        rpcTimeoutMs: config.rpcTimeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
    });

    let _dbApiId: number | null = null;
    let _historyApiId: number | null = null;

    async function connect(servers?: string[]): Promise<void> {
        const effectiveNodes = Array.isArray(servers) && servers.length > 0
            ? servers
            : nodes;
        await transport.connect(effectiveNodes, false);
        const loginOk = await transport.call('call', [1, 'login', ['', '']]);
        if (!loginOk) throw new ConnectionError('Login error');
        _dbApiId = await transport.call('call', [1, 'database', []]);
        _historyApiId = await transport.call('call', [1, 'history', []]);

        if (validateChainId) {
            const chainId: string = await transport.call('call', [_dbApiId, 'get_chain_id', []]);
            if (chainId !== expectedChainId) {
                disconnect();
                throw new ChainConfigError(
                    `Chain ID mismatch: expected ${expectedChainId}, got ${chainId}`
                );
            }
        }
    }

    function disconnect(): void {
        _dbApiId = null;
        _historyApiId = null;
        transport.disconnect();
    }

    async function db(method: string, args?: any[]): Promise<any> {
        if (_dbApiId == null) throw new Error('Not connected');
        return transport.call('call', [_dbApiId, toRpcMethodName(method), args || []]);
    }

    async function history(method: string, args?: any[]): Promise<any> {
        if (_historyApiId == null) throw new Error('Not connected');
        return transport.call('call', [_historyApiId, toRpcMethodName(method), args || []]);
    }

    function setNodes(servers: string[]): void {
        transport._setNodes(servers);
    }

    function getNodes(): string[] {
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

export = { createChainClient, createReadOnlyClient, ChainConfigError };
