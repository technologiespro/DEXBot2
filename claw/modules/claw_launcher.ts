'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chainKeys = require('../../modules/chain_keys');
const { loadSettingsFile, resolveRawBotEntries, saveSettingsFile, normalizeBotEntries } = require('../../modules/bot_settings');
const { detectMode, setPreferredMode, describeModeChoice } = require('./launcher_mode_detector');
const { normalizeRoot, normalizeProfileDir, resolveRuntimeScript } = require('./launcher_paths');

const {
  stopPM2Processes,
  deletePM2Processes,
  restartPM2Processes,
  reloadPM2Processes,
  generateEcosystemConfig,
  startManagedRuntimePM2,
  buildEcosystemApps,
} = require('../../pm2');

/**
 * Start a bot directly (foreground, spawned as detached child process).
 * Returns immediately with PID and command info.
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}] - Options including profileRoot
 * @returns {Promise<Object>} { started: true, botName, pid, command }
 */
async function launcherStart(botName, options = {}) {
  const ROOT = normalizeRoot(options);
  const dexbotPath = resolveRuntimeScript(ROOT, 'dexbot.js');

  const args = ['start'];
  if (botName) {
    args.push(botName);
  }

  const child = spawn('node', [dexbotPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    botName: botName || 'default',
    pid: child.pid,
    command: `node dexbot start ${botName || '(default)'}`,
  };
}

/**
 * Dry-run a bot (no broadcast).
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { started: true, botName, pid, command, dryRun: true }
 */
async function launcherDrystart(botName, options = {}) {
  const ROOT = normalizeRoot(options);
  const dexbotPath = resolveRuntimeScript(ROOT, 'dexbot.js');

  const args = ['drystart'];
  if (botName) {
    args.push(botName);
  }

  const child = spawn('node', [dexbotPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    botName: botName || 'default',
    pid: child.pid,
    command: `node dexbot drystart ${botName || '(default)'}`,
    dryRun: true,
  };
}

/**
 * Reset a bot grid (writes trigger file).
 * @param {string|null} botName - Bot name or null for all active
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { reset: true, targets: [...] }
 */
async function launcherReset(botName, options = {}) {
  const PROFILES_DIR = normalizeProfileDir(options);
  const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');

  const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = normalizeBotEntries(resolveRawBotEntries(config));

  const targets = botName ? entries.filter(b => b.name === botName) : entries.filter(b => b.active);

  if (botName && targets.length === 0) {
    throw new Error(`Bot '${botName}' not found in profiles/bots.json`);
  }

  const triggered = [];

  for (const bot of targets) {
    try {
      const triggerFile = path.join(PROFILES_DIR, `recalculate.${bot.botKey}.trigger`);
      fs.writeFileSync(triggerFile, new Date().toISOString());
      triggered.push({
        botName: bot.name,
        triggerFile: path.basename(triggerFile),
      });
    } catch (err: any) {
      throw new Error(`Failed to write trigger for '${bot.name}': ${err.message}`);
    }
  }

  return {
    reset: true,
    targets: triggered,
  };
}

/**
 * Disable a bot in config.
 * @param {string|null} botName - Bot name or null for all
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { disabled: true, targets: [...] } or { disabled: false, reason: '...' }
 */
async function launcherDisable(botName, options = {}) {
  const PROFILES_DIR = normalizeProfileDir(options);
  const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');

  const { config, filePath } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = resolveRawBotEntries(config);

  if (!botName) {
    // Disable all
    let updated = false;
    entries.forEach(entry => {
      if (entry.active !== false) {
        entry.active = false;
        updated = true;
      }
    });

    if (!updated) {
      return { disabled: false, reason: 'No active bots to disable' };
    }

    saveSettingsFile(config, filePath);
    return {
      disabled: true,
      targets: entries.map(b => ({ botName: b.name, active: false })),
    };
  }

  const match = entries.find(b => b.name === botName);
  if (!match) {
    throw new Error(`Bot '${botName}' not found in profiles/bots.json`);
  }

  if (match.active === false) {
    return { disabled: false, reason: `Bot '${botName}' is already inactive` };
  }

  match.active = false;
  saveSettingsFile(config, filePath);

  return {
    disabled: true,
    targets: [{ botName: botName, active: false }],
  };
}

/**
 * Start bots via PM2 (production-grade, managed).
 * Requires credential daemon to already be running.
 * @param {string|null} botName - Bot name or null for all active
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { started: true, targets: [{ botName, pm2: true }] }
 */
async function launcherPm2Start(botName, options = {}) {
  const ROOT = normalizeRoot(options);
  const PROFILES_DIR = normalizeProfileDir(options);
  const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');

  // Validate bot configuration first (better error message)
  const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = normalizeBotEntries(resolveRawBotEntries(config));

  const targets = botName ? entries.filter(b => b.name === botName) : entries.filter(b => b.active);

  if (botName && targets.length === 0) {
    throw new Error(`Bot '${botName}' not found or not active in profiles/bots.json`);
  }

  // Then check if daemon is ready
  if (!(await chainKeys.isDaemonResponsive())) {
    throw new Error(
      'Credential daemon is not running. Start it first with: node pm2 or node unlock-start'
    );
  }

  // Generate ecosystem config and get apps array
  generateEcosystemConfig({ clawOnly: false, exitOnError: false });
  const apps = buildEcosystemApps({ clawOnly: false });

  // Filter apps if specific bot requested
  let appsToStart = apps;
  if (botName) {
    appsToStart = apps.filter(app => app.name === botName);
    if (appsToStart.length === 0) {
      throw new Error(`No PM2 app found for bot '${botName}'`);
    }
  }

  // Start via pm2 without bootstrap (daemon already running)
  await startManagedRuntimePM2({ apps: appsToStart });

  return {
    started: true,
    targets: targets.map(b => ({ botName: b.name, pm2: true })),
  };
}

/**
 * Stop bot processes via PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { stopped: true, target }
 */
async function launcherPm2Stop(target, options = {}) {
  await stopPM2Processes(target || 'all');
  return {
    stopped: true,
    target: target || 'all',
  };
}

/**
 * Delete bot processes from PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { deleted: true, target }
 */
async function launcherPm2Delete(target, options = {}) {
  await deletePM2Processes(target || 'all');
  return {
    deleted: true,
    target: target || 'all',
  };
}

/**
 * Restart bot processes via PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { restarted: true, target }
 */
async function launcherPm2Restart(target, options = {}) {
  await restartPM2Processes(target || 'all');
  return {
    restarted: true,
    target: target || 'all',
  };
}

/**
 * Reload bot processes via PM2 (zero-downtime).
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { reloaded: true, target }
 */
async function launcherPm2Reload(target, options = {}) {
  await reloadPM2Processes(target || 'all');
  return {
    reloaded: true,
    target: target || 'all',
  };
}

/**
 * Unified launcher command: auto-detects deployment mode and runs accordingly.
 *
 * Flow:
 *   1. Detect mode (stored preference, or suggest based on bot config)
 *   2. If user needs to choose, return choices for MCP/CLI to handle
 *   3. If mode is known, delegate to appropriate implementation
 *   4. Store choice if user provided deploymentMode override
 *
 * @param {string|null} botName - Bot name or null for default/all
 * @param {Object} [options={}] - Options
 * @param {string} [options.deploymentMode] - Override mode: dexbot-direct, pm2, unlock-start, claw-only
 * @param {boolean} [options.setPreference] - If true, save deploymentMode as preferred
 * @param {string} [options.profileRoot] - Optional profile root
 * @returns {Promise<Object>}
 *   Delegated modes: { started: true, mode?, botName?, pid?, command?, targets?, message?, warning? }
 *   Mode present in claw-only / unlock-start; absent in dexbot-direct / pm2.
 *   No-mode: { needsChoice: true, reason, choices: [{ mode, description }], message }
 */
async function launcherRun(botName, options = {}) {
  const detection = detectMode(options);

  // User is overriding the mode
  if (options.deploymentMode) {
    const validModes = ['dexbot-direct', 'pm2', 'unlock-start', 'claw-only'];
    if (!validModes.includes(options.deploymentMode)) {
      throw new Error(`Invalid deploymentMode: ${options.deploymentMode}. Must be one of: ${validModes.join(', ')}`);
    }

    // Note if botName is provided for claw-only mode (will be ignored)
    const clawOnlyWarning = (options.deploymentMode === 'claw-only' && botName)
      ? `botName '${botName}' is ignored in claw-only mode (daemon does not target specific bots)`
      : null;

    // Save as preference if requested
    if (options.setPreference) {
      setPreferredMode(options.deploymentMode, options);
    }

    // Delegate to appropriate implementation
    const result = await (async () => {
      switch (options.deploymentMode) {
        case 'dexbot-direct':
          return launcherStart(botName, options);
        case 'pm2':
          return launcherPm2Start(botName, options);
        case 'unlock-start':
          return launcherUnlockStart(botName, options);
        case 'claw-only':
          return launcherClawOnly(options);
      }
    })();
    if (clawOnlyWarning) result.warning = clawOnlyWarning;
    return result;
  }

  // Mode is known from stored preference
  if (detection.mode) {
    switch (detection.mode) {
      case 'dexbot-direct':
        return launcherStart(botName, options);
      case 'pm2':
        return launcherPm2Start(botName, options);
      case 'unlock-start':
        return launcherUnlockStart(botName, options);
      case 'claw-only':
        return launcherClawOnly(options);
    }
  }

  // No mode set and user hasn't chosen — ask them
  return {
    needsChoice: true,
    reason: detection.reason,
    choices: detection.choices.map(mode => ({
      mode,
      description: describeModeChoice(mode)
    })),
    message: 'Please choose a deployment mode for launcher-run. Provide it in the next call as deploymentMode parameter and set setPreference:true to save your choice.'
  };
}

/**
 * Start credential daemon only (claw-only mode).
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function launcherClawOnly(options = {}) {
  const ROOT = normalizeRoot(options);
  const pm2ScriptPath = resolveRuntimeScript(ROOT, 'pm2.js');

  const child = spawn('node', [pm2ScriptPath, 'claw-only'], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    mode: 'claw-only',
    message: 'Credential daemon started in background (PM2 managed)',
    pid: child.pid,
    command: 'node pm2 claw-only'
  };
}

/**
 * Start via unlock-start (single password prompt, no PM2).
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function launcherUnlockStart(botName, options = {}) {
  const ROOT = normalizeRoot(options);
  const unlockStartPath = resolveRuntimeScript(ROOT, 'unlock-start.js');

  const args = [];
  if (botName) {
    args.push(botName);
  }

  const child = spawn('node', [unlockStartPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    mode: 'unlock-start',
    botName: botName || 'default',
    pid: child.pid,
    command: `node unlock-start ${botName || '(default)'}`,
    message: 'Bots started via unlock-start (single password prompt, no PM2)'
  };
}

export = {
  launcherRun,
  launcherStart,
  launcherDrystart,
  launcherReset,
  launcherDisable,
  launcherPm2Start,
  launcherPm2Stop,
  launcherPm2Delete,
  launcherPm2Restart,
  launcherPm2Reload,
  launcherClawOnly,
  launcherUnlockStart,
};
