const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running unlock-start main tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const originalControllerModule = require.cache[controllerPath];
const originalSpawn = childProcess.spawn;
const originalSupervisorSocket = process.env.DEXBOT_SUPERVISOR_SOCKET;
const originalDisableSupervisorSocket = process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET;
const originalIsolatedForeground = process.env.DEXBOT_ISOLATED_FOREGROUND;
const originalMonolithicBg = process.env.DEXBOT_MONOLITHIC_BG;

const state = {
    calls: [],
    ensureCount: 0,
    waitCount: 0,
    stopCount: 0,
};

const controller = {
    ensureCredentialDaemon: async () => {
        state.ensureCount += 1;
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
    state.calls.length = 0;
    state.ensureCount = 0;
    state.waitCount = 0;
    state.stopCount = 0;
}

function installStubs() {
    setCachedModule(controllerPath, {
        createCredentialDaemonController: () => controller,
    });

    childProcess.spawn = (command, args, options) => {
        state.calls.push({ command, args, options });
        const child = new EventEmitter();
        child.killed = false;
        child.pid = 9999;
        child.stdout = new EventEmitter();
        child.stdout.pipe = (dest) => dest;
        child.stderr = new EventEmitter();
        child.stderr.pipe = (dest) => dest;
        child.kill = () => {
            child.killed = true;
        };
        process.nextTick(() => {
            child.emit('spawn');
            setImmediate(() => child.emit('close', 0));
        });
        return child;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    restoreCachedModule(controllerPath, originalControllerModule);
}

installStubs();
process.env.DEXBOT_SUPERVISOR_SOCKET = `/tmp/dexbot-supervisor-test-${process.pid}.sock`;
process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';
process.env.DEXBOT_ISOLATED_FOREGROUND = '1';
process.env.DEXBOT_MONOLITHIC_BG = '1';

const unlockStart = require('../unlock-start');

async function runAllBotsTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start'], startupGraceMs: 0 });

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.waitCount, 0, 'normal startup should not wait on daemon shutdown');
    assert.strictEqual(state.stopCount, 1, 'launcher should clean up its owned daemon');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn exactly one bot process');
    assert.deepStrictEqual(
        state.calls[0].args,
        ['--import', 'tsx', path.resolve(__dirname, '..', 'dexbot.ts'), 'start'],
        'default unlock-start should launch all bots'
    );
}

async function runSingleBotTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', 'XRP-BTS'], startupGraceMs: 0 });

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 1, 'launcher should clean up its owned daemon');
    assert.deepStrictEqual(
        state.calls[0].args,
        ['--import', 'tsx', path.resolve(__dirname, '..', 'dexbot.ts'), 'start', 'XRP-BTS'],
        'single-bot unlock-start should pass the bot name through'
    );
}

async function runClawOnlyTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', '--claw-only'], startupGraceMs: 0 });

    assert.strictEqual(state.ensureCount, 1, 'claw-only mode should unlock the credential daemon');
    assert.strictEqual(state.waitCount, 1, 'claw-only mode should wait for daemon lifecycle');
    assert.strictEqual(state.calls.length, 0, 'claw-only mode should not spawn a bot process');
    assert.strictEqual(state.stopCount, 1, 'claw-only mode should still clean up owned daemons');
}

async function runIsolatedAllBotsTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', '--isolated'], startupGraceMs: 0 });

    assert.strictEqual(state.ensureCount, 1, 'isolated launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 1, 'isolated launcher should clean up its owned daemon');
    assert.ok(state.calls.length >= 1, 'isolated launcher should spawn at least one bot process');
}

async function runIsolatedSingleBotTest() {
    resetState();
    await unlockStart.main({ argv: ['node', 'unlock-start', '--isolated', 'XRP-BTS'], startupGraceMs: 0 });

    assert.strictEqual(state.ensureCount, 1, 'isolated single-bot launcher should unlock the credential daemon');
    assert.strictEqual(state.stopCount, 1, 'isolated single-bot launcher should clean up its owned daemon');
    const botCalls = state.calls.filter((call) => call.args.some((arg) => String(arg).endsWith('bot.ts')));
    assert.strictEqual(botCalls.length, 1, 'isolated single-bot launcher should spawn exactly one bot process');
    assert.ok(
        botCalls[0].args.some((arg) => String(arg).endsWith('bot.ts')),
        'isolated launcher should use the source bot entry point'
    );
}

async function runImmediateExitStartupFailureTest() {
    resetState();
    await assert.rejects(
        () => unlockStart.main({ argv: ['node', 'unlock-start'], startupGraceMs: 50 }),
        /DEXBot exited during startup/,
        'launcher should reject when the bot exits before the startup grace period elapses'
    );
    assert.strictEqual(state.ensureCount, 1, 'launcher should still unlock the credential daemon before startup');
    assert.strictEqual(state.stopCount, 1, 'launcher should still clean up its owned daemon on startup failure');
}

async function runMissingIsolatedBotFailsFastTest() {
    resetState();
    await assert.rejects(
        () => unlockStart.main({ argv: ['node', 'unlock-start', '--isolated', 'DOES-NOT-EXIST'], startupGraceMs: 0 }),
        /Bot 'DOES-NOT-EXIST' not found in bots\.json/,
        'isolated startup should fail immediately for unknown bots'
    );
    assert.strictEqual(state.ensureCount, 0, 'launcher should validate the target bot before unlocking credentials');
    assert.strictEqual(state.calls.length, 0, 'launcher should not spawn child processes for unknown bots');
}

(async () => {
    try {
        await runAllBotsTest();
        await runSingleBotTest();
        await runClawOnlyTest();
        await runIsolatedAllBotsTest();
        await runIsolatedSingleBotTest();
        await runImmediateExitStartupFailureTest();
        await runMissingIsolatedBotFailsFastTest();
        console.log('unlock-start main tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        restoreStubs();
        if (originalSupervisorSocket === undefined) {
            delete process.env.DEXBOT_SUPERVISOR_SOCKET;
        } else {
            process.env.DEXBOT_SUPERVISOR_SOCKET = originalSupervisorSocket;
        }
        if (originalDisableSupervisorSocket === undefined) {
            delete process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET;
        } else {
            process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = originalDisableSupervisorSocket;
        }
        if (originalIsolatedForeground === undefined) {
            delete process.env.DEXBOT_ISOLATED_FOREGROUND;
        } else {
            process.env.DEXBOT_ISOLATED_FOREGROUND = originalIsolatedForeground;
        }
        if (originalMonolithicBg === undefined) {
            delete process.env.DEXBOT_MONOLITHIC_BG;
        } else {
            process.env.DEXBOT_MONOLITHIC_BG = originalMonolithicBg;
        }
    }
})();
