const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running credential controller cleanup tests');

const chainKeysPath = require.resolve('../modules/chain_keys');
const credentialRuntimePath = require.resolve('../modules/credential_runtime');
const bootstrapPath = require.resolve('../modules/launcher/credential_bootstrap');
const credentialPolicyPath = require.resolve('../modules/credential_policy');

const originalChainKeys = require.cache[chainKeysPath];
const originalCredentialRuntime = require.cache[credentialRuntimePath];
const originalBootstrap = require.cache[bootstrapPath];
const originalCredentialPolicy = require.cache[credentialPolicyPath];
const originalSpawn = childProcess.spawn;
const originalTestSecret = process.env.TEST_DAEMON_SECRET;

const state = {
    ensurePolicyPaths: [],
    killSignals: [],
    spawnCount: 0,
    spawnOptions: [],
};

function installStubs() {
    setCachedModule(chainKeysPath, {
        authenticate: async () => 'test-secret',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
    });

    setCachedModule(credentialRuntimePath, {
        ensureCredentialRuntimeDirSync: () => {},
        getCredentialReadyFilePath: () => '/tmp/dexbot-test.ready',
        getCredentialRuntimeDir: () => '/tmp',
        getCredentialSocketPath: () => '/tmp/dexbot-test.sock',
    });

    setCachedModule(bootstrapPath, {
        createPasswordBootstrapServer: async () => ({
            credentialEnv: { DEXBOT_CRED_BOOTSTRAP_SOCKET: '/tmp/bootstrap.sock' },
            close: () => {},
            waitForTransfer: async () => {},
        }),
    });

    setCachedModule(credentialPolicyPath, {
        ensurePolicyConfig: (filePath) => {
            state.ensurePolicyPaths.push(filePath);
            return { accounts: {} };
        },
    });

    childProcess.spawn = (_command, _args, options) => {
        state.spawnCount += 1;
        state.spawnOptions.push(options);
        const child = new EventEmitter();
        child.killed = false;
        child.kill = (signal) => {
            state.killSignals.push(signal);
            child.killed = true;
        };
        process.nextTick(() => child.emit('close', 0));
        return child;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(credentialRuntimePath, originalCredentialRuntime);
    restoreCachedModule(bootstrapPath, originalBootstrap);
    restoreCachedModule(credentialPolicyPath, originalCredentialPolicy);
    if (originalTestSecret === undefined) delete process.env.TEST_DAEMON_SECRET;
    else process.env.TEST_DAEMON_SECRET = originalTestSecret;
}

installStubs();
process.env.TEST_DAEMON_SECRET = 'should-not-leak';

const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');

(async () => {
    try {
        const controller = createCredentialDaemonController({
            root: '/tmp',
            socketPath: '/tmp/dexbot-test.sock',
            readyFilePath: '/tmp/dexbot-test.ready',
        });

        await controller.ensureCredentialDaemon();

        const startedAt = Date.now();
        await controller.stopManagedDaemon();
        const elapsed = Date.now() - startedAt;

        assert.strictEqual(state.spawnCount, 1, 'controller should spawn exactly one daemon');
        assert.deepStrictEqual(state.ensurePolicyPaths, ['/tmp/profiles/daemon-policies.json'], 'controller should preflight policy before daemon spawn');
        assert.deepStrictEqual(state.killSignals, ['SIGTERM'], 'controller should terminate the daemon it owns');
        assert.ok(elapsed < 1000, `cleanup should resolve quickly after daemon exit, elapsed=${elapsed}ms`);
        assert.strictEqual(state.spawnOptions[0].env.TEST_DAEMON_SECRET, undefined, 'credential daemon controller should not forward arbitrary parent secrets');
        assert.strictEqual(state.spawnOptions[0].env.DEXBOT_CRED_BOOTSTRAP_SOCKET, '/tmp/bootstrap.sock', 'credential daemon controller should keep explicit bootstrap env');

        console.log('credential controller cleanup tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        restoreStubs();
    }
})();
