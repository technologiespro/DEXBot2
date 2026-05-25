const crypto = require('crypto');
const {
  DEFAULT_READY_FILE,
  DEFAULT_SOCKET_PATH,
  sendCredentialDaemonRequest,
  executeOperationsViaCredentialDaemon,
  isCredentialDaemonReady,
  waitForCredentialDaemon,
} = require('../../modules/dexbot_credential_client');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function getSocketPath(options = {}) {
  return options.socketPath || DEFAULT_SOCKET_PATH;
}

function requestPrivateKeyFromCredentialDaemon(accountName, options = {}) {
  if (!accountName) {
    return Promise.reject(new Error('accountName is required to request a private key'));
  }

  const socketPath = getSocketPath(options);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;

  return sendCredentialDaemonRequest(socketPath, { type: 'private-key', accountName }, timeoutMs).then((response) => {
    if (response.success) {
      return response.privateKey;
    }
    throw new Error(response.error || 'Unknown credential daemon error');
  });
}

function broadcastOperationViaCredentialDaemon(accountName, operation, options = {}) {
  if (!accountName) {
    return Promise.reject(new Error('accountName is required to broadcast operations'));
  }
  if (!operation || typeof operation !== 'object') {
    return Promise.reject(new Error('operation must be an object'));
  }

  const socketPath = getSocketPath(options);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;

  const payload = { type: 'broadcast-operation', accountName, operation };
  const sessionId = options.sessionId || null;
  if (sessionId) payload.sessionId = sessionId;

  const botHmacSecret = options.botHmacSecret || null;
  if (botHmacSecret && sessionId) {
    payload.hmac = crypto
      .createHmac('sha256', Buffer.from(botHmacSecret, 'hex'))
      .update(JSON.stringify({ sessionId, operations: [operation] }))
      .digest('hex');
  }

  return sendCredentialDaemonRequest(socketPath, payload, timeoutMs).then((response) => {
    if (response.success) {
      return response.result;
    }
    throw new Error(response.error || 'Unknown credential daemon error');
  });
}

export = {
  DEFAULT_READY_FILE,
  DEFAULT_SOCKET_PATH,
  broadcastOperationViaCredentialDaemon,
  executeOperationsViaCredentialDaemon,
  isCredentialDaemonReady,
  requestPrivateKeyFromCredentialDaemon,
  waitForCredentialDaemon
};
