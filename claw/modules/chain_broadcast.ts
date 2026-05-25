const { createAccountClient } = require('./bitshares_client');
const path = require('path');
const {
  isCredentialDaemonReady,
  broadcastOperationViaCredentialDaemon,
  executeOperationsViaCredentialDaemon,
  requestPrivateKeyFromCredentialDaemon,
  waitForCredentialDaemon
} = require('./dexbot_credential_client');
const { getDexbot2Root, requireDexbot2Module } = require('./dexbot_bridge');

// Lazy-load DEXBot2 modules
let chainKeys = null;
let credentialPolicy = null;

function getChainKeys() {
  if (!chainKeys) chainKeys = requireDexbot2Module('modules/chain_keys.js');
  return chainKeys;
}

function getCredentialPolicy() {
  if (!credentialPolicy) credentialPolicy = requireDexbot2Module('modules/credential_policy.js');
  return credentialPolicy;
}

/**
 * Resolve sessionId and botHmacSecret for an account.
 * Probes the daemon for a session and loads the HMAC secret from DEXBot2 profiles.
 */
async function resolveSessionCredentials(accountName, options = {}) {
  let sessionId = options.sessionId || null;
  let botHmacSecret = options.botHmacSecret || null;

  if (sessionId && botHmacSecret) {
    return { sessionId, botHmacSecret };
  }

  try {
    const chainKeysMod = getChainKeys();
    const policyMod = getCredentialPolicy();

    // If no sessionId, probe the daemon
    if (!sessionId) {
      sessionId = await chainKeysMod.probeAccountInDaemon(accountName, 5000, options);
    }

    // If no secret, try to load it from DEXBot2 profile
    if (!botHmacSecret) {
      const policyPath = path.join(getDexbot2Root(), 'profiles', 'daemon-policies.json');
      botHmacSecret = policyMod.loadBotHmacSecret(accountName, policyPath);
    }
  } catch (_: any) {
    // Fall back to unauthenticated request if probe/load fails
  }

  return { sessionId, botHmacSecret };
}

async function createSigningClient(accountName, privateKey) {
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

  if (!options.privateKey && isCredentialDaemonReady(options)) {
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

    const { sessionId, botHmacSecret } = await resolveSessionCredentials(accountName, options);

    const result = await executeOperationsViaCredentialDaemon(accountName, ops, {
      socketPath: options.socketPath,
      timeoutMs: requestTimeoutMs,
      sessionId,
      botHmacSecret
    });

    return {
      ...result,
      operation_results: result.operation_results || [],
      raw: result.raw || null,
      success: true
    };
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

  if (!options.privateKey && isCredentialDaemonReady(options)) {
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

    const { sessionId, botHmacSecret } = await resolveSessionCredentials(accountName, options);

    const result = await broadcastOperationViaCredentialDaemon(accountName, operation, {
      socketPath: options.socketPath,
      timeoutMs: requestTimeoutMs,
      sessionId,
      botHmacSecret
    });

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

  const client = await getSigningClient(options);
  return client.broadcast(operation);
}

export = {
  broadcastOperation,
  createSigningClient,
  createSigningClientFromCredentialDaemon,
  executeOperations,
  getSigningClient,
  resolveAccountName
};
