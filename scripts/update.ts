#!/usr/bin/env node
// @ts-nocheck

/**
 * DEXBot2 Auto-Update Script
 *
 * Manages pulling latest code from git repository with smart logic:
 * - Fetches from configured remote repository
 * - Detects if updates are available
 * - Handles branch switching if needed
 * - Reinstalls npm dependencies
 * - Selectively reloads active PM2 processes
 * - Gracefully handles missing files or PM2
 *
 * Configuration:
 * - Repository URL: Hardcoded in modules/constants.js (UPDATER.REPOSITORY_URL)
 * - Target branch: Configurable in constants.js (UPDATER.BRANCH), supports 'auto' for auto-detection
 *
 * Exit codes:
 * - 0: Update completed successfully (or already up-to-date)
 * - 1: Update failed (with error details printed)
 *
 * Usage: node scripts/update.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sendControlCommand } = require('../modules/launcher/supervisor_control');

// Project root directory — handles running from scripts/ or dist/scripts/
const SCRIPTS_DIR = __dirname;
const ROOT = path.basename(path.dirname(SCRIPTS_DIR)) === 'dist'
    ? path.resolve(SCRIPTS_DIR, '..', '..')
    : path.resolve(SCRIPTS_DIR, '..');

// Import update configuration from constants
// Contains: REPOSITORY_URL, BRANCH settings
const { UPDATER } = require('../modules/constants');
const MONOLITHIC_PID_FILE = path.join(ROOT, 'profiles', 'monolithic.pid');
const MONOLITHIC_BOT_PID_FILE = path.join(ROOT, 'profiles', 'monolithic-bot.pid');
const MONOLITHIC_BOT_INFO_FILE = path.join(ROOT, 'profiles', 'monolithic-bot.json');

/**
 * log: Output timestamped update log message
 *
 * Formats: [ISO_TIMESTAMP] [UPDATE] message
 *
 * @param {string} msg - Message to log
 */
function log(msg) {
    console.log(`[${new Date().toISOString()}] [UPDATE] ${msg}`);
}

/**
 * run: Execute shell command with error handling
 *
 * Runs command with inherited stdio so user sees full output.
 * Throws error if command fails, breaking update process.
 *
 * @param {string} cmd - Shell command to execute
 * @throws {Error} If command exits with non-zero status
 */
function run(cmd) {
    log(`Executing: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    } catch (err) {
        console.error(`[ERROR] Command failed: ${cmd}`);
        throw err;
    }
}

function readLivePidFile(filePath) {
    if (!fs.existsSync(filePath)) return 0;

    try {
        const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
        if (!Number.isInteger(pid) || pid <= 0) return 0;
        process.kill(pid, 0);
        return pid;
    } catch (_) {
        return 0;
    }
}

function detectMonolithicRuntime() {
    const wrapperPid = readLivePidFile(MONOLITHIC_PID_FILE);
    if (!wrapperPid) return null;

    const detected = { wrapperPid, botPid: readLivePidFile(MONOLITHIC_BOT_PID_FILE), botNames: [] };
    try {
        const info = JSON.parse(fs.readFileSync(MONOLITHIC_BOT_INFO_FILE, 'utf8'));
        if (Array.isArray(info.botNames)) {
            detected.botNames = info.botNames.map((name) => String(name));
        } else if (info.botName) {
            detected.botNames = [String(info.botName)];
        }
    } catch (_) {}
    return detected;
}

function restartMonolithicRuntime(monolithic) {
    const details = [
        `wrapper PID ${monolithic.wrapperPid}`,
        monolithic.botPid ? `bot PID ${monolithic.botPid}` : null,
        monolithic.botNames.length ? `bots: ${monolithic.botNames.join(', ')}` : null,
    ].filter(Boolean).join('; ');

    log(`Monolithic runtime detected (${details}). Restarting via unlock-start control...`);
    const unlockStartPath = fs.existsSync(path.join(ROOT, 'dist', 'unlock-start.js'))
        ? path.join(ROOT, 'dist', 'unlock-start.js')
        : path.join(ROOT, 'unlock-start.js');
    run(`node "${unlockStartPath}" restart-all`);
}

async function detectIsolatedSupervisor() {
    try {
        const resp = await sendControlCommand({ cmd: 'status' });
        return resp && resp.ok ? resp.status || {} : null;
    } catch (_) {
        return null;
    }
}

async function reloadActiveIsolatedProcesses() {
    const status = await detectIsolatedSupervisor();
    if (!status) {
        return false;
    }

    const runningNames = Object.entries(status)
        .filter(([name, info]) => name !== 'dexbot-update' && info && info.status === 'running')
        .map(([name]) => name);

    if (runningNames.length === 0) {
        log('No active isolated processes are currently running. Skipping supervisor restart.');
        return true;
    }

    log(`Active isolated processes detected: ${runningNames.join(', ')}`);
    await sendControlCommand({ cmd: 'restart-running' });
    return true;
}

(async () => {
try {
    // Change to project root for all git operations
    process.chdir(ROOT);
    log('Starting DEXBot2 update process...');

    // Get configured repository URL and target branch
    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

    /**
     * STEP 1: Validate Git Repository
     * Ensures .git directory exists so we can perform git operations
     */
    if (!fs.existsSync(path.join(ROOT, '.git'))) {
        throw new Error('Not a git repository. Manual update required.');
    }

    /**
     * STEP 2: Detect Current Branch
     * Gets the current checked-out branch name
     */
    log('Checking for updates...');

    let currentBranch;
    try {
        // Get detached/attached branch name
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
        // Fallback if command fails
        currentBranch = 'unknown';
    }

    /**
     * STEP 3: Handle Branch Auto-Detection
     * If UPDATER.BRANCH is 'auto', detect or default to 'main'
     * Otherwise use the configured branch name
     */
    if (branch === 'auto') {
        if (currentBranch === 'HEAD' || currentBranch === 'unknown') {
            // Detached HEAD or unknown state - default to main
            branch = 'main';
            log(`Could not detect current branch, defaulting to: ${branch}`);
        } else {
            // Auto-detect: use current branch
            branch = currentBranch;
            log(`Detected current branch: ${branch}`);
        }
    }

    /**
     * STEP 4: Verify/Fix Remote Configuration
     * Ensures origin points to the correct repository URL
     * Updates URL if it differs, or adds origin remote if missing
     */
    try {
        const currentRemote = execSync('git remote get-url origin').toString().trim();
        if (currentRemote !== repoUrl) {
            log(`Updating origin URL to: ${repoUrl}`);
            run(`git remote set-url origin ${repoUrl}`);
        }
    } catch (e) {
        // Remote doesn't exist, add it
        log(`Adding origin remote: ${repoUrl}`);
        run(`git remote add origin ${repoUrl}`);
    }

    /**
     * STEP 5: Check for Available Updates
     * Fetches remote branch metadata and compares with local
     */
    run(`git fetch origin ${branch}`);

    // Get current commit hashes for comparison
    const localHash = execSync('git rev-parse HEAD').toString().trim();
    const remoteHash = execSync(`git rev-parse origin/${branch}`).toString().trim();

    /**
     * Check for incoming commits
     * git rev-list --count HEAD..origin/branch = commits that exist remotely but not locally
     * This is the core check: if > 0, updates are available
     */
    const incomingCommits = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`).toString().trim(), 10);
    const updatesAvailable = incomingCommits > 0;
    const branchSwitchNeeded = currentBranch !== branch;

    /**
     * Decision Logic for Update Flow
     *
     * Three scenarios are possible:
     * 1. NO incoming updates (updatesAvailable = false)
     *    - Local is either equal to or ahead of remote
     *    - Action: Switch branch if needed, then exit cleanly
     * 2. Incoming updates available (updatesAvailable = true)
     *    - Remote has new commits we need to pull
     *    - Action: Proceed with full update (pull, npm install, reload PM2)
     */
    if (!updatesAvailable) {
        // No updates available - check if branch switch is needed
        if (branchSwitchNeeded) {
            log(`Aligning branch reference: ${currentBranch} -> ${branch} (no incoming updates).`);
            run(`git checkout ${branch}`);
            log('DEXBot2 is now tracking the correct branch.');
        }
        log('DEXBot2 is already up to date (local is equal or ahead of remote).');
        process.exit(2);
    }

    log(`${incomingCommits} update(s) available. Proceeding with update process...`);

    // List changes
    console.log('\n----------------------------------------------------------------');
    console.log('Incoming Changes:');
    try {
        execSync(`git log --oneline --graph --decorate HEAD..origin/${branch}`, { stdio: 'inherit', cwd: ROOT });
    } catch (e) {
        log('Warning: Could not list changes.');
    }
    console.log('----------------------------------------------------------------\n');

    /**
     * STEP 6: Prepare Working Directory
     * Stashes local changes to ensure a clean pull.
     * Uses --include-untracked to capture build artifacts etc.
     * Ignores gitignored directories (profiles/, dist/) — they are
     * never touched by stash, so bot configs and keys are safe.
     */
    log('Stashing local changes before pull...');
    run('git stash push --include-untracked --message "dexbot-update-auto" 2>/dev/null; true');

    /**
     * STEP 7: Pull Latest Code Changes
     * Switches branch if needed, then pulls remote changes
     */
    if (currentBranch !== branch) {
        log(`Switching to branch: ${branch}...`);
        run(`git checkout ${branch}`);
    }
    log(`Pulling latest changes from ${repoUrl} (branch: ${branch})...`);
    // Use --rebase to avoid merge commits and keep clean linear history
    run(`git pull --rebase origin ${branch}`);

    /**
     * STEP 8: Reinstall Dependencies
     * Updates npm packages to versions specified in package-lock.json
     * --prefer-offline: Uses cached packages when possible
     */
    log('Updating dependencies...');
    run('npm install --prefer-offline');

    /**
     * STEP 8b: Build TypeScript sources (already compiled by prepare hook during npm install)
     */
    log('TypeScript sources built during npm install prepare hook.');

    /**
     * STEP 8c: Regenerate Ecosystem Config
     * Ensures profiles/ecosystem.config.js reflects the current bots.json
     * state, including service apps like dexbot-adapter and dexbot-update.
     * Uses the compiled dist/pm2.js (after TS build) for correct dist/ paths.
     */
    log('Regenerating PM2 ecosystem config...');
    try {
        // Try loading from compiled dist/ first, then fall back to source dir
        let generateEcosystemConfig;
        try {
            ({ generateEcosystemConfig } = require(path.join(ROOT, 'dist', 'pm2')));
        } catch (_) {
            ({ generateEcosystemConfig } = require(path.join(ROOT, 'pm2')));
        }
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        log('Ecosystem config regenerated successfully.');
    } catch (err) {
        log(`Warning: Ecosystem config regeneration failed (${err.message}). Continuing with existing config.`);
    }

    /**
     * STEP 9: Reload Active PM2 Processes
     * Intelligently reloads only the bots that were active before update
     * This approach:
     * - Preserves PM2 state if not running
     * - Reloads active bots to pick up code changes
     * - Handles missing bots.json gracefully
     * - Never reloads dexbot-cred through bulk PM2 actions
     */
    log('Reloading active runtime processes...');
    try {
        if (process.env.DEXBOT_UPDATE_SKIP_RELOAD === '1') {
            log('Reload skipped (managed by launcher).');
        } else {
            const monolithic = detectMonolithicRuntime();
            if (monolithic) {
                restartMonolithicRuntime(monolithic);
            } else if (await reloadActiveIsolatedProcesses()) {
                log('Isolated supervisor runtime restarted.');
            } else {
                const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
                if (fs.existsSync(BOTS_FILE)) {
                    const raw = fs.readFileSync(BOTS_FILE, 'utf8');
                    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
                    const config = JSON.parse(stripped);

                    const activeInConfig = (config.bots || [])
                        .filter(b => b.active !== false)
                        .map(b => b.name)
                        .filter(name => !!name);

                    if (activeInConfig.length > 0) {
                        let runningProcesses = [];
                        try {
                            const output = execSync('pm2 jlist').toString().trim();
                            const jsonStart = output.indexOf('[');
                            if (jsonStart !== -1) {
                                const jsonPart = output.substring(jsonStart);
                                const parsed = JSON.parse(jsonPart);
                                runningProcesses = parsed.map(p => p.name);
                            } else {
                                log('Warning: PM2 jlist output did not contain JSON array.');
                            }
                        } catch (e) {
                            log('Warning: Could not fetch PM2 process list. Falling back to config-only detection.');
                            runningProcesses = activeInConfig;
                        }

                        const botsToReload = activeInConfig.filter(name => runningProcesses.includes(name));
                        const activeBots = (config.bots || []).filter(b => b.active !== false);
                        const runningActiveBots = activeBots.filter(b => runningProcesses.includes(b.name));
                        let needsMarketAdapter;
                        try {
                            ({ needsMarketAdapter } = require(path.join(ROOT, 'dist', 'pm2')));
                        } catch (_) {
                            ({ needsMarketAdapter } = require(path.join(ROOT, 'pm2')));
                        }
                        const marketAdapterRequired = needsMarketAdapter(runningActiveBots);

                        const serviceAppsToReload = marketAdapterRequired ? ['dexbot-adapter'] : [];
                        const servicesToReload = serviceAppsToReload.filter(name => runningProcesses.includes(name));
                        const allToReload = [...botsToReload, ...servicesToReload];

                        if (allToReload.length > 0) {
                            log(`Active processes detected: ${allToReload.join(', ')}`);
                            for (const name of allToReload) {
                                try {
                                    run(`pm2 reload "${name}"`);
                                } catch (e) {
                                    log(`Warning: Failed to reload process "${name}" (it might not be running).`);
                                }
                            }
                        } else {
                            log('No active processes currently running in PM2. Skipping reload.');
                        }

                        if (marketAdapterRequired && !runningProcesses.includes('dexbot-adapter')) {
                            log('dexbot-adapter is required by an AMA-grid bot but not running. Starting from ecosystem...');
                            try {
                                run('pm2 start profiles/ecosystem.config.js --only dexbot-adapter');
                            } catch (e) {
                                log('Warning: Failed to start dexbot-adapter from ecosystem config.');
                            }
                        }
                    } else {
                        log('No active bots found in config.');
                    }
                } else {
                    log('Warning: profiles/bots.json not found, skipping selective reload.');
                }
            }
        }
    } catch (err) {
        log(`Warning: runtime reload logic failed (${err.message}). Skipping bulk reload to avoid touching dexbot-cred.`);
    }


    log('DEXBot2 update completed successfully.');
    process.exit(0);
} catch (err) {
    console.error('==========================================');
    console.error('UPDATE FAILED');
    console.error('Error:', err.message);
    console.error('==========================================');
    process.exit(1);
}
})();
export {};
