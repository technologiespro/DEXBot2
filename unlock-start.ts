#!/usr/bin/env node

/**
 * unlock-start.js - Credential Daemon Launcher
 *
 * Starts credential daemon with master password and launches the bot process.
 * Use --claw-only to run credential daemon only, without bot startup.
 * Use --isolated to run each bot in its own process with auto-restart and log files.
 *
 * Usage:
 *   node unlock-start [botName]
 *   node unlock-start --claw-only
 *   node unlock-start --isolated
 *   node unlock-start --isolated <botName>
 *   node unlock-start control status
 *   node unlock-start control stop <botName>
 *   node unlock-start control restart <botName>
 *   node unlock-start control stop-all
 *   node unlock-start control restart-all
 *   node unlock-start control shutdown
 */

process.umask(0o077);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCredentialDaemonController } = require('./modules/launcher/credential_daemon');
const { buildScopedChildEnv } = require('./modules/launcher/child_env');
const { parseUnlockStartArgs } = require('./modules/launcher/launch_modes');
const { buildRuntimeScriptArgs } = require('./modules/launcher/runtime_entry');
const { createBotSupervisor, SOCKET_PATH } = require('./modules/launcher/bot_supervisor');
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

function forwardSignal(child: any, signal: any) {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err) {
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
} = {}) {
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

    process.on('SIGINT', () => supervisor.shutdownSignalHandler('SIGINT'));
    process.on('SIGTERM', () => supervisor.shutdownSignalHandler('SIGTERM'));
    process.on('SIGUSR1', () => supervisor.printStatusSummary());
    process.on('SIGUSR2', () => supervisor.restartRunning());

    if (stayResident) {
        return new Promise(() => {});
    }

    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            const status = supervisor.getStatus();
            const running = Object.values(status).some(
                (s: any) => s.status === 'running' || s.status === 'restarting' || s.status === 'starting'
            );
            if (!running && !supervisor.hasUserStopped()) {
                clearInterval(interval);
                await supervisor.shutdown();
                resolve(0);
            }
        }, 1000);
    });
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
            try {
                await sendControlCommand({ cmd: 'status' });
                finish(resolve, true);
            } catch (_) {
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

    if (parsed.control) {
        await handleControl(parsed.control);
        return;
    }

    const { botName, clawOnly, isolated } = parsed;
    const selectedBot = botName ? resolveBotEntryForName(botName) : null;

    try {
        if (botName && !selectedBot) {
            throw new Error(`Bot '${botName}' not found in bots.json`);
        }

        if (!isDetachedSupervisorChild) {
            printLauncherHeader({ botName, clawOnly, isolated });
            const unlockedNow = await controller.ensureCredentialDaemon({ detached: isolated && !forceForegroundIsolated });
            if (unlockedNow) {
                console.log('✓ Authentication successful');
            }
        } else if (!(await controller.isDaemonReady())) {
            throw new Error('credential daemon is not ready for isolated supervisor startup');
        }

        if (clawOnly) {
            printLauncherSuccess({ clawOnly });
            const exitCode = await controller.waitForManagedDaemon();
            process.exitCode = exitCode || 0;
            return;
        }

        if (isolated) {
            if (isDetachedSupervisorChild || forceForegroundIsolated) {
                process.exitCode = (await runIsolated({
                    botName,
                    botEntry: selectedBot,
                    stayResident: isDetachedSupervisorChild,
                    startupGraceMs,
                })) as any;
                return;
            }

            const supervisorPid = await launchDetachedSupervisor({
                botName,
                credentialDaemonPid: controller.getManagedDaemonPid(),
            });
            controller.releaseManagedDaemon();
            printLauncherSuccess({ botName, isolated: true });
            console.log(`Supervisor PID: ${supervisorPid}`);
            console.log(`Control socket: ${process.env.DEXBOT_SUPERVISOR_SOCKET || SOCKET_PATH}`);
            console.log(`Supervisor logs: ${SUPERVISOR_OUT_LOG}`);
            process.exitCode = 0;
            return;
        }

        const dexbotArgs = buildDexbotStartArgs(botName);

        const botProcess = spawn(process.execPath, dexbotArgs, {
            cwd: ROOT,
            env: process.env,
            stdio: 'inherit',
        });

        await waitForStableChildStartup(botProcess, { label: 'DEXBot', timeoutMs: startupGraceMs });
        printLauncherSuccess({ botName });

        process.on('SIGINT', () => forwardSignal(botProcess, 'SIGINT'));
        process.on('SIGTERM', () => forwardSignal(botProcess, 'SIGTERM'));

        const exitCode = await new Promise((resolve, reject) => {
            botProcess.on('error', reject);
            botProcess.on('close', (code: any) => resolve(code));
        });
        process.exitCode = (exitCode as any) || 0;
    } finally {
        if (!isDetachedSupervisorChild) {
            await controller.stopManagedDaemon();
        }
    }
}

async function handleControl({ cmd, target }: { cmd: string; target?: string }) {
    const controlCmd: any = {
        cmd,
    };
    if (target) {
        controlCmd.bot = target;
    }

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
    path.basename(process.argv[1]).replace(/\.js$/, '') === 'unlock-start'
);
if (isUnlockStartDirectRun) {
    setupGracefulShutdown();
    if (process.env.DEXBOT_ISOLATED_CHILD === '1') {
        registerCleanup('Credential daemon', () => stopCredentialDaemonPid(process.env.DEXBOT_MANAGED_CRED_PID as string));
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
