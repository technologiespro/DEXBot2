#!/usr/bin/env node

/**
 * unlock.js - Credential Daemon Launcher
 *
 * Starts credential daemon with master password and launches the bot process.
 *
 * Default mode: daemonizes to background and auto-restarts on crash.
 * Use --foreground to run in terminal (no auto-restart).
 *
 * Usage:
 *   node unlock [botName]       Background + auto-restart (default)
 *   node unlock --foreground    Terminal mode (no auto-restart)
 *   node unlock claw-only
 *   node unlock --claw-only
 *   node unlock --isolated
 *   node unlock --isolated <botName>
 *   node unlock status
 *   node unlock stop
 *   node unlock restart <botName>
 *   node unlock stop-all
 *   node unlock restart-all
 *   node unlock delete
 *
 * Environment:
 *   BOT_NAME              Fallback bot name when none is given as positional arg
 */

process.umask(0o077);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCredentialDaemonController } = require('./modules/launcher/credential_daemon');
const { buildScopedChildEnv } = require('./modules/launcher/child_env');
const { parseUnlockArgs } = require('./modules/launcher/launch_modes');
const { UPDATER } = require('./modules/constants');
const { buildRuntimeScriptArgs } = require('./modules/launcher/runtime_entry');
const { createBotSupervisor, SOCKET_PATH, parseCronExpression, getNextCronDate } = require('./modules/launcher/bot_supervisor');
const { sendControlCommand } = require('./modules/launcher/supervisor_control');
const { registerCleanup, setupGracefulShutdown } = require('./modules/graceful_shutdown');
const { getCredentialReadyFilePath, getCredentialSocketPath } = require('./modules/credential_runtime');
const { normalizeBotEntry, resolveRawBotEntries, loadSettingsFile } = require('./modules/bot_settings');
const chainKeys = require('./modules/chain_keys');

const CODE_ROOT = __dirname;
const ROOT = path.basename(CODE_ROOT) === 'dist' ? path.dirname(CODE_ROOT) : CODE_ROOT;
const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
const LOGS_DIR = path.join(ROOT, 'profiles', 'logs');
const SUPERVISOR_OUT_LOG = path.join(LOGS_DIR, 'supervisor.log');
const SUPERVISOR_ERROR_LOG = path.join(LOGS_DIR, 'supervisor-error.log');

const controller = createCredentialDaemonController({ root: ROOT, codeRoot: CODE_ROOT });
const DEFAULT_STARTUP_GRACE_MS = 750;

// Monolithic background process supervision
const MONOLITHIC_PID_FILE = path.join(ROOT, 'profiles', 'monolithic.pid');
const MONOLITHIC_BOT_PID_FILE = path.join(ROOT, 'profiles', 'monolithic-bot.pid');
const MONOLITHIC_BOT_INFO_FILE = path.join(ROOT, 'profiles', 'monolithic-bot.json');
const MONOLITHIC_CRED_PID_FILE = path.join(ROOT, 'profiles', 'monolithic-cred.pid');
const CREDENTIAL_SOCKET_FILE = getCredentialSocketPath({ root: ROOT });
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath({ root: ROOT });
const MONOLITHIC_OUT_LOG = path.join(LOGS_DIR, 'dexbot.log');
const MONOLITHIC_ERROR_LOG = path.join(LOGS_DIR, 'dexbot-error.log');
const MONOLITHIC_MAX_RESTARTS = 13;
const MONOLITHIC_MIN_UPTIME_MS = 86400000;
const MONOLITHIC_RESTART_DELAY_MS = 3000;
const MONOLITHIC_CONTROL_STOP_TIMEOUT_MS = 12000;
const MARKET_ADAPTER_LOCK_FILE = path.join(ROOT, 'market_adapter', 'state', 'market_adapter.lock');
const botProcessRef: { current: any } = { current: null };

function cleanupMonolithicStateFiles() {
    try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
    try { fs.unlinkSync(MONOLITHIC_BOT_PID_FILE); } catch (_) {}
    try { fs.unlinkSync(MONOLITHIC_BOT_INFO_FILE); } catch (_) {}
}

function forwardSignal(child: any, signal: any) {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err: any) {
        if (err.code === 'ESRCH') return;
        throw err;
    }
}

function printLauncherHeader({ botName = null, clawOnly = false, isolated = false }: { botName?: string | null; clawOnly?: boolean; isolated?: boolean } = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 Unlock Launcher');
    if (isolated) console.log('Mode: isolated (per-bot processes)');
    if (clawOnly) {
        console.log('Starting credential daemon only');
    } else if (botName) {
        console.log(`Starting bot: ${botName}`);
    } else {
        console.log('Starting all bots');
    }
    console.log('='.repeat(50));
    console.log();
}

function printLauncherStartupSummary({
    botNames,
    mode,
}: {
    botNames: string[];
    mode: 'background' | 'foreground' | 'isolated';
}) {
    console.log('='.repeat(50));
    console.log(`DEXBot2 started ${botNames.length} bot(s) in ${mode}`);
    console.log();
    for (const botName of botNames) {
        console.log(`- ${botName}`);
    }
    console.log('='.repeat(50));
}

function printLauncherSuccess({ botName = null, clawOnly = false, isolated = false }: { botName?: string | null; clawOnly?: boolean; isolated?: boolean } = {}) {
    console.log();
    console.log('='.repeat(50));
    if (clawOnly) {
        console.log('DEXBot2 credential daemon started successfully!');
        console.log('If the daemon stops, rerun `node unlock --claw-only` to unlock it again.');
    } else if (botName) {
        console.log('DEXBot2 started successfully!');
        const cmd = isolated ? `node unlock --isolated ${botName}` : `node unlock ${botName}`;
        console.log(`If the bot stops, rerun \`${cmd}\` to unlock it again.`);
    } else {
        console.log('DEXBot2 started successfully!');
        const cmd = isolated ? 'node unlock --isolated' : 'node unlock';
        console.log(`If the bot stops, rerun \`${cmd}\` to unlock it again.`);
    }
    console.log('='.repeat(50));
    console.log();
}

function waitForChildSpawn(child: any) {
    return new Promise<void>((resolve, reject) => {
        let settled = false;

        const handleSpawn = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };

        const handleError = (error: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const cleanup = () => {
            child.off('spawn', handleSpawn);
            child.off('error', handleError);
        };

        child.once('spawn', handleSpawn);
        child.once('error', handleError);
    });
}

function waitForStableChildStartup(child: any, { label = 'child process', timeoutMs = DEFAULT_STARTUP_GRACE_MS } = {}) {
    if (timeoutMs <= 0) {
        return waitForChildSpawn(child);
    }

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;

        const finish = (fn: (value?: any) => void, value?: any) => {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            cleanup();
            fn(value);
        };

        const handleSpawn = () => {
            timer = setTimeout(() => finish(resolve), timeoutMs);
            if (timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        };

        const handleError = (error: any) => finish(reject, error);
        const handleClose = (code: any, signal: any) => {
            finish(reject, new Error(`${label} exited during startup (exit ${code}${signal ? `, signal ${signal}` : ''})`));
        };

        const cleanup = () => {
            child.off('spawn', handleSpawn);
            child.off('error', handleError);
            child.off('close', handleClose);
        };

        child.once('spawn', handleSpawn);
        child.once('error', handleError);
        child.once('close', handleClose);
    });
}

function ensureMonolithicLogDir() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
}

function resolveBotEntryForName(botName: string) {
    const { config } = loadSettingsFile(BOTS_FILE);
    const raw = resolveRawBotEntries(config);
    const match = raw.find((b: any) => b && b.name === botName);
    if (!match) return null;
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    return normalizeBotEntry(entryCopy);
}

function buildDexbotStartArgs(botName: string | null = null) {
    const scriptArgs = ['start'];
    if (botName) scriptArgs.push(botName);
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['dexbot'],
        scriptArgs,
    });
}

function buildUnlockArgs({ isolated = false, botName = null }: { isolated?: boolean; botName?: string | null } = {}) {
    const scriptArgs = [];
    if (isolated) {
        scriptArgs.push('--isolated');
    }
    if (botName) {
        scriptArgs.push(botName);
    }
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['unlock'],
        scriptArgs,
    });
}

async function runIsolated({
    botName,
    botEntry = null,
    stayResident = false,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
}: {
    botName?: string;
    botEntry?: any;
    stayResident?: boolean;
    startupGraceMs?: number;
} = {}): Promise<number> {
    let supervisor;

    if (botName) {
        const bot = botEntry || resolveBotEntryForName(botName);
        if (!bot) {
            throw new Error(`Bot '${botName}' not found in bots.json`);
        }
        supervisor = createBotSupervisor({ bots: [bot] });
    } else {
        supervisor = createBotSupervisor();
    }

    registerCleanup('Bot supervisor', () => supervisor.shutdown());

    await supervisor.start();
    await supervisor.waitForStableStartup({ timeoutMs: startupGraceMs });

    printLauncherStartupSummary({ botNames: getLaunchedBotNames(botName || null), mode: 'isolated' });

    const sigintHandler = () => supervisor.shutdownSignalHandler('SIGINT');
    const sigtermHandler = () => supervisor.shutdownSignalHandler('SIGTERM');
    const sigusr1Handler = () => supervisor.printStatusSummary();
    const sigusr2Handler = () => supervisor.restartRunning();
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGUSR1', sigusr1Handler);
    process.on('SIGUSR2', sigusr2Handler);

    const cleanupSignalHandlers = () => {
        process.off('SIGINT', sigintHandler);
        process.off('SIGTERM', sigtermHandler);
        process.off('SIGUSR1', sigusr1Handler);
        process.off('SIGUSR2', sigusr2Handler);
    };

    if (stayResident) {
        return new Promise(() => {});
    }

    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                const status = supervisor.getStatus();
                const running = Object.values(status).some(
                    (s: any) => s.status === 'running' || s.status === 'restarting' || s.status === 'starting'
                );
                if (!running && !supervisor.hasUserStopped()) {
                    clearInterval(interval);
                    cleanupSignalHandlers();
                    await supervisor.shutdown();
                    resolve(0);
                }
            } catch (err) {
                clearInterval(interval);
                cleanupSignalHandlers();
                reject(err);
            }
        }, 1000);
    });
}

function isSupervisorTransientError(err: any): boolean {
    const msg = String(err && err.message || '');
    return msg.includes('No supervisor socket found') || msg.includes('Connection timed out');
}

function waitForSupervisorReady({ child = null, timeoutMs = 15000, intervalMs = 250 }: { child?: any; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;

        const finish = (fn: (value?: any) => void, value?: any) => {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            cleanup();
            fn(value);
        };

        const handleClose = (code: any, signal: any) => {
            finish(reject, new Error(`supervisor exited before becoming ready (exit ${code}${signal ? `, signal ${signal}` : ''})`));
        };
        const handleError = (error: any) => finish(reject, error);
        const cleanup = () => {
            if (child) {
                child.off('close', handleClose);
                child.off('error', handleError);
            }
        };

        const startedAt = Date.now();
        const poll = async () => {
            if (settled) return;
            try {
                await sendControlCommand({ cmd: 'status' });
                if (!settled) finish(resolve, true);
            } catch (err: any) {
                if (settled) return;
                if (!isSupervisorTransientError(err)) {
                    finish(reject, err);
                    return;
                }
                if ((Date.now() - startedAt) >= timeoutMs) {
                    finish(resolve, false);
                    return;
                }
                timer = setTimeout(poll, intervalMs);
                if (timer && typeof timer.unref === 'function') {
                    timer.unref();
                }
            }
        };

        if (child) {
            child.once('close', handleClose);
            child.once('error', handleError);
        }

        poll().catch((error) => finish(reject, error));
    });
}

function ensureSupervisorLogDir() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
}

async function stopCredentialDaemonPid(pid: string | number) {
    const daemonPid = Number(pid);
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
        return;
    }

    try {
        process.kill(daemonPid, 'SIGTERM');
    } catch (err: any) {
        if (err.code === 'ESRCH') {
            return;
        }
        throw err;
    }

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < 5000) {
        try {
            process.kill(daemonPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err: any) {
            if (err.code === 'ESRCH') {
                return;
            }
            throw err;
        }
    }

    try {
        process.kill(daemonPid, 'SIGKILL');
    } catch (err: any) {
        if (err.code !== 'ESRCH') {
            throw err;
        }
    }
}

function isPidAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

async function waitForPidExit(pid: number, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return !isPidAlive(pid);
}

function cleanupCredentialRuntimeFiles() {
    try { fs.unlinkSync(CREDENTIAL_SOCKET_FILE); } catch (_) {}
    try { fs.unlinkSync(CREDENTIAL_READY_FILE); } catch (_) {}
}

async function stopMonolithicCredentialDaemon(): Promise<{ signaled: boolean; cleaned: boolean }> {
    let pidRaw: string | null = null;
    try {
        pidRaw = fs.readFileSync(MONOLITHIC_CRED_PID_FILE, 'utf8').trim();
    } catch (_) {}

    const daemonPid = Number(pidRaw);
    if (!pidRaw || !Number.isInteger(daemonPid) || daemonPid <= 0) {
        cleanupCredentialRuntimeFiles();
        try { fs.unlinkSync(MONOLITHIC_CRED_PID_FILE); } catch (_) {}
        return { signaled: false, cleaned: true };
    }

    const signaled = isPidAlive(daemonPid);
    await stopCredentialDaemonPid(daemonPid);
    cleanupCredentialRuntimeFiles();
    try { fs.unlinkSync(MONOLITHIC_CRED_PID_FILE); } catch (_) {}
    return { signaled, cleaned: true };
}

async function sendIsolatedDeleteIfAvailable() {
    try {
        const resp = await sendControlCommand({ cmd: 'delete' });
        if (resp.ok && resp.status) {
            printControlStatus(resp.status);
        } else if (resp.ok) {
            console.log('OK');
        }
        return !!resp.ok;
    } catch (err: any) {
        if (isSupervisorTransientError(err)) {
            return false;
        }
        throw err;
    }
}

async function launchDetachedSupervisor({ botName = null, credentialDaemonPid = null } = {}) {
    try {
        await sendControlCommand({ cmd: 'status' });
        throw new Error(`another isolated supervisor is already running at ${process.env.DEXBOT_SUPERVISOR_SOCKET || SOCKET_PATH}`);
    } catch (err: any) {
        if (!String(err && err.message || '').includes('No supervisor socket found')) {
            throw err;
        }
    }

    ensureSupervisorLogDir();
    const stdoutFd = fs.openSync(SUPERVISOR_OUT_LOG, 'a', 0o600);
    const stderrFd = fs.openSync(SUPERVISOR_ERROR_LOG, 'a', 0o600);
    const args = buildUnlockArgs({ isolated: true, botName });
    let child = null;

    try {
        child = spawn(process.execPath, args, {
            cwd: ROOT,
            detached: true,
            env: buildScopedChildEnv({
                extra: {
                    DEXBOT_ISOLATED_CHILD: '1',
                    ...(credentialDaemonPid ? { DEXBOT_MANAGED_CRED_PID: String(credentialDaemonPid) } : {}),
                },
            }),
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        child.unref();

        const ready = await waitForSupervisorReady({ child });
        if (!ready) {
            throw new Error(`supervisor did not become ready. Check ${SUPERVISOR_OUT_LOG} and ${SUPERVISOR_ERROR_LOG}`);
        }
        return child.pid || 0;
    } catch (err) {
        if (child && child.pid) {
            try { process.kill(child.pid, 'SIGTERM'); } catch (_) {}
        }
        throw err;
    } finally {
        try { fs.closeSync(stdoutFd); } catch (_) {}
        try { fs.closeSync(stderrFd); } catch (_) {}
    }
}

let _updateTimer: NodeJS.Timeout | null = null;
let _pendingRestart = false;

function clearMonolithicUpdateTimer() {
    if (_updateTimer) {
        clearTimeout(_updateTimer);
        _updateTimer = null;
    }
}

function scheduleMonolithicUpdateJob(botProcessRef: { current: any }) {
    if (!UPDATER.ACTIVE) return () => {};

    let cancelled = false;

    const scheduleNext = () => {
        if (cancelled) return;
        try {
            const parsed = parseCronExpression(UPDATER.SCHEDULE);
            const nextDate = getNextCronDate(parsed);
            const delay = Math.max(0, nextDate.getTime() - Date.now());
            _updateTimer = setTimeout(async () => {
                if (cancelled) return;
                const updateArgs = buildRuntimeScriptArgs({
                    codeRoot: CODE_ROOT,
                    scriptSegments: ['scripts', 'update'],
                    scriptArgs: [],
                });
                const updateChild = spawn(process.execPath, updateArgs, {
                    cwd: ROOT,
                    stdio: 'inherit',
                    env: buildScopedChildEnv({ extra: { DEXBOT_UPDATE_SKIP_RELOAD: '1' } }),
                });
                const code = await new Promise<number>((resolve) => {
                    updateChild.on('close', resolve);
                });
                if (code === 0 && !cancelled) {
                    _pendingRestart = true;
                    const bot = botProcessRef.current;
                    if (bot && !bot.killed) {
                        forwardSignal(bot, 'SIGTERM');
                    }
                }
                if (!cancelled) scheduleNext();
            }, delay);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        } catch (err: any) {
            console.warn(`Update scheduler: ${err.message}`);
            _updateTimer = setTimeout(scheduleNext, 3600000);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        }
    };

    scheduleNext();

    return () => { cancelled = true; clearMonolithicUpdateTimer(); };
}

/**
 * Main entry point.
 * Starts daemon, then launches bot process(es) via monolithic or isolated mode.
 *
 * @private
 * @returns {Promise<void>}
 */
async function main({ argv = process.argv, startupGraceMs = DEFAULT_STARTUP_GRACE_MS } = {}) {
    const parsed = parseUnlockArgs(argv);
    const isDetachedSupervisorChild = process.env.DEXBOT_ISOLATED_CHILD === '1';
    const forceForegroundIsolated = process.env.DEXBOT_ISOLATED_FOREGROUND === '1';
    const isMonolithicBgChild = process.env.DEXBOT_MONOLITHIC_BG === '1';
    const forceForeground = argv.includes('--foreground');

    if (parsed.control) {
        await handleControl(parsed.control);
        return;
    }

    const { botName, clawOnly, isolated } = parsed;
    const selectedBot = botName ? resolveBotEntryForName(botName) : null;
    const launchedBotNames = getLaunchedBotNames(botName);
    let daemonReleased = false;

    try {
        if (botName && !selectedBot) {
            throw new Error(`Bot '${botName}' not found in bots.json`);
        }

        if (!isDetachedSupervisorChild) {
            printLauncherHeader({ botName, clawOnly, isolated });

            const daemonOpts: any = { detached: isolated && !forceForegroundIsolated };
            let daemonOutFd: number | null = null;
            let daemonErrFd: number | null = null;

            // In default monolithic background mode, redirect credential daemon
            // output to log files (like PM2 does) instead of polluting the terminal
            if (!clawOnly && !isolated && !forceForeground) {
                ensureMonolithicLogDir();
                daemonOutFd = fs.openSync(MONOLITHIC_OUT_LOG, 'a', 0o600);
                try {
                    daemonErrFd = fs.openSync(MONOLITHIC_ERROR_LOG, 'a', 0o600);
                } catch (_e) {
                    try { fs.closeSync(daemonOutFd); } catch (_) {}
                    daemonOutFd = null;
                    throw _e;
                }
                daemonOpts.stdio = ['ignore', daemonOutFd, daemonErrFd];
            }

            try {
                const unlockedNow = await controller.ensureCredentialDaemon(daemonOpts);
                if (unlockedNow) {
                    console.log('✓ Authentication successful');
                }
            } finally {
                if (daemonOutFd !== null) try { fs.closeSync(daemonOutFd); } catch (_) {}
                if (daemonErrFd !== null) try { fs.closeSync(daemonErrFd); } catch (_) {}
            }
        } else if (!(await controller.isDaemonReady())) {
            throw new Error('credential daemon is not ready for isolated supervisor startup');
        }

        // Background daemonization for monolithic mode (default)
        if (!clawOnly && !isolated && !isDetachedSupervisorChild && !isMonolithicBgChild && !forceForeground) {
            // Check old PID file before overwriting
            try {
                if (fs.existsSync(MONOLITHIC_PID_FILE)) {
                    const oldPid = Number(fs.readFileSync(MONOLITHIC_PID_FILE, 'utf8').trim());
                    if (Number.isInteger(oldPid) && oldPid > 0) {
                        try { process.kill(oldPid, 0); throw new Error('already running'); } catch (e: any) {
                            if (e.message === 'already running') {
                                throw new Error(`background instance already running (PID ${oldPid})`);
                            }
                        }
                    }
                }
            } catch (e: any) {
                if (e.message.includes('already running')) throw e;
            }

            const credentialDaemonPid = controller.getManagedDaemonPid();
            if (credentialDaemonPid) {
                try { fs.writeFileSync(MONOLITHIC_CRED_PID_FILE, String(credentialDaemonPid), { mode: 0o600 }); } catch (_) {}
            }
            controller.releaseManagedDaemon();
            daemonReleased = true;

            ensureMonolithicLogDir();
            const stdoutFd = fs.openSync(MONOLITHIC_OUT_LOG, 'a', 0o600);
            let stderrFd;
            try {
                stderrFd = fs.openSync(MONOLITHIC_ERROR_LOG, 'a', 0o600);
            } catch (_e) {
                try { fs.closeSync(stdoutFd); } catch (_) {}
                throw _e;
            }

            const child = spawn(process.execPath, [__filename, ...argv.slice(2)], {
                cwd: ROOT,
                detached: true,
                env: {
                    ...process.env,
                    DEXBOT_MONOLITHIC_BG: '1',
                    ...(credentialDaemonPid ? { DEXBOT_MANAGED_CRED_PID: String(credentialDaemonPid) } : {}),
                },
                stdio: ['ignore', stdoutFd, stderrFd],
            });
            child.unref();
            fs.writeFileSync(MONOLITHIC_PID_FILE, String(child.pid), { mode: 0o600 });

            printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'background' });
            process.exit(0);
        }

        if (clawOnly) {
            printLauncherSuccess({ clawOnly });
            const exitCode = await controller.waitForManagedDaemon();
            process.exitCode = exitCode || 0;
            return;
        }

        if (isolated) {
            if (isDetachedSupervisorChild || forceForegroundIsolated) {
                process.exitCode = await runIsolated({
                    botName,
                    botEntry: selectedBot,
                    stayResident: isDetachedSupervisorChild,
                    startupGraceMs,
                });
                return;
            }

            const supervisorPid = await launchDetachedSupervisor({
                botName,
                credentialDaemonPid: controller.getManagedDaemonPid(),
            });
            controller.releaseManagedDaemon();
            daemonReleased = true;
            printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'isolated' });
            console.log(`Supervisor PID: ${supervisorPid}`);
            console.log(`Control socket: ${process.env.DEXBOT_SUPERVISOR_SOCKET || SOCKET_PATH}`);
            console.log(`Supervisor logs: ${SUPERVISOR_OUT_LOG}`);
            process.exitCode = 0;
            return;
        }

        const cancelUpdateScheduler = scheduleMonolithicUpdateJob(botProcessRef);
        let restartCount = 0;
        let lastStartTime = 0;
        let keepRunning = true;
        let monolithicRestartSignalRegistered = false;
        const onSigusr2 = () => {
            _pendingRestart = true;
            forwardSignal(botProcessRef.current, 'SIGTERM');
        };
        process.on('SIGUSR2', onSigusr2);
        monolithicRestartSignalRegistered = true;

        try {
            do {
                const dexbotArgs = buildDexbotStartArgs(botName);

                const botProcess = spawn(process.execPath, dexbotArgs, {
                    cwd: ROOT,
                    env: process.env,
                    stdio: isMonolithicBgChild ? 'pipe' : 'inherit',
                });
                botProcessRef.current = botProcess;

                if (isMonolithicBgChild) {
                    try { fs.writeFileSync(MONOLITHIC_BOT_PID_FILE, String(botProcess.pid), { mode: 0o600 }); } catch (_) {}
                    const botStat = botProcess.pid ? readProcStat(botProcess.pid) : null;
                    try {
                        fs.writeFileSync(
                            MONOLITHIC_BOT_INFO_FILE,
                            JSON.stringify({ botName, botNames: launchedBotNames, pid: botProcess.pid, starttime: botStat?.starttime ?? null }),
                            { mode: 0o600 }
                        );
                    } catch (_) {}
                }

                // Pipe output to log files in background mode
                if (isMonolithicBgChild && botProcess.stdout) {
                    const outStream = fs.createWriteStream(MONOLITHIC_OUT_LOG, { flags: 'a' });
                    const errStream = fs.createWriteStream(MONOLITHIC_ERROR_LOG, { flags: 'a' });
                    botProcess.stdout.pipe(outStream);
                    botProcess.stderr.pipe(errStream);
                    botProcess.stdout.on('error', () => {});
                    botProcess.stderr.on('error', () => {});
                    botProcess.once('close', () => {
                        try { outStream.end(); } catch (_) {}
                        try { errStream.end(); } catch (_) {}
                    });
                }

                lastStartTime = Date.now();
                await waitForStableChildStartup(botProcess, { label: 'DEXBot', timeoutMs: startupGraceMs });

                if (!_pendingRestart) {
                    if (!isMonolithicBgChild) {
                        printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'foreground' });
                    }
                }

                const onSigint = () => forwardSignal(botProcess, 'SIGINT');
                const onSigterm = () => forwardSignal(botProcess, 'SIGTERM');
                process.on('SIGINT', onSigint);
                process.on('SIGTERM', onSigterm);

                const cleanupBotHandlers = () => {
                    process.off('SIGINT', onSigint);
                    process.off('SIGTERM', onSigterm);
                };

                const exitCode: any = await new Promise((resolve, reject) => {
                    botProcess.on('error', reject);
                    botProcess.on('close', (code: any) => resolve(code));
                }).catch((err) => {
                    cleanupBotHandlers();
                    throw err;
                });
                cleanupBotHandlers();

                if (_pendingRestart) {
                    _pendingRestart = false;
                    console.log('Update applied, restarting bot...');
                } else if (exitCode !== 0) {
                    const uptime = Date.now() - lastStartTime;
                    if (uptime >= MONOLITHIC_MIN_UPTIME_MS) {
                        restartCount = 0;
                    }
                    restartCount++;
                    if (restartCount > MONOLITHIC_MAX_RESTARTS) {
                        console.error(`Bot crashed ${MONOLITHIC_MAX_RESTARTS} times without stable uptime. Exiting.`);
                        process.exitCode = exitCode || 1;
                        keepRunning = false;
                    } else {
                        console.log(`Bot crashed (exit ${exitCode}), restarting in ${MONOLITHIC_RESTART_DELAY_MS / 1000}s (attempt ${restartCount}/${MONOLITHIC_MAX_RESTARTS})...`);
                        await new Promise((r) => setTimeout(r, MONOLITHIC_RESTART_DELAY_MS));
                    }
                } else {
                    process.exitCode = 0;
                    keepRunning = false;
                }
            } while (keepRunning);
        } finally {
            if (monolithicRestartSignalRegistered) {
                process.off('SIGUSR2', onSigusr2);
            }
            cancelUpdateScheduler();
        }
    } finally {
        if (isMonolithicBgChild) {
            cleanupMonolithicStateFiles();
        }
        if (!isDetachedSupervisorChild && !daemonReleased) {
            await controller.stopManagedDaemon();
        }
    }
}

function readProcStat(pid: number): { utime: number; stime: number; starttime: number } | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const lastParen = stat.lastIndexOf(')');
        if (lastParen === -1) return null;
        const fields = stat.slice(lastParen + 2).split(/\s+/);
        return {
            utime: parseInt(fields[11], 10) || 0,
            stime: parseInt(fields[12], 10) || 0,
            starttime: parseInt(fields[19], 10) || 0,
        };
    } catch { return null; }
}

function readProcMemMB(pid: number): string {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
        if (match) {
            const mb = Math.round(parseInt(match[1], 10) / 1024);
            return `${mb}MB`;
        }
    } catch {}
    return '-';
}

function readProcCpuTotal(pid: number): number | null {
    try {
        const stat = readProcStat(pid);
        if (!stat) return null;
        return (stat.utime + stat.stime) / 100;
    } catch { return null; }
}

function readProcCpuTime(pid: number): string {
    try {
        const totalSec = readProcCpuTotal(pid);
        if (totalSec == null) return '-';
        if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
        const m = Math.floor(totalSec / 60);
        const s = Math.floor(totalSec % 60);
        if (m < 60) return `${m}m ${s}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    } catch { return '-'; }
}

async function readProcCpuPercent(pid: number, samples: number = 2, intervalMs: number = 400): Promise<string> {
    try {
        const snap = () => {
            const stat = readProcStat(pid);
            if (!stat) return null;
            return { pidCpu: stat.utime + stat.stime, ts: Date.now() };
        };
        let prev = snap();
        if (!prev) return '-';
        for (let i = 0; i < samples - 1; i++) {
            await new Promise(r => setTimeout(r, intervalMs));
        }
        const cur = snap();
        if (!cur) return '-';
        const dt = (cur.ts - prev.ts) / 1000;
        const dcpu = (cur.pidCpu - prev.pidCpu) / 100;
        if (dt <= 0) return '-';
        const pct = (dcpu / dt) * 100;
        return `${pct.toFixed(1)}%`;
    } catch { return '-'; }
}

function readProcCmdline(pid: number): string {
    return readProcArgs(pid).join(' ');
}

function readProcArgs(pid: number): string[] {
    if (!isPidAlive(pid)) return [];
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

function runtimeScriptPath(scriptSegments: string[]): string {
    const scriptExt = path.basename(CODE_ROOT) === 'dist' ? '.js' : '.ts';
    const segments = [...scriptSegments];
    const last = segments.pop() as string;
    segments.push(last.replace(/\.(?:[cm]?js|ts)$/i, '') + scriptExt);
    return path.join(CODE_ROOT, ...segments);
}

function scriptPathForRoot(root: string, scriptSegments: string[], ext: string): string {
    const segments = [...scriptSegments];
    const last = segments.pop() as string;
    segments.push(last.replace(/\.(?:[cm]?js|ts)$/i, '') + ext);
    return path.join(root, ...segments);
}

function candidateRuntimeScriptPaths(scriptSegments: string[]): Set<string> {
    const candidates = new Set<string>();
    candidates.add(runtimeScriptPath(scriptSegments));

    candidates.add(scriptPathForRoot(ROOT, scriptSegments, '.ts'));
    candidates.add(scriptPathForRoot(path.join(ROOT, 'dist'), scriptSegments, '.js'));

    if (scriptSegments.length === 1) {
        candidates.add(scriptPathForRoot(ROOT, scriptSegments, '.js'));
    }

    // Compatibility for wrappers already running from before the unlock-start -> unlock rename.
    if (scriptSegments.length === 1 && scriptSegments[0] === 'unlock') {
        candidates.add(scriptPathForRoot(ROOT, ['unlock-start'], '.js'));
        candidates.add(scriptPathForRoot(ROOT, ['unlock-start'], '.ts'));
        candidates.add(scriptPathForRoot(path.join(ROOT, 'dist'), ['unlock-start'], '.js'));
    }

    return candidates;
}

function readProcCwd(pid: number): string {
    try {
        return fs.realpathSync(`/proc/${pid}/cwd`);
    } catch {
        return '';
    }
}

function normalizeProcScriptArg(arg: string, cwd: string): string {
    if (!arg || arg.startsWith('-')) return '';
    if (!/\.(?:[cm]?js|ts)$/i.test(arg)) return '';
    return path.isAbsolute(arg)
        ? path.normalize(arg)
        : path.resolve(cwd || ROOT, arg);
}

function isNodeProcessWithExactScript(pid: number, scriptSegments: string[]): boolean {
    const args = readProcArgs(pid);
    if (!args.some((arg) => path.basename(String(arg)).includes('node'))) {
        return false;
    }

    const expected = candidateRuntimeScriptPaths(scriptSegments);
    const cwd = readProcCwd(pid);
    for (const arg of args.slice(1)) {
        const scriptPath = normalizeProcScriptArg(arg, cwd);
        if (scriptPath && expected.has(scriptPath)) {
            return true;
        }
    }

    return false;
}

function isLikelyMarketAdapterProcess(pid: number): boolean {
    return isNodeProcessWithExactScript(pid, ['market_adapter', 'market_adapter']);
}

function isLikelyCredentialDaemonProcess(pid: number): boolean {
    return isNodeProcessWithExactScript(pid, ['credential-daemon']);
}

function isLikelyDexbotProcess(pid: number): boolean {
    return isNodeProcessWithExactScript(pid, ['dexbot']);
}

function isLikelyUnlockProcess(pid: number): boolean {
    return isNodeProcessWithExactScript(pid, ['unlock']);
}

async function readCredentialDaemonStatus(pid: number | null): Promise<{ alive: boolean; ready: boolean; socket: boolean }> {
    const alive = !!(pid && isLikelyCredentialDaemonProcess(pid));
    if (!alive) {
        return { alive: false, ready: false, socket: false };
    }

    try {
        const responsive = await chainKeys.isDaemonResponsive({
            socketPath: CREDENTIAL_SOCKET_FILE,
            readyFilePath: CREDENTIAL_READY_FILE,
        });
        return { alive, ready: responsive, socket: responsive };
    } catch (_) {
        return { alive, ready: false, socket: false };
    }
}

function isExpectedProcessStarttime(pid: number, expectedStarttime: number | null | undefined): boolean {
    if (typeof expectedStarttime !== 'number') return false;
    const stat = readProcStat(pid);
    return !!(stat && stat.starttime === expectedStarttime);
}

function isExpectedMonolithicBotPid(pid: number, botInfo: { pid?: number; starttime?: number | null } | null): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    if (!botInfo || botInfo.pid !== pid) {
        return false;
    }
    if (!isLikelyDexbotProcess(pid)) {
        return false;
    }
    if (!isExpectedProcessStarttime(pid, botInfo.starttime)) {
        return false;
    }
    return true;
}

function readMarketAdapterStatus(): { pid: number | null; alive: boolean; uptime: string; mem: string } {
    try {
        const raw = fs.readFileSync(MARKET_ADAPTER_LOCK_FILE, 'utf8');
        const info = JSON.parse(raw);
        const pid = Number(info.pid);
        if (!Number.isInteger(pid) || pid <= 0) {
            return { pid: null, alive: false, uptime: '-', mem: '-' };
        }
        const alive = isLikelyMarketAdapterProcess(pid);
        return {
            pid,
            alive,
            uptime: alive ? readProcUptime(pid) : '-',
            mem: alive ? readProcMemMB(pid) : '-',
        };
    } catch (_) {
        return { pid: null, alive: false, uptime: '-', mem: '-' };
    }
}

function readProcUptime(pid: number): string {
    try {
        const stat = readProcStat(pid);
        if (!stat) return '-';
        const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
        const clkTck = 100;
        const processStartSec = stat.starttime / clkTck;
        const uptimeMs = (uptimeSec - processStartSec) * 1000;
        return formatControlUptime(uptimeMs);
    } catch { return '-'; }
}

function usesAmaGridPrice(bot: any): boolean {
    const gridPrice = typeof bot?.gridPrice === 'string' ? bot.gridPrice.trim().toLowerCase() : '';
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

function listConfiguredBots(): { name: string; active: boolean; gridPrice: string }[] {
    try {
        const { config } = loadSettingsFile(BOTS_FILE);
        const raw = resolveRawBotEntries(config);
        return raw.map((b: any) => ({
            name: b.name,
            active: b.active !== false,
            gridPrice: typeof b.gridPrice === 'string' ? b.gridPrice.trim().toLowerCase() : '',
        }));
    } catch { return []; }
}

function getLaunchedBotNames(botName: string | null): string[] {
    return botName
        ? [botName]
        : listConfiguredBots().filter((b) => b.active).map((b) => b.name);
}

function getAllControlBotNames(): string[] {
    const botInfo = readMonolithicBotInfo();
    if (Array.isArray(botInfo?.botNames) && botInfo.botNames.length > 0) {
        return botInfo.botNames.map((name) => String(name));
    }
    if (botInfo?.botName) {
        return [String(botInfo.botName)];
    }
    return listConfiguredBots().filter((b) => b.active).map((b) => b.name);
}

function getControlBotNames(target?: string, wholeRuntime = false): string[] {
    if (target) return [target];
    if (wholeRuntime) return getAllControlBotNames();
    return [];
}

function getControlActionLabel(cmd: string): string {
    if (cmd === 'restart' || cmd === 'restart-all') return 'restarting';
    if (cmd === 'shutdown' || cmd === 'delete') return 'shutting down';
    return 'stopping';
}

function printControlActionSummary(action: string, botNames: string[]) {
    console.log('='.repeat(50));
    console.log(`DEXBot2 ${action} ${botNames.length} bot(s)`);
    console.log();
    for (const botName of botNames) {
        console.log(`- ${botName}`);
    }
    console.log('='.repeat(50));
    console.log();
}

function readMonolithicBotInfo(): { botName?: string | null; botNames?: string[]; pid?: number; starttime?: number | null } | null {
    try {
        const infoRaw = fs.readFileSync(MONOLITHIC_BOT_INFO_FILE, 'utf8');
        const info = JSON.parse(infoRaw);
        return info && typeof info === 'object' ? info : null;
    } catch (_) {
        return null;
    }
}

function readLiveMonolithicPid(): { pid: number; stale: boolean } {
    if (!fs.existsSync(MONOLITHIC_PID_FILE)) return { pid: 0, stale: false };

    let pid = 0;
    try {
        const raw = fs.readFileSync(MONOLITHIC_PID_FILE, 'utf8').trim();
        pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) pid = 0;
    } catch (_) {
        try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
        return { pid: 0, stale: true };
    }

    if (pid <= 0) return { pid: 0, stale: true };

    if (!isLikelyUnlockProcess(pid)) {
        try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
        return { pid: 0, stale: true };
    }

    return { pid, stale: false };
}

async function handleControl({ cmd, target }: { cmd: string; target?: string }) {
    const effectiveCmd = cmd === 'shutdown' ? 'delete' : cmd;
    const actionLabel = getControlActionLabel(cmd);

    if (effectiveCmd === 'restart' && !target) {
        console.error('Usage: node unlock restart <botName> or node unlock restart-all');
        process.exitCode = 1;
        return;
    }

    // Try monolithic PID file first for whole-runtime controls.
    if ((effectiveCmd === 'stop' || effectiveCmd === 'stop-all' || effectiveCmd === 'delete' || effectiveCmd === 'status' || effectiveCmd === 'restart-all') && !target) {
        const { pid, stale } = readLiveMonolithicPid();

        if (pid > 0) {
            const summaryBotNames = getControlBotNames(undefined, true);

            if (effectiveCmd === 'restart-all') {
                try {
                    process.kill(pid, 'SIGUSR2');
                } catch (err: any) {
                    if (err.code !== 'ESRCH') throw err;
                }
                printControlActionSummary(actionLabel, summaryBotNames);
                return;
            }

            if (effectiveCmd === 'status') {
                const botInfo = readMonolithicBotInfo();

                // Read actual bot PID from companion file (fallback to wrapper PID)
                let targetPid = pid;
                let botPidRaw: string | null = null;
                try { botPidRaw = fs.readFileSync(MONOLITHIC_BOT_PID_FILE, 'utf8').trim(); } catch (_) {}
                if (botPidRaw) {
                    const bp = Number(botPidRaw);
                    if (isExpectedMonolithicBotPid(bp, botInfo)) {
                        targetPid = bp;
                    }
                }

                const mem = readProcMemMB(targetPid);
                const cpuTime = readProcCpuTime(targetPid);
                const cpuPct = await readProcCpuPercent(targetPid);
                const uptime = readProcUptime(targetPid);

                // No info file means backward compatibility with an older running wrapper.
                let displayedBots: { name: string }[];
                if (Array.isArray(botInfo?.botNames)) {
                    displayedBots = botInfo.botNames.map((name) => ({ name: String(name) }));
                } else if (botInfo?.botName) {
                    displayedBots = [{ name: String(botInfo.botName) }];
                } else {
                    const allBots = listConfiguredBots();
                    displayedBots = allBots.filter(b => b.active);
                }

                let credPid: number | null = null;
                try {
                    const raw = fs.readFileSync(MONOLITHIC_CRED_PID_FILE, 'utf8').trim();
                    const n = Number(raw);
                    if (Number.isInteger(n) && n > 0) credPid = n;
                } catch (_) {}

                const credStatus = await readCredentialDaemonStatus(credPid);

                console.log('Monolithic bot');
                console.log(`  PID:     ${targetPid}`);
                console.log(`  Uptime:  ${uptime}`);
                console.log(`  Memory:  ${mem}`);
                console.log(`  CPU:     ${cpuPct}  (cumulative: ${cpuTime})`);
                console.log(`  Bots:    ${displayedBots.length} active`);
                for (const b of displayedBots) {
                    console.log(`    - ${b.name}`);
                }
                console.log('  Credential daemon:');
                console.log(`    PID:   ${credPid || '-'}`);
                if (credStatus.alive) {
                    const credUptime = readProcUptime(credPid!);
                    console.log(`    Alive: yes  (uptime: ${credUptime})`);
                } else {
                    console.log(`    Alive: no`);
                }
                console.log(`    Ready: ${credStatus.ready ? 'yes' : 'no'}`);
                console.log(`    Socket: ${credStatus.socket ? 'yes' : 'no'}`);

                const adapterStatus = readMarketAdapterStatus();
                const amaBots = listConfiguredBots().filter(b => b.active && usesAmaGridPrice(b));
                console.log('  Market adapter:');
                if (adapterStatus.alive) {
                    console.log(`    PID:     ${adapterStatus.pid}`);
                    console.log(`    Uptime:  ${adapterStatus.uptime}`);
                    console.log(`    Memory:  ${adapterStatus.mem}`);
                } else if (adapterStatus.pid) {
                    console.log(`    PID:     ${adapterStatus.pid} (not alive)`);
                } else {
                    console.log('    (not running)');
                }
                console.log(`    Active:  ${amaBots.length} bot(s)`);
                for (const b of amaBots) {
                    console.log(`      - ${b.name} (${b.gridPrice})`);
                }
                return;
            }

            let monolithicExited = false;
            try {
                process.kill(pid, 'SIGTERM');
                const timeoutMs = effectiveCmd === 'delete' ? MONOLITHIC_CONTROL_STOP_TIMEOUT_MS : 5000;
                monolithicExited = await waitForPidExit(pid, timeoutMs);
                if (!monolithicExited && effectiveCmd === 'delete') {
                    process.kill(pid, 'SIGKILL');
                    monolithicExited = await waitForPidExit(pid, 2000);
                    if (!monolithicExited) {
                        throw new Error(`monolithic wrapper PID ${pid} did not exit after SIGKILL`);
                    }
                }
                if (effectiveCmd === 'delete') {
                    const credResult = await stopMonolithicCredentialDaemon();
                    if (credResult.signaled) {
                        console.log('Stop signal sent to credential daemon');
                    }
                }
            } catch (err: any) {
                if (err.code !== 'ESRCH') throw err;
                monolithicExited = true;
            } finally {
                if (effectiveCmd !== 'delete' || monolithicExited) {
                    cleanupMonolithicStateFiles();
                }
            }
            printControlActionSummary(actionLabel, summaryBotNames);
            return;
        } else if (stale) {
            if (effectiveCmd === 'delete') {
                const summaryBotNames = getControlBotNames(undefined, true);
                const isolatedDeleted = await sendIsolatedDeleteIfAvailable();
                const credResult = await stopMonolithicCredentialDaemon();
                if (credResult.signaled) {
                    console.log('Stop signal sent to credential daemon');
                }
                printControlActionSummary(actionLabel, summaryBotNames);
                if (isolatedDeleted || credResult.cleaned) return;
            }
            console.log(effectiveCmd === 'delete' ? 'Removed stale monolithic PID file' : 'Monolithic bot not running (stale PID file)');
            return;
        }
    }

    if (effectiveCmd === 'delete' && !target && fs.existsSync(MONOLITHIC_CRED_PID_FILE)) {
        await sendIsolatedDeleteIfAvailable();
        const credResult = await stopMonolithicCredentialDaemon();
        if (credResult.signaled) {
            console.log('Stop signal sent to credential daemon');
        }
        if (credResult.cleaned) {
            printControlActionSummary(actionLabel, getControlBotNames(undefined, true));
            return;
        }
    }

    // No monolithic PID file or target-specific control — fall through to isolated supervisor socket
    const controlCmd: any = { cmd: effectiveCmd };
    if (target) controlCmd.bot = target;

    try {
        const resp = await sendControlCommand(controlCmd);
        if (resp.ok && resp.status) {
            printControlStatus(resp.status);
        } else {
            if (target || effectiveCmd === 'stop-all' || effectiveCmd === 'restart-all' || effectiveCmd === 'delete') {
                const summaryBotNames = getControlBotNames(target, !target && (effectiveCmd === 'stop-all' || effectiveCmd === 'restart-all' || effectiveCmd === 'delete'));
                printControlActionSummary(actionLabel, summaryBotNames);
            }
            console.log('OK');
        }
    } catch (err: any) {
        if (effectiveCmd === 'delete' && !target && isSupervisorTransientError(err)) {
            console.log('No runtime processes found.');
            return;
        }
        console.error(`control ${cmd}: ${err.message}`);
        process.exitCode = 1;
    }
}

function printControlStatus(status: any) {
    const entries = Object.entries(status);
    if (entries.length === 0) {
        console.log('No bots');
        return;
    }
    const nameWidth = Math.max(...entries.map(([n]) => n.length), 8);
    const header = `${'NAME'.padEnd(nameWidth)} | STATUS    | PID   | RESTARTS | UPTIME`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const [name, s] of Object.entries(status) as [string, any][]) {
        const uptime = s.uptimeMs ? formatControlUptime(s.uptimeMs) : '-';
        console.log(
            `${name.padEnd(nameWidth)} | ${(s.status || '-').padEnd(9)} | ${String(s.pid || '-').padEnd(5)} | ${String(s.restarts).padEnd(8)} | ${uptime}`
        );
    }
}

function formatControlUptime(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

// Run if called directly or via the root-level unlock.js shim
const isUnlockStartDirectRun = require.main === module || (
    process.argv[1] &&
    path.parse(process.argv[1]).name === 'unlock'
);
if (isUnlockStartDirectRun) {
    setupGracefulShutdown();
    if (process.env.DEXBOT_ISOLATED_CHILD === '1') {
        registerCleanup('Credential daemon', () => stopCredentialDaemonPid(process.env.DEXBOT_MANAGED_CRED_PID as string));
    } else if (process.env.DEXBOT_MONOLITHIC_BG === '1') {
        registerCleanup('PID files', cleanupMonolithicStateFiles);
        registerCleanup('Bot process', async () => {
            const bot = botProcessRef.current;
            if (bot && !bot.killed) {
                forwardSignal(bot, 'SIGTERM');
                await Promise.race([
                    new Promise((resolve) => bot.once('close', resolve)),
                    new Promise((resolve) => setTimeout(resolve, 10000)),
                ]);
            }
        });
    } else {
        registerCleanup('Credential daemon', () => controller.stopManagedDaemon());
    }
    (async () => {
        try {
            await main();
        } catch (err: any) {
            console.error('unlock failed:', err.message || err);
            process.exitCode = 1;
        }
    })();
}

export = {
    buildDexbotStartArgs,
    buildUnlockArgs,
    main,
    waitForChildSpawn,
    waitForStableChildStartup,
};
