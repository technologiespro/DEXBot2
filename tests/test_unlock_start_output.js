const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running unlock-start output tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const originalControllerModule = require.cache[controllerPath];
const originalSpawn = childProcess.spawn;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const logs = [];
const errors = [];
const state = {
    ensureCount: 0,
    ensureResult: true,
    waitCount: 0,
    stopCount: 0,
    calls: [],
};

const controller = {
    ensureCredentialDaemon: async () => {
        state.ensureCount += 1;
        return state.ensureResult;
    },
    waitForManagedDaemon: async () => {
        state.waitCount += 1;
        return 0;
    },
    stopManagedDaemon: async () => {
        state.stopCount += 1;
    },
};

function resetState() {
    state.ensureCount = 0;
    state.ensureResult = true;
    state.waitCount = 0;
    state.stopCount = 0;
    state.calls.length = 0;
    logs.length = 0;
    errors.length = 0;
}

function installStubs() {
    setCachedModule(controllerPath, {
        createCredentialDaemonController: () => controller,
    });

    childProcess.spawn = (command, args, options) => {
        state.calls.push({ command, args, options });
        const child = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
        };
        process.nextTick(() => {
            child.emit('spawn');
            child.emit('close', 0);
        });
        return child;
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    restoreCachedModule(controllerPath, originalControllerModule);
}

installStubs();

const unlockStart = require('../unlock-start');

async function runAllBotsTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start'] });

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.waitCount, 0, 'normal startup should not wait on daemon shutdown');
    assert.strictEqual(state.stopCount, 1, 'launcher should clean up its owned daemon');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn exactly one bot process');
    assert.deepStrictEqual(state.calls[0].args, ['dexbot.js', 'start'], 'default unlock-start should launch all bots');
    assert.ok(logs.includes('DEXBot2 Unlock-Start Launcher'), 'launcher should print a banner title');
    assert.ok(logs.includes('Starting all bots'), 'launcher should print the chosen launch mode');
    assert.ok(logs.includes('✓ Authentication successful'), 'launcher should confirm successful authentication');
    assert.ok(logs.includes('DEXBot2 started successfully!'), 'launcher should print a success footer');
    assert.ok(logs.includes('If the bot stops, rerun `node unlock-start` to unlock it again.'), 'launcher should print the restart hint');
}

async function runSingleBotTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', 'XRP-BTS'] });

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 1, 'launcher should clean up its owned daemon');
    assert.deepStrictEqual(state.calls[0].args, ['dexbot.js', 'start', 'XRP-BTS'], 'single-bot unlock-start should pass the bot name through');
    assert.ok(logs.includes('Starting bot: XRP-BTS'), 'launcher should print the selected bot name');
    assert.ok(
        logs.includes('If the bot stops, rerun `node unlock-start XRP-BTS` to unlock it again.'),
        'launcher should print a bot-specific restart hint'
    );
}

async function runReuseDaemonTest() {
    resetState();
    state.ensureResult = false;
    await unlockStart.main({ argv: ['node', 'unlock-start'] });

    assert.strictEqual(state.ensureCount, 1, 'launcher should still check daemon availability');
    assert.strictEqual(state.stopCount, 1, 'launcher should still run cleanup');
    assert.ok(!logs.includes('✓ Authentication successful'), 'launcher should not claim fresh authentication when reusing an existing daemon');
}

async function runClawOnlyTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', '--claw-only'] });

    assert.strictEqual(state.ensureCount, 1, 'claw-only mode should unlock the credential daemon');
    assert.strictEqual(state.waitCount, 1, 'claw-only mode should wait for daemon lifecycle');
    assert.strictEqual(state.calls.length, 0, 'claw-only mode should not spawn a bot process');
    assert.strictEqual(state.stopCount, 1, 'claw-only mode should still clean up owned daemons');
    assert.ok(logs.includes('Starting credential daemon only'), 'launcher should print the claw-only mode');
    assert.ok(logs.includes('DEXBot2 credential daemon started successfully!'), 'launcher should print the claw-only success footer');
    assert.ok(logs.includes('If the daemon stops, rerun `node unlock-start --claw-only` to unlock it again.'), 'launcher should print the claw-only restart hint');
}

(async () => {
    try {
        await runAllBotsTest();
        await runSingleBotTest();
        await runReuseDaemonTest();
        await runClawOnlyTest();
        restoreStubs();
        process.stdout.write('unlock-start output tests passed\n');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
