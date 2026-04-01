const { createAccountClient } = require('./bitshares_client');
const {
  isCredentialDaemonReady,
  requestPrivateKeyFromCredentialDaemon,
  waitForCredentialDaemon
} = require('./dexbot_credential_client');

function createSigningClient(accountName, privateKey) {
  return createAccountClient(accountName, privateKey);
}

function resolveAccountName(options = {}) {
  return options.accountName || process.env.BITSHARES_ACCOUNT || null;
}

async function createSigningClientFromCredentialDaemon(options = {}) {
  const accountName = resolveAccountName(options);
  if (!accountName) {
    throw new Error('accountName is required');
  }

  const daemonTimeoutMs = Number.isFinite(Number(options.daemonTimeoutMs))
    ? Number(options.daemonTimeoutMs)
    : undefined;
  const requestTimeoutMs = Number.isFinite(Number(options.daemonRequestTimeoutMs))
    ? Number(options.daemonRequestTimeoutMs)
    : undefined;

  await waitForCredentialDaemon(daemonTimeoutMs, options);
  const privateKey = await requestPrivateKeyFromCredentialDaemon(accountName, {
    socketPath: options.socketPath,
    timeoutMs: requestTimeoutMs
  });
  return createSigningClient(accountName, privateKey);
}

async function getSigningClient(options = {}) {
  const accountName = resolveAccountName(options);
  if (!accountName) {
    throw new Error('accountName is required');
  }

  if (options.privateKey) {
    return createSigningClient(accountName, options.privateKey);
  }

  if (!isCredentialDaemonReady(options)) {
    throw new Error('Credential daemon is not ready');
  }

  return createSigningClientFromCredentialDaemon({
    ...options,
    accountName
  });
}

function normalizeOperations(operations) {
  const ops = Array.isArray(operations) ? operations : [operations];
  return ops.filter(Boolean);
}

async function executeOperations(operations, options = {}) {
  const ops = normalizeOperations(operations);
  if (ops.length === 0) {
    return { success: true, operation_results: [], raw: null };
  }

  const client = await getSigningClient(options);
  if (client.initPromise) {
    await client.initPromise;
  }

  if (typeof client.newTx !== 'function') {
    throw new Error('Signing client does not support newTx()');
  }

  const tx = client.newTx();
  for (const op of ops) {
    if (!op.op_name || !op.op_data) {
      throw new Error('Each operation requires op_name and op_data');
    }
    if (typeof tx[op.op_name] !== 'function') {
      throw new Error(`Transaction builder does not support ${op.op_name}`);
    }
    tx[op.op_name](op.op_data);
  }

  const result = await tx.broadcast();
  const operationResults =
    (result && Array.isArray(result.operation_results) && result.operation_results) ||
    (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
    (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
    [];

  return {
    success: true,
    raw: result,
    operation_results: operationResults
  };
}

async function broadcastOperation(operation, options = {}) {
  if (operation && operation.op_name && operation.op_data) {
    return executeOperations([operation], options);
  }

  const client = await getSigningClient(options);
  return client.broadcast(operation);
}

module.exports = {
  broadcastOperation,
  createSigningClient,
  createSigningClientFromCredentialDaemon,
  executeOperations,
  getSigningClient,
  resolveAccountName
};
