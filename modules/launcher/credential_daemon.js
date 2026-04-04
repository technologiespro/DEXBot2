const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chainKeys = require('../chain_keys');
const {
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('../credential_runtime');
const { createPasswordBootstrapServer } = require('./credential_bootstrap');
const { buildScopedChildEnv } = require('./child_env');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLL_INTERVAL_MS = 1000;

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });
}

function createCredentialDaemonController({
    root = DEFAULT_ROOT,
    socketPath = getCredentialSocketPath({ root }),
    readyFilePath = getCredentialReadyFilePath({ root }),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
    let daemonProcess = null;
    let daemonExitPromise = null;

    function isDaemonReady() {
        return chainKeys.isDaemonReady({ socketPath, readyFilePath });
    }

    function removeStaleDaemonFiles() {
        if (isDaemonReady()) return;
        try { fs.unlinkSync(socketPath); } catch (err) { }
        try { fs.unlinkSync(readyFilePath); } catch (err) { }
    }

    function forwardSignal(signal) {
        if (!daemonProcess || daemonProcess.killed) return;
        try {
            daemonProcess.kill(signal);
        } catch (err) {
        }
    }

    async function ensureCredentialDaemon() {
        if (isDaemonReady()) {
            return false;
        }

        removeStaleDaemonFiles();
        ensureCredentialRuntimeDirSync({ socketPath, readyFilePath, root });

        const vaultSecret = await chainKeys.authenticate();
        const bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });

        try {
            daemonProcess = spawn(process.execPath, [path.join(root, 'credential-daemon.js')], {
                cwd: root,
                env: buildScopedChildEnv({ extra: bootstrap.credentialEnv }),
                stdio: 'inherit',
            });
            daemonExitPromise = waitForExit(daemonProcess);

            await Promise.all([
                chainKeys.waitForDaemon(undefined, { socketPath, readyFilePath }),
                bootstrap.waitForTransfer(),
            ]);
            return true;
        } catch (error) {
            bootstrap.close();
            throw error;
        }
    }

    async function stopManagedDaemon() {
        if (!daemonProcess || daemonProcess.killed) return;

        forwardSignal('SIGTERM');
        await Promise.race([
            daemonExitPromise || waitForExit(daemonProcess),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);

        try { fs.unlinkSync(socketPath); } catch (err) { }
        try { fs.unlinkSync(readyFilePath); } catch (err) { }
    }

    async function waitForManagedDaemon() {
        if (daemonProcess) {
            return daemonExitPromise || waitForExit(daemonProcess);
        }

        if (!isDaemonReady()) {
            return 0;
        }

        while (isDaemonReady()) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        return 0;
    }

    return {
        ensureCredentialDaemon,
        forwardSignal,
        isDaemonReady,
        stopManagedDaemon,
        waitForManagedDaemon,
    };
}

module.exports = {
    createCredentialDaemonController,
    DEFAULT_ROOT,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_READY_FILE: getCredentialReadyFilePath({ root: DEFAULT_ROOT }),
    DEFAULT_SOCKET_PATH: getCredentialSocketPath({ root: DEFAULT_ROOT }),
    waitForExit,
};
