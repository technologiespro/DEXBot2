#!/usr/bin/env node
/**
 * pm2.js - PM2 Orchestration Launcher
 *
 * Unified PM2 launcher for DEXBot2 multi-bot system.
 * One-command startup with all setup required before starting bots.
 * Handles process management, configuration generation, and daemon startup.
 *
 * ===============================================================================
 * COMMANDS
 * ===============================================================================
 *
 * node pm2                       - Default: unlock keystore and start all bots
 * node pm2 unlock-start          - Explicit: unlock keystore and start all bots
 * node pm2 unlock-start <bot>    - Unlock keystore and start specific bot
 * node pm2 claw-only             - Credential daemon only, managed by PM2
 * node pm2 unlock-start --claw-only - Credential daemon only, managed by PM2
 * node pm2 update                - Run the update script immediately
 * node pm2 stop all              - Stop all dexbot PM2 processes
 * node pm2 stop <bot-name>       - Stop specific bot process
 * node pm2 delete all            - Delete all dexbot processes from PM2
 * node pm2 delete <bot-name>     - Delete specific bot from PM2
 * node pm2 restart all           - Restart managed apps; re-unlock dexbot-cred only if needed
 * node pm2 restart <target>      - Restart a bot or safely re-unlock dexbot-cred
 * node pm2 reload all            - Reload managed apps without touching dexbot-cred
 * node pm2 reload <target>       - Reload a bot, or safely re-unlock dexbot-cred
 * node pm2 help                  - Show help message
 *
 * ===============================================================================
 * SETUP SEQUENCE
 * ===============================================================================
 *
 * Step 0: BITSHARES CONNECTION VERIFICATION
 *    - Waits for BitShares blockchain network connection
 *    - Suppresses debug output to keep terminal clean
 *    - Validates node availability before proceeding
 *
 * Step 1: PM2 INSTALLATION CHECK
 *    - Detects local and global PM2 installations
 *    - Prompts to install PM2 if missing
 *    - Validates PM2 is available before proceeding
 *
 * Step 2: ECOSYSTEM CONFIGURATION GENERATION
 *    - Reads bot definitions from profiles/bots.json for bot mode
 *    - Generates profiles/ecosystem.config.js with absolute paths
 *    - Filters only active bots (active !== false)
 *    - If bot-name provided, filters to only that bot
 *    - In claw-only mode, generates only the credential daemon app
 *    - Each bot configured with:
 *      * Unique app name
 *      * Log file paths
 *      * Restart/memory policies
 *
 * Step 3: AUTHENTICATION & CLEANUP
 *    - Cleans up stale daemon socket files
 *    - Prompts interactively for the unlock secret once at startup
 *    - Authenticates against profiles/keys.json
 *    - Uses a one-shot local bootstrap channel for credential-daemon only
 *
 * Step 4: PM2 DAEMON STARTUP
 *    - Starts PM2 daemon if not already running
 *    - Waits for PM2 to be ready
 *    - Starts each configured bot as PM2 app
 *    - Credential daemon is started as a PM2 app after one-shot bootstrap
 *    - Bots request private keys from credential daemon via Unix socket
 */

process.umask(0o077);

const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const { promisify } = require('util');
const { parseJsonWithComments } = require('./modules/order/utils/system');
const { readBotsFileWithLock } = require('./modules/bots_file_lock');
const { loadSettingsFile, selectActiveBotEntries } = require('./modules/bot_settings');
const chainKeys = require('./modules/chain_keys');
const {
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const { buildScopedChildEnv } = require('./modules/launcher/child_env');
const { createPasswordBootstrapServer } = require('./modules/launcher/credential_bootstrap');
const { parsePm2Args } = require('./modules/launcher/launch_modes');
const { setupGracefulShutdown } = require('./modules/graceful_shutdown');
const { UPDATER, TIMING } = require('./modules/constants');

// Setup graceful shutdown handlers
setupGracefulShutdown();

const execAsync = promisify(exec);

const ROOT = __dirname;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BOTS_JSON = path.join(PROFILES_DIR, 'bots.json');
const ECOSYSTEM_FILE = path.join(PROFILES_DIR, 'ecosystem.config.js');
const LOGS_DIR = path.join(PROFILES_DIR, 'logs');
const CREDENTIAL_DAEMON_APP_NAME = 'dexbot-cred';
const CREDENTIAL_SOCKET_PATH = getCredentialSocketPath({ root: ROOT });
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath({ root: ROOT });

function usesAmaGridPrice(bot) {
    const gridPrice = typeof bot?.gridPrice === 'string' ? bot.gridPrice.trim().toLowerCase() : '';
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

function needsMarketAdapter(bots) {
    return (bots || []).some((bot) => usesAmaGridPrice(bot));
}

function isServiceApp(app) {
    const name = String(app?.name || '');
    return name === 'dexbot-update' || name === CREDENTIAL_DAEMON_APP_NAME || name === 'dexbot-adapter';
}

function countManagedBots(apps) {
    return (apps || []).filter((app) => !isServiceApp(app)).length;
}

function isPm2TableLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return true;
    return /^[┌┬│├┤└┴─\s]+$/.test(trimmed) || /^[┌┬│├┤└┴]/.test(trimmed);
}

function transformPm2Line(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    if (isPm2TableLine(trimmed)) return null;
    if (/^\[PM2\] Starting\b/.test(trimmed)) return null;
    if (trimmed === '[PM2] Done.') return null;
    if (/^\[PM2\] cron restart at /.test(trimmed)) return null;
    if (/^\[PM2\]\[WARN\] Applications .* not running, starting\.\.\.$/.test(trimmed)) return null;
    if (/^\[PM2\] Applying action /.test(trimmed)) return null;
    return trimmed.replace(/\s+\(\d+ instances?\)$/, '');
}

function flushPm2Buffer(buffer, writer, { final = false } = {}) {
    if (!buffer) return '';
    const lines = buffer.split(/\r?\n/);
    const trailing = lines.pop();
    for (const line of lines) {
        const transformed = transformPm2Line(line);
        if (transformed) writer(transformed);
    }
    if (final && trailing && trailing.trim()) {
        const transformed = transformPm2Line(trailing);
        if (transformed) writer(transformed);
        return '';
    }
    return trailing || '';
}

/**
 * Build PM2 app definitions for the current runtime.
 * @param {Array<Object>} bots - Active bot entries.
 * @param {Object} options - Build options.
 * @param {boolean} options.includeUpdater - Whether to add the updater service.
 * @returns {Array<Object>} PM2 app definitions.
 */
function buildEcosystemApps(bots, { includeUpdater = true } = {}) {
    const apps = (bots || []).map((bot, index) => {
        const botName = bot.name || `bot-${index}`;
        return {
            name: botName,
            script: path.join(ROOT, 'bot.js'),
            args: botName,
            cwd: ROOT,
            max_memory_restart: '250M',
            watch: false,
            autorestart: true,
            error_file: path.join(LOGS_DIR, `${botName}-error.log`),
            out_file: path.join(LOGS_DIR, `${botName}.log`),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: false,
            combine_logs: true,
            max_restarts: 13,
            min_uptime: 86400000,
            restart_delay: 3000
        };
    });

    if (needsMarketAdapter(bots)) {
        apps.unshift({
            name: 'dexbot-adapter',
            script: path.join(ROOT, 'market_adapter', 'market_adapter.js'),
            cwd: ROOT,
            watch: false,
            autorestart: true,
            max_memory_restart: '150M',
            error_file: path.join(LOGS_DIR, 'dexbot-adapter-error.log'),
            out_file: path.join(LOGS_DIR, 'dexbot-adapter.log'),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: false,
            combine_logs: true,
            max_restarts: 13,
            min_uptime: 60000,
            restart_delay: 3000
        });
    }

    if (includeUpdater && UPDATER.ACTIVE) {
        apps.push({
            name: "dexbot-update",
            script: path.join(ROOT, 'scripts', 'update.js'),
            cwd: ROOT,
            autorestart: false,
            cron_restart: UPDATER.SCHEDULE,
            error_file: path.join(LOGS_DIR, `dexbot-update-error.log`),
            out_file: path.join(LOGS_DIR, `dexbot-update.log`),
            log_date_format: "YY-MM-DD HH:mm:ss.SSS"
        });
    }

    return apps;
}

function buildCredentialDaemonApp({ credentialEnv = {} } = {}) {
    return {
        name: CREDENTIAL_DAEMON_APP_NAME,
        script: path.join(ROOT, 'credential-daemon.js'),
        cwd: ROOT,
        autorestart: false,
        max_memory_restart: '100M',
        error_file: path.join(LOGS_DIR, 'dexbot-cred-error.log'),
        out_file: path.join(LOGS_DIR, 'dexbot-cred.log'),
        log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
        env: {
            DEXBOT_CRED_DAEMON_SOCKET: CREDENTIAL_SOCKET_PATH,
            DEXBOT_CRED_DAEMON_READY_FILE: CREDENTIAL_READY_FILE,
            ...credentialEnv,
        }
    };
}

/**
 * Generate ecosystem.config.js from bots.json or claw-only mode.
 * @param {Object} [options={}] - Generation options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to filter by.
 * @param {boolean} [options.clawOnly=false] - Generate no managed bot apps.
 * @returns {Array<Object>} The generated app configurations.
 * @throws {Error} If configuration loading fails.
 */
function generateEcosystemConfig({ botNameFilter = null, clawOnly = false, exitOnError = true } = {}) {
    function fail(message) {
        if (exitOnError) {
            console.error(message);
            process.exit(1);
        }
        throw new Error(message);
    }

    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    try {
        if (clawOnly) {
            const apps = [];
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: node pm2 or node dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

            fs.writeFileSync(ECOSYSTEM_FILE, ecosystemContent);
            return apps;
        }

        if (!fs.existsSync(BOTS_JSON)) {
            fail('profiles/bots.json not found. Run: dexbot bots');
        }

        const { config } = loadSettingsFile(BOTS_JSON, { exitOnError });
        const bots = selectActiveBotEntries(config);

        if (botNameFilter) {
            const filtered = bots.filter((b) => b.name === botNameFilter);
            if (filtered.length === 0) {
                fail(`Bot '${botNameFilter}' not found or not active in profiles/bots.json`);
            }
            const apps = buildEcosystemApps(filtered, { includeUpdater: false });
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: node pm2 or node dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

            fs.writeFileSync(ECOSYSTEM_FILE, ecosystemContent);
            return apps;
        }

        if (bots.length === 0) {
            fail('No active bots found in profiles/bots.json');
        }

        const apps = buildEcosystemApps(bots, { includeUpdater: true });

        const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: node pm2 or node dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

        fs.writeFileSync(ECOSYSTEM_FILE, ecosystemContent);
        return apps;
    } catch (err) {
        fail(`Error reading bots.json: ${err.message}`);
    }
}

async function runManagedAppsPm2Action(action, { regenerate = false } = {}) {
    if (regenerate) {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
    }
    if (!fs.existsSync(ECOSYSTEM_FILE)) {
        return false;
    }
    return execPM2CommandIgnoreMissing(action, ECOSYSTEM_FILE);
}

function cleanupStaleCredentialDaemonFiles() {
    try {
        try { fs.unlinkSync(CREDENTIAL_SOCKET_PATH); } catch (e) { }
        try { fs.unlinkSync(CREDENTIAL_READY_FILE); } catch (e) { }
    } catch (e) {
        // Socket files already cleaned, that's fine
    }
}

async function ensureCredentialDaemonPM2({ forceRefresh = false } = {}) {
    ensureCredentialRuntimeDirSync({ root: ROOT, socketPath: CREDENTIAL_SOCKET_PATH, readyFilePath: CREDENTIAL_READY_FILE });
    const daemonReady = chainKeys.isDaemonReady({
        socketPath: CREDENTIAL_SOCKET_PATH,
        readyFilePath: CREDENTIAL_READY_FILE,
    });

    if (daemonReady && !forceRefresh) {
        return false;
    }

    if (!daemonReady) {
        cleanupStaleCredentialDaemonFiles();
    }

    let bootstrap = null;
    try {
        const vaultSecret = await chainKeys.authenticate();
        bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        console.log('✓ Authentication successful\n');
        await startManagedRuntimePM2({ apps: [], bootstrap });
        return true;
    } catch (error) {
        if (bootstrap) bootstrap.close();
        throw error;
    }
}

async function assertActiveBotTarget(target) {
    try {
        const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
        const botExists = selectActiveBotEntries(config).some((b) => b.name === target);
        if (!botExists) {
            throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
        }
    } catch (err) {
        if (String(err && err.message || '').includes('not found or not active')) {
            throw err;
        }
        throw new Error(`Failed to read bots configuration: ${err.message}`);
    }
}

/**
 * Main application entry point for PM2 orchestration.
 * @param {Object} [options={}] - Launcher options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to start.
 * @param {boolean} [options.clawOnly=false] - Start the credential daemon only.
 * @returns {Promise<void>}
 */
async function main({ botNameFilter = null, clawOnly = false } = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 PM2 Launcher');
    if (clawOnly) {
        console.log('Starting credential daemon only');
    }
    if (botNameFilter) {
        console.log(`Starting bot: ${botNameFilter}`);
    }
    console.log('='.repeat(50));
    console.log();

    if (!clawOnly) {
        // Step 0: Wait for BitShares connection (suppress BitShares client logs)
        const { waitForConnected } = require('./modules/bitshares_client');

        // Suppress BitShares console output during connection
        const originalLog = console.log;
        try {
            console.log = (...args) => {
                // Only suppress BitShares-specific messages
                const msg = args.join(' ');
                if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                    originalLog(...args);
                }
            };

            await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);
        } finally {
            // Always restore console output, even if waitForConnected throws
            console.log = originalLog;
        }

        console.log('Connected to BitShares');
    } else {
        console.log();
    }

    // Step 1: Check PM2
    if (!checkPM2Installed()) {
        console.error('PM2 is not installed');
        await installPM2();
    }

    // Step 2: Ensure credential daemon availability
    try {
        await ensureCredentialDaemonPM2();
    } catch (error) {
        console.error('\n❌', error.message);
        process.exit(1);
    }

    // Step 3: Generate ecosystem config
    const apps = generateEcosystemConfig({
        botNameFilter,
        clawOnly,
    });
    const botCount = countManagedBots(apps);
    console.log(`Number active bots: ${botCount}`);
    console.log();

    // Step 4: Start PM2
    console.log(clawOnly ? 'Starting PM2 with credential daemon only...' : 'Starting PM2 with all services...');
    await startManagedAppsPM2(apps);

    console.log();
    console.log('='.repeat(50));
    console.log('DEXBot2 started successfully!');
    console.log('If dexbot-cred stops, rerun `node pm2` to unlock it again.');
    console.log('='.repeat(50));
    console.log();
}

function startPM2Process(args, env = buildScopedChildEnv()) {
    return new Promise((resolve, reject) => {
        const pm2 = spawn('pm2', args, {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            shell: process.platform === 'win32'
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';

        pm2.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line) => console.log(line));
        });

        pm2.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line) => console.error(line));
        });

        pm2.on('close', code => {
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line) => console.log(line), { final: true });
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line) => console.error(line), { final: true });
            if (code === 0) {
                // Ensure we disconnect from PM2's file descriptors
                setImmediate(resolve);
            } else {
                reject(new Error(`PM2 exited with code ${code}`));
            }
        });

        pm2.on('error', reject);
    });
}

function startManagedAppsPM2(apps) {
    if (!apps || apps.length === 0) {
        return Promise.resolve();
    }
    return startPM2Process(['start', ECOSYSTEM_FILE]);
}

function startCredentialDaemonPM2({ credentialEnv = {} } = {}) {
    const app = buildCredentialDaemonApp({ credentialEnv });
    const args = [
        'start',
        app.script,
        '--name', app.name,
        '--cwd', app.cwd,
        '--output', app.out_file,
        '--error', app.error_file,
        '--max-memory-restart', app.max_memory_restart,
        '--log-date-format', app.log_date_format,
        '--no-autorestart',
    ];
    return startPM2Process(args, buildScopedChildEnv({ extra: app.env }));
}

async function startManagedRuntimePM2({ apps, bootstrap = null } = {}) {
    if (bootstrap) {
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
        await startCredentialDaemonPM2({ credentialEnv: bootstrap.credentialEnv });
        await Promise.all([
            bootstrap.waitForTransfer(),
            chainKeys.waitForDaemon(TIMING.DAEMON_STARTUP_TIMEOUT_MS, {
                socketPath: CREDENTIAL_SOCKET_PATH,
                readyFilePath: CREDENTIAL_READY_FILE,
            }),
        ]);
    }

    await startManagedAppsPM2(apps);
}

/**
 * Check if PM2 is installed locally or globally.
 * @returns {boolean} True if PM2 is found.
 */
function checkPM2Installed() {
    try {
        require.resolve('pm2');
        return true;
    } catch (e) {
        // Check if pm2 is available in PATH
        const { execSync } = require('child_process');
        try {
            execSync('pm2 --version', { stdio: 'ignore' });
            return true;
        } catch (err) {
            return false;
        }
    }
}

/**
 * Prompt the user to install PM2 globally.
 * @returns {Promise<void>}
 */
async function installPM2() {
    const readline = require('readline');
    const { spawn } = require('child_process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve, reject) => {
        rl.question('PM2 is not installed. Install now? (Y/n): ', (answer) => {
            rl.close();

            if (answer.toLowerCase() === 'n') {
                console.log('PM2 installation cancelled. Run: npm install -g pm2');
                process.exit(1);
            }

            console.log('Installing PM2...');

            // Helper to run installation command
            const runInstall = (command, args) => {
                return new Promise((res, rej) => {
                    const proc = spawn(command, args, {
                        stdio: 'inherit',
                        shell: process.platform === 'win32'
                    });
                    proc.on('close', (code) => {
                        if (code === 0) res();
                        else rej(code);
                    });
                    proc.on('error', (err) => rej(err));
                });
            };

            // Try standard install first
            runInstall('npm', ['install', '-g', 'pm2'])
                .then(() => {
                    console.log('PM2 installed successfully!');
                    resolve();
                })
                .catch((err) => {
                    // If failed and not on Windows, try sudo
                    if (process.platform !== 'win32') {
                        console.log('\nStandard installation failed (likely permissions). Trying with sudo...');
                        console.log('This covers Linux and macOS. Please enter your password if prompted:');

                        runInstall('sudo', ['npm', 'install', '-g', 'pm2'])
                            .then(() => {
                                console.log('PM2 installed successfully with sudo!');
                                resolve();
                            })
                            .catch((finalErr) => {
                                reject(new Error('PM2 installation failed even with sudo'));
                            });
                    } else {
                        // Windows handling
                        console.log('\nStandard installation failed (likely permissions).');
                        console.log('Attempting to install with Administrator privileges...');
                        console.log('Please accept the UAC dialog to proceed.');

                        // Run npm install in a new elevated window
                        // We use timeout so the user can see the result before window closes
                        const psCommand = "Start-Process cmd -ArgumentList '/c npm install -g pm2 & echo. & echo Installation complete. Closing in 5 seconds... & timeout /t 5' -Verb RunAs -Wait";

                        runInstall('powershell', ['-Command', psCommand])
                            .then(() => {
                                // Verify installation succeeded since we can't easily get the exit code from the elevated process
                                if (checkPM2Installed()) {
                                    console.log('PM2 installed successfully (Elevated)!');
                                    resolve();
                                } else {
                                    reject(new Error('PM2 installation failed or was cancelled in the elevated window.'));
                                }
                            })
                            .catch((winErr) => {
                                console.error('\nFailed to elevate permissions.');
                                console.error('Please manually run "npm install -g pm2" as Administrator.');
                                reject(new Error('PM2 installation failed.'));
                            });
                    }
                });
        });
    });
}

/**
 * Execute a PM2 command safely.
 * @param {string} action - PM2 action (start, stop, etc.).
 * @param {string} [target] - The target process name or configuration file.
 * @returns {Promise<Object>} Command result.
 * @throws {Error} If action is invalid or command fails.
 */
async function execPM2Command(action, target, { suppressStderrOnError = false, silent = false } = {}) {
    // Validate action to prevent injection
    const validActions = ['start', 'stop', 'delete', 'restart', 'reload'];
    if (!validActions.includes(action)) {
        throw new Error(`Invalid PM2 action: ${action}`);
    }

    // Use spawn instead of shell to avoid injection vulnerabilities
    // spawn passes arguments as array, preventing shell interpretation
    return new Promise((resolve, reject) => {
        const args = [action];
        if (target) {
            args.push(target);
        }

        const { spawn } = require('child_process');
        const pm2 = spawn('pm2', args, {
            stdio: 'pipe',
            shell: process.platform === 'win32'
        });

        let stdout = '';
        let stderr = '';
        let stdoutBuffer = '';

        pm2.stdout.on('data', (data) => {
            stdout += data.toString();
            if (!silent) {
                stdoutBuffer += data.toString();
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line) => console.log(line));
            }
        });

        pm2.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pm2.on('close', (code) => {
            if (!silent) {
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line) => console.log(line), { final: true });
            }
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
            } else {
                if (stderr && !suppressStderrOnError) console.error(stderr);
                reject(new Error(`PM2 command failed with code ${code}: ${stderr || stdout}`));
            }
        });

        pm2.on('error', reject);
    });
}

async function execPM2CommandIgnoreMissing(action, target, options = {}) {
    try {
        await execPM2Command(action, target, { suppressStderrOnError: true, ...options });
        return true;
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        if (message.includes('Process or Namespace') || message.includes('not found') || message.includes('does not exist')) {
            return false;
        }
        throw error;
    }
}

/**
 * Stop PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or stopping fails.
 */
async function stopPM2Processes(target) {
    console.log(`Stopping PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        if (fs.existsSync(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('stop');
        } else if (fs.existsSync(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('stop', { regenerate: true });
            } catch (err) {
                console.warn(`Skipping managed bot stop: ${err.message}`);
            }
        }
        await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME, { silent: true });
        console.log('');
        console.log('All dexbot PM2 processes stopped.');
    } else {
        if (target === CREDENTIAL_DAEMON_APP_NAME) {
            await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME);
            console.log(`PM2 process '${target}' stopped.`);
            return;
        }

        // Validate bot exists in configuration before stopping (with lock protection)
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const botExists = selectActiveBotEntries(config).some((b) => b.name === target);

            if (!botExists) {
                throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
            }
        } catch (err) {
            throw new Error(`Failed to read bots configuration: ${err.message}`);
        }

        // Stop specific bot by name
        await execPM2Command('stop', target);
        console.log(`PM2 process '${target}' stopped.`);
    }
}

/**
 * Delete PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or deleting fails.
 */
async function deletePM2Processes(target) {
    console.log(`Deleting PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        if (fs.existsSync(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('delete');
        } else if (fs.existsSync(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('delete', { regenerate: true });
            } catch (err) {
                console.warn(`Skipping managed bot delete: ${err.message}`);
            }
        }
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME, { silent: true });
        console.log('');
        console.log('All dexbot PM2 processes deleted.');
        return;
    } else {
        if (target === CREDENTIAL_DAEMON_APP_NAME) {
            await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
            console.log(`PM2 process '${target}' deleted.`);
            return;
        }

        // Validate bot exists in configuration before deleting (with lock protection)
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const botExists = selectActiveBotEntries(config).some((b) => b.name === target);

            if (!botExists) {
                throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
            }
        } catch (err) {
            throw new Error(`Failed to read bots configuration: ${err.message}`);
        }

        // Delete specific bot by name
        await execPM2Command('delete', target);
        console.log(`PM2 process '${target}' deleted.`);
    }
}

async function restartPM2Processes(target) {
    console.log(`Restarting PM2 processes: ${target}`);

    if (target === 'all') {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        await ensureCredentialDaemonPM2({ logReuse: false });
        await runManagedAppsPm2Action('restart');
        console.log('Managed dexbot PM2 apps restarted. dexbot-cred was left on the safe wrapper path.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await ensureCredentialDaemonPM2({ forceRefresh: true, logReuse: false });
        console.log(`Credential daemon '${target}' restarted with a fresh unlock.`);
        return;
    }

    await assertActiveBotTarget(target);
    await ensureCredentialDaemonPM2({ logReuse: false });
    await execPM2Command('restart', target);
    console.log(`PM2 process '${target}' restarted.`);
}

async function reloadPM2Processes(target) {
    console.log(`Reloading PM2 processes: ${target}`);

    if (target === 'all') {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        await ensureCredentialDaemonPM2({ logReuse: false });
        await runManagedAppsPm2Action('reload');
        console.log('Managed dexbot PM2 apps reloaded. dexbot-cred was not reloaded.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await ensureCredentialDaemonPM2({ forceRefresh: true, logReuse: false });
        console.log(`Credential daemon '${target}' re-unlocked via safe restart flow.`);
        return;
    }

    await assertActiveBotTarget(target);
    await ensureCredentialDaemonPM2({ logReuse: false });
    await execPM2Command('reload', target);
    console.log(`PM2 process '${target}' reloaded.`);
}

/**
 * Show help text for PM2 CLI usage.
 */
function showPM2Help() {
    console.log(`
Usage: node pm2 <command> [target]

Commands:
  unlock-start              Unlock keystore and start all bots with PM2 (default)
  claw-only                 Start only the credential daemon with PM2
  update                    Run the update script immediately
  stop <bot-name|all>       Stop PM2 process(es) - only dexbot processes
  delete <bot-name|all>     Delete PM2 process(es) - only dexbot processes
  restart <bot-name|all>    Restart managed apps safely; dexbot-cred uses fresh unlock flow
  reload <bot-name|all>     Reload managed apps safely; dexbot-cred uses fresh unlock flow
  help                      Show this help message

Examples:
  node pm2                       # Start all bots (unlock + start)
  node pm2 claw-only             # Start only the credential daemon
  node pm2 unlock-start --claw-only # Start only the credential daemon
  node pm2 stop all             # Stop all dexbot processes
  node pm2 stop XRP-BTS         # Stop specific bot
  node pm2 delete all           # Delete all dexbot processes from PM2
  node pm2 delete XRP-BTS       # Delete specific bot from PM2
  node pm2 restart all          # Safe restart path for managed apps
  node pm2 reload XRP-BTS       # Safe reload path for a specific bot
  node pm2 help                 # Show help
    `);
}

// Run if called directly
if (require.main === module) {
    // Parse command line arguments
    const { command, target, clawOnly } = parsePm2Args(process.argv);

    (async () => {
        try {
            if (command === 'unlock-start') {
                // Full setup: unlock, generate config, authenticate, start PM2
                // Optional: filter to specific bot if provided
                await main({ botNameFilter: target || null, clawOnly });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'claw-only') {
                await main({ clawOnly: true });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'update') {
                const { spawn } = require('child_process');
                const update = spawn('node', [path.join(ROOT, 'scripts', 'update.js')], { stdio: 'inherit' });
                update.on('close', code => process.exit(code));
            } else if (command === 'stop') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await stopPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to stop processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'delete') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await deletePM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to delete processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'restart') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name, "dexbot-cred", or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await restartPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to restart processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'reload') {
                if (!target) {
                    console.error('Error: Target required. Specify bot name, "dexbot-cred", or "all".');
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await reloadPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(`Failed to reload processes: ${err.message}`);
                    process.exit(1);
                }
            } else if (command === 'help') {
                showPM2Help();
                process.exit(0);
            } else {
                console.error(`Unknown command: ${command}`);
                showPM2Help();
                process.exit(1);
            }
        } catch (err) {
            console.error('Error:', err.message);
            process.exit(1);
        }
    })();
}

module.exports = {
    buildCredentialDaemonApp,
    buildEcosystemApps,
    buildScopedChildEnv,
    countManagedBots,
    deletePM2Processes,
    ensureCredentialDaemonPM2,
    generateEcosystemConfig,
    isServiceApp,
    main,
    needsMarketAdapter,
    reloadPM2Processes,
    restartPM2Processes,
    stopPM2Processes,
    startManagedRuntimePM2,
    usesAmaGridPrice
};
