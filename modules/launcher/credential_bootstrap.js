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

function cleanupStaleBootstrapDirs() {
    const tmpDir = os.tmpdir();
    let entries;
    try {
        entries = fs.readdirSync(tmpDir);
    } catch (err) {
        return;
    }
    const now = Date.now();
    const staleThresholdMs = 30 * 60 * 1000;
    for (const entry of entries) {
        if (!entry.startsWith(BOOTSTRAP_SOCKET_PREFIX)) continue;
        const dirPath = path.join(tmpDir, entry);
        let stat;
        try { stat = fs.statSync(dirPath); } catch (err) { continue; }
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs > staleThresholdMs) {
            try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (err) { }
        }
    }
}

function createBootstrapSocketDir() {
    cleanupStaleBootstrapDirs();
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
                if (!response || response.success !== true) {
                    finish(reject, new Error(response && response.error ? response.error : 'Invalid bootstrap response'));
                    return;
                }
                if (typeof response.password === 'string') {
                    socket.end();
                    finish(resolve, response.password);
                    return;
                }
                if (typeof response.secret !== 'undefined') {
                    socket.end();
                    finish(resolve, response.secret);
                    return;
                }
                finish(reject, new Error('Invalid bootstrap response'));
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
    secret,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const credential = typeof secret !== 'undefined' ? secret : password;
    const credentialType = typeof secret !== 'undefined' ? 'secret' : 'password';
    if (credentialType === 'password') {
        if (typeof credential !== 'string' || credential.length === 0) {
            throw new Error('Bootstrap password must be a non-empty string');
        }
    } else if (typeof credential === 'undefined' || credential === null) {
        throw new Error('Bootstrap secret must be defined');
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

                    socket.write(JSON.stringify({ success: true, [credentialType]: credential }) + '\n');
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
