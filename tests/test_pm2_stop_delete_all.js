const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 stop/delete all tests');

const pm2Path = require.resolve('../pm2');
const botSettingsPath = require.resolve('../modules/bot_settings');

const originalPm2Module = require.cache[pm2Path];
const originalBotSettings = require.cache[botSettingsPath];
const originalSpawn = childProcess.spawn;
const originalExistsSync = fs.existsSync;
const originalWarn = console.warn;

const calls = [];
const warnings = [];

function installStubs() {
    delete require.cache[pm2Path];
    setCachedModule(botSettingsPath, {
        loadSettingsFile: () => {
            throw new Error('malformed bots.json');
        },
        selectActiveBotEntries: () => [],
    });

    childProcess.spawn = (_command, args) => {
        calls.push(args);
        const child = {
            stdout: { on() {} },
            stderr: { on() {} },
            on(event, cb) {
                if (event === 'close') process.nextTick(() => cb(0));
                return child;
            },
        };
        return child;
    };

    fs.existsSync = (targetPath) => {
        if (String(targetPath).endsWith('profiles/ecosystem.config.js')) return false;
        if (String(targetPath).endsWith('profiles/bots.json')) return true;
        if (String(targetPath).endsWith('profiles/logs')) return true;
        return originalExistsSync(targetPath);
    };

    console.warn = (message) => warnings.push(String(message));
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    console.warn = originalWarn;

    restoreCachedModule(botSettingsPath, originalBotSettings);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

installStubs();

const { deletePM2Processes, stopPM2Processes } = require('../pm2');

(async () => {
    try {
        await stopPM2Processes('all');
        await deletePM2Processes('all');

        assert.deepStrictEqual(
            calls.map((args) => [args[0], args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['delete', 'dexbot-cred'],
            ],
            'all-target stop/delete should still act on dexbot-cred when bots.json is malformed'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot stop')),
            'stop all should warn when managed bot config regeneration fails'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot delete')),
            'delete all should warn when managed bot config regeneration fails'
        );

        console.log('PM2 stop/delete all tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        restoreStubs();
    }
})();
