const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { TIMING } = require('../constants');

const BOOTSTRAP_SOCKET_PREFIX = 'dexbot-cred-bootstrap-';
const DEFAULT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;

function debugLog(message, err = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    console.error(`[credential-bootstrap][debug] ${message}${suffix}`);
}

function cleanupBootstrapArtifacts(socketPath, socketDir) {
    if (socketPath) {
        try { fs.unlinkSync(socketPath); } catch (err) { }
    }
    if (socketDir) {
        try { fs.rmdirSync(socketDir); } catch (err) { }
    }
}

function createBootstrapSocketDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), BOOTSTRAP_SOCKET_PREFIX));
    try {
        fs.chmodSync(dir, 0o700);
    } catch (err) {
        debugLog(`Unable to chmod bootstrap dir ${dir}`, err);
    }
    return dir;
}

function fetchBootstrapPassword({
    socketPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (!socketPath) {
        return Promise.reject(new Error('Missing bootstrap socket'));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        const socket = net.createConnection(socketPath, () => {
            socket.write(JSON.stringify({ type: 'bootstrap-password' }) + '\n');
        });

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error(`Timed out waiting for bootstrap password after ${timeoutMs}ms`));
        }, timeoutMs);

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        }

        socket.on('data', (data) => {
            buffer += data.toString();
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) return;

            const line = buffer.slice(0, newlineIndex).trim();
            try {
                const response = JSON.parse(line);
                if (!response || response.success !== true || typeof response.password !== 'string') {
                    finish(reject, new Error(response && response.error ? response.error : 'Invalid bootstrap response'));
                    return;
                }
                socket.end();
                finish(resolve, response.password);
            } catch (error) {
                finish(reject, new Error('Invalid bootstrap response'));
            }
        });

        socket.on('error', (error) => finish(reject, error));
        socket.on('end', () => {
            if (!settled) {
                finish(reject, new Error('Bootstrap socket closed before password was received'));
            }
        });
    });
}

async function createPasswordBootstrapServer({
    password,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Bootstrap password must be a non-empty string');
    }

    const socketDir = createBootstrapSocketDir();
    const socketPath = path.join(socketDir, 'bootstrap.sock');
    let server = null;
    let settled = false;
    let cleanedUp = false;
    let timeoutHandle = null;
    let resolveTransfer;
    let rejectTransfer;

    const transferPromise = new Promise((resolve, reject) => {
        resolveTransfer = resolve;
        rejectTransfer = reject;
    });

    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        if (server) {
            try { server.close(); } catch (err) { }
            server = null;
        }
        cleanupBootstrapArtifacts(socketPath, socketDir);
    }

    function settle(fn, value) {
        if (settled) return;
        settled = true;
        fn(value);
        cleanup();
    }

    await new Promise((resolve, reject) => {
        server = net.createServer((socket) => {
            let buffer = '';

            socket.on('data', (data) => {
                buffer += data.toString();
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) return;

                const line = buffer.slice(0, newlineIndex).trim();
                try {
                    const request = JSON.parse(line);
                    if (!request || request.type !== 'bootstrap-password') {
                        socket.write(JSON.stringify({ success: false, error: 'Invalid bootstrap request' }) + '\n');
                        socket.end();
                        return;
                    }

                    socket.write(JSON.stringify({ success: true, password }) + '\n');
                    socket.end();
                    settle(resolveTransfer);
                } catch (error) {
                    socket.write(JSON.stringify({ success: false, error: 'Invalid bootstrap request' }) + '\n');
                    socket.end();
                }
            });

            socket.on('error', () => {
            });
        });

        server.on('error', (error) => {
            cleanup();
            reject(error);
        });

        server.listen(socketPath, () => {
            try {
                fs.chmodSync(socketPath, 0o600);
            } catch (err) {
                debugLog(`Unable to chmod bootstrap socket ${socketPath}`, err);
            }
            resolve();
        });
    });

    timeoutHandle = setTimeout(() => {
        settle(rejectTransfer, new Error(`Timed out waiting for credential daemon bootstrap after ${timeoutMs}ms`));
    }, timeoutMs);

    return {
        credentialEnv: {
            DEXBOT_CRED_BOOTSTRAP_SOCKET: socketPath,
        },
        close: cleanup,
        waitForTransfer: () => transferPromise.finally(() => cleanup()),
    };
}

module.exports = {
    BOOTSTRAP_SOCKET_PREFIX,
    DEFAULT_TIMEOUT_MS,
    createPasswordBootstrapServer,
    fetchBootstrapPassword,
};
