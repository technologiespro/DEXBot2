#!/usr/bin/env node

/**
 * unlock-start.js - Credential Daemon Launcher
 *
 * Starts credential daemon with master password and launches the bot process.
 *
 * Default mode: daemonizes to background and auto-restarts on crash.
 * Use --foreground to run in terminal (no auto-restart).
 *
 * Usage:
 *   node unlock-start [botName]       Background + auto-restart (default)
 *   node unlock-start --foreground    Terminal mode (no auto-restart)
 *   node unlock-start claw-only
 *   node unlock-start --claw-only
 *   node unlock-start --isolated
 *   node unlock-start --isolated <botName>
 *   node unlock-start status
 *   node unlock-start stop
 *   node unlock-start restart <botName>
 *   node unlock-start stop-all
 *   node unlock-start restart-all
 *   node unlock-start shutdown
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
const { parseUnlockStartArgs } = require('./modules/launcher/launch_modes');
const { UPDATER } = require('./modules/constants');
const { buildRuntimeScriptArgs } = require('./modules/launcher/runtime_entry');
const { createBotSupervisor, SOCKET_PATH, parseCronExpression, getNextCronDate } = require('./modules/launcher/bot_supervisor');
const { sendControlCommand } = require('./modules/launcher/supervisor_control');
const { registerCleanup, setupGracefulShutdown } = require('./modules/graceful_shutdown');
const { normalizeBotEntry, resolveRawBotEntries, loadSettingsFile } = require('./modules/bot_settings');

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
const MONOLITHIC_OUT_LOG = path.join(LOGS_DIR, 'dexbot.log');
const MONOLITHIC_ERROR_LOG = path.join(LOGS_DIR, 'dexbot-error.log');
const MONOLITHIC_MAX_RESTARTS = 13;
const MONOLITHIC_MIN_UPTIME_MS = 86400000;
const MONOLITHIC_RESTART_DELAY_MS = 3000;
const botProcessRef: { current: any } = { current: null };

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
    console.log('DEXBot2 Unlock-Start Launcher');
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

function printLauncherSuccess({ botName = null, clawOnly = false, isolated = false }: { botName?: string | null; clawOnly?: boolean; isolated?: boolean } = {}) {
    console.log();
    console.log('='.repeat(50));
    if (clawOnly) {
        console.log('DEXBot2 credential daemon started successfully!');
        console.log('If the daemon stops, rerun `node unlock-start --claw-only` to unlock it again.');
    } else if (botName) {
        console.log('DEXBot2 started successfully!');
        const cmd = isolated ? `node unlock-start --isolated ${botName}` : `node unlock-start ${botName}`;
        console.log(`If the bot stops, rerun \`${cmd}\` to unlock it again.`);
    } else {
        console.log('DEXBot2 started successfully!');
        const cmd = isolated ? 'node unlock-start --isolated' : 'node unlock-start';
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

function buildUnlockStartArgs({ isolated = false, botName = null }: { isolated?: boolean; botName?: string | null } = {}) {
    const scriptArgs = [];
    if (isolated) {
        scriptArgs.push('--isolated');
    }
    if (botName) {
        scriptArgs.push(botName);
    }
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['unlock-start'],
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

    printLauncherSuccess({ botName, isolated: true });

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
    const args = buildUnlockStartArgs({ isolated: true, botName });
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
    const parsed = parseUnlockStartArgs(argv);
    const isDetachedSupervisorChild = process.env.DEXBOT_ISOLATED_CHILD === '1';
    const forceForegroundIsolated = process.env.DEXBOT_ISOLATED_FOREGROUND === '1';
    const isMonolithicBgChild = process.env.DEXBOT_MONOLITHIC_BG === '1';
    const forceForeground = process.argv.includes('--foreground');

    if (parsed.control) {
        await handleControl(parsed.control);
        return;
    }

    const { botName, clawOnly, isolated } = parsed;
    const selectedBot = botName ? resolveBotEntryForName(botName) : null;
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

            const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
                cwd: ROOT,
                detached: true,
                env: { ...process.env, DEXBOT_MONOLITHIC_BG: '1' },
                stdio: ['ignore', stdoutFd, stderrFd],
            });
            child.unref();
            fs.writeFileSync(MONOLITHIC_PID_FILE, String(child.pid), { mode: 0o600 });

            console.log('='.repeat(50));
            console.log('DEXBot2 started in background');
            console.log(`PID: ${child.pid}`);
            console.log(`Logs: ${MONOLITHIC_OUT_LOG}`);
            console.log(`Stop: node unlock-start stop`);
            console.log('='.repeat(50));
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
            printLauncherSuccess({ botName, isolated: true });
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

        do {
            const dexbotArgs = buildDexbotStartArgs(botName);

            const botProcess = spawn(process.execPath, dexbotArgs, {
                cwd: ROOT,
                env: process.env,
                stdio: isMonolithicBgChild ? 'pipe' : 'inherit',
            });
            botProcessRef.current = botProcess;

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
                    printLauncherSuccess({ botName });
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

        cancelUpdateScheduler();
    } finally {
        if (!isDetachedSupervisorChild && !daemonReleased) {
            await controller.stopManagedDaemon();
        }
    }
}

async function handleControl({ cmd, target }: { cmd: string; target?: string }) {
    // Try monolithic PID file first for stop/status/shutdown (no bot target)
    if ((cmd === 'stop' || cmd === 'shutdown' || cmd === 'status') && !target && fs.existsSync(MONOLITHIC_PID_FILE)) {
        let pid = 0;
        try {
            const raw = fs.readFileSync(MONOLITHIC_PID_FILE, 'utf8').trim();
            pid = Number(raw);
            if (!Number.isInteger(pid) || pid <= 0) pid = 0;
        } catch (_) {
            try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
        }

        if (pid > 0) {
            try {
                process.kill(pid, 0);
            } catch (_) {
                console.log('Monolithic bot not running (stale PID file)');
                try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
                return;
            }

            if (cmd === 'status') {
                console.log(`Monolithic bot running (PID: ${pid})`);
                return;
            }

            try {
                process.kill(pid, 'SIGTERM');
                console.log('Stop signal sent to monolithic bot');
                const started = Date.now();
                while (Date.now() - started < 5000) {
                    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 200)); } catch (_) { break; }
                }
            } catch (err: any) {
                if (err.code !== 'ESRCH') throw err;
            } finally {
                try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {}
            }
            return;
        }
    }

    // No monolithic PID file or target-specific control — fall through to isolated supervisor socket
    const controlCmd: any = { cmd };
    if (target) controlCmd.bot = target;

    try {
        const resp = await sendControlCommand(controlCmd);
        if (resp.ok && resp.status) {
            printControlStatus(resp.status);
        } else {
            console.log('OK');
        }
    } catch (err: any) {
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

// Run if called directly or via the root-level unlock-start.js shim
const isUnlockStartDirectRun = require.main === module || (
    process.argv[1] &&
    path.parse(process.argv[1]).name === 'unlock-start'
);
if (isUnlockStartDirectRun) {
    setupGracefulShutdown();
    if (process.env.DEXBOT_ISOLATED_CHILD === '1') {
        registerCleanup('Credential daemon', () => stopCredentialDaemonPid(process.env.DEXBOT_MANAGED_CRED_PID as string));
    } else if (process.env.DEXBOT_MONOLITHIC_BG === '1') {
        registerCleanup('PID file', () => { try { fs.unlinkSync(MONOLITHIC_PID_FILE); } catch (_) {} });
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
            console.error('unlock-start failed:', err.message || err);
            process.exitCode = 1;
        }
    })();
}

export = {
    buildDexbotStartArgs,
    buildUnlockStartArgs,
    main,
    waitForChildSpawn,
    waitForStableChildStartup,
};
