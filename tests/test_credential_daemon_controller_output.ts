const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running credential daemon controller output tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const chainKeysPath = require.resolve('../modules/chain_keys');
const bootstrapPath = require.resolve('../modules/launcher/credential_bootstrap');

const originalControllerModule = require.cache[controllerPath];
const originalChainKeys = require.cache[chainKeysPath];
const originalBootstrap = require.cache[bootstrapPath];
const originalSpawn = childProcess.spawn;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const logs = [];
const warns = [];
const errors = [];
let spawnCount = 0;
const spawnCalls = [];

function installStubs() {
    delete require.cache[controllerPath];

    setCachedModule(chainKeysPath, {
        authenticate: async () => 'test-password',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
    });

    setCachedModule(bootstrapPath, {
        createPasswordBootstrapServer: async () => ({
            credentialEnv: {
                DEXBOT_CRED_BOOTSTRAP_SOCKET: '/tmp/bootstrap.sock',
            },
            close() {},
            waitForTransfer: async () => {},
        }),
    });

    childProcess.spawn = (command, args, options) => {
        spawnCount += 1;
        spawnCalls.push({ command, args, options });

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {
            child.killed = true;
            child.emit('close', 0);
        };
        child.killed = false;

        process.nextTick(() => child.emit('close', 0));
        return child;
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.warn = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) warns.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(bootstrapPath, originalBootstrap);

    if (originalControllerModule) require.cache[controllerPath] = originalControllerModule;
    else delete require.cache[controllerPath];
}

installStubs();

const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');

(async () => {
    try {
        const controller = createCredentialDaemonController({
            root: '/tmp/dexbot2-test',
            socketPath: '/tmp/dexbot2-test/dexbot-cred.sock',
            readyFilePath: '/tmp/dexbot2-test/dexbot-cred.ready',
            pollIntervalMs: 1,
        });
        logs.length = 0;
        warns.length = 0;
        errors.length = 0;
        spawnCalls.length = 0;
        spawnCount = 0;

        await controller.ensureCredentialDaemon();

        assert.strictEqual(spawnCount, 1, 'controller should spawn the daemon once');
        assert.deepStrictEqual(
            spawnCalls[0].args,
            ['--import', 'tsx', require('path').resolve(__dirname, '..', 'credential-daemon.ts')],
            'controller should launch the source credential daemon through tsx'
        );
        assert.deepStrictEqual(logs, [], 'controller startup should not emit info logs');
        assert.deepStrictEqual(warns, [], 'controller startup should not emit warnings');
        assert.deepStrictEqual(errors, [], 'controller startup should not emit errors');

        restoreStubs();
        originalConsoleLog('credential daemon controller output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
