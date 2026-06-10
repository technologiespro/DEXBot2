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
const DEFAULT_BROADCAST_TIMEOUT_MS = TIMING.CREDENTIAL_BROADCAST_TIMEOUT_MS || 30000;
const DEFAULT_WAIT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;
const DEFAULT_POLL_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

/**
 * Typed error raised when the bot-side socket timer fires BEFORE the credential
 * daemon has responded. The chain status of the operations is unknown at this
 * point — the daemon may have signed and broadcast, or it may have stalled
 * before doing anything. Callers (chain_orders.ts / dexbot_class.ts) MUST catch
 * this and run the recovery path (read chain, match by fingerprint, adopt or
 * discard). A plain `Error` would lose the metadata the recovery path needs.
 *
 * Fields:
 *   - operations: the original op array sent to the daemon
 *   - accountName: account the ops were intended for
 *   - batchId: caller-provided correlation id (if any)
 *   - payload: the full request payload (for retry/log)
 *   - timeoutMs: the outer timeout that fired
 */
class BroadcastUncertainError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'BroadcastUncertainError';
        this.code = 'BROADCAST_UNCERTAIN';
        this.operations = details.operations || null;
        this.accountName = details.accountName || null;
        this.batchId = details.batchId || null;
        this.payload = details.payload || null;
        this.timeoutMs = details.timeoutMs || null;
    }
}

function getSocketPath(options = {}) {
    return options.socketPath || DEFAULT_SOCKET_PATH;
}

function sendCredentialDaemonRequest(socketPath, payload, timeoutMs, meta = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = net.createConnection(socketPath, () => {
            socket.write(`${JSON.stringify(payload)}\n`);
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            if (!settled) {
                settled = true;
                // For broadcast requests the chain may have already accepted the
                // operations by the time we time out. Use a typed error so the
                // recovery path can detect this case explicitly. Non-broadcast
                // requests stay on the plain Error path.
                if (meta && meta.uncertainOnTimeout) {
                    reject(new BroadcastUncertainError(
                        `Credential daemon broadcast request timed out after ${timeoutMs}ms`,
                        {
                            operations: meta.operations || null,
                            accountName: meta.accountName || null,
                            batchId: meta.batchId || null,
                            payload,
                            timeoutMs,
                        }
                    ));
                } else {
                    reject(new Error(`Credential daemon request timed out after ${timeoutMs}ms`));
                }
            }
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
    // Broadcast requests have their own (longer) outer timeout. Non-broadcast
    // callers can still pass timeoutMs explicitly to override.
    const isBroadcast = options.requestType === 'broadcast' || options.isBroadcast === true;
    const defaultTimeout = isBroadcast ? DEFAULT_BROADCAST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : defaultTimeout;

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

    const meta = isBroadcast
        ? {
            uncertainOnTimeout: true,
            operations,
            accountName,
            batchId: options.batchId || null,
        }
        : {};

    return sendCredentialDaemonRequest(socketPath, payload, timeoutMs, meta).then((response) => {
        if (response.success) {
            return response;
        }
        const errMsg = response.error || 'Unknown credential daemon error';
        const errCode = response.code || null;
        // The daemon hit its inner deadline (BROADCAST_DEADLINE) and the chain
        // state is uncertain. Convert this typed failure back to a
        // BroadcastUncertainError so the recovery path picks it up. Only
        // relevant for broadcast requests — non-broadcast callers don't carry
        // the uncertainOnTimeout flag.
        if (
            isBroadcast &&
            (errCode === 'BROADCAST_DEADLINE' ||
                (typeof errMsg === 'string' && errMsg.startsWith('BROADCAST_DEADLINE')))
        ) {
            throw new BroadcastUncertainError(
                `Credential daemon broadcast uncertain: ${errCode || errMsg}`,
                {
                    operations,
                    accountName,
                    batchId: options.batchId || null,
                    payload,
                    timeoutMs,
                }
            );
        }
        // Typed failure reply from the daemon (e.g. policy denied, bad op) —
        // the chain state is known (chain NOT touched), so a plain Error is
        // fine.
        throw new Error(errMsg);
    });
}

export = {
    DEFAULT_READY_FILE,
    DEFAULT_SOCKET_PATH,
    DEFAULT_BROADCAST_TIMEOUT_MS,
    sendCredentialDaemonRequest,
    executeOperationsViaCredentialDaemon,
    isCredentialDaemonReady,
    waitForCredentialDaemon,
    BroadcastUncertainError,
};
