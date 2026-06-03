#!/usr/bin/env node
/**
 * dexbot.js - DEXBot2 Primary CLI Driver
 *
 * Main entry point for DEXBot2 grid trading bot system.
 * Manages tracked bots and provides helper utilities (key/bot editors).
 * Creates grid-based limit orders across price ranges and auto-replaces fills.
 *
 * ===============================================================================
 * FEATURES
 * ===============================================================================
 *
 * GRID TRADING:
 * - Configurable grid spacing with geometric increments (e.g., 0.5%)
 * - Independent BUY and SELL order counts per bot
 * - Dynamic spread zone around market price
 * - Automatic order replacement when fills occur
 * - Fund allocation controls (percentage of wallet)
 * - Copy-on-Write rebalancing: Safe concurrent updates with isolated working grids
 * - Automatic grid reconciliation: Detects offline fills and syncs with blockchain
 *
 * SECURITY:
 * - Master password encryption for stored private keys (AES-256-GCM)
 * - Optional credential daemon for multi-bot key management
 * - No private keys in environment variables
 * - Per-bot configuration and state isolation
 *
 * OPERATION MODES:
 * - Live trading: Real orders on blockchain
 * - Dry-run mode: Simulate operations without broadcasting
 * - Manual control: Enable/disable/reset individual bots
 *
 * ===============================================================================
 * CLI COMMANDS
 * ===============================================================================
 *
 * TRADING OPERATIONS:
 *   node dexbot test <bot-name>      - Test-run single bot (live trading)
 *   node dexbot drystart <bot-name>  - Start bot in dry-run mode (no transactions)
 *
 * 🛠️ BOT MANAGEMENT:
 *   node dexbot reset all            - Reset all active bot grids (full regeneration)
 *   node dexbot reset <bot-name>     - Reset bot grid (full regeneration)
 *   node dexbot disable all          - Mark all bots inactive in config
 *   node dexbot disable <bot-name>   - Mark bot inactive in config
 *   node dexbot clear                - Clear all log files in profiles/logs/
 *
 * CONFIGURATION:
 *   node dexbot keys                 - Set up master password and keyring
 *   node dexbot bots                 - Interactive editor for bot definitions
 *
 * PM2 ORCHESTRATION:
 *   node dexbot pm2                  - Start all bots via PM2 with daemon
  *   node dexbot pm2 stop all         - Stop all PM2 bot processes
  *   node dexbot pm2 stop <bot-name>  - Stop specific bot
  *   node dexbot pm2 delete all       - Delete all bots from PM2
  *   node dexbot pm2 delete <bot-name>- Delete specific bot from PM2
 *   node dexbot pm2 help             - Show PM2 command help
 *
 * STATUS:
 *   node dexbot status               - Show bot runtime status (unlock monolithic/isolated or PM2)
 *
 * MAINTENANCE:
 *   node dexbot update               - Update to latest version (pull + install + restart)
 *   node dexbot export <bot-name>    - Export trading history to CSV/JSON for QTradeX
 *   node dexbot order                - Analyze persisted order grids in profiles/orders/
 *   node dexbot help                 - Show this help message
 *
 * NPM SCRIPTS (alternative invocation):
 *   npm run pm2:start                - Start bots (requires ecosystem.config.js pre-generated)
 *   npm run pm2:stop                 - Stop all PM2 bots
 *
 * ===============================================================================
 * CONFIGURATION
 * ===============================================================================
 *
 * Bots:  profiles/bots.json
 * Keys:  profiles/keys.json (gitignored, encrypted)
 * State: profiles/orders/{botKey}.json (per-bot grid snapshots)
 * Logs:  profiles/logs/{botname}.log (managed by PM2)
 *
 * ===============================================================================
 */
const { BitShares, waitForConnected, setSuppressConnectionLog } = require('./modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const chainKeys = require('./modules/chain_keys');
const { initializeFeeCache, ensureProfilesDirectory, readInput } = require('./modules/order/utils/system');
const accountBots = require('./modules/account_bots');
const SharedDEXBot = require('./modules/dexbot_class');

const { setupGracefulShutdown, registerCleanup, unregisterCleanup } = require('./modules/graceful_shutdown');
const {
    collectValidationIssues,
    loadSettingsFile,
    normalizeBotEntries,
    resolveRawBotEntries,
    saveSettingsFile,
} = require('./modules/bot_settings');
const { buildRuntimeScriptArgs } = require('./modules/launcher/runtime_entry');

// Setup graceful shutdown handlers
setupGracefulShutdown();

// Note: accountOrders is now per-bot only. Each bot has its own AccountOrders instance
// created in DEXBot.start() in modules/dexbot_class.js. This eliminates shared-file race conditions.

// Primary CLI driver that manages tracked bots and helper utilities such as key/bot editors.
const ROOT = path.basename(__dirname) === 'dist' ? path.dirname(__dirname) : __dirname;
const PROFILES_BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(ROOT, 'profiles');


const CLI_COMMANDS = ['start', 'test', 'reset', 'disable', 'drystart', 'keys', 'bots', 'pm2', 'update', 'export', 'order', 'clear', 'status', 'whitelist', 'unlock'];
const COMMAND_ALIASES: Record<string, string> = { orders: 'order', key: 'keys', bot: 'bots', white: 'whitelist', stat: 'status', start: 'test' };
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Test-run a bot from the tracked config', command: 'dexbot test bot-name', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart bot-name', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Disable a bot in config', command: 'dexbot disable bot-name', notes: 'Marks the bot inactive in config.' },
    { title: 'Reset all active bot grids', command: 'dexbot reset all', notes: 'Triggers full grid regeneration for every active bot.' },
    { title: 'Reset a bot grid', command: 'dexbot reset bot-name', notes: 'Triggers a full grid regeneration for the named bot.' },
    { title: 'Manage keys', command: 'dexbot key', notes: 'Runs modules/chain_keys.js to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bot', notes: 'Launches the interactive modules/account_bots.js helper for the JSON config.' },
    { title: 'Start bots with PM2', command: 'dexbot pm2', notes: 'Generates ecosystem config, authenticates, and starts PM2.' },
    { title: 'Update DEXBot2', command: 'node dexbot update', notes: 'Fetches latest code, updates dependencies, and restarts PM2.' },
    { title: 'Export bot trades for QTradeX', command: 'dexbot export bot-name', notes: 'Exports trading history and settings to CSV/JSON for backtesting.' },
    { title: 'Analyze persisted order grids', command: 'dexbot order', notes: 'Runs the order analyzer across profiles/orders/ and prints spread/increment/funds/distribution metrics.' },
    { title: 'Clear all bot log files', command: 'dexbot clear', notes: 'Runs scripts/clear-logs.sh to remove log files from profiles/logs/.' }
];
const cliArgs = process.argv.slice(2);

/**
 * Show the CLI usage/help text when requested or upon invalid commands.
 */
function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot-name]');
    console.log('Commands:');
    console.log('  test <bot>        Test-run the named bot (one-shot, live trading).');
    console.log('  start <bot>       Alias for test (legacy).');
    console.log('  drystart <bot>    Same as test but forces dry-run execution.');
    console.log('  reset all         Trigger grid resets for all active bots.');
    console.log('  reset <bot>       Trigger a grid reset (auto-reloads if running, or applies on next start).');
    console.log('  disable all       Mark all bots inactive in config.');
    console.log('  disable <bot>     Mark the bot inactive in config.');
    console.log('  export <bot>      Export bot trades and settings for QTradeX backtesting.');
    console.log('  key               Launch the chain key helper (modules/chain_keys.js).');
    console.log('  bot               Launch the interactive bot configurator (modules/account_bots.js).');
    console.log('  pm2               Start all active bots with PM2 (authenticate + generate config + start).');
    console.log('  update            Update DEXBot2 from the repository and restart active bots.');
    console.log('  order             Analyze persisted order grids in profiles/orders/ (spread, increment, funds).');
    console.log('  status, stat      Show bot runtime status (unlock monolithic/isolated or PM2).');
    console.log('  unlock            Run credential daemon + bot (equivalent to `node unlock`).');
    console.log('  whitelist, white  Generate market adapter whitelist from AMA bot configs.');
    console.log('  clear             Remove all log files from profiles/logs/ (runs scripts/clear-logs.sh).');
    console.log('Options:');
    console.log('  --cli-examples    Print curated CLI snippets.');
    console.log('  -h, --help        Show this help text.');
    console.log('Envs: OPEN_ORDERS_SYNC_LOOP_MS controls the open-orders sync polling delay; LIVE_BOT_NAME or BOT_NAME selects a single entry.');
}

/**
 * Print curated CLI snippets for quick reference.
 */
function printCLIExamples() {
    console.log('CLI Examples:');
    CLI_EXAMPLES.forEach((example, index) => {
        console.log(`${index + 1}. ${example.title}`);
        console.log(`   ${example.command}`);
        if (example.notes) console.log(`   ${example.notes}`);
    });
    console.log(`Read the README "CLI usage" section for more details (file: ${PROFILES_BOTS_FILE}).`);
}

if (cliArgs.some(arg => CLI_HELP_FLAGS.includes(arg))) {
    printCLIUsage();
    process.exit(0);
}

if (cliArgs.includes(CLI_EXAMPLES_FLAG)) {
    printCLIExamples();
    process.exit(0);
}

// Connection handled centrally by modules/bitshares_client; use waitForConnected() when needed

/**
 * DEXBot - Core trading bot class that manages grid-based market making
 *
 * Responsibilities:
 * - Initializes connection to BitShares and authenticates account
 * - Creates and manages an OrderManager instance for grid operations
 * - Places initial orders and listens for fills to replace them
 * - Handles grid synchronization with on-chain state
 * - Supports dry-run mode for testing without broadcasting
 *
 * @class
 */
// Extend SharedDEXBot for dexbot.js context (currently just a thin wrapper)
class DEXBot extends SharedDEXBot {
    constructor(config: any) {
        super(config, { logPrefix: '' });
    }
}

// Register BitShares cleanup on shutdown
registerCleanup('BitShares connection', () => {
    try {
        BitShares.disconnect();
    } catch (err) {
        // BitShares may already be disconnected
    }
});

// Track attempts to prevent infinite loops while allowing retries after key setup
let keySetupInProgress = false;

/**
 * Launch the account key manager helper.
 * @param {Object} [options={}] - Manager options.
 * @param {boolean} [options.waitForConnection=false] - Whether to wait for BitShares connection.
 * @param {boolean} [options.exitAfter=false] - Whether to exit the process after completion.
 * @param {boolean} [options.disconnectAfter=false] - Whether to disconnect BitShares after completion.
 * @returns {Promise<void>}
 */
async function runAccountManager({ waitForConnection = false, exitAfter = false, disconnectAfter = false } = {}) {
     if (waitForConnection) {
         try {
             await waitForConnected();
         } catch (err) {
             console.warn('Timed out waiting for BitShares connection before launching key manager.');
         }
     }

     let succeeded = false;
     try {
         await chainKeys.main();
         succeeded = true;
     } finally {
         if (disconnectAfter) {
             try {
                 BitShares.disconnect();
    } catch (err: any) {
        console.warn('Failed to disconnect BitShares connection after key manager exited:', err.message || err);
    }
         }
     }

     if (exitAfter && succeeded) {
         process.exit(0);
     }
 }

 /**
  * Handle master password authentication with auto-launch fallback.
  * If no master password is set, automatically launches the key manager
  * to guide the user through initial setup.
  * @returns {Promise<string>} The authenticated master password
  */
async function authenticateMasterPassword() {
    try {
        return await chainKeys.authenticate();
    } catch (err: any) {
        if (!keySetupInProgress && err && err.message && err.message.includes('No master password set')) {
            keySetupInProgress = true;
            try {
                await runAccountManager();
                keySetupInProgress = false;
                return await chainKeys.authenticate();
            } catch (setupErr) {
                keySetupInProgress = false;
                 throw setupErr;
             }
         }
        throw err;
    }
}

function printStartLauncherHeader({ botName = null, dryRun = false } = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 Start Launcher');
    if (botName) {
        console.log(`Starting bot: ${botName}`);
    } else {
        console.log('Starting all bots');
    }
    if (dryRun) {
        console.log('Dry-run mode enabled');
    }
    console.log('='.repeat(50));
    console.log();
}

function printStartLauncherSuccess({ botName = null, dryRun = false } = {}) {
    const command = dryRun ? 'drystart' : 'test';
    const target = botName ? ` ${botName}` : '';
    console.log();
    console.log('='.repeat(50));
    console.log('DEXBot2 started successfully!');
    if (botName) {
        console.log(`If the bot stops, rerun \`node dexbot ${command}${target}\` to start it again.`);
    } else {
        console.log(`If the bots stop, rerun \`node dexbot ${command}\` to start them again.`);
    }
    console.log('='.repeat(50));
    console.log();
}

function printMasterPasswordFailure(err: any) {
    console.error();
    console.error(`❌ ${err.message}`);
}

/**
 * Execute the provided bot entries after validation and authentication.
 * This is the main orchestration function that:
 * 1. Validates all bot configurations
 * 2. Prompts for master password if any bot needs it
 * 3. Creates DEXBot instances and starts them
 *
 * @param {Array} botEntries - Array of normalized bot configurations
 * @param {Object} [options] - Execution options
 * @param {boolean} [options.forceDryRun=false] - Force all bots into dry-run mode
 * @param {string} [options.sourceName='settings'] - Source label for logging
 * @param {Object} [options.launcherStyle=null] - Launcher presentation options
 * @returns {Promise<Array>} Array of started DEXBot instances
 */
async function runBotInstances(botEntries: any[], { forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: any } = {}) {
    setSuppressConnectionLog(true);

    const shouldAnnounceLauncher = !!launcherStyle;
    const launcherBotName = launcherStyle?.botName || null;
    const launcherDryRun = !!launcherStyle?.dryRun;
    let connectionAnnounced = false;
    let authenticationAnnounced = false;
    const activeCount = (botEntries || []).filter((entry: any) => entry && entry.active !== false).length;

    const announceConnection = () => {
        if (shouldAnnounceLauncher && !connectionAnnounced) {
            console.log('Connected to BitShares');
            connectionAnnounced = true;
        }
    };

    const announceAuthentication = () => {
        if (shouldAnnounceLauncher && !authenticationAnnounced) {
            console.log('✓ Authentication successful');
            authenticationAnnounced = true;
        }
    };

    try {
        if (shouldAnnounceLauncher) {
            printStartLauncherHeader({ botName: launcherBotName, dryRun: launcherDryRun });
        }

        if (!botEntries.length) {
            console.log(`No bot entries were found in ${sourceName}.`);
            return [];
        }

        const prepared = botEntries.map((entry: any) => ({
            ...entry,
            dryRun: forceDryRun ? true : entry.dryRun,
        }));

        // Note: ensureBotEntries is no longer needed here. Each bot creates its own AccountOrders
        // instance with per-bot file when it starts, eliminating the need for shared initialization.

        const { errors } = collectValidationIssues(prepared, sourceName);

        if (errors.length) {
            console.error('ERROR: Invalid configuration for one or more **active** bots:');
            errors.forEach((e: any) => console.error('  -', e));
            console.error('Fix the configuration problems in profiles/bots.json and restart. Aborting.');
            process.exit(1);
        }

        const needMaster = prepared.some((b: any) => b.active && b.preferredAccount);
        let masterPassword = null;
        if (needMaster) {
            const daemonReady = await chainKeys.isDaemonResponsive();

            try {
                await waitForConnected();
                announceConnection();
            } catch (err) {
                // Continue; the bot startup path will retry through the normal runtime flow.
            }

            if (!daemonReady) {
                try {
                    masterPassword = await authenticateMasterPassword();
                    announceAuthentication();
                } catch (err) {
                    if (chainKeys.isMasterPasswordFailure(err)) {
                        throw err;
                    }
                    masterPassword = null;
                }
            }
        }

        // Fee cache is required for fill processing (getAssetFees), including offline fill reconciliation at startup.
        // Initialize it once per process for the assets used by active bots.
        try {
            await waitForConnected();
            announceConnection();
            await initializeFeeCache(prepared.filter((b: any) => b.active), BitShares);
        } catch (err: any) {
            console.error(`Fee cache initialization failed: ${err.message}`);
            console.error('Cannot proceed without fee cache for fill processing. Aborting.');
            process.exit(1);
        }

        if (shouldAnnounceLauncher) {
            console.log(`Number active bots: ${activeCount}`);
            console.log();
            console.log('Starting bot runtime...');
        }

        const instances = [];
        for (const entry of prepared) {
            if (!entry.active) {
                continue;
            }

            const botCleanupName = `Bot: ${entry.name || entry.botKey || instances.length + 1}`;
            let bot: any = null;
            let botCleanupHandler: (() => Promise<void>) | null = null;
            try {
                bot = new DEXBot(entry);
                botCleanupHandler = () => bot.shutdown();
                registerCleanup(botCleanupName, botCleanupHandler);
                await bot.start(masterPassword);
                instances.push(bot);
            } catch (err: any) {
                // The bot's _runStartupSequence already invoked shutdown() once on
                // the failure path. Remove the registered cleanup so the LIFO
                // cleanup loop in graceful_shutdown.js does not call shutdown() a
                // second time, and avoid the "double graceful shutdown" log pattern.
                if (botCleanupHandler) {
                    unregisterCleanup(botCleanupHandler);
                }
                // Attempt graceful cleanup before continuing. Idempotent via the
                // _shutdownStarted guard, so a redundant call is a no-op.
                if (bot) {
                    try {
                        await bot.shutdown();
                    } catch (shutdownErr: any) {
                        console.error(`Error during cleanup: ${shutdownErr.message}`);
                    }
                }
                if (chainKeys.isMasterPasswordFailure(err)) {
                    printMasterPasswordFailure(err);
                    process.exit(1);
                    return;
                }
                console.error('Failed to start bot:', err.message);
                if (err && err.message && String(err.message).toLowerCase().includes('marketprice')) {
                    console.info('Hint: startPrice could not be derived.');
                    console.info(' - If using profiles/bots.json with "pool" or "book" signals, ensure the chain contains a matching liquidity pool or orderbook for the configured pair.');
                    console.info(' - Alternatively, set a numeric `startPrice` directly in profiles/bots.json for this bot to avoid auto-derive.');
                    console.info(' - You can also set LIVE_BOT_NAME or BOT_NAME to select a different bot from the profiles settings.');
                }
            }
        }

        if (instances.length === 0) {
            console.log('No active bots were started. Check bots.json and ensure at least one bot is active.');
            return instances;
        }

        if (shouldAnnounceLauncher) {
            printStartLauncherSuccess({ botName: launcherBotName, dryRun: launcherDryRun });
        }

        return instances;
    } finally {
        setSuppressConnectionLog(false);
    }
}

/**
 * Start a specific bot by name or all active bots if no name provided.
 * Looks up the bot in profiles/bots.json and starts it.
 * @param {string|null|undefined} botName - Name of the bot to start, or null/undefined for all active
 * @param {Object} [options] - Start options
 * @param {boolean} [options.dryRun=false] - Run in dry-run mode (no broadcasts)
 */
async function startBotByName(botName: string | null | undefined, { dryRun = false }: { dryRun?: boolean } = {}) {
    if (!botName) {
        return runDefaultBots({
            forceDryRun: dryRun,
            sourceName: dryRun ? 'CLI drystart (all)' : 'CLI start (all)',
            launcherStyle: { botName: null, dryRun },
        });
    }
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    if (!entries.length) {
        console.error('No bot definitions exist in the tracked settings.');
        process.exit(1);
    }
    const match = entries.find((b: any) => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' in the tracked settings.`);
        process.exit(1);
    }
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    if (dryRun) entryCopy.dryRun = true;
    const normalized = normalizeBotEntries([entryCopy]);
    await runBotInstances(normalized, {
        forceDryRun: dryRun,
        sourceName: dryRun ? 'CLI drystart' : 'CLI start',
        launcherStyle: { botName, dryRun },
    });
}

/**
 * Mark a bot (or all bots) as inactive in profiles/bots.json.
 * Note: This only updates the config file; running processes must be
 * stopped separately using pm2.js or Ctrl+C.
 * @param {string|null|undefined} botName - Name of the bot to disable, or null/undefined for all
 */
async function disableBotByName(botName: string | null | undefined) {
    const { config, filePath } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    if (!botName) {
        let updated = false;
        entries.forEach((entry: any) => {
            if (entry.active) {
                entry.active = false;
                updated = true;
            }
        });
        if (!updated) {
            console.log('No active bots were found to disable.');
            return;
        }
        saveSettingsFile(config, filePath);
        console.log(`Marked all bots inactive in ${path.basename(filePath)}.`);
        return;
    }
    const match = entries.find((b: any) => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' to disable.`);
        process.exit(1);
    }
    if (!match.active) {
        console.log(`Bot '${botName}' is already inactive.`);
        return;
    }
    match.active = false;
    saveSettingsFile(config, filePath);
    console.log(`Marked '${botName}' inactive in ${path.basename(filePath)}. Stop the PM2 process using 'node pm2 stop ${botName}'.`);
}

/**
 * Reset a bot by regenerating its grid and starting it fresh.
 * This method creates a trigger file that signals the bot instance
 * (whether running locally or via PM2) to perform a full grid resync.
 *
 * 1. Creates profiles/recalculate.<botKey>.trigger
 * 2. If bot is running, it detects file -> resyncs grid -> deletes file
 * 3. If bot is stopped, it detects file on startup -> resyncs grid -> deletes file
 *
 * @param {string|null|undefined} botName - Name of the bot to reset, or null/undefined for all active
 */
async function resetBotByName(botName: string | null | undefined) {
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = normalizeBotEntries(resolveRawBotEntries(config));

    // Filter targets
    const targets = botName ? entries.filter((b: any) => b.name === botName) : entries.filter((b: any) => b.active);
    if (botName && targets.length === 0) {
        console.error(`Could not find any bot named '${botName}' to reset.`);
        process.exit(1);
    }

    console.log(`Setting regeneration trigger for ${targets.length} bot(s)...`);

    for (const bot of targets) {
        try {
            const triggerFile = path.join(PROFILES_DIR, `recalculate.${bot.botKey}.trigger`);
            fs.writeFileSync(triggerFile, '');
            console.log(`✓ Trigger set for '${bot.name}' (${path.basename(triggerFile)})`);
        } catch (err: any) {
            console.warn(`Failed to set trigger for '${bot.name}': ${err.message}`);
        }
    }

    console.log();
    console.log('Action complete.');
    console.log('- If the bot is running (CLI or PM2), it will detect the trigger and reset automatically.');
    console.log('- If the bot is stopped, the grid will be regenerated the next time you run `dexbot test`.');
}

/**
 * Export bot trading history and settings for QTradeX
 * @param {string|undefined} botName - Bot name; may be undefined from CLI when no target provided to export
 */
async function exportBotTrades(botName: string | undefined) {
    if (!botName) {
        console.error('Please specify a bot name: dexbot export <bot-name>');
        process.exit(1);
    }

    try {
        const exporter = require('./modules/order/export');

        // Load bots configuration
        const { config: botsData } = loadSettingsFile(PROFILES_BOTS_FILE);
        const bot = resolveRawBotEntries(botsData).find((b: any) => b.name === botName);

        if (!bot) {
            console.error(`Bot '${botName}' not found in profiles/bots.json`);
            process.exit(1);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Exporting bot: ${botName}`);
        console.log(`${'='.repeat(60)}\n`);

        // Create bot key from bot name (lowercase, replace spaces with hyphens)
        const botKey = botName.toLowerCase().replace(/\s+/g, '-');

        // Export trades and settings
        const result = await exporter.exportBotTrades(botKey, bot, './exports');

        if (result.success) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`✓ Export successful!`);
            console.log(`${'='.repeat(60)}`);
            console.log(`Bot:              ${botName}`);
            console.log(`Trades exported:  ${result.trades_exported}`);
            console.log(`CSV file:         ${result.csv_path}`);
            console.log(`Settings file:    ${result.settings_path}`);
            console.log(`Output directory: ${result.output_dir}`);
            console.log(`Timestamp:        ${result.timestamp}`);
            console.log(`\nYou can now use these files with QTradeX for backtesting.\n`);
        } else {
            console.error(`\n✗ Export failed: ${result.error || 'Unknown error'}\n`);
            process.exit(1);
        }
    } catch (err: any) {
        console.error(`\nExport error: ${err.message}\n`);
        process.exit(1);
    }
}

/**
 * Parse and execute CLI commands.
 * Supported commands: start, drystart, reset, disable, key, bot, pm2, update, export
 * @returns {Promise<boolean>} True if a command was handled, false otherwise
 */
async function handleCLICommands() {
    if (!cliArgs.length) return false;
    const [rawCommand, target] = cliArgs;
    const command = COMMAND_ALIASES[rawCommand] ?? rawCommand;
    if (!CLI_COMMANDS.includes(command)) {
        console.error(`Unknown command '${command}'.`);
        printCLIUsage();
        process.exit(1);
    }
    switch (command) {
        case 'test':
            await startBotByName(target, { dryRun: false });
            return true;
        case 'drystart':
            await startBotByName(target, { dryRun: true });
            return true;
        case 'reset':
            if (!target) {
                console.error('Error: Target required. Specify "all" or a bot name.');
                printCLIUsage();
                process.exit(1);
            }
            await resetBotByName(target === 'all' ? null : target);
            process.exit(0);
        case 'disable':
            if (!target) {
                console.error('Error: Target required. Specify "all" or a bot name.');
                printCLIUsage();
                process.exit(1);
            }
            await disableBotByName(target === 'all' ? null : target);
            process.exit(0);
        case 'keys':
            await runAccountManager({ waitForConnection: true, exitAfter: true, disconnectAfter: true });
            return true;
         case 'bots':
             setSuppressConnectionLog(true);
             try {
                 await accountBots.main();
             } finally {
                 try {
                     BitShares.disconnect();
                  } catch (err: any) {
                      console.warn('Failed to disconnect BitShares after bot helper exit:', err && err.message ? err.message : err);
                  }
             }
             process.exit(0);
             return true;
        case 'pm2':
            try {
                const pm2Launcher = require('./pm2');
                await pm2Launcher.main();
                // Close stdin and exit cleanly after PM2 startup
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } catch (err: any) {
                console.error('Error:', err.message);
                process.exit(1);
            }
            return true;
        case 'update':
            setSuppressConnectionLog(true);
            require('./scripts/update');
            return true;
        case 'export':
            setSuppressConnectionLog(true);
            await exportBotTrades(target);
            process.exit(0);
            return true;
        case 'whitelist': {
            const { spawnSync } = require('child_process');
            const result = spawnSync('npm', ['run', 'market-adapter:whitelist', ...(target ? [target] : [])], {
                cwd: ROOT,
                stdio: 'inherit',
                shell: true,
            });
            if (result.error) {
                console.error(`whitelist: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'order': {
            const { spawnSync } = require('child_process');
            const scriptArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['scripts', 'analyze-orders'],
                scriptArgs: [],
            });
            const result = spawnSync(process.execPath, scriptArgs, {
                cwd: ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`order: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'unlock': {
            const { spawnSync } = require('child_process');
            const unlockScript = path.join(ROOT, 'unlock.js');
            const unlockArgs = [unlockScript, ...cliArgs.slice(1)];
            const result = spawnSync(process.execPath, unlockArgs, {
                cwd: ROOT,
                stdio: 'inherit',
            });
            process.exit(result.status ?? 0);
            return true;
        }
        case 'clear': {
            const { spawnSync } = require('child_process');
            const clearScript = path.join(ROOT, 'scripts', 'clear-logs.sh');
            const result = spawnSync('bash', [clearScript], {
                cwd: ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`clear: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'status': {
            const { spawnSync, execSync } = require('child_process');
            const MONOLITHIC_PID_FILE = path.join(PROFILES_DIR, 'monolithic.pid');
            const SUPERVISOR_SOCK = path.join(PROFILES_DIR, 'supervisor.sock');
            let unlockRunning = false;

            if (fs.existsSync(MONOLITHIC_PID_FILE)) {
                try {
                    const pid = Number(fs.readFileSync(MONOLITHIC_PID_FILE, 'utf8').trim());
                    if (Number.isInteger(pid) && pid > 0) {
                        try { process.kill(pid, 0); unlockRunning = true; } catch (_) {}
                    }
                } catch (_) {}
            }

            if (!unlockRunning && fs.existsSync(SUPERVISOR_SOCK)) {
                unlockRunning = true;
            }

            if (unlockRunning) {
                const unlockScript = path.join(ROOT, 'unlock.js');
                const result = spawnSync(process.execPath, [unlockScript, 'status'], {
                    cwd: ROOT,
                    stdio: 'inherit',
                });
                process.exit(result.status ?? 0);
                return true;
            }

            try {
                const output = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 }).toString().trim();
                const jsonStart = output.indexOf('[');
                if (jsonStart === -1) {
                    console.log('No DEXBot2 processes running.');
                    process.exit(0);
                    return true;
                }

                const allProcs = JSON.parse(output.slice(jsonStart));
                if (!Array.isArray(allProcs) || allProcs.length === 0) {
                    console.log('No DEXBot2 processes running.');
                    process.exit(0);
                    return true;
                }

                const serviceNames = new Set(['dexbot-cred', 'dexbot-adapter', 'dexbot-update']);
                const botNames = new Set<string>();
                try {
                    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
                    const entries = resolveRawBotEntries(config);
                    for (const b of entries) {
                        if (b.name) botNames.add(b.name);
                    }
                } catch (_) {}

                const dexbotProcs = allProcs.filter((p: any) => {
                    const name = String(p?.name || '');
                    return serviceNames.has(name) || botNames.has(name);
                });

                if (dexbotProcs.length === 0) {
                    console.log('No DEXBot2 PM2 processes running.');
                    process.exit(0);
                    return true;
                }

                console.log('='.repeat(50));
                console.log('DEXBot2 PM2 Processes');
                console.log('='.repeat(50));
                console.log('');

                const fmtUptime = (p: any) => {
                    if (!p?.pm2_env?.pm_uptime) return '-';
                    const ms = Date.now() - new Date(p.pm2_env.pm_uptime).getTime();
                    const s = Math.floor(Math.abs(ms) / 1000);
                    if (s < 60) return `${s}s`;
                    const m = Math.floor(s / 60);
                    if (m < 60) return `${m}m ${s % 60}s`;
                    const h = Math.floor(m / 60);
                    if (h < 24) return `${h}h ${m % 60}m`;
                    const d = Math.floor(h / 24);
                    return `${d}d ${h % 24}h`;
                };

                const fmtMem = (p: any) => {
                    const bytes = p?.monit?.memory;
                    if (!bytes || bytes <= 0) return '-';
                    if (bytes < 1024) return `${bytes}B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
                };

                const rows = dexbotProcs.map((p: any) => ({
                    pid: String(p?.pid || '-'),
                    name: String(p?.name || '-'),
                    status: String(p?.pm2_env?.status || '-'),
                    uptime: fmtUptime(p),
                    mem: fmtMem(p),
                }));

                const nameWidth = Math.max(...rows.map(r => r.name.length), 4);
                const statusWidth = Math.max(...rows.map(r => r.status.length), 6);
                const header = `${'PID'.padEnd(8)} ${'NAME'.padEnd(nameWidth)} ${'STATUS'.padEnd(statusWidth)} ${'UPTIME'.padEnd(12)} ${'MEMORY'}`;
                console.log(header);
                console.log('-'.repeat(header.length));
                for (const r of rows) {
                    console.log(`${r.pid.padEnd(8)} ${r.name.padEnd(nameWidth)} ${r.status.padEnd(statusWidth)} ${r.uptime.padEnd(12)} ${r.mem}`);
                }
            } catch (err: any) {
                const msg = String(err?.message || err || '');
                if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('not installed')) {
                    console.log('PM2 is not installed or not available.');
                } else {
                    console.log('No DEXBot2 processes running.');
                }
            }
            process.exit(0);
            return true;
        }
        default:
            printCLIUsage();
            process.exit(1);
    }
}

/**
 * Run all bots marked as active in settings.
 * @param {Object} [options={}] - Run options.
 * @param {boolean} [options.forceDryRun=false] - Force dry-run mode.
 * @param {string} [options.sourceName='settings'] - Source label.
 * @param {Object} [options.launcherStyle=null] - Launcher presentation options.
 * @returns {Promise<void>}
 */
async function runDefaultBots({ forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: any } = {}) {
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(entries);
    await runBotInstances(normalized, { forceDryRun, sourceName, launcherStyle });
}

/**
 * Main application entry point for DEXBot2 CLI.
 * Handles initial setup, command routing, and starting active bots.
 * @returns {Promise<void>}
 */
async function bootstrap() {
    // Ensure profiles directory exists
    const isNewSetup = ensureProfilesDirectory(PROFILES_DIR);

    // Handle CLI commands early — commands like 'update' must work even
    // when profiles/ was just cleaned (isNewSetup = true), otherwise the
    // new-setup wizard would block them before the CLI handler is reached.
    if (await handleCLICommands()) return;

    // If this is a new setup, prompt to set up keys
    if (isNewSetup) {
        // Suppress BitShares connection log during first-time setup
        setSuppressConnectionLog(true);
        console.log();
        console.log('='.repeat(50));
        console.log('Welcome to DEXBot2!');
        console.log('='.repeat(50));
        console.log();

        // Generate default general.settings.json for new installations
        const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');
        const { LOG_LEVEL, GRID_LIMITS, TIMING, UPDATER, NODE_MANAGEMENT, MARKET_ADAPTER } = require('./modules/constants');

        // Create a copy of GRID_LIMITS and remove any legacy fields if necessary
        // (Though constants.js was already updated, this ensures a clean object)
        const gridLimits = { ...GRID_LIMITS };

        // Create NODES config from NODE_MANAGEMENT constants
        const nodesConfig = {
            enabled: false,
            list: NODE_MANAGEMENT.DEFAULT_NODES,
            healthCheck: {
                enabled: true,
                intervalMs: NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS,
                maxPingMs: NODE_MANAGEMENT.MAX_PING_MS,
                blacklistThreshold: NODE_MANAGEMENT.BLACKLIST_THRESHOLD
            },
            selection: {
                strategy: NODE_MANAGEMENT.SELECTION_STRATEGY,
                preferredNode: null
            }
        };

        const defaultSettings = {
            LOG_LEVEL,
            NODES: nodesConfig,
            GRID_LIMITS: gridLimits,
            TIMING: { ...TIMING },
            UPDATER: { ...UPDATER },
            MARKET_ADAPTER: { ...MARKET_ADAPTER },
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2) + '\n', 'utf8');
        console.log('✓ Created default general.settings.json');
        console.log();

        console.log('To get started, you need to configure your master password.');
        console.log('This password will encrypt your private keys.');
        console.log();
        const setupKeysAnswer = (await readInput('Set up master password now? [y/N]: ')).trim().toLowerCase();
        const setupKeys = setupKeysAnswer === 'y' || setupKeysAnswer === 'yes';
        if (setupKeys) {
            console.log();
            await chainKeys.main();
            console.log();
            console.log('Master password configured! Now you can:');
            console.log('  node dexbot bots   - Create and manage bots');
            console.log('  node dexbot        - Run your configured bots');
            console.log();
        } else {
            console.log();
            console.log('You can set up your master password later by running:');
            console.log('  node dexbot keys');
            console.log();
        }
        return;
    }

    // Check if bots.json exists - if not, guide user
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        // Suppress BitShares connection log when no bots configured
        setSuppressConnectionLog(true);
        console.log();
        console.log('No bot configuration found.');
        console.log();
        console.log('First, set up your master password:');
        console.log('  node dexbot keys');
        console.log();
        console.log('Then, create your first bot:');
        console.log('  node dexbot bots');
        console.log();
        process.exit(0);
    }

    await runDefaultBots();
}

function handleFatalBootstrapError(err: any) {
    if (chainKeys.isMasterPasswordFailure(err)) {
        printMasterPasswordFailure(err);
        process.exit(1);
        return;
    } else if (err && err.message) {
        console.error(err.message);
    } else {
        console.error(err);
    }

    try {
        BitShares.disconnect();
    } catch (disconnectErr) {
    }

    process.exit(1);
}

bootstrap().catch(handleFatalBootstrapError);
export {};
