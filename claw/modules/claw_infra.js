const fs = require('fs/promises');
const path = require('path');

const bitsharesClient = require('./bitshares_client');
const chainBroadcast = require('./chain_broadcast');
const chainQueries = require('./chain_queries');
const credentialClient = require('./dexbot_credential_client');
const { createHonestEcosystemAdapter } = require('./honest_ecosystem');
const { loadDexbotOrderSubsystem } = require('./dexbot_bridge');
const { createDexbotProfileAdapter } = require('./dexbot_profiles');
const {
  createPositionManagerWatcher,
  parsePositionManagerWatchArgs,
  runPositionManagerWatch
} = require('./position_manager_watch');

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function createRuntimeContext(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const stateDir = options.stateDir || path.join(dataDir, 'state');

  return {
    accountName: options.accountName || null,
    config: clone(options.config) || {},
    createdAt: new Date().toISOString(),
    dataDir,
    cwd: process.cwd(),
    logger: options.logger || console,
    name: options.name || 'claw-runtime',
    profileRoot: options.profileRoot || process.env.DEXBOT_PROFILE_ROOT || null,
    readyFilePath: options.readyFilePath || credentialClient.DEFAULT_READY_FILE,
    socketPath: options.socketPath || credentialClient.DEFAULT_SOCKET_PATH,
    stateDir
  };
}

function createStateStore(options = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), 'data');
  const stateDir = options.stateDir || path.join(dataDir, 'state');
  const filePath = options.filePath || path.join(stateDir, 'claw-state.json');
  const defaultValue = clone(options.defaultValue);

  async function read() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      if (!raw.trim()) {
        return clone(defaultValue);
      }
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return clone(defaultValue);
      }
      throw new Error(`Failed to read state store ${filePath}: ${error.message}`);
    }
  }

  async function write(value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const serialized = JSON.stringify(value, null, 2);
    await fs.writeFile(filePath, `${serialized === undefined ? 'null' : serialized}\n`, 'utf8');
    return value;
  }

  async function patch(partial) {
    const current = await read();
    const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const next = {
      ...base,
      ...(partial && typeof partial === 'object' ? partial : {})
    };
    return write(next);
  }

  async function update(updater) {
    if (typeof updater !== 'function') {
      throw new Error('update(updater) requires a function');
    }

    const current = await read();
    const next = await updater(clone(current));
    return write(next);
  }

  async function clear() {
    return write(clone(defaultValue));
  }

  return {
    clear,
    filePath,
    patch,
    read,
    update,
    write
  };
}

function createCredentialClient(options = {}) {
  const socketPath = options.socketPath || credentialClient.DEFAULT_SOCKET_PATH;
  const readyFilePath = options.readyFilePath || credentialClient.DEFAULT_READY_FILE;

  return {
    isReady: () => credentialClient.isCredentialDaemonReady({ socketPath, readyFilePath }),
    readyFilePath,
    requestPrivateKey: (accountName, requestOptions = {}) => credentialClient.requestPrivateKeyFromCredentialDaemon(accountName, {
      socketPath,
      timeoutMs: requestOptions.timeoutMs
    }),
    socketPath,
    waitForReady: (timeoutMs) => credentialClient.waitForCredentialDaemon(timeoutMs, {
      pollIntervalMs: options.pollIntervalMs,
      readyFilePath,
      socketPath
    })
  };
}

function createBitsharesClient(options = {}) {
  const accountName = options.accountName || null;
  const socketPath = options.socketPath || credentialClient.DEFAULT_SOCKET_PATH;
  const readyFilePath = options.readyFilePath || credentialClient.DEFAULT_READY_FILE;

  return {
    accountName,
    createAccountClient: (name = accountName, privateKey) => bitsharesClient.createAccountClient(name, privateKey),
    credentials: {
      readyFilePath,
      socketPath
    },
    dbCall: chainQueries.dbCall,
    executeOperations: (operations, broadcastOptions = {}) => chainBroadcast.executeOperations(operations, {
      ...broadcastOptions,
      accountName: broadcastOptions.accountName || accountName,
      readyFilePath,
      socketPath
    }),
    getSigningClient: (broadcastOptions = {}) => chainBroadcast.getSigningClient({
      ...broadcastOptions,
      accountName: broadcastOptions.accountName || accountName,
      readyFilePath,
      socketPath
    }),
    isConnected: bitsharesClient.isConnected,
    read: chainQueries,
    setSuppressConnectionLog: bitsharesClient.setSuppressConnectionLog,
    waitForConnected: bitsharesClient.waitForConnected
  };
}

function createMarketAdapter(options = {}) {
  const readAccountSnapshot = async (accountRef) => {
    const [account, balances, openOrders] = await Promise.all([
      chainQueries.getFullAccount(accountRef),
      chainQueries.getBalances(accountRef),
      chainQueries.readOpenOrders(accountRef)
    ]);

    return {
      account,
      balances,
      openOrders
    };
  };

  const readMarketSnapshot = async (baseSymbol, quoteSymbol, limit = 10) => {
    const [dynamicGlobalProperties, orderBook, ticker] = await Promise.all([
      chainQueries.getDynamicGlobalProperties(),
      chainQueries.getOrderBook(baseSymbol, quoteSymbol, limit),
      chainQueries.getTicker(baseSymbol, quoteSymbol)
    ]);

    return {
      dynamicGlobalProperties,
      orderBook,
      ticker
    };
  };

  return {
    getAsset: chainQueries.getAsset,
    getBackingAsset: chainQueries.getBackingAsset,
    getBitassetData: chainQueries.getBitassetData,
    getCallOrders: chainQueries.getCallOrders,
    getDynamicGlobalProperties: chainQueries.getDynamicGlobalProperties,
    getFullAccount: chainQueries.getFullAccount,
    getOrderBook: chainQueries.getOrderBook,
    getTicker: chainQueries.getTicker,
    listAssets: chainQueries.listAssets,
    readAccountSnapshot,
    readMarketSnapshot,
    readOpenOrders: chainQueries.readOpenOrders,
    resolveAccountId: chainQueries.resolveAccountId,
    resolveAccountName: chainQueries.resolveAccountName
  };
}

function createOrderTools() {
  return loadDexbotOrderSubsystem();
}

function createClawInfrastructure(options = {}) {
  const runtime = createRuntimeContext({
    ...options,
    ...(options.runtime || {})
  });
  const stateStore = createStateStore({
    ...(options.stateStore || {}),
    dataDir: (options.stateStore && options.stateStore.dataDir) || runtime.dataDir,
    defaultValue: options.stateDefaultValue,
    filePath: (options.stateStore && options.stateStore.filePath) || options.stateFilePath,
    stateDir: (options.stateStore && options.stateStore.stateDir) || runtime.stateDir
  });
  const credential = createCredentialClient(options.credential || options);
  const bitshares = createBitsharesClient({
    ...(options.bitshares || {}),
    accountName: (options.bitshares && options.bitshares.accountName) || runtime.accountName,
    readyFilePath: (options.bitshares && options.bitshares.readyFilePath) || credential.readyFilePath,
    socketPath: (options.bitshares && options.bitshares.socketPath) || credential.socketPath
  });
  const market = createMarketAdapter(options.market || options);
  const order = createOrderTools();
  const honest = createHonestEcosystemAdapter({
    logger: runtime.logger
  });
  const profiles = createDexbotProfileAdapter(runtime.profileRoot, {
    logger: runtime.logger
  });

  return {
    bitshares,
    credential,
    honest,
    profiles,
    market,
    order,
    runtime,
    stateStore
  };
}

module.exports = {
  createBitsharesClient,
  createClawInfrastructure,
  createCredentialClient,
  createHonestEcosystemAdapter,
  createMarketAdapter,
  createOrderTools,
  createRuntimeContext,
  createStateStore,
  createPositionManagerWatcher,
  parsePositionManagerWatchArgs,
  runPositionManagerWatch
};
