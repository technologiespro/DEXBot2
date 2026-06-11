const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 single-target output tests');

const pm2Path = require.resolve('../pm2');
const botSettingsPath = require.resolve('../modules/bot_settings');
const botsFileLockPath = require.resolve('../modules/bots_file_lock');
const chainKeysPath = require.resolve('../modules/chain_keys');

const originalPm2Module = require.cache[pm2Path];
const originalBotSettings = require.cache[botSettingsPath];
const originalBotsFileLock = require.cache[botsFileLockPath];
const originalChainKeys = require.cache[chainKeysPath];
const originalSpawn = childProcess.spawn;
const originalLog = console.log;
const originalError = console.error;

const targetBot = 'XRP-BTS';
const logs: any[] = [];
const errors: any[] = [];
const spawnCalls: any[] = [];

function makePm2Child() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
}

function emitChunks(child, chunks) {
    process.nextTick(() => {
        for (const chunk of chunks) {
            child.stdout.emit('data', chunk);
        }
        child.emit('close', 0);
    });
}

function resetCaptured() {
    logs.length = 0;
    errors.length = 0;
    spawnCalls.length = 0;
}

function installStubs() {
    delete require.cache[pm2Path];

    setCachedModule(botSettingsPath, {
        selectActiveBotEntries: (config) => (config && Array.isArray(config.bots) ? config.bots.filter((bot) => bot.active !== false) : []),
    });

    setCachedModule(botsFileLockPath, {
        readBotsFileWithLock: async () => ({
            config: {
                bots: [
                    { name: targetBot, active: true },
                ],
            },
        }),
    });

    setCachedModule(chainKeysPath, {
        isDaemonReady: () => true,
        isDaemonResponsive: async () => true,
        authenticate: async () => 'unused',
        waitForDaemon: async () => {},
    });

    childProcess.spawn = (_command, args) => {
        spawnCalls.push(args);
        const child = makePm2Child();
        const action = args[0];
        const target = String(args[1] || '');

        if (target === targetBot) {
            const actionVerb = {
                stop: 'stopProcessId',
                delete: 'deleteProcessId',
                restart: 'restartProcessId',
                reload: 'reloadProcessId',
            }[action];

            emitChunks(child, [
                `[PM2] Applying action ${actionVerb} on app [${targetBot}](ids: [ 63 ])\n`,
                `[PM2] [${targetBot}](63) ✓\n[PM2] Done.\n`,
                '┌────┬────────────────┬──────────┐\n│ id │ name           │ status   │\n└────┴────────────────┴──────────┘\n',
            ]);
            return child;
        }

        process.nextTick(() => child.emit('close', 0));
        return child;
    };

    console.log = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
    };

    console.error = (...args) => {
        errors.push(args.map((part) => String(part)).join(' '));
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    console.log = originalLog;
    console.error = originalError;

    restoreCachedModule(botSettingsPath, originalBotSettings);
    restoreCachedModule(botsFileLockPath, originalBotsFileLock);
    restoreCachedModule(chainKeysPath, originalChainKeys);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

installStubs();

const {
    deletePM2Processes,
    restartPM2Processes,
    stopPM2Processes,
} = require('../pm2');

(async () => {
    try {
        resetCaptured();
        await stopPM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Stopping PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' stopped.`,
            ],
            'single-target stop should emit compact PM2 output without table noise'
        );
        assert.deepStrictEqual(errors, [], 'single-target stop should not write stderr on success');
        assert.deepStrictEqual(spawnCalls.map((args) => [args[0], args[1]]), [['stop', targetBot]], 'single-target stop should only invoke pm2 stop for the bot');

        resetCaptured();
        await deletePM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Deleting PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' deleted.`,
            ],
            'single-target delete should emit compact PM2 output without the config advisory'
        );
        assert.deepStrictEqual(errors, [], 'single-target delete should not write stderr on success');
        assert.deepStrictEqual(spawnCalls.map((args) => [args[0], args[1]]), [['delete', targetBot]], 'single-target delete should only invoke pm2 delete for the bot');

        resetCaptured();
        await restartPM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Restarting PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' restarted.`,
            ],
            'single-target restart should emit compact PM2 output without helper noise when dexbot-cred is already ready'
        );
        assert.deepStrictEqual(errors, [], 'single-target restart should not write stderr on success');
        assert.deepStrictEqual(spawnCalls.map((args) => [args[0], args[1]]), [['restart', targetBot]], 'single-target restart should only invoke pm2 restart for the bot when dexbot-cred is already ready');

        restoreStubs();
        console.log('PM2 single-target output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
