const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadSettingsFile, resolveRawBotEntries } = require('../modules/bot_settings');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running unlock output tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const originalControllerModule = require.cache[controllerPath];
const originalSpawn = childProcess.spawn;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalWriteFileSync = fs.writeFileSync;
const originalUnlinkSync = fs.unlinkSync;
const originalRealpathSync = fs.realpathSync;
const originalProcessKill = process.kill;
const originalProcessExit = process.exit;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalMonolithicBg = process.env.DEXBOT_MONOLITHIC_BG;
const originalNoColor = process.env.NO_COLOR;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const logs = [];
const errors = [];
const profilesDir = path.resolve(__dirname, '..', 'profiles');
const monolithicPidPath = path.join(profilesDir, 'monolithic.pid');
const monolithicCredPidPath = path.join(profilesDir, 'monolithic-cred.pid');
const monolithicBotPidPath = path.join(profilesDir, 'monolithic-bot.pid');
const monolithicBotInfoPath = path.join(profilesDir, 'monolithic-bot.json');
const monolithicLogPaths = new Set([
    path.join(profilesDir, 'logs', 'dexbot.log'),
    path.join(profilesDir, 'logs', 'dexbot-error.log'),
]);
const monolithicStatePaths = new Set([
    monolithicPidPath,
    monolithicCredPidPath,
    monolithicBotPidPath,
    monolithicBotInfoPath,
]);
const botsFile = path.resolve(__dirname, '..', 'profiles', 'bots.json');
const state = {
    ensureCount: 0,
    ensureResult: true,
    waitCount: 0,
    stopCount: 0,
    calls: [],
    liveMonolithicPid: false,
    monolithicAlive: false,
    monolithicBotInfoJson: null,
};

function setStdoutTTY(value) {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
}

function stripAnsi(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function logsIncludePlain(expected) {
    return logs.some((line) => stripAnsi(line) === expected);
}

const controller = {
    ensureCredentialDaemon: async () => {
        state.ensureCount += 1;
        return state.ensureResult;
    },
    getManagedDaemonPid: () => 12345,
    releaseManagedDaemon: () => {},
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
    state.liveMonolithicPid = false;
    state.monolithicAlive = false;
    state.monolithicBotInfoJson = null;
    logs.length = 0;
    errors.length = 0;
    process.exitCode = 0;
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
        child.unref = () => {};
        process.nextTick(() => {
            child.emit('spawn');
            setImmediate(() => child.emit('close', 0));
        });
        return child;
    };

    fs.existsSync = (filePath) => {
        if (String(filePath) === monolithicPidPath) return state.liveMonolithicPid;
        if (String(filePath) === monolithicBotInfoPath) return !!state.monolithicBotInfoJson;
        if (String(filePath) === `/proc/999999/cmdline`) {
            return state.liveMonolithicPid && state.monolithicAlive;
        }
        if (monolithicStatePaths.has(String(filePath))) return false;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, options) => {
        if (String(filePath) === monolithicPidPath && state.liveMonolithicPid) {
            return '999999';
        }
        if (String(filePath) === monolithicBotInfoPath && state.monolithicBotInfoJson) {
            return state.monolithicBotInfoJson;
        }
        if (String(filePath) === `/proc/999999/cmdline` && state.liveMonolithicPid && state.monolithicAlive) {
            return ['node', path.resolve(__dirname, '..', 'unlock.js')].join('\0');
        }
        if (String(filePath) === `/proc/999999/stat` && state.liveMonolithicPid && state.monolithicAlive) {
            return '999999 (node) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1234567 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
        }
        if (String(filePath) === `/proc/999999/status` && state.liveMonolithicPid && state.monolithicAlive) {
            return 'VmRSS:\t123456 kB\n';
        }
        if (String(filePath) === '/proc/uptime' && state.liveMonolithicPid && state.monolithicAlive) {
            return '1234567.00 0.00\n';
        }
        return originalReadFileSync(filePath, options);
    };
    fs.realpathSync = (filePath) => {
        if (String(filePath) === `/proc/999999/cwd`) {
            return path.resolve(__dirname, '..');
        }
        return originalRealpathSync(filePath);
    };
    fs.openSync = (filePath, flags, mode) => {
        if (monolithicLogPaths.has(String(filePath))) {
            return originalOpenSync('/dev/null', flags, mode);
        }
        return originalOpenSync(filePath, flags, mode);
    };
    fs.closeSync = (fd) => originalCloseSync(fd);
    fs.writeFileSync = (filePath, data, options) => {
        if (monolithicStatePaths.has(String(filePath))) return;
        return originalWriteFileSync(filePath, data, options);
    };
    fs.unlinkSync = (filePath) => {
        if (monolithicStatePaths.has(String(filePath))) return;
        return originalUnlinkSync(filePath);
    };
    process.kill = (pid, signal) => {
        if (pid === 999999 && state.liveMonolithicPid) {
            if (signal === 0 || signal === undefined) {
                if (!state.monolithicAlive) {
                    const err = new Error('No such process');
                    err.code = 'ESRCH';
                    throw err;
                }
                return true;
            }
            return true;
        }
        return originalProcessKill(pid, signal);
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
    process.exit = (code) => {
        const err = new Error(`process.exit:${code}`);
        err.code = 'TEST_PROCESS_EXIT';
        throw err;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.unlinkSync = originalUnlinkSync;
    fs.realpathSync = originalRealpathSync;
    process.kill = originalProcessKill;
    process.exit = originalProcessExit;
    setStdoutTTY(originalStdoutIsTTY);
    if (originalMonolithicBg === undefined) {
        delete process.env.DEXBOT_MONOLITHIC_BG;
    } else {
        process.env.DEXBOT_MONOLITHIC_BG = originalMonolithicBg;
    }
    if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
    } else {
        process.env.NO_COLOR = originalNoColor;
    }
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    restoreCachedModule(controllerPath, originalControllerModule);
}

function getActiveBotNames() {
    const { config } = loadSettingsFile(botsFile, { silent: true, exitOnError: false });
    return resolveRawBotEntries(config)
        .filter((bot) => bot && bot.active !== false)
        .map((bot) => String(bot.name));
}

function countSpawnCallsMatchingScript(scriptName) {
    return state.calls.filter((call) => Array.isArray(call.args) && call.args.some((arg) => (
        typeof arg === 'string' && path.basename(arg).replace(/\.(?:[cm]?js|ts)$/i, '') === scriptName
    ))).length;
}

async function runUnlockStart(args, startupGraceMs = 0) {
    try {
        await unlock.main({ argv: args, startupGraceMs });
    } catch (err) {
        if (err && err.code === 'TEST_PROCESS_EXIT') {
            return;
        }
        throw err;
    }
}

installStubs();

const unlock = require('../unlock');

async function runAllBotsTest() {
    resetState();
    await runUnlockStart(['node', 'unlock']);
    const activeBotNames = getActiveBotNames();

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.waitCount, 0, 'normal startup should not wait on daemon shutdown');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn the background child once');
    assert.ok(logs.includes('DEXBot2 Unlock Launcher'), 'launcher should print a banner title');
    assert.ok(logs.includes('Starting all bots'), 'launcher should print the chosen launch mode');
    assert.ok(logs.includes('✓ Authentication successful'), 'launcher should confirm successful authentication');
    assert.ok(
        logs.includes(`DEXBot2 started ${activeBotNames.length} bots in background`),
        'launcher should print the launched bot count'
    );
    for (const botName of activeBotNames) {
        assert.ok(logsIncludePlain(`- ${botName}`), `launcher should list active bot ${botName}`);
    }
}

async function runSingleBotTest() {
    resetState();
    await runUnlockStart(['node', 'unlock', 'XRP-BTS']);

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn the background child once');
    assert.ok(logs.includes('Starting bot: XRP-BTS'), 'launcher should print the selected bot name');
    assert.ok(logs.includes('DEXBot2 started 1 bot in background'), 'launcher should print the single-bot count');
    assert.ok(logsIncludePlain('- XRP-BTS'), 'launcher should list the launched bot');
}

async function runForegroundTest() {
    resetState();
    await runUnlockStart(['node', 'unlock', '--foreground']);
    const activeBotNames = getActiveBotNames();

    assert.strictEqual(state.ensureCount, 1, 'foreground mode should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 1, 'foreground mode should clean up its owned daemon');
    assert.strictEqual(countSpawnCallsMatchingScript('dexbot'), 1, 'foreground mode should spawn the bot process once');
    assert.ok(
        logs.includes(`DEXBot2 started ${activeBotNames.length} bots in foreground`),
        'foreground mode should print the shared startup summary'
    );
    for (const botName of activeBotNames) {
        assert.ok(logsIncludePlain(`- ${botName}`), `foreground mode should list active bot ${botName}`);
    }
}

async function runReuseDaemonTest() {
    resetState();
    state.ensureResult = false;
    await runUnlockStart(['node', 'unlock']);

    assert.strictEqual(state.ensureCount, 1, 'launcher should still check daemon availability');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.ok(!logs.includes('✓ Authentication successful'), 'launcher should not claim fresh authentication when reusing an existing daemon');
}

async function runAlreadyRunningTest() {
    resetState();
    state.liveMonolithicPid = true;
    state.monolithicAlive = true;

    await runUnlockStart(['node', 'unlock']);

    assert.strictEqual(state.ensureCount, 0, 'already-running startup should not unlock the credential daemon');
    assert.strictEqual(state.stopCount, 0, 'already-running startup should not stop any daemon');
    assert.strictEqual(state.calls.length, 0, 'already-running startup should not spawn another wrapper');
    assert.strictEqual(process.exitCode, 0, 'already-running startup should exit successfully');
    assert.ok(logs.includes('DEXBot2 already running in background (PID 999999).'), 'launcher should report the live wrapper PID');
    assert.ok(errors.length === 0, 'already-running startup should not print an error');
}

async function runClawOnlyTest() {
    resetState();
    await runUnlockStart(['node', 'unlock', '--claw-only']);

    assert.strictEqual(state.ensureCount, 1, 'claw-only mode should unlock the credential daemon');
    assert.strictEqual(state.waitCount, 1, 'claw-only mode should wait for daemon lifecycle');
    assert.strictEqual(state.calls.length, 0, 'claw-only mode should not spawn a bot process');
    assert.strictEqual(state.stopCount, 1, 'claw-only mode should still clean up owned daemons');
    assert.ok(logs.includes('Starting credential daemon only'), 'launcher should print the claw-only mode');
    assert.ok(logs.includes('DEXBot2 credential daemon started successfully!'), 'launcher should print the claw-only success footer');
    assert.ok(logs.includes('If the daemon stops, rerun `node unlock --claw-only` to unlock it again.'), 'launcher should print the claw-only restart hint');
}

async function runStartupFailureSuppressesSuccessTest() {
    resetState();
    const previousMonolithicBg = process.env.DEXBOT_MONOLITHIC_BG;
    process.env.DEXBOT_MONOLITHIC_BG = '1';
    try {
        await assert.rejects(
            () => unlock.main({ argv: ['node', 'unlock'], startupGraceMs: 50 }),
            /DEXBot exited during startup/,
            'launcher should fail when the child exits during the startup grace period'
        );
    } finally {
        if (previousMonolithicBg === undefined) {
            delete process.env.DEXBOT_MONOLITHIC_BG;
        } else {
            process.env.DEXBOT_MONOLITHIC_BG = previousMonolithicBg;
        }
    }

    assert.ok(!logs.includes('DEXBot2 started successfully!'), 'launcher should not print the success footer on startup failure');
    assert.strictEqual(state.stopCount, 1, 'launcher should still clean up the daemon after startup failure');
}

async function runStatusColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;
    state.liveMonolithicPid = true;
    state.monolithicAlive = true;
    const activeBotNames = getActiveBotNames();
    state.monolithicBotInfoJson = JSON.stringify({ botNames: activeBotNames });

    await runUnlockStart(['node', 'unlock', 'status']);

    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && activeBotNames.some((botName) => line.includes(botName))),
        'status output should color active bot names green'
    );
}

async function runStartupSummaryColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;
    await runUnlockStart(['node', 'unlock']);
    const activeBotNames = getActiveBotNames();

    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && activeBotNames.some((botName) => line.includes(botName))),
        'startup summary should color active bot names green'
    );
    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('✓ Authentication successful')),
        'startup summary should color authentication success green'
    );
}

async function runClawOnlySuccessColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;

    await runUnlockStart(['node', 'unlock', 'claw-only']);

    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('DEXBot2 credential daemon started successfully!')),
        'claw-only startup should color the credential-daemon success footer green'
    );
}

(async () => {
    try {
        await runAllBotsTest();
        await runSingleBotTest();
        await runForegroundTest();
        await runReuseDaemonTest();
        await runAlreadyRunningTest();
        await runClawOnlyTest();
        await runStartupFailureSuppressesSuccessTest();
        await runStatusColorTest();
        await runStartupSummaryColorTest();
        await runClawOnlySuccessColorTest();
        restoreStubs();
        process.stdout.write('unlock output tests passed\n');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
