const fs = require('fs');
const net = require('net');
const { TIMING } = require('../../modules/constants');
const {
  getCredentialReadyFilePath,
  getCredentialSocketPath,
} = require('../../modules/credential_runtime');

const DEFAULT_SOCKET_PATH = getCredentialSocketPath();
const DEFAULT_READY_FILE = getCredentialReadyFilePath();
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;
const DEFAULT_POLL_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

function getSocketPath(options = {}) {
  return options.socketPath || DEFAULT_SOCKET_PATH;
}

function getReadyFilePath(options = {}) {
  return options.readyFilePath || DEFAULT_READY_FILE;
}

function isCredentialDaemonReady(options = {}) {
  try {
    return fs.existsSync(getReadyFilePath(options)) && fs.existsSync(getSocketPath(options));
  } catch {
    return false;
  }
}

async function waitForCredentialDaemon(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, options = {}) {
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs))
    ? Number(options.pollIntervalMs)
    : DEFAULT_POLL_INTERVAL_MS;
  const start = Date.now();

  while (!isCredentialDaemonReady(options)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for DEXBot2 credential daemon after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
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

module.exports = {
  DEFAULT_READY_FILE,
  DEFAULT_SOCKET_PATH,
  isCredentialDaemonReady,
  requestPrivateKeyFromCredentialDaemon,
  waitForCredentialDaemon
};
