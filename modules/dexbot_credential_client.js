const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { TIMING } = require('./constants');
const {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
    isPrivatePathSecure,
} = require('./credential_runtime');

const DEFAULT_SOCKET_PATH = getCredentialSocketPath();
const DEFAULT_READY_FILE = getCredentialReadyFilePath();
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;
const DEFAULT_POLL_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

function getSocketPath(options = {}) {
    return options.socketPath || DEFAULT_SOCKET_PATH;
}

function sendCredentialDaemonRequest(socketPath, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = net.createConnection(socketPath, () => {
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
                if (!line.trim()) continue;
                clearTimeout(timer);
                socket.end();
                if (!settled) {
                    settled = true;
                    try {
                        resolve(JSON.parse(line));
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

function getReadyFilePath(options = {}) {
    return options.readyFilePath || DEFAULT_READY_FILE;
}

function isCredentialDaemonReady(options = {}) {
    try {
        const readyFilePath = getReadyFilePath(options);
        const socketPath = getSocketPath(options);
        return fs.existsSync(readyFilePath) &&
            fs.existsSync(socketPath) &&
            isPrivatePathSecure(readyFilePath, { expectedType: 'file', requiredMode: 0o600 }) &&
            isPrivatePathSecure(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
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

function executeOperationsViaCredentialDaemon(accountName, operations, options = {}) {
    if (!accountName) {
        return Promise.reject(new Error('accountName is required to execute operations'));
    }
    if (!Array.isArray(operations)) {
        return Promise.reject(new Error('operations must be an array'));
    }

    const socketPath = getSocketPath(options);
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : DEFAULT_REQUEST_TIMEOUT_MS;

    const payload = { type: 'execute-operations', accountName, operations };
    const sessionId = options.sessionId || null;
    if (sessionId) payload.sessionId = sessionId;

    const botHmacSecret = options.botHmacSecret || null;
    if (botHmacSecret && sessionId) {
        payload.hmac = crypto
            .createHmac('sha256', Buffer.from(botHmacSecret, 'hex'))
            .update(JSON.stringify({ sessionId, operations }))
            .digest('hex');
    }

    return sendCredentialDaemonRequest(socketPath, payload, timeoutMs).then((response) => {
        if (response.success) {
            return response;
        }
        throw new Error(response.error || 'Unknown credential daemon error');
    });
}

module.exports = {
    DEFAULT_READY_FILE,
    DEFAULT_SOCKET_PATH,
    sendCredentialDaemonRequest,
    executeOperationsViaCredentialDaemon,
    isCredentialDaemonReady,
    waitForCredentialDaemon,
};
