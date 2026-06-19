const { path } = require('../path_api');
const { getStorage } = require('../storage');
const storage = getStorage();
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
const { buildRuntimeScriptArgs, SCRIPTS_ROOT: DEFAULT_CODE_ROOT } = require('./runtime_entry');
const { Config } = require('../config');
const { PATHS } = require('../paths');
const { safeUnlink } = require('../utils/fs_utils');
const { readHeadlessPassword } = require('./headless_password');

const DEFAULT_POLL_INTERVAL_MS = 1000;

function waitForExit(child: any): Promise<any> {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code: any) => resolve(code));
    });
}

function createCredentialDaemonController({
    root = PATHS.PROJECT_ROOT,
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
            if (storage.exists(socketPath)) {
                assertPrivatePathSecurity(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
                storage.unlink(socketPath);
            }
        } catch (err: any) {
            throw new Error(`Insecure credential socket path: ${err.message}`);
        }
        try {
            if (storage.exists(readyFilePath)) {
                assertPrivatePathSecurity(readyFilePath, { expectedType: 'file', requiredMode: 0o600 });
                storage.unlink(readyFilePath);
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

    async function ensureCredentialDaemon({ detached = false, stdio: stdioOption = undefined, headless = false, passwordFile = null }: {
        detached?: boolean;
        stdio?: StdioOptions;
        headless?: boolean;
        passwordFile?: string | null;
    } = {}) {
        if (await isDaemonReady()) {
            return false;
        }

        await removeStaleDaemonFiles();
        ensureCredentialRuntimeDirSync({ socketPath, readyFilePath, root });
        credentialPolicy.ensurePolicyConfig(path.join(root, 'profiles', 'daemon-policies.json'));

        let vaultSecret;

        if (headless) {
            vaultSecret = chainKeys.unlockWithPassword(readHeadlessPassword({ passwordFile }));
        } else {
            vaultSecret = await chainKeys.authenticate();
        }
        const bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        const daemonArgs = buildRuntimeScriptArgs({
            codeRoot,
            scriptSegments: ['credential-daemon'],
        });

        // Write the bootstrap socket path to a stable file in the runtime dir
        // so the credential daemon can find it via DEXBOT_CRED_BOOTSTRAP_PATH_FILE
        // instead of a PM2-persistable env var.
        const bootstrapPathFile = path.join(path.dirname(socketPath), '.dexbot-cred-bootstrap-path');
        try {
            storage.writeFile(bootstrapPathFile, bootstrap.socketPath, { mode: 0o600 });
        } catch (err: any) {
            bootstrap.close();
            throw new Error(
                `Cannot write bootstrap path file at ${bootstrapPathFile}: ${err.message}`
            );
        }

        try {
            const childStdio: StdioOptions = stdioOption ?? (detached ? 'ignore' : 'inherit');
            daemonProcess = spawn(Config.EXEC_PATH, daemonArgs, {
                cwd: root,
                env: buildScopedChildEnv({
                    extra: {
                        DEXBOT_CRED_DAEMON_SOCKET: socketPath,
                        DEXBOT_CRED_DAEMON_READY_FILE: readyFilePath,
                        DEXBOT_CRED_BOOTSTRAP_PATH_FILE: bootstrapPathFile,
                    },
                }),
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

        safeUnlink(socketPath)
        safeUnlink(readyFilePath)
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
    DEFAULT_ROOT: PATHS.PROJECT_ROOT,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_READY_FILE: getCredentialReadyFilePath({ root: PATHS.PROJECT_ROOT }),
    DEFAULT_SOCKET_PATH: getCredentialSocketPath({ root: PATHS.PROJECT_ROOT }),
    waitForExit,
};
