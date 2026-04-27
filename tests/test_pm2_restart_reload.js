const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 restart/reload tests');

const pm2Path = require.resolve('../pm2');
const chainKeysPath = require.resolve('../modules/chain_keys');
const bootstrapPath = require.resolve('../modules/launcher/credential_bootstrap');

const originalPm2Module = require.cache[pm2Path];
const originalChainKeys = require.cache[chainKeysPath];
const originalBootstrap = require.cache[bootstrapPath];
const originalSpawn = childProcess.spawn;

const spawnCalls = [];

function installStubs() {
    delete require.cache[pm2Path];

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
        spawnCalls.push({ command, args, options });

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
        };

        process.nextTick(() => child.emit('close', 0));
        return child;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(bootstrapPath, originalBootstrap);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

function resetCalls() {
    spawnCalls.length = 0;
}

installStubs();

const { reloadPM2Processes, restartPM2Processes } = require('../pm2');

(async () => {
    try {
        resetCalls();
        await reloadPM2Processes('all');

        assert.ok(
            spawnCalls.some((call) => call.args[0] === 'start' && String(call.args[1]).includes('credential-daemon.js')),
            'reload all should ensure dexbot-cred is started through the wrapper when needed'
        );
        assert.ok(
            spawnCalls.some((call) => call.args[0] === 'reload' && String(call.args[1]).includes('ecosystem.config.js')),
            'reload all should target the managed ecosystem file'
        );
        assert.ok(
            !spawnCalls.some((call) => call.args[0] === 'reload' && call.args[1] === 'all'),
            'reload all should not issue a raw pm2 reload all'
        );
        assert.ok(
            !spawnCalls.some((call) => call.args[0] === 'reload' && call.args[1] === 'dexbot-cred'),
            'reload all should never reload dexbot-cred directly'
        );

        resetCalls();
        await restartPM2Processes('dexbot-cred');

        assert.ok(
            spawnCalls.some((call) => call.args[0] === 'delete' && call.args[1] === 'dexbot-cred'),
            'credential daemon restart should delete the old PM2 process first'
        );
        assert.ok(
            spawnCalls.some((call) => call.args[0] === 'start' && String(call.args[1]).includes('credential-daemon.js')),
            'credential daemon restart should start dexbot-cred through the wrapper bootstrap flow'
        );
        assert.ok(
            !spawnCalls.some((call) => call.args[0] === 'restart' && call.args[1] === 'dexbot-cred'),
            'credential daemon restart should not call raw pm2 restart dexbot-cred'
        );

        console.log('PM2 restart/reload tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        restoreStubs();
    }
})();
