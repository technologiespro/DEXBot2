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

function runtimeScript(...segments: string[]) {
    return path.join(CODE_ROOT, ...segments);
}

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
    const dexbotArgs = [runtimeScript('dexbot.js'), 'start'];
    if (botName) {
        dexbotArgs.push(botName);
    }
    return dexbotArgs;
}

async function runIsolated({ botName, stayResident = false }: { botName?: string; stayResident?: boolean } = {}) {
    let supervisor;

    if (botName) {
        const bot = resolveBotEntryForName(botName);
        if (!bot) {
            console.error(`Bot '${botName}' not found in bots.json`);
            process.exitCode = 1;
            return;
        }
        supervisor = createBotSupervisor({ bots: [bot] });
    } else {
        supervisor = createBotSupervisor();
    }

    registerCleanup('Bot supervisor', () => supervisor.shutdown());

    await supervisor.start();

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

async function waitForSupervisorReady({ timeoutMs = 15000, intervalMs = 250 } = {}) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            await sendControlCommand({ cmd: 'status' });
            return true;
        } catch (_) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    return false;
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
    const args = [runtimeScript('unlock-start.js'), '--isolated'];
    let child = null;
    if (botName) {
        args.push(botName);
    }

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

        const ready = await waitForSupervisorReady();
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
async function main({ argv = process.argv } = {}) {
    const parsed = parseUnlockStartArgs(argv);
    const isDetachedSupervisorChild = process.env.DEXBOT_ISOLATED_CHILD === '1';
    const forceForegroundIsolated = process.env.DEXBOT_ISOLATED_FOREGROUND === '1';

    if (parsed.control) {
        await handleControl(parsed.control);
        return;
    }

    const { botName, clawOnly, isolated } = parsed;

    try {
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
                process.exitCode = (await runIsolated({ botName, stayResident: isDetachedSupervisorChild })) as any;
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

        await waitForChildSpawn(botProcess);
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

if (require.main === module) {
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
    main,
    waitForChildSpawn,
};
