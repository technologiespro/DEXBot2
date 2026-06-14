const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
import type { StdioOptions } from 'child_process';
const chainKeys = require('../chain_keys');
const credentialPolicy = require('../credential_policy');
const {
    assertPrivatePathSecurity,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('../credential_runtime');
const { createPasswordBootstrapServer } = require('./credential_bootstrap');
const { buildScopedChildEnv } = require('./child_env');
const { buildRuntimeScriptArgs, resolveProjectRoot } = require('./runtime_entry');
const { BUILD_DIR } = require('../constants');

const DEFAULT_CODE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = resolveProjectRoot(DEFAULT_CODE_ROOT);
const DEFAULT_POLL_INTERVAL_MS = 1000;

function waitForExit(child: any): Promise<any> {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code: any) => resolve(code));
    });
}

function createCredentialDaemonController({
    root = DEFAULT_ROOT,
    codeRoot = DEFAULT_CODE_ROOT,
    socketPath = getCredentialSocketPath({ root }),
    readyFilePath = getCredentialReadyFilePath({ root }),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
    let daemonProcess: any = null;
    let daemonExitPromise: any = null;

    async function isDaemonReady() {
        return chainKeys.isDaemonResponsive({ socketPath, readyFilePath });
    }

    async function removeStaleDaemonFiles() {
        if (await isDaemonReady()) return;
        try {
            if (fs.existsSync(socketPath)) {
                assertPrivatePathSecurity(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
                fs.unlinkSync(socketPath);
            }
        } catch (err: any) {
            throw new Error(`Insecure credential socket path: ${err.message}`);
        }
        try {
            if (fs.existsSync(readyFilePath)) {
                assertPrivatePathSecurity(readyFilePath, { expectedType: 'file', requiredMode: 0o600 });
                fs.unlinkSync(readyFilePath);
            }
        } catch (err: any) {
            throw new Error(`Insecure credential ready path: ${err.message}`);
        }
    }

    function forwardSignal(signal: string): void {
        if (!daemonProcess || daemonProcess.killed) return;
        try {
            daemonProcess.kill(signal);
        } catch (err: any) {
            if (err.code === 'ESRCH') return;
            throw err;
        }
    }

    async function ensureCredentialDaemon({ detached = false, stdio: stdioOption = undefined } = {}) {
        if (await isDaemonReady()) {
            return false;
        }

        await removeStaleDaemonFiles();
        ensureCredentialRuntimeDirSync({ socketPath, readyFilePath, root });
        credentialPolicy.ensurePolicyConfig(path.join(root, 'profiles', 'daemon-policies.json'));

        const vaultSecret = await chainKeys.authenticate();
        const bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        const daemonArgs = buildRuntimeScriptArgs({
            codeRoot,
            scriptSegments: ['credential-daemon'],
        });

        try {
            const childStdio: StdioOptions = stdioOption ?? (detached ? 'ignore' : 'inherit');
            daemonProcess = spawn(process.execPath, daemonArgs, {
                cwd: root,
                env: buildScopedChildEnv({ extra: bootstrap.credentialEnv }),
                stdio: childStdio,
                detached,
            });
            daemonExitPromise = waitForExit(daemonProcess);
            if (detached) {
                daemonProcess.unref();
            }

            await Promise.all([
                chainKeys.waitForDaemon(undefined, { socketPath, readyFilePath }),
                bootstrap.waitForTransfer(),
            ]);
            return true;
        } catch (error: any) {
            bootstrap.close();
            throw error;
        }
    }

    function getManagedDaemonPid() {
        return daemonProcess && daemonProcess.pid ? daemonProcess.pid : null;
    }

    function releaseManagedDaemon() {
        daemonProcess = null;
        daemonExitPromise = null;
    }

    async function stopManagedDaemon() {
        if (!daemonProcess || daemonProcess.killed) return;

        forwardSignal('SIGTERM');
        await Promise.race([
            daemonExitPromise || waitForExit(daemonProcess),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);

        try { fs.unlinkSync(socketPath); } catch (err: any) { }
        try { fs.unlinkSync(readyFilePath); } catch (err: any) { }
        daemonProcess = null;
        daemonExitPromise = null;
    }

    async function waitForManagedDaemon() {
        if (daemonProcess) {
            return daemonExitPromise || waitForExit(daemonProcess);
        }

        if (!(await isDaemonReady())) {
            return 0;
        }

        while (await isDaemonReady()) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        return 0;
    }

    return {
        ensureCredentialDaemon,
        forwardSignal,
        getManagedDaemonPid,
        isDaemonReady,
        releaseManagedDaemon,
        stopManagedDaemon,
        waitForManagedDaemon,
    };
}

export = {
    createCredentialDaemonController,
    DEFAULT_ROOT,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_READY_FILE: getCredentialReadyFilePath({ root: DEFAULT_ROOT }),
    DEFAULT_SOCKET_PATH: getCredentialSocketPath({ root: DEFAULT_ROOT }),
    waitForExit,
};
