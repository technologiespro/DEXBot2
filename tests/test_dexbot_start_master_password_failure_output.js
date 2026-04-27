const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot master password failure output tests');

const dexbotPath = require.resolve('../dexbot.js');
const botSettingsPath = require.resolve('../modules/bot_settings');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const chainKeysPath = require.resolve('../modules/chain_keys');
const gracefulShutdownPath = require.resolve('../modules/graceful_shutdown');
const systemPath = require.resolve('../modules/order/utils/system');
const accountBotsPath = require.resolve('../modules/account_bots');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

const originalDexbotModule = require.cache[dexbotPath];
const originalBotSettings = require.cache[botSettingsPath];
const originalDexbotClass = require.cache[dexbotClassPath];
const originalChainKeys = require.cache[chainKeysPath];
const originalGracefulShutdown = require.cache[gracefulShutdownPath];
const originalSystem = require.cache[systemPath];
const originalAccountBots = require.cache[accountBotsPath];
const originalBitsharesClient = require.cache[bitsharesClientPath];
const originalExistsSync = fs.existsSync;
const originalArgv = process.argv.slice();
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

const logs = [];
const errors = [];
const errorCalls = [];
const suppressCalls = [];
let exitCode = null;

function installStubs() {
    delete require.cache[dexbotPath];

    fs.existsSync = (filePath) => {
        if (String(filePath).endsWith('/profiles/bots.json')) {
            return true;
        }
        return originalExistsSync(filePath);
    };

    setCachedModule(botSettingsPath, {
        collectValidationIssues: () => ({ errors: [], warnings: [] }),
        loadSettingsFile: () => ({
            config: {
                bots: [
                    {
                        name: 'XRP-BTS',
                        active: true,
                        assetA: 'XRP',
                        assetB: 'BTS',
                        preferredAccount: 'xrp-account',
                    },
                ],
            },
        }),
        normalizeBotEntries: (entries) => entries.map((entry, index) => ({
            ...entry,
            active: entry.active !== false,
            botIndex: index,
            botKey: `bot-${index}`,
        })),
        resolveRawBotEntries: (config) => config?.bots || [],
        saveSettingsFile: () => {},
    });

    const masterPasswordError = new Error('Incorrect master password after 3 attempts.');
    masterPasswordError.name = 'MasterPasswordError';
    masterPasswordError.code = 'MASTER_PASSWORD_FAILED';

    class StubSharedDEXBot {
        constructor(config) {
            this.config = config;
        }

        async start() {
            throw masterPasswordError;
        }

        async shutdown() {}
    }
    StubSharedDEXBot.authenticateWithChainKeys = async () => {};
    StubSharedDEXBot.normalizeBotEntry = (bot, index) => ({
        ...bot,
        active: bot.active !== false,
        botIndex: index,
        botKey: `bot-${index}`,
    });

    setCachedModule(dexbotClassPath, StubSharedDEXBot);
    setCachedModule(chainKeysPath, {
        authenticate: async () => 'test-password',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        isMasterPasswordFailure: (err) => !!(err && (err.code === 'MASTER_PASSWORD_FAILED' || err.name === 'MasterPasswordError')),
    });
    setCachedModule(gracefulShutdownPath, {
        setupGracefulShutdown: () => {},
        registerCleanup: () => {},
    });
    setCachedModule(systemPath, {
        ensureProfilesDirectory: () => false,
        initializeFeeCache: async () => {},
    });
    setCachedModule(accountBotsPath, {
        main: async () => {},
    });
    setCachedModule(bitsharesClientPath, {
        BitShares: {
            disconnect: () => {},
        },
        setSuppressConnectionLog: (value) => {
            suppressCalls.push(value);
        },
        waitForConnected: async () => {},
    });

    process.argv = ['node', '/home/alex/BTS/DEXBot2/dexbot.js', 'start'];
    process.exit = (code) => {
        exitCode = code;
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        errorCalls.push(line);
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    fs.existsSync = originalExistsSync;
    process.argv = originalArgv;
    process.exit = originalProcessExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    restoreCachedModule(botSettingsPath, originalBotSettings);
    restoreCachedModule(dexbotClassPath, originalDexbotClass);
    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(gracefulShutdownPath, originalGracefulShutdown);
    restoreCachedModule(systemPath, originalSystem);
    restoreCachedModule(accountBotsPath, originalAccountBots);
    restoreCachedModule(bitsharesClientPath, originalBitsharesClient);

    if (originalDexbotModule) require.cache[dexbotPath] = originalDexbotModule;
    else delete require.cache[dexbotPath];
}

installStubs();
require('../dexbot.js');

(async () => {
    try {
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(exitCode, 1, 'dexbot start should exit with code 1 on master password failure');
        assert.ok(suppressCalls.includes(true), 'dexbot startup should suppress BitShares connection logs');
        assert.ok(suppressCalls.includes(false), 'dexbot startup should restore BitShares connection logs after startup');
        assert.ok(errorCalls.includes(''), 'dexbot start should print a blank line before the failure message');
        assert.ok(errors.includes('❌ Incorrect master password after 3 attempts.'), 'dexbot start should match the PM2-style failure output');
        assert.ok(!errors.some((line) => line.includes('Failed to start bot:')), 'dexbot start should not print the generic failure prefix');
        assert.ok(!errors.some((line) => line.includes('Aborting because the master password failed 3 times.')), 'dexbot start should not print the extra abort line');
        assert.ok(logs.includes('Connected to BitShares'), 'dexbot start should still print the connection banner before failure');

        restoreStubs();
        originalConsoleLog('dexbot master password failure output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
