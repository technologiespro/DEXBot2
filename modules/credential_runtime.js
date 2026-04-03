const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_DIR_NAME = 'dexbot2';
const DEFAULT_SOCKET_BASENAME = 'dexbot-cred-daemon.sock';
const DEFAULT_READY_BASENAME = 'dexbot-cred-daemon.ready';

function debugLog(message, err = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    console.error(`[credential-runtime][debug] ${message}${suffix}`);
}

function getDexbotRoot() {
    return path.resolve(__dirname, '..');
}

function isUsableRuntimeBaseDir(dirPath) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
        return fs.statSync(dirPath).isDirectory();
    } catch (err) {
        return false;
    }
}

function getCredentialRuntimeDir(options = {}) {
    if (options.runtimeDir) {
        return path.resolve(options.runtimeDir);
    }
    if (process.env.DEXBOT_CRED_RUNTIME_DIR) {
        return path.resolve(process.env.DEXBOT_CRED_RUNTIME_DIR);
    }
    if (process.env.XDG_RUNTIME_DIR) {
        const xdgRuntimeDir = path.resolve(process.env.XDG_RUNTIME_DIR);
        if (isUsableRuntimeBaseDir(xdgRuntimeDir)) {
            return path.join(xdgRuntimeDir, DEFAULT_RUNTIME_DIR_NAME);
        }
    }

    const root = options.root ? path.resolve(options.root) : getDexbotRoot();
    return path.join(root, 'profiles', 'run');
}

function getCredentialSocketPath(options = {}) {
    if (options.socketPath) {
        return path.resolve(options.socketPath);
    }
    if (process.env.DEXBOT_CRED_DAEMON_SOCKET) {
        return path.resolve(process.env.DEXBOT_CRED_DAEMON_SOCKET);
    }
    return path.join(getCredentialRuntimeDir(options), DEFAULT_SOCKET_BASENAME);
}

function getCredentialReadyFilePath(options = {}) {
    if (options.readyFilePath) {
        return path.resolve(options.readyFilePath);
    }
    if (process.env.DEXBOT_CRED_DAEMON_READY_FILE) {
        return path.resolve(process.env.DEXBOT_CRED_DAEMON_READY_FILE);
    }
    return path.join(getCredentialRuntimeDir(options), DEFAULT_READY_BASENAME);
}

function ensureCredentialRuntimeDirSync(options = {}) {
    const runtimeDir = getCredentialRuntimeDir(options);
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(runtimeDir, 0o700);
    } catch (err) {
        debugLog(`Unable to chmod runtime dir ${runtimeDir}`, err);
    }
    return runtimeDir;
}

module.exports = {
    DEFAULT_READY_BASENAME,
    DEFAULT_RUNTIME_DIR_NAME,
    DEFAULT_SOCKET_BASENAME,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialRuntimeDir,
    getCredentialSocketPath,
    isUsableRuntimeBaseDir,
};
