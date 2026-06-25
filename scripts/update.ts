#!/usr/bin/env node

/**
 * DEXBot2 Auto-Update Script
 *
 * Manages pulling latest code from git repository with smart logic:
 * - Fetches from configured remote repository
 * - Detects if updates are available
 * - Handles branch switching if needed
 * - Reinstalls npm dependencies
 * - Selectively restarts active runtime processes
 * - Gracefully handles missing files or PM2
 *
 * Configuration:
 * - Repository URL: Hardcoded in modules/constants.ts (UPDATER.REPOSITORY_URL)
 * - Target branch: Configurable in constants.ts (UPDATER.BRANCH), supports 'auto' for auto-detection
 *
 * Exit codes:
 * - 0: Update completed successfully (or already up-to-date)
 * - 1: Update failed (with error details printed)
 *
 * Usage: tsx scripts/update.ts
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sendControlCommand } = require('../modules/launcher/supervisor_control');

// Import update configuration from constants
// Contains: REPOSITORY_URL, BRANCH, BUILD_DIR settings
const { UPDATER, BUILD_DIR } = require('../modules/constants');
const { PATHS } = require('../modules/paths');
const { Config } = require('../modules/config');
const { readJSON } = require('../modules/utils/fs_utils');


const UPDATE_COLORS = {
    reset: '\x1b[0m',
    ok: '\x1b[1;92m',
    error: '\x1b[1;31m',
};

function colorUpdateOutput(text: string, color: string, stream: NodeJS.WriteStream = process.stdout) {
    return stream.isTTY && !Config.NO_COLOR
        ? `${color}${text}${UPDATE_COLORS.reset}`
        : text;
}

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

function logSuccess(msg) {
    console.log(colorUpdateOutput(`[${new Date().toISOString()}] [UPDATE] ${msg}`, UPDATE_COLORS.ok));
}

function updateError(msg) {
    return colorUpdateOutput(msg, UPDATE_COLORS.error, process.stderr);
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
        execSync(cmd, { stdio: 'inherit', cwd: PATHS.PROJECT_ROOT });
    } catch (err) {
        console.error(updateError(`[ERROR] Command failed: ${cmd}`));
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
    const wrapperPid = readLivePidFile(PATHS.PROFILES.MONOLITHIC_PID);
    if (!wrapperPid) return null;

    const detected = { wrapperPid, botPid: readLivePidFile(PATHS.PROFILES.MONOLITHIC_BOT_PID), botNames: [] };
    try {
        const info = readJSON(PATHS.PROFILES.MONOLITHIC_BOT_INFO);
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

    log(`Monolithic runtime detected (${details}). Restarting via unlock control...`);
    const unlockPath = fs.existsSync(path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'unlock.js'))
        ? path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'unlock.js')
        : path.join(PATHS.PROJECT_ROOT, 'unlock.js');
    run(`node "${unlockPath}" restart all`);
}

async function detectIsolatedSupervisor(): Promise<Record<string, any> | null> {
    try {
        const resp: any = await sendControlCommand({ cmd: 'status' });
        return resp?.ok ? (resp.status as Record<string, any>) || {} : null;
    } catch (_) {
        return null;
    }
}

async function restartActiveIsolatedProcesses() {
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
    process.chdir(PATHS.PROJECT_ROOT);
    log('Starting DEXBot2 update process...');

    // Get configured repository URL and target branch
    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

    /**
     * STEP 1: Validate Git Repository
     * Ensures .git directory exists so we can perform git operations
     */
    if (!fs.existsSync(path.join(PATHS.PROJECT_ROOT, '.git'))) {
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
        const currentRemote = execSync('git remote get-url origin', { stdio: 'pipe' }).toString().trim();
        log(`Remote origin already configured (${currentRemote}). Keeping existing remote.`);
    } catch (e) {
        // Remote doesn't exist, add it from config
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
     *    - Action: Proceed with full update (pull, npm install, restart runtimes)
     */
    if (!updatesAvailable) {
        // No updates available - check if branch switch is needed
        if (branchSwitchNeeded) {
            log(`Aligning branch reference: ${currentBranch} -> ${branch} (no incoming updates).`);
            run(`git checkout ${branch}`);
            log('DEXBot2 is now tracking the correct branch.');
        }
        log('DEXBot2 is already up to date (local is equal or ahead of remote).');
        process.exit(0);
    }

    log(`${incomingCommits} update(s) available. Proceeding with update process...`);

    // List changes
    console.log('\n----------------------------------------------------------------');
    console.log('Incoming Changes:');
    try {
        execSync(`git log --oneline --graph --decorate HEAD..origin/${branch}`, { stdio: 'inherit', cwd: PATHS.PROJECT_ROOT });
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
    const STASH_MESSAGE = 'dexbot-update-auto';
    let ourStashRef = '';
    log('Stashing local changes before pull...');
    run(`git stash push --include-untracked --message "${STASH_MESSAGE}" 2>/dev/null; true`);
    // Capture the stash ref by message so we pop the exact entry after pull,
    // avoiding ambiguity if any other stash operation occurs between push and pop.
    try {
        const list = execSync(`git stash list --format="%gd %gs" 2>/dev/null`, { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        if (list) {
            for (const line of list.split('\n')) {
                if (line.includes(STASH_MESSAGE)) {
                    ourStashRef = line.split(' ')[0];
                    break;
                }
            }
        }
    } catch (_) {
        log('Debug: Could not enumerate stash list to resolve stash ref. Skipping pop.');
    }

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
     * Restore our stashed entry by ref (if we created one).
     * Using the captured ref prevents accidentally popping a stash that was
     * created by another process between push and pop.
     */
    if (ourStashRef) {
        try {
            execSync(`git stash pop ${ourStashRef}`, { stdio: 'inherit', cwd: PATHS.PROJECT_ROOT });
            // Check for unmerged paths that git stash pop may have left behind.
            // git diff --diff-filter=U catches all asymmetric variants (AU, UA, DU, UD)
            // in addition to the symmetric ones (UU, AA, DD).
            const unmerged = execSync('git diff --name-only --diff-filter=U', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
            if (unmerged) {
                log('Warning: Stash pop completed with merge conflicts. Run `git status` to resolve unresolved files.');
            }
        } catch (err) {
            log(`Warning: Could not restore stashed changes (merge conflicts may exist). ` +
                `Check \`git stash list\` for "${STASH_MESSAGE}" entry.`);
            if (err.message) log(`Details: ${err.message}`);
        }
    }

    /**
     * STEP 8: Reinstall Dependencies
     * Updates npm packages to versions specified in package-lock.json.
     * --ignore-scripts prevents npm from running the package `prepare` hook,
     * which would build once here before the explicit build step below.
     * --prefer-offline: Uses cached packages when possible
     */
    log('Updating dependencies...');
    run('npm install --prefer-offline --ignore-scripts');

    /**
     * STEP 8b: Build TypeScript sources
     *
     * Do NOT rely on the npm `prepare` hook. The `prepare` script only re-fires
     * when package.json itself changes, not when only .ts source files are
     * updated. After a `git pull` that touches only .ts files, `npm install`
     * is a no-op, `tsc` never runs, and the running bot process keeps loading
     * the stale dist/ bundle — with no error surfaced to the operator.
     *
     * Always run the explicit build here so the next PM2 restart picks up
     * the new code. The staleness check at the end of this step is defense
     * in depth: if the build silently no-ops (e.g. tsc crashed, output path
     * missing), the update aborts before PM2 is restarted.
     */
    log('Building TypeScript sources (npm run build)...');
    run('npm run build');

    const SOURCE_MARKER = path.join(PATHS.PROJECT_ROOT, 'modules', 'dexbot_class.ts');
    const DIST_MARKER = path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'modules', 'dexbot_class.js');
    if (fs.existsSync(SOURCE_MARKER)) {
        if (!fs.existsSync(DIST_MARKER)) {
            throw new Error(
                `Build did not produce ${BUILD_DIR}/modules/dexbot_class.js. ` +
                `Refusing to restart PM2 with a missing bundle. ` +
                `Run \`npm run build\` manually and inspect tsc output.`
            );
        }

        const srcStat = fs.statSync(SOURCE_MARKER);
        const distStat = fs.statSync(DIST_MARKER);
        if (distStat.mtimeMs < srcStat.mtimeMs) {
            throw new Error(
                `Build did not refresh ${BUILD_DIR}/modules/dexbot_class.js ` +
                `(src mtime=${srcStat.mtime.toISOString()}, ` +
                `${BUILD_DIR} mtime=${distStat.mtime.toISOString()}). ` +
                `Refusing to restart PM2 with a stale bundle. ` +
                `Run \`npm run build\` manually and inspect tsc output.`
            );
        }
        log(`${BUILD_DIR}/ is fresh (mtime=${distStat.mtime.toISOString()}).`);
    }

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
            ({ generateEcosystemConfig } = require(path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'pm2')));
        } catch (_) {
            ({ generateEcosystemConfig } = require(path.join(PATHS.PROJECT_ROOT, 'pm2')));
        }
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        logSuccess('Ecosystem config regenerated successfully.');
    } catch (err) {
        log(`Warning: Ecosystem config regeneration failed (${err.message}). Continuing with existing config.`);
    }

    /**
     * STEP 9: Restart Active Runtime Processes
     * Intelligently restarts only the bots that were active before update
     * This approach:
     * - Preserves PM2 state if not running
     * - Restarts active bots to pick up code changes
     * - Handles missing bots.json gracefully
     * - Never restarts dexbot-cred through bulk PM2 actions
     */
    log('Restarting active runtime processes...');
    try {
        if (Config.DEXBOT_UPDATE_SKIP_RELOAD) {
            log('Restart skipped (managed by launcher).');
        } else {
            const monolithic = detectMonolithicRuntime();
            if (monolithic) {
                restartMonolithicRuntime(monolithic);
            } else if (await restartActiveIsolatedProcesses()) {
                log('Isolated supervisor runtime restarted.');
            } else {
                const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
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

                        const botsToRestart = activeInConfig.filter(name => runningProcesses.includes(name));
                        const activeBots = (config.bots || []).filter(b => b.active !== false);
                        const runningActiveBots = activeBots.filter(b => runningProcesses.includes(b.name));
                        let needsMarketAdapter;
                        try {
                            ({ needsMarketAdapter } = require(path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'pm2')));
                        } catch (_) {
                            ({ needsMarketAdapter } = require(path.join(PATHS.PROJECT_ROOT, 'pm2')));
                        }
                        const marketAdapterRequired = needsMarketAdapter(runningActiveBots);

                        const serviceAppsToRestart = marketAdapterRequired ? ['dexbot-adapter'] : [];
                        const servicesToRestart = serviceAppsToRestart.filter(name => runningProcesses.includes(name));
                        const allToRestart = [...botsToRestart, ...servicesToRestart];

                        if (allToRestart.length > 0) {
                            log(`Active processes detected: ${allToRestart.join(', ')}`);
                            for (const name of allToRestart) {
                                try {
                                    run(`pm2 restart "${name}"`);
                                } catch (e) {
                                    log(`Warning: Failed to restart process "${name}" (it might not be running).`);
                                }
                            }
                        } else {
                            log('No active processes currently running in PM2. Skipping restart.');
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
                    log('Warning: profiles/bots.json not found, skipping selective restart.');
                }
            }
        }
    } catch (err) {
        log(`Warning: runtime restart logic failed (${err.message}). Skipping bulk restart to avoid touching dexbot-cred.`);
    }


    logSuccess('DEXBot2 update completed successfully.');
    process.exit(0);
} catch (err) {
    console.error(updateError('=========================================='));
    console.error(updateError('UPDATE FAILED'));
    console.error(updateError(`Error: ${err.message}`));
    console.error(updateError('=========================================='));
    process.exit(1);
}
})();
export {};
