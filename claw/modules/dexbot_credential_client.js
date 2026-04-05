const net = require('net');
const crypto = require('crypto');
const {
  DEFAULT_READY_FILE,
  DEFAULT_SOCKET_PATH,
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

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(`${JSON.stringify({ type: 'private-key', accountName })}\n`);
    });

    let responseBuffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Credential daemon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('data', (data) => {
      responseBuffer += data.toString();
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        clearTimeout(timer);
        socket.end();

        try {
          const response = JSON.parse(line);
          if (response.success) {
            resolve(response.privateKey);
          } else {
            reject(new Error(response.error || 'Unknown credential daemon error'));
          }
        } catch {
          reject(new Error('Invalid credential daemon response'));
        }
        return;
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Credential daemon connection failed: ${error.message}`));
    });

    socket.on('end', () => {
      clearTimeout(timer);
      if (!responseBuffer.trim()) {
        reject(new Error('Credential daemon closed the connection unexpectedly'));
      }
    });
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
  const sessionId = options.sessionId || null;
  const botHmacSecret = options.botHmacSecret || null;

  // Compute HMAC if botHmacSecret is provided
  let hmac = null;
  if (botHmacSecret && sessionId) {
    const signingPayload = JSON.stringify({ sessionId, operations: [operation] });
    hmac = crypto
      .createHmac('sha256', Buffer.from(botHmacSecret, 'hex'))
      .update(signingPayload)
      .digest('hex');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(socketPath, () => {
      const payload = {
        type: 'broadcast-operation',
        accountName,
        sessionId,
        operation
      };
      if (hmac) {
        payload.hmac = hmac;
      }
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    let responseBuffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) { settled = true; reject(new Error(`Credential daemon request timed out after ${timeoutMs}ms`)); }
    }, timeoutMs);

    socket.on('data', (data) => {
      responseBuffer += data.toString();
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        clearTimeout(timer);
        socket.end();

        if (!settled) {
          settled = true;
          try {
            const response = JSON.parse(line);
            if (response.success) {
              resolve(response.result);
            } else {
              reject(new Error(response.error || 'Unknown credential daemon error'));
            }
          } catch {
            reject(new Error('Invalid credential daemon response'));
          }
        }
        return;
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`Credential daemon connection failed: ${error.message}`)); }
    });

    socket.on('end', () => {
      clearTimeout(timer);
      if (!settled && !responseBuffer.trim()) {
        settled = true;
        reject(new Error('Credential daemon closed the connection unexpectedly'));
      }
    });
  });
}

module.exports = {
  DEFAULT_READY_FILE,
  DEFAULT_SOCKET_PATH,
  broadcastOperationViaCredentialDaemon,
  executeOperationsViaCredentialDaemon,
  isCredentialDaemonReady,
  requestPrivateKeyFromCredentialDaemon,
  waitForCredentialDaemon
};
