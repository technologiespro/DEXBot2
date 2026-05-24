const assert = require('assert');
const { EventEmitter } = require('events');

console.log('Running bot supervisor tests');

process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';

const { createBotSupervisor, parseCronExpression, getNextCronDate } = require('../modules/launcher/bot_supervisor');

function getScriptArg(args) {
    return args.find((arg) => /\.(?:ts|js)$/.test(String(arg))) || '';
}

function createChild({ closeOnKill = true } = {}) {
    const child = new EventEmitter();
    child.pid = 12345;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.pipe = (dest) => dest;
    child.stderr = new EventEmitter();
    child.stderr.pipe = (dest) => dest;
    child.kill = (signal) => {
        child.killed = true;
        if (closeOnKill) {
            setImmediate(() => child.emit('close', null, signal));
        }
    };
    process.nextTick(() => child.emit('spawn'));
    return child;
}

async function testAmaBotsStartAdapterService() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'AMA-BOT', gridPrice: 'ama', active: true }],
        controlSocket: false,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            const child = createChild();
            setImmediate(() => child.emit('close', 0));
            return child;
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.shutdown();

    assert.ok(
        calls.some((call) => getScriptArg(call.args).endsWith('market_adapter.ts')),
        'AMA isolated mode should supervise dexbot-adapter like PM2'
    );
    assert.ok(
        calls.some((call) => getScriptArg(call.args).endsWith('bot.ts') && call.args.includes('AMA-BOT')),
        'isolated mode should still supervise the selected bot process'
    );
}

async function testMemoryLimitRestartsProcess() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'MEM-BOT', active: true }],
        controlSocket: false,
        memoryCheckIntervalMs: 5,
        getChildRss: () => 300 * 1024 * 1024,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            return createChild();
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await supervisor.shutdown();

    const botStarts = calls.filter((call) => getScriptArg(call.args).endsWith('bot.ts') && call.args.includes('MEM-BOT'));
    assert.ok(botStarts.length >= 2, 'memory limit should restart the bot instead of leaving it stopped');
}

async function testRestartControlsExcludeUpdaterJob() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'CTRL-BOT', active: true }],
        controlSocket: false,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            const child = createChild();
            if (getScriptArg(args).endsWith('update.ts')) {
                setImmediate(() => child.emit('close', 0));
            }
            return child;
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    supervisor.restartRunning();
    await new Promise((resolve) => setTimeout(resolve, 20));

    supervisor.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    supervisor.restartAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await supervisor.shutdown();

    const updaterStarts = calls.filter((call) => getScriptArg(call.args).endsWith('update.ts'));
    const botStarts = calls.filter((call) => getScriptArg(call.args).endsWith('bot.ts') && call.args.includes('CTRL-BOT'));

    assert.strictEqual(updaterStarts.length, 1, 'restart controls should not relaunch the one-shot updater job');
    assert.ok(botStarts.length >= 3, 'restart controls should still restart the managed bot runtime');
}

async function testStableStartupRejectsImmediateExit() {
    const supervisor = createBotSupervisor({
        bots: [{ name: 'FAIL-BOT', active: true }],
        controlSocket: false,
        log: () => {},
        logError: () => {},
        spawnFn: () => {
            const child = createChild();
            setImmediate(() => child.emit('close', 0));
            return child;
        },
    });

    await supervisor.start();
    await assert.rejects(
        () => supervisor.waitForStableStartup({ timeoutMs: 50, pollIntervalMs: 5 }),
        /supervised startup failed: FAIL-BOT \(stopped\)/,
        'supervisor should reject startup when a managed bot exits during the grace period'
    );
    await supervisor.shutdown();
}

function testCronSchedulingHelpers() {
    const schedule = parseCronExpression('*/15 * * * *');
    const next = getNextCronDate(schedule, new Date('2026-05-24T10:07:22Z'));
    assert.strictEqual(next.toISOString(), '2026-05-24T10:15:00.000Z', 'cron helper should resolve the next matching minute');
}

(async () => {
    try {
        await testAmaBotsStartAdapterService();
        await testMemoryLimitRestartsProcess();
        await testRestartControlsExcludeUpdaterJob();
        await testStableStartupRejectsImmediateExit();
        testCronSchedulingHelpers();
        console.log('bot supervisor tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
