#!/usr/bin/env node

/**
 * unlock-start.js - Credential Daemon Launcher
 * 
 * Starts credential daemon with master password and launches the bot process.
 * Use --claw-only to run credential daemon only, without bot startup.
 * 
 * Usage:
 *   node unlock-start [botName]
 *   node unlock-start --claw-only
 */

process.umask(0o077);

const { spawn } = require('child_process');
const { createCredentialDaemonController } = require('./modules/launcher/credential_daemon');
const { parseUnlockStartArgs } = require('./modules/launcher/launch_modes');
const { registerCleanup, setupGracefulShutdown } = require('./modules/graceful_shutdown');

const ROOT = __dirname;
const controller = createCredentialDaemonController({ root: ROOT });

function forwardSignal(child, signal) {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err) {
    }
}

function printLauncherHeader({ botName = null, clawOnly = false } = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 Unlock-Start Launcher');
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

function printLauncherSuccess({ botName = null, clawOnly = false } = {}) {
    console.log();
    console.log('='.repeat(50));
    if (clawOnly) {
        console.log('DEXBot2 credential daemon started successfully!');
        console.log('If the daemon stops, rerun `node unlock-start --claw-only` to unlock it again.');
    } else if (botName) {
        console.log('DEXBot2 started successfully!');
        console.log(`If the bot stops, rerun \`node unlock-start ${botName}\` to unlock it again.`);
    } else {
        console.log('DEXBot2 started successfully!');
        console.log('If the bot stops, rerun `node unlock-start` to unlock it again.');
    }
    console.log('='.repeat(50));
    console.log();
}

function waitForChildSpawn(child) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const handleSpawn = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };

        const handleError = (error) => {
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

/**
 * Main entry point.
 * Starts daemon, then launches bot process with stdio inheritance.
 * Forwards SIGINT/SIGTERM to bot, and cleans up daemon on exit.
 * 
 * @private
 * @returns {Promise<void>}
 */
async function main({ argv = process.argv } = {}) {
    const { botName, clawOnly } = parseUnlockStartArgs(argv);

    try {
        printLauncherHeader({ botName, clawOnly });
        const unlockedNow = await controller.ensureCredentialDaemon();
        if (unlockedNow) {
            console.log('✓ Authentication successful');
        }

        if (clawOnly) {
            printLauncherSuccess({ clawOnly });
            const exitCode = await controller.waitForManagedDaemon();
            process.exitCode = exitCode || 0;
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
            botProcess.on('close', (code) => resolve(code));
        });
        process.exitCode = exitCode || 0;
    } finally {
        await controller.stopManagedDaemon();
    }
}

function buildDexbotStartArgs(botName = null) {
    const dexbotArgs = ['dexbot.js', 'start'];
    if (botName) {
        dexbotArgs.push(botName);
    }
    return dexbotArgs;
}

if (require.main === module) {
    setupGracefulShutdown();
    registerCleanup('Credential daemon', () => controller.stopManagedDaemon());
    (async () => {
        try {
            await main();
        } catch (err) {
            console.error('unlock-start failed:', err.message || err);
            process.exitCode = 1;
        }
    })();
}

module.exports = {
    buildDexbotStartArgs,
    main,
    waitForChildSpawn,
};
