// @ts-nocheck
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const { BUILD_DIR } = require('./constants');
const runtimeLogger = new Logger('credential-runtime');

const DEFAULT_RUNTIME_DIR_NAME = 'dexbot2';
const DEFAULT_SOCKET_BASENAME = 'dexbot-cred-daemon.sock';
const DEFAULT_READY_BASENAME = 'dexbot-cred-daemon.ready';

function debugLog(message, err = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    runtimeLogger.error(`[credential-runtime][debug] ${message}${suffix}`);
}

function getDexbotRoot() {
    const MODULE_DIR = path.dirname(__dirname);
    return path.basename(MODULE_DIR) === BUILD_DIR ? path.dirname(MODULE_DIR) : MODULE_DIR;
}

function isUsableRuntimeBaseDir(dirPath) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
        return fs.statSync(dirPath).isDirectory();
    } catch (err: any) {
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
    } catch (err: any) {
        debugLog(`Unable to chmod runtime dir ${runtimeDir}`, err);
    }
    assertPrivatePathSecurity(runtimeDir, { expectedType: 'dir', requiredMode: 0o700 });
    return runtimeDir;
}

function getCurrentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertPrivatePathSecurity(filePath, options = {}) {
    if (!filePath) {
        throw new Error('filePath is required');
    }

    const expectedType = options.expectedType || 'file';
    const requiredMode = options.requiredMode;
    const requireOwner = options.requireOwner !== false;

    if (process.platform === 'win32' && expectedType === 'socket') {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing socket path: ${filePath}`);
        }
        return null;
    }

    const stat = fs.lstatSync(filePath);

    if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to use symbolic link: ${filePath}`);
    }

    const typeCheck = {
        dir: () => stat.isDirectory(),
        file: () => stat.isFile(),
        socket: () => stat.isSocket(),
    }[expectedType];

    if (!typeCheck) {
        throw new Error(`Unsupported expectedType: ${expectedType}`);
    }

    if (!typeCheck()) {
        throw new Error(`Unexpected path type for ${filePath}; expected ${expectedType}`);
    }

    const currentUid = getCurrentUid();
    if (requireOwner && currentUid !== null && typeof stat.uid === 'number' && stat.uid !== currentUid) {
        throw new Error(`Unexpected owner for ${filePath}; expected uid ${currentUid}, found ${stat.uid}`);
    }

    if (Number.isInteger(requiredMode) && process.platform !== 'win32') {
        const mode = stat.mode & 0o777;
        if (mode !== requiredMode) {
            throw new Error(`Unexpected permissions for ${filePath}; expected ${requiredMode.toString(8)}, found ${mode.toString(8)}`);
        }
    }

    return stat;
}

function isPrivatePathSecure(filePath, options = {}) {
    try {
        assertPrivatePathSecurity(filePath, options);
        return true;
    } catch {
        return false;
    }
}

export = {
    DEFAULT_READY_BASENAME,
    DEFAULT_RUNTIME_DIR_NAME,
    DEFAULT_SOCKET_BASENAME,
    assertPrivatePathSecurity,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialRuntimeDir,
    getCredentialSocketPath,
    getCurrentUid,
    isUsableRuntimeBaseDir,
    isPrivatePathSecure,
};
