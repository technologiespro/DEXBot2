const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BitShares } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const Grid = require('./order/grid');
const { ORDER_STATES, ORDER_TYPES, TIMING, GRID_LIMITS, FEE_PARAMETERS, BTS_PRECISION, NATIVE_CLIENT, BUILD_DIR } = require('./constants');
const { applyGridDivergenceCorrections, loadAmaCenterSnapshot } = require('./order/utils/system');
const { isPm2Runtime } = require('./order/logger');
const { getSharedMarketAdapterRuntime } = require('./launcher/market_adapter_runtime');
const {
    resetMarketAdapterWhitelistCache,
    isBotDynamicWeightWhitelisted,
} = require('./market_adapter_whitelist');
const Format = require('./order/format');
const { parseJsonWithComments } = require('./order/utils/system');
const { cloneWeightDistribution, calculateOrderCreationFees, calculateSwapInAmount, floatToBlockchainInt, blockchainToFloat } = require('./order/utils/math');
const { updateDynamicGridSnapshotSync } = require('../market_adapter/utils/dynamic_grid_snapshot');
const { reconcileGridOrders } = require('./order/grid_reconcile');
const { formatUnmatchedChainOrder, getSideBudget } = require('./order/utils/order');

const CODE_ROOT = path.join(__dirname, '..');
const ROOT = path.basename(CODE_ROOT) === BUILD_DIR ? path.dirname(CODE_ROOT) : CODE_ROOT;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');
const LOGS_DIR = path.join(PROFILES_DIR, 'logs');
const MARKET_ADAPTER_APP_NAME = 'dexbot-adapter';
const MARKET_ADAPTER_SCRIPT = path.join(CODE_ROOT, 'market_adapter', 'market_adapter' + (path.basename(CODE_ROOT) === BUILD_DIR ? '.js' : '.ts'));
const MARKET_ADAPTER_ERROR_FILE = path.join(LOGS_DIR, 'dexbot-adapter-error.log');
const MARKET_ADAPTER_OUT_FILE = path.join(LOGS_DIR, 'dexbot-adapter.log');
const MARKET_ADAPTER_TRIGGER_SOURCE = 'market_adapter/market_adapter' + (path.basename(CODE_ROOT) === BUILD_DIR ? '.js' : '.ts');
const MANUAL_TRIGGER_METADATA = {
    shouldRefreshCenterPrice: true,
    centerRefreshContext: 'manual grid resync',
    centerRefreshLabel: 'manual grid reset',
    resetSource: 'manual_grid_resync',
};
const MARKET_ADAPTER_TRIGGER_RESETS = Object.freeze({
    market_adapter_bootstrap: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA bootstrap grid resync',
        centerRefreshLabel: 'AMA bootstrap grid reset',
    },
    market_adapter_ama_slope_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA slope grid resync',
        centerRefreshLabel: 'AMA slope grid reset',
    },
    market_adapter_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA center grid resync',
        centerRefreshLabel: 'AMA center grid reset',
    },
});
const GRID_RESYNC_REASONS = Object.freeze({
    ...MARKET_ADAPTER_TRIGGER_RESETS,
    manual_grid_resync: MANUAL_TRIGGER_METADATA,
    rms_structural_grid_resync: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'RMS structural grid resync',
        centerRefreshLabel: 'RMS structural grid resync',
    },
});

/**
 * Check if a bot configuration uses an AMA grid price source.
 * @param {Object} bot - Bot configuration object
 * @returns {boolean} True if gridPrice starts with 'ama' (ama, ama1..ama4)
 */
function usesAmaGridPrice(bot) {
    const gridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

/**
 * Find a bot entry in the bots config snapshot that matches a runtime config.
 * Matches by botKey or name.
 * @param {import('./types').BotsConfigSnapshot} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {Object|null} Matched bot entry or null
 */
function findSnapshotBotForRuntimeConfig(snapshot, config) {
    if (!snapshot || !Array.isArray(snapshot.activeBots) || !config) {
        return null;
    }

    const botKey = config.botKey ? String(config.botKey) : null;
    const name = config.name ? String(config.name) : null;
    return snapshot.activeBots.find((bot) => {
        if (!bot) return false;
        if (botKey && String(bot.botKey || '') === botKey) return true;
        if (name && String(bot.name || '') === name) return true;
        return false;
    }) || null;
}

/**
 * Check if a runtime bot configuration requires the market adapter.
 * @param {import('./types').BotsConfigSnapshot} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {boolean} True if the bot uses AMA grid pricing
 */
function runtimeConfigNeedsMarketAdapter(snapshot, config) {
    const snapshotBot = findSnapshotBotForRuntimeConfig(snapshot, config);
    if (snapshotBot) {
        return usesAmaGridPrice(snapshotBot);
    }
    return usesAmaGridPrice(config);
}

function countLiveGridOrders(manager, type) {
    if (!manager) return 0;
    const active = manager.getOrdersByTypeAndState?.(type, ORDER_STATES.ACTIVE) || [];
    const partial = manager.getOrdersByTypeAndState?.(type, ORDER_STATES.PARTIAL) || [];
    return active.concat(partial).filter(o => o?.orderId).length;
}

function getTargetActiveOrders(config, side) {
    const configured = Number(config?.activeOrders?.[side]);
    return Math.max(0, Number.isFinite(configured) ? configured : 1);
}

function _hasBudgetForSide(manager, config, side) {
    try {
        const funds = manager?.getChainFundsSnapshot?.();
        if (!funds) return true;
        const allocated = side === 'buy' ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
        if (allocated <= 0) return false;
        const targetBuy = Math.max(0, config?.activeOrders?.buy || 1);
        const targetSell = Math.max(0, config?.activeOrders?.sell || 1);
        const totalTarget = targetBuy + targetSell;
        const budget = getSideBudget(side, funds, config, totalTarget);
        return budget > 0;
    } catch { return true; }
}

function getTargetedSyncReason(bot) {
    if (!bot.manager || bot.config?.dryRun) return null;

    const targetBuy = getTargetActiveOrders(bot.config, 'buy');
    const targetSell = getTargetActiveOrders(bot.config, 'sell');
    const liveBuy = countLiveGridOrders(bot.manager, ORDER_TYPES.BUY);
    const liveSell = countLiveGridOrders(bot.manager, ORDER_TYPES.SELL);
    const shortfalls = [];

    if (liveBuy < targetBuy) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'buy')) {
            shortfalls.push(`buy ${liveBuy}/${targetBuy}`);
        }
    }
    if (liveSell < targetSell) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'sell')) {
            shortfalls.push(`sell ${liveSell}/${targetSell}`);
        }
    }

    const drift = bot.manager.checkFundDriftAfterFills?.();
    if (drift && drift.isValid === false) {
        return { reason: `fund drift: ${drift.reason}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    if (shortfalls.length > 0) {
        return { reason: `active order shortfall: ${shortfalls.join(', ')}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    return null;
}

async function maybeRunTargetedDriftReconciliation(context) {
    const trigger = getTargetedSyncReason(this);
    if (!trigger) return false;

    const now = Date.now();
    const cooldownMs = Number.isFinite(Number(this._targetedDriftSyncCooldownMs))
        ? Number(this._targetedDriftSyncCooldownMs)
        : 60_000;
    const lastSyncAt = Number(this._lastTargetedDriftSyncAt || 0);
    if (lastSyncAt > 0 && now - lastSyncAt < cooldownMs) {
        this._log(
            `[TARGETED-SYNC] Deferring ${context} reconciliation for ${Math.ceil((cooldownMs - (now - lastSyncAt)) / 1000)}s: ${trigger.reason}`,
            'debug'
        );
        return false;
    }

    if (!this.accountId || typeof chainOrders.readOpenOrders !== 'function') {
        this._warn(`[TARGETED-SYNC] Cannot reconcile ${context}: missing account id or readOpenOrders`);
        return false;
    }

    this._log(`[TARGETED-SYNC] Fetching open orders during ${context}: ${trigger.reason}`, 'warn');

    try {
        await this.manager.fetchAccountTotals?.(this.accountId);
        const { syncResult, openOrders, aborted } = await this._syncOpenOrdersAndProcessFills(`targeted ${context} reconciliation`);
        if (aborted) {
            this._warn(`[TARGETED-SYNC] Chain sync failed during ${context}, skipping reconciliation`);
            return false;
        }

        const remaining = getTargetedSyncReason(this);
        const unmatchedCount = Number(syncResult?.unmatchedChainOrders?.length || 0);
        if (remaining || unmatchedCount > 0) {
            this._log(
                `[TARGETED-SYNC] Running startup-style reconcile during ${context}: ` +
                `${remaining ? remaining.reason : `${unmatchedCount} unmatched chain order(s)`}`,
                'warn'
            );
            const reconcileResult = await reconcileGridOrders({
                manager: this.manager,
                config: this.config,
                account: this.account,
                privateKey: this.privateKey,
                chainOrders,
                chainOpenOrders: openOrders,
                fillLockAlreadyHeld: true,
            });
            await this._executeBatchIfNeeded(reconcileResult, `targeted ${context} reconcile`);
        }

        // Advance cooldown only after the sync (and optional reconcile) succeeds.
        // Previously this was set before the work, which meant a network blip
        // would lock out the next drift for the full cooldown even though no
        // useful work happened. With post-sync stamping, transient failures
        // retry on the next maintenance tick.
        this._lastTargetedDriftSyncAt = Date.now();
        await this.manager.persistGrid?.();
        return true;
    } catch (err) {
        this._warn(`[TARGETED-SYNC] Failed during ${context}: ${err.message}`);
        return false;
    }
}

/**
 * Load and fingerprint the bots.json configuration file.
 * @returns {import('./types').BotsConfigSnapshot} Snapshot with exists flag, fingerprint, active bots list, and adapter requirement
 */
function loadBotsConfigSnapshot() {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        return {
            exists: false,
            fingerprint: null,
            activeBots: [],
            needsMarketAdapter: false,
        };
    }

    const raw = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
    if (!raw || !raw.trim()) {
        return {
            exists: false,
            fingerprint: null,
            activeBots: [],
            needsMarketAdapter: false,
        };
    }

    const fingerprint = crypto.createHash('sha1').update(raw).digest('hex');
    const parsed = parseJsonWithComments(raw);
    const bots = Array.isArray(parsed?.bots) ? parsed.bots.filter(Boolean) : [];
    const activeBots = bots.filter((bot) => bot.active !== false);

    return {
        exists: true,
        fingerprint,
        config: parsed,
        activeBots,
        needsMarketAdapter: activeBots.some(usesAmaGridPrice),
    };
}

/**
 * Parse PM2 jlist command output to extract process names.
 * @param {string} stdout - Raw stdout from pm2 jlist
 * @returns {string[]} Array of process names
 * @throws {Error} If output cannot be parsed
 */
function parsePm2JlistOutput(stdout) {
    const output = String(stdout || '').trim();
    if (!output) return [];

    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) {
        throw new Error('pm2 jlist output did not contain JSON');
    }

    const parsed = JSON.parse(output.slice(jsonStart));
    if (!Array.isArray(parsed)) {
        throw new Error('pm2 jlist output was not an array');
    }

    return parsed.map((proc) => String(proc?.name || '')).filter(Boolean);
}

/**
 * Run a PM2 CLI command and return stdout/stderr.
 * @param {string[]} args - PM2 command arguments
 * @returns {Promise<{stdout: string, stderr: string}>} Command output
 * @throws {Error} If the command exits with non-zero code
 */
function runPm2Command(args): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn('pm2', args, {
            stdio: 'pipe',
            shell: process.platform === 'win32',
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(stderr || stdout || `pm2 exited with code ${code}`));
        });

        child.on('error', reject);
    });
}

/**
 * Get list of running PM2 process names.
 * @returns {Promise<string[]>} Array of process names
 */
async function getPm2ProcessNames() {
    const { stdout } = await runPm2Command(['jlist']);
    return parsePm2JlistOutput(stdout);
}

/**
 * Start the market adapter process under PM2.
 * @returns {Promise<void>}
 */
async function startMarketAdapterPm2() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const pm2Args = [
        'start',
        MARKET_ADAPTER_SCRIPT,
    ];
    if (path.basename(CODE_ROOT) !== BUILD_DIR) {
        pm2Args.push('--node-args', '--import', '--node-args', 'tsx');
    }
    pm2Args.push(
        '--name',
        MARKET_ADAPTER_APP_NAME,
        '--cwd',
        path.join(__dirname, '..'),
        '--output',
        MARKET_ADAPTER_OUT_FILE,
        '--error',
        MARKET_ADAPTER_ERROR_FILE,
        '--max-memory-restart',
        '150M',
        '--log-date-format',
        'YY-MM-DD HH:mm:ss.SSS',
    );
    await runPm2Command(pm2Args);
}

/**
 * Stop and delete the market adapter process from PM2.
 * @returns {Promise<void>}
 */
async function stopMarketAdapterPm2() {
    await runPm2Command(['delete', MARKET_ADAPTER_APP_NAME]);
}

/**
 * Synchronize market adapter state based on periodic config checks.
 * Starts or stops the market adapter based on whether any active bot uses AMA grid pricing.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string} [context='periodic'] - Context label for logging
 * @returns {Promise<import('./types').MarketAdapterSyncResult>}
 */
async function syncMarketAdapterOnPeriodicConfigCheck(context = 'periodic') {
    if (this._marketAdapterWatchdogInFlight) {
        return { skipped: true, reason: 'in-flight' };
    }

    this._marketAdapterWatchdogInFlight = true;

    try {
        const snapshot = typeof this._loadBotsConfigSnapshot === 'function'
            ? await this._loadBotsConfigSnapshot()
            : loadBotsConfigSnapshot();
        const previousFingerprint = this._marketAdapterWatchdogFingerprint || null;
        const changed = snapshot.fingerprint !== previousFingerprint;
        this._marketAdapterWatchdogFingerprint = snapshot.fingerprint;

        if (changed) {
            this._log(`Detected bots.json changes during ${context}; re-evaluating market adapter requirements.`);
        }

        if (!isPm2Runtime()) {
            const runtime = getSharedMarketAdapterRuntime({ root: ROOT });
            const botId = String(this.config?.botKey || this.config?.name || this.config?.preferredAccount || this.config?.assetA || 'dexbot');
            const botNeedsMarketAdapter = !!snapshot.exists && runtimeConfigNeedsMarketAdapter(snapshot, this.config);
            const required = !!snapshot.needsMarketAdapter || botNeedsMarketAdapter;
            const result = await runtime.syncBot(botId, botNeedsMarketAdapter);

            if (!snapshot.exists || !required) {
                if (result?.stopped) {
                    this._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are active.`, 'info');
                }
                return {
                    changed,
                    required: false,
                    running: !!result?.running,
                    started: false,
                    stopped: !!result?.stopped,
                    mode: 'direct',
                };
            }

            if (result?.started) {
                this._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');
            }

            return {
                changed,
                required,
                running: !!result?.running,
                started: !!result?.started,
                stopped: false,
                mode: 'direct',
            };
        }

        const getPm2ProcessNamesFn = typeof this._getPm2ProcessNames === 'function'
            ? this._getPm2ProcessNames.bind(this)
            : getPm2ProcessNames;
        const startMarketAdapterFn = typeof this._startMarketAdapterPm2 === 'function'
            ? this._startMarketAdapterPm2.bind(this)
            : startMarketAdapterPm2;
        const stopMarketAdapterFn = typeof this._stopMarketAdapterPm2 === 'function'
            ? this._stopMarketAdapterPm2.bind(this)
            : stopMarketAdapterPm2;

        let processNames = [];
        let pm2QueryFailed = false;
        try {
            processNames = await getPm2ProcessNamesFn();
        } catch (err: any) {
            pm2QueryFailed = true;
            this._warn(`Could not query PM2 for ${MARKET_ADAPTER_APP_NAME}: ${err.message}. Using a direct PM2 action.`);
        }

        // Cross-reference config-active bots against actually running PM2 processes
        // so we don't start the adapter for configured AMA bots that aren't running.
        const runningActiveBots = pm2QueryFailed
            ? snapshot.activeBots
            : snapshot.activeBots.filter((b) => processNames.includes(b.name));
        const needsAdapterForRunningBots = runningActiveBots.some(usesAmaGridPrice);

        if (!snapshot.exists || !needsAdapterForRunningBots) {
            const shouldStop = pm2QueryFailed || processNames.includes(MARKET_ADAPTER_APP_NAME);
            if (!shouldStop) {
                return {
                    changed,
                    required: false,
                    running: false,
                    started: false,
                    stopped: false,
                    mode: 'pm2',
                };
            }

            await stopMarketAdapterFn();
            this._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are running.`, 'info');
            return {
                changed,
                required: false,
                running: false,
                started: false,
                stopped: true,
                mode: 'pm2',
            };
        }

        if (processNames.includes(MARKET_ADAPTER_APP_NAME)) {
            return {
                changed,
                required: true,
                running: true,
                started: false,
                stopped: false,
                mode: 'pm2',
            };
        }

        await startMarketAdapterFn();
        this._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');

        return {
            changed,
            required: true,
            running: false,
            started: true,
            stopped: false,
            mode: 'pm2',
        };
    } catch (err: any) {
        this._warn(`Market adapter watchdog failed during ${context}: ${err.message}`);
        return {
            changed: false,
            required: false,
            running: false,
            started: false,
            stopped: false,
            error: err.message,
        };
    } finally {
        this._marketAdapterWatchdogInFlight = false;
    }
}

/**
 * Refresh the dynamic weight distribution from the AMA center snapshot.
 * Applies live dynamic weights if the bot is whitelisted and weights are ready.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string} [context='runtime'] - Context label for logging
 * @returns {import('./types').DynamicWeightRefreshResult}
 */
function refreshDynamicWeightDistribution(context = 'runtime') {
    const baseWeights = cloneWeightDistribution(
        this._baseWeightDistribution,
        this.config?.weightDistribution || this.manager?.config?.weightDistribution
    );

    if (!this.config || !this.manager || !this.config.botKey || !baseWeights) {
        return {
            applied: false,
            source: 'static',
            weightDistribution: baseWeights,
        };
    }

    const botKey = this.config.botKey;
    let nextWeights = baseWeights;
    let source = 'static';
    let snapshot = null;

    // Re-read the shared whitelist on every refresh so live flag changes apply
    // without requiring a bot restart.
    resetMarketAdapterWhitelistCache();
    if (isBotDynamicWeightWhitelisted(botKey)) {
        snapshot = loadAmaCenterSnapshot(botKey);
        const dw = snapshot?.dynamicWeights;
        const liveWeights = cloneWeightDistribution(dw?.effectiveWeights);
        if (dw?.isReady && liveWeights) {
            const snapshotBase = cloneWeightDistribution(dw?.baseWeights);
            const baseChanged = !snapshotBase
                || snapshotBase.sell !== baseWeights.sell
                || snapshotBase.buy !== baseWeights.buy;
            if (baseChanged) {
                this._log(
                    `Skipping stale dynamic weights (${context}): ` +
                    `snapshot base (sell=${snapshotBase?.sell}, buy=${snapshotBase?.buy}) ` +
                    `!= config (sell=${baseWeights.sell}, buy=${baseWeights.buy})`,
                    'warn'
                );
            } else {
                nextWeights = liveWeights;
                source = 'dynamic';
            }
        }
    }

    this.config.weightDistribution = { ...nextWeights };
    if (this.manager?.config) {
        this.manager.config.weightDistribution = { ...nextWeights };
    }

    if (source === 'dynamic') {
        this._log(
            `Applied live dynamic weights (${context}): sell=${nextWeights.sell} buy=${nextWeights.buy}`,
            'info'
        );
    }

    return {
        applied: source === 'dynamic',
        source,
        weightDistribution: nextWeights,
        snapshotUpdatedAt: snapshot?.updatedAt || null,
    };
}

/**
 * Read and parse a trigger file's metadata payload.
 * Determines whether the trigger originated from the market adapter or was manual.
 * @param {string} triggerFile - Path to the trigger file
 * @returns {import('./types').GridResyncMetadata} Parsed trigger metadata
 */
function readTriggerMetadata(triggerFile) {
    const manualTriggerMetadata = (payload = null) => ({
        ...buildGridResyncMetadata('manual_grid_resync'),
        payload,
    });

    const marketAdapterTriggerMetadata = (payload) => {
        const reason = String(payload?.reason || '').trim();
        return {
            ...buildGridResyncMetadata(reason || 'market_adapter_grid_resync'),
            payload,
        };
    };

    try {
        const raw = fs.readFileSync(triggerFile, 'utf8').trim();
        if (!raw) {
            // An empty trigger is the legacy/manual CLI reset signal.
            return manualTriggerMetadata();
        }

        const payload = JSON.parse(raw);
        const source = String(payload?.source || '').trim();
        return source === MARKET_ADAPTER_TRIGGER_SOURCE
            ? marketAdapterTriggerMetadata(payload)
            : manualTriggerMetadata(payload);
    } catch (_: any) {
        return manualTriggerMetadata();
    }
}

/**
 * Build grid resync metadata from a reason string.
 * Maps known reason strings to structured metadata with refresh flags.
 * @param {string} reason - Resync reason identifier (e.g. 'manual_grid_resync', 'rms_structural_grid_resync')
 * @returns {import('./types').GridResyncMetadata}
 */
function buildGridResyncMetadata(reason) {
    const resetSource = String(reason || '').trim() || 'dexbot_grid_resync';
    const defaults = {
        shouldRefreshCenterPrice: false,
        centerRefreshContext: 'grid resync',
        centerRefreshLabel: 'grid resync',
    };
    const marketAdapterUnknown = resetSource === 'market_adapter_grid_resync'
        ? {
            centerRefreshContext: 'market adapter grid resync',
            centerRefreshLabel: 'market adapter grid reset',
        }
        : null;
    return {
        ...defaults,
        ...marketAdapterUnknown,
        ...GRID_RESYNC_REASONS[resetSource],
        resetSource,
    };
}

/**
 * Build grid resync options from a reason string or metadata object.
 * @param {string|import('./types').GridResyncMetadata} reasonOrMetadata - Reason string or metadata object
 * @returns {import('./types').GridResyncOptions}
 */
function buildGridResyncOptions(reasonOrMetadata) {
    const metadata = typeof reasonOrMetadata === 'string'
        ? buildGridResyncMetadata(reasonOrMetadata)
        : reasonOrMetadata;
    return {
        refreshCenterPrice: !!metadata?.shouldRefreshCenterPrice,
        centerRefreshContext: metadata?.centerRefreshContext,
        centerRefreshLabel: metadata?.centerRefreshLabel,
        resetSource: metadata?.resetSource,
    };
}

/**
 * Promote the AMA center price to the grid center price in the dynamic grid snapshot.
 * Used during grid resets to align the grid center with the latest AMA calculation.
 * @param {string} botKey - Bot identifier key
 * @returns {boolean} True if promotion succeeded
 */
function promoteAmaCenterSnapshotForGridReset(botKey) {
    if (!botKey) return false;

    // Full grid resets rebuild from the latest AMA center. The active grid
    // baseline is promoted to that value before recalculation, while the raw
    // AMA output remains intact in amaCenterPrice for diagnostics.
    const snapshotPath = path.join(PROFILES_DIR, 'orders', `${botKey}.dynamicgrid.json`);
    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot) => {
            const amaCenterPrice = Number(snapshot?.amaCenterPrice);
            if (!Number.isFinite(amaCenterPrice) || amaCenterPrice <= 0) {
                return { ok: false, write: false };
            }

            const currentCenterPrice = Number(snapshot?.gridCenterPrice ?? snapshot?.centerPrice);
            if (Number.isFinite(currentCenterPrice) && currentCenterPrice === amaCenterPrice) {
                return { write: false };
            }

            return {
                ...snapshot,
                gridCenterPrice: amaCenterPrice,
                centerPrice: amaCenterPrice,
                updatedAt: new Date().toISOString(),
            };
        });
        return result.ok;
    } catch (_: any) {
        return false;
    }
}

/**
 * Update the grid reset metadata (last reset timestamp and source) in the dynamic grid snapshot.
 * @param {string} botKey - Bot identifier key
 * @param {Object} [options] - Reset metadata options
 * @param {string} [options.resetAt] - ISO timestamp for the reset (defaults to now)
 * @param {string} [options.resetSource] - Source label for the reset (defaults to 'dexbot_grid_resync')
 * @returns {boolean} True if metadata was written
 */
function updateBotGridResetMetadata(botKey, options: { resetAt?: string; resetSource?: string } = {}) {
    if (!botKey) return false;

    const resetAt = options.resetAt || new Date().toISOString();
    const resetSource = options.resetSource || 'dexbot_grid_resync';
    const snapshotPath = path.join(PROFILES_DIR, 'orders', `${botKey}.dynamicgrid.json`);

    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot) => {
            const gridCenterPrice = Number(snapshot?.gridCenterPrice ?? snapshot?.centerPrice);
            if (!Number.isFinite(gridCenterPrice) || gridCenterPrice <= 0) {
                return { ok: false, write: false };
            }
            return {
                ...snapshot,
                gridCenterPrice,
                centerPrice: gridCenterPrice,
                lastGridResetAt: resetAt,
                lastGridResetSource: resetSource,
                updatedAt: resetAt,
            };
        });
        return result.ok && result.written;
    } catch (_: any) {
        return false;
    }
}

/**
 * Perform a full grid resync: reload config, optionally refresh center price,
 * recalculate the grid, persist, and record reset metadata.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').GridResyncOptions} [options] - Grid resync options
 * @returns {Promise<boolean>} True if resync succeeded
 */
function performGridResync(options: {
    refreshCenterPrice?: boolean;
    centerRefreshContext?: string;
    centerRefreshLabel?: string;
    resetSource?: string;
} = {}) {
    const self = this;
    let success = false;
    const refreshCenterPrice = !!options.refreshCenterPrice;
    const centerRefreshContext = options.centerRefreshContext || (refreshCenterPrice ? 'grid reset recenter' : 'grid resync');
    const centerRefreshLabel = options.centerRefreshLabel || (refreshCenterPrice ? 'grid reset' : 'grid resync');
    const resetSource = options.resetSource || (refreshCenterPrice ? 'manual_grid_resync' : 'dexbot_grid_resync');
    if (self._dustSinceMap?.size > 0 && getPendingDustDelayMs(self) === null) {
        self._dustSinceMap.clear();
        self._log('[MAINT-IDLE] Cleared stale dust timer entries (all timers expired).', 'info');
    }
    const dustDelayMs = getPendingDustDelayMs(self);
    const idleDelayMs = getMaintenanceIdleDelayMs(self);
    if (dustDelayMs !== null || idleDelayMs > 0) {
        self._log(
            `[MAINT-IDLE] Deferring grid resync until bot is idle` +
            (dustDelayMs !== null ? ` and pending dust timer completes` : '') +
            ` (next check in ${Math.ceil(Math.max(dustDelayMs || 0, idleDelayMs) / 1000)}s)`,
            'info'
        );
        self._scheduleDustMaintenanceCheck?.();
        scheduleDeferredGridResync(self, options);
        return Promise.resolve(false);
    }

    self.manager.startBootstrap();
    self._log('Grid regeneration triggered. Performing full grid resync...');
    return (async () => {
        try {
            try {
                const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
                const allBotsConfig = parseJsonWithComments(content).bots || [];
                const myName = self.config.name;
                const updatedBot = allBotsConfig.find(b => b.name === myName);

                if (updatedBot) {
                    self._log(`Reloaded configuration for bot '${myName}'`);
                    const oldKey = self.config.botKey;
                    const oldIndex = self.config.botIndex;
                    self.config = { ...updatedBot, botKey: oldKey, botIndex: oldIndex };
                    self.manager.config = { ...self.manager.config, ...self.config };
                    self._baseWeightDistribution = cloneWeightDistribution(
                        updatedBot.weightDistribution,
                        self._baseWeightDistribution
                    );
                    refreshDynamicWeightDistribution.call(self, 'grid resync');
                }
            } catch (e: any) {
                self._warn(`Failed to reload config during resync (using current settings): ${e.message}`);
            }

            if (refreshCenterPrice) {
                if (promoteAmaCenterSnapshotForGridReset(self.config?.botKey)) {
                    self._log(`Refreshed AMA center snapshot for ${centerRefreshLabel}.`, 'info');
                    refreshDynamicWeightDistribution.call(self, centerRefreshContext);
                } else {
                    self._warn(`${centerRefreshLabel} requested but AMA center snapshot could not be refreshed.`);
                }
            }

            const readFn = () => chainOrders.readOpenOrders(self.accountId);
            await Grid.recalculateGrid(self.manager, {
                readOpenOrdersFn: readFn,
                chainOrders,
                account: self.account,
                privateKey: self.privateKey,
                config: self.config,
            });

            self.manager.funds.btsFeesOwed = 0;
            await self.manager.persistGrid();
            success = true;
            if (updateBotGridResetMetadata(self.config?.botKey, {
                resetAt: new Date().toISOString(),
                resetSource,
            })) {
                self._log('Recorded grid reset metadata for dynamic grid state.', 'info');
            }

            if (fs.existsSync(self.triggerFile)) {
                fs.unlinkSync(self.triggerFile);
                self._log('Removed trigger file.');
            }
        } catch (err: any) {
            self._log(`Error during triggered resync: ${err.message}`, 'error');
        } finally {
            self.manager.finishBootstrap();
        }

        return success;
    })();
}

/**
 * Handle a pending trigger file detected at startup or during runtime.
 * Processes the trigger and performs a grid resync if the trigger file exists.
 * @this {import('./dexbot_class').DEXBot}
 * @returns {Promise<boolean>} True if reset was handled successfully
 */
async function handlePendingTriggerReset() {
    if (!fs.existsSync(this.triggerFile)) {
        return false;
    }

    this._log('Pending trigger file detected. Processing reset before startup...');
    const triggerInfo = readTriggerMetadata(this.triggerFile);

    let resetSucceeded = false;
    await this.manager._fillProcessingLock.acquire(async () => {
        resetSucceeded = await this._performGridResync(buildGridResyncOptions(triggerInfo));
    });

    if (!resetSucceeded) {
        this._warn('Pending trigger reset failed. Continuing with normal startup path.');
    }

    return resetSucceeded;
}

/**
 * Set up a file watcher on the profiles directory to detect trigger file creation.
 * When a trigger file appears, debounces and processes the grid resync.
 * @this {import('./dexbot_class').DEXBot}
 * @returns {Promise<void>}
 */
async function setupTriggerFileDetection() {
    if (this._triggerWatcher && typeof this._triggerWatcher.close === 'function') {
        this._triggerWatcher.close();
        this._triggerWatcher = null;
    }

    if (this._triggerDebounceTimer) {
        clearTimeout(this._triggerDebounceTimer);
        this._triggerDebounceTimer = null;
    }

    try {
        this._triggerWatcher = fs.watch(PROFILES_DIR, (eventType, filename) => {
            try {
                if (this._shuttingDown) return;

                if (filename === path.basename(this.triggerFile)) {
                    if ((eventType === 'rename' || eventType === 'change') && fs.existsSync(this.triggerFile)) {
                        if (this._triggerDebounceTimer) clearTimeout(this._triggerDebounceTimer);
                        this._triggerDebounceTimer = setTimeout(() => {
                            this._triggerDebounceTimer = null;
                            const triggerInfo = readTriggerMetadata(this.triggerFile);
                            this.manager._fillProcessingLock.acquire(async () => {
                                const ok = await this._performGridResync(buildGridResyncOptions(triggerInfo));
                                if (!ok) {
                                    this._warn('Runtime trigger reset failed; retaining existing grid state.');
                                }
                            }).catch(err => {
                                this._warn(`Trigger reset lock error: ${err.message}`);
                            });
                        }, 200);
                    }
                }
            } catch (err: any) {
                this._warn(`fs.watch handler error: ${err && err.message ? err.message : err}`);
            }
        });
    } catch (err: any) {
        this._warn(`Failed to setup file watcher: ${err.message}`);
    }
}

/**
 * Perform periodic grid health checks (divergence, spread condition, dust detection).
 * Called as part of the periodic blockchain fetch interval.
 * @this {import('./dexbot_class').DEXBot}
 * @returns {Promise<void>}
 */
async function performPeriodicGridChecks() {
    await this._runGridMaintenance('periodic', { fillLockAlreadyHeld: true });
}

/**
 * Check if the continuous open-orders sync loop is enabled.
 * @returns {boolean} True if the sync loop is enabled in TIMING config
 */
function isOpenOrdersSyncLoopEnabled() {
    return !!TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED;
}

/**
 * Start the continuous open-orders sync loop.
 * Periodically reads on-chain orders and synchronizes with the grid manager.
 * @this {import('./dexbot_class').DEXBot}
 */
function startOpenOrdersSyncLoop() {
    if (this._mainLoopPromise) return;

    const hasPreferredEnvLoopDelay = Object.prototype.hasOwnProperty.call(process.env, 'OPEN_ORDERS_SYNC_LOOP_MS');
    const loopDelayRaw = hasPreferredEnvLoopDelay ? process.env.OPEN_ORDERS_SYNC_LOOP_MS : undefined;
    const hasEnvLoopDelay = loopDelayRaw !== undefined;
    const configuredLoopDelayMs = hasEnvLoopDelay ? Number(loopDelayRaw) : Number(TIMING.RUN_LOOP_DEFAULT_MS);
    const loopDelayMs = Number.isFinite(configuredLoopDelayMs) && configuredLoopDelayMs > 0
        ? configuredLoopDelayMs
        : Number(TIMING.RUN_LOOP_DEFAULT_MS);

    if (hasEnvLoopDelay && loopDelayMs !== configuredLoopDelayMs) {
        this._warn(`Invalid OPEN_ORDERS_SYNC_LOOP_MS='${loopDelayRaw}'. Falling back to default ${TIMING.RUN_LOOP_DEFAULT_MS}ms.`);
    }

    this._mainLoopActive = true;
    this._log(`Open-orders sync loop started (every ${loopDelayMs}ms, dryRun=${!!this.config.dryRun})`);
    const readOpenOrdersFn = chainOrders.readOpenOrders;

    this._mainLoopPromise = (async () => {
        while (this._mainLoopActive && !this._shuttingDown) {
            try {
                if (this.manager && this.accountId && !this.config.dryRun) {
                    if (!this.manager._fillProcessingLock.isLocked() &&
                        this.manager._fillProcessingLock.getQueueLength() === 0) {
                        await this.manager._fillProcessingLock.acquire(async () => {
                            const chainOpenOrders = await readOpenOrdersFn.call(chainOrders, this.accountId);
                            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders', { fillLockAlreadyHeld: true });

                            if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                this._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                this._markGridActivity?.('open-orders sync fill');
                                const batchResult = await this._processFillsWithBatching(
                                    syncResult.filledOrders, new Set(), 'open-orders sync fill rebalance'
                                );
                                if (!batchResult?.aborted) {
                                    await this.manager.persistGrid();
                                }
                            }
                        });
                    }
                }
            } catch (err: any) {
                this._warn(`Order manager loop error: ${err.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, loopDelayMs));
        }
    })().catch(err => {
        this._warn(`Open-orders sync loop failed: ${err && err.message ? err.message : err}`);
    }).finally(() => {
        this._mainLoopPromise = null;
    });
}

/**
 * Stop the continuous open-orders sync loop.
 * @this {import('./dexbot_class').DEXBot}
 * @returns {Promise<void>}
 */
async function stopOpenOrdersSyncLoop() {
    this._mainLoopActive = false;
    if (this._mainLoopPromise) {
        await this._mainLoopPromise;
    }
}

/**
 * Set up the periodic blockchain fetch interval.
 * Periodically fetches account totals and syncs open orders from the blockchain.
 * @this {import('./dexbot_class').DEXBot}
 */
function setupBlockchainFetchInterval() {
    const intervalMin = TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN;

    syncMarketAdapterOnPeriodicConfigCheck.call(this, 'startup blockchain fetch setup')
        .catch((err) => {
            this._warn(`Market adapter watchdog failed during startup blockchain fetch setup: ${err.message}`);
        });

    if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
        this._stopBlockchainFetchInterval();
    }

    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        this._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
        return;
    }

    if (!this.manager || typeof this.manager.fetchAccountTotals !== 'function') {
        this._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
        return;
    }

    if (!this.accountId) {
        this._warn('Cannot start blockchain fetch interval: account ID not available');
        return;
    }

    const intervalMs = intervalMin * 60 * 1000;
    this._blockchainFetchInterval = setInterval(async () => {
        try {
            await syncMarketAdapterOnPeriodicConfigCheck.call(this, 'periodic blockchain fetch');

            await this.manager._fillProcessingLock.acquire(async () => {
                if (this.manager.accountant && typeof this.manager.accountant.resetRecoveryState === 'function') {
                    this.manager.accountant.resetRecoveryState();
                } else {
                    this.manager._recoveryAttempted = false;
                }
                this._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                await this.manager.fetchAccountTotals(this.accountId);

                let chainOpenOrders = [];
                if (!this.config.dryRun) {
                    try {
                        chainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                        const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch', { fillLockAlreadyHeld: true });

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                            this._markGridActivity?.('periodic sync fill rebalance');
                            const batchResult = await this._processFillsWithBatching(
                                syncResult.filledOrders, new Set(), 'periodic sync fill rebalance'
                            );
                            if (!batchResult?.aborted) {
                                await this.manager.persistGrid();
                            }
                        }

                        if (syncResult.unmatchedChainOrders && syncResult.unmatchedChainOrders.length > 0) {
                            const sample = syncResult.unmatchedChainOrders
                                .slice(0, 3)
                                .map(formatUnmatchedChainOrder)
                                .join(' | ');
                            this._log(
                                `Periodic sync: ${syncResult.unmatchedChainOrders.length} chain order(s) not in grid ` +
                                `(surplus/divergence)${sample ? `: ${sample}` : ''}`,
                                'warn'
                            );
                        }
                    } catch (err: any) {
                        this._warn(`Error reading open orders during periodic fetch: ${err.message}`);
                    }
                }

                await this._performPeriodicGridChecks();
            });
        } catch (err: any) {
            this._warn(`Error during periodic blockchain fetch: ${err && err.message ? err.message : err}`);
        }
    }, intervalMs);

    this._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
}

/**
 * Stop the periodic blockchain fetch interval.
 * @this {import('./dexbot_class').DEXBot}
 */
function stopBlockchainFetchInterval() {
    if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
        clearInterval(this._blockchainFetchInterval);
        this._blockchainFetchInterval = null;
        this._log('Stopped periodic blockchain fetch interval');
    }
}

/**
 * Release the market adapter runtime for a bot.
 * In PM2 mode this is a no-op; in direct mode it calls the shared runtime's releaseBot.
 * @param {string} botId - Bot identifier
 * @param {string} [context='shutdown'] - Context label for logging
 * @returns {Promise<import('./types').MarketAdapterReleaseResult>}
 */
async function releaseMarketAdapterRuntime(botId, context = 'shutdown') {
    if (isPm2Runtime()) {
        return { released: false, mode: 'pm2' };
    }

    if (!botId) {
        return { released: false, mode: 'direct', reason: 'missing-bot-id' };
    }

    const runtime = getSharedMarketAdapterRuntime({ root: ROOT });
    const result = await runtime.releaseBot(botId);
    return {
        released: true,
        context,
        mode: 'direct',
        ...result,
    };
}

/**
 * Calculate the remaining delay (ms) before dust orders are eligible for cancellation.
 * @param {Object} ctx - Bot context with _dustSinceMap
 * @returns {number|null} Remaining delay in ms, or null if no dust orders pending
 */
function getPendingDustDelayMs(ctx) {
    const delaySec = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;
    if (
        !ctx?._dustSinceMap ||
        ctx._dustSinceMap.size === 0 ||
        !Number.isFinite(delaySec) ||
        delaySec < 0
    ) {
        return null;
    }

    const delayMs = delaySec * 1_000;
    const now = Date.now();
    let nextRunAt = Number.POSITIVE_INFINITY;
    for (const firstSeen of ctx._dustSinceMap.values()) {
        if (!Number.isFinite(firstSeen)) continue;
        nextRunAt = Math.min(nextRunAt, firstSeen + delayMs);
    }

    if (!Number.isFinite(nextRunAt)) return delayMs;
    const remaining = Math.max(0, nextRunAt - now);
    return remaining === 0 ? null : remaining;
}

/**
 * Check if an error message indicates that an order does not exist on the blockchain.
 * @param {string} message - Error message to check
 * @param {string} [orderId] - Optional order ID for context-aware matching
 * @returns {boolean} True if the message indicates a nonexistent order
 */
function isOrderDoesNotExistError(message, orderId) {
    if (typeof message !== 'string' || message.length === 0) return false;
    const normalized = message.toLowerCase();
    if (/\border\b.*\bdoes not exist\b/i.test(message)) return true;
    if (/\bdoes not exist\b.*\border\b/i.test(message)) return true;
    if (orderId && normalized.includes(String(orderId).toLowerCase())) {
        return /\bdoes not exist\b/i.test(message)
            || /\bcould not find object\b/i.test(message)
            || /\bunable to find object\b/i.test(message)
            || /\bobject\b.*\bnot found\b/i.test(message);
    }
    return false;
}

/**
 * Calculate the remaining idle delay (ms) before grid maintenance can proceed.
 * Waits for fill queue to drain and for recent grid activity to settle.
 * @param {Object} ctx - Bot context with _lastGridActivityAt and _incomingFillQueue
 * @returns {number} Remaining idle delay in ms (0 if bot is idle)
 */
function getMaintenanceIdleDelayMs(ctx) {
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : 6_000;
    if (settleDelayMs <= 0) return 0;

    if (ctx?._incomingFillQueue?.length > 0) return settleDelayMs;

    const lastActivityAt = Number(ctx?._lastGridActivityAt || 0);
    if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return 0;

    return Math.max(0, settleDelayMs - (Date.now() - lastActivityAt));
}

/**
 * Schedule grid maintenance to run after the bot becomes idle.
 * @param {Object} ctx - Bot context
 * @param {string} context - Context label for logging
 * @param {Object} [options] - Maintenance options forwarded to runGridMaintenance
 */
function scheduleMaintenanceAfterIdle(ctx, context, options = {}) {
    if (!ctx || ctx._shuttingDown || ctx._maintenanceIdleTimer || !ctx.manager?._fillProcessingLock) return;

    const delayMs = getMaintenanceIdleDelayMs(ctx);
    if (!(delayMs > 0)) return;

    // The caller will have returned (and released _fillProcessingLock, if it
    // was held) by the time this deferred callback fires, so the deferred
    // run must always acquire the lock itself. Override any caller-supplied
    // fillLockAlreadyHeld=true so the deferred path can't deadlock against
    // a lock the caller no longer owns.
    const timerOptions = {
        ...options,
        fillLockAlreadyHeld: false,
    };

    ctx._maintenanceIdleTimer = setTimeout(() => {
        ctx._maintenanceIdleTimer = null;
        if (ctx._shuttingDown) return;
        ctx._runGridMaintenance(context, timerOptions)
            .catch(err => ctx._warn(`Deferred ${context} grid maintenance failed: ${err.message}`));
    }, delayMs);
}

/**
 * Schedule a deferred grid resync after dust timer and idle delays elapse.
 * @param {Object} ctx - Bot context
 * @param {import('./types').GridResyncOptions} [options] - Grid resync options
 */
function scheduleDeferredGridResync(ctx, options = {}) {
    if (
        !ctx ||
        ctx._shuttingDown ||
        ctx._deferredGridResyncTimer ||
        !ctx.manager?._fillProcessingLock
    ) {
        return;
    }

    const dustDelayMs = getPendingDustDelayMs(ctx);
    const idleDelayMs = getMaintenanceIdleDelayMs(ctx);
    const triggerFileWasPresent = !!(ctx.triggerFile && fs.existsSync(ctx.triggerFile));
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : 6_000;
    const delayMs = Math.max(
        dustDelayMs !== null ? dustDelayMs + settleDelayMs : 0,
        idleDelayMs
    );
    if (!(delayMs > 0)) return;

    ctx._deferredGridResyncTimer = setTimeout(() => {
        ctx._deferredGridResyncTimer = null;
        if (ctx._shuttingDown) return;
        if (triggerFileWasPresent && !fs.existsSync(ctx.triggerFile)) return;

        ctx.manager._fillProcessingLock.acquire(async () => {
            const ok = await ctx._performGridResync(options);
            if (!ok && !ctx._shuttingDown) {
                const curDustMs = getPendingDustDelayMs(ctx);
                const curIdleMs = getMaintenanceIdleDelayMs(ctx);
                const reason = curDustMs !== null
                    ? `dust timer pending (${Math.ceil(curDustMs / 1000)}s)`
                    : curIdleMs > 0
                        ? `idle cooldown (${Math.ceil(curIdleMs / 1000)}s)`
                        : 'grid resync rejected or failed';
                ctx._warn(`Deferred trigger reset blocked: ${reason}; retaining existing grid state.`);
            }
        }).catch(err => {
            ctx._warn(`Deferred trigger reset lock error: ${err.message}`);
        });
    }, delayMs);
}

/**
 * Execute the core maintenance logic: recalculate funds, check pipeline,
 * refresh dynamic weights, check grid health, cancel dust orders,
 * apply divergence corrections, and fix spread conditions.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string} context - Context label for logging (e.g. 'periodic', 'dust-timer')
 * @returns {Promise<void>}
 */
async function executeMaintenanceLogic(context) {
    await this.manager.recalculateFunds();
    await checkBtsBalanceAndAcquire.call(this);
    this.manager.clearStalePipelineOperations();

    // Clear stale divergence flags before the pipeline check to break a self-blocking loop:
    // checkAndUpdateGridIfNeeded / compareGrids may have set _gridSidesUpdated earlier in this
    // tick (or in a previous tick that aborted before corrections ran), and applyGridDivergenceCorrections
    // is the only consumer that clears it. If a prior tick set the flag but never reached the
    // correction path, the flag persists and the next isPipelineEmpty sees it as a blockage,
    // preventing the divergence section from running. Stale flags must be cleared here, BEFORE
    // the pipeline check, so the divergence section can be entered.
    const staleFlags = this.manager._gridSidesUpdated?.size || 0;
    if (staleFlags > 0) {
        this.manager._gridSidesUpdated.clear();
        this._log(
            `[PIPELINE-CLEAR] Cleared ${staleFlags} stale _gridSidesUpdated flag(s) before ${context} pipeline check`,
            'info'
        );
    }

    if (this._maintenanceCooldownCycles > 0) {
        this._maintenanceCooldownCycles--;
        this._log(
            `[MAINT-COOLDOWN] Skipping ${context} maintenance after hard-abort recovery sync (remaining=${this._maintenanceCooldownCycles})`,
            'warn'
        );
        return;
    }

    const pipelineStatus = this.manager.isPipelineEmpty(this._getPipelineSignals());
    if (pipelineStatus.isEmpty) {
        const repairedFromChain = await maybeRunTargetedDriftReconciliation.call(this, context);
        if (repairedFromChain) return;

        // Refresh live dynamic weights before any structural checks that may create or
        // resize orders (dust detection, divergence correction, spread correction).
        refreshDynamicWeightDistribution.call(this, context);

        const healthResult = await this.manager.checkGridHealth(this.updateOrdersOnChainPlan.bind(this));
        if (await this._abortFlowIfIllegalState(`${context} health check`)) return;
        const dustCancelResult = await this._cancelDustOrders({
            buy: healthResult.buyDustOrders,
            sell: healthResult.sellDustOrders,
        });
        if (dustCancelResult?.batchResult?.abortedForIllegalState || dustCancelResult?.batchResult?.abortedForAccountingFailure) {
            return;
        }
        if (this._dustSinceMap?.size > 0) {
            const delayMs = getPendingDustDelayMs(this);
            if (delayMs !== null) {
                this._log(
                    `[DUST-CANCEL] Deferring ${context} structural maintenance until dust timer completes` +
                    ` (next check in ${Math.ceil(delayMs / 1000)}s)`,
                    'info'
                );
                scheduleDeferredGridResync(this);
                return;
            }
            // All dust timers have expired — stale entries remain in the map but
            // there is nothing left to wait for. Proceed with structural maintenance.
            this._log(
                `[DUST-CANCEL] Dust timer expired; stale map entries cleared before ${context} structural maintenance`,
                'info'
            );
            this._dustSinceMap.clear();
        }

        try {
            const persistedGridData = this.accountOrders.loadBotGrid(this.config.botKey, true) || [];
            const calculatedGrid = Array.from(this.manager.orders.values());

            const divergence = await Grid.monitorDivergence(this.manager, calculatedGrid, persistedGridData);

            if (divergence.needsUpdate) {
                const hasRmsDivergence = !!(divergence.buy.rms || divergence.sell.rms);
                if (divergence.buy.ratio || divergence.sell.ratio) {
                    this._log(`Grid update triggered by funds during ${context} (buy: ${divergence.buy.ratio}, sell: ${divergence.sell.ratio})`);
                }
                if (hasRmsDivergence) {
                    this._log(`Grid update triggered by structural divergence during ${context}: buy=${Format.formatPrice6(divergence.buy.metric)}, sell=${Format.formatPrice6(divergence.sell.metric)}`);
                    const ok = await this._performGridResync(buildGridResyncOptions('rms_structural_grid_resync'));
                    if (!ok) {
                        this._warn(`RMS structural divergence full grid resync failed during ${context}; retaining existing grid state.`);
                    }
                    // Clear any ratio flags set by checkAndUpdateGridIfNeeded earlier in this tick,
                    // since the resync already rebuilt the full grid.
                    if (this.manager._gridSidesUpdated?.size > 0) {
                        this.manager._gridSidesUpdated.clear();
                    }
                    return;
                }

                try {
                    await applyGridDivergenceCorrections(
                        this.manager,
                        this.accountOrders,
                        this.config.botKey,
                        this.updateOrdersOnChainBatch.bind(this)
                    );
                    if (await this._abortFlowIfIllegalState(`${context} divergence correction`)) return;
                    this._log(`Grid divergence corrections applied during ${context}`);
                } catch (err: any) {
                    this._warn(`Error applying divergence corrections during ${context}: ${err.message}`);
                }
            }
        } catch (err: any) {
            this._warn(`Error running divergence check during ${context}: ${err.message}`);
        }

        const spreadResult = await this.manager.checkSpreadCondition(BitShares, this.updateOrdersOnChainPlan.bind(this));
        if (await this._abortFlowIfIllegalState(`${context} spread check`)) return;
        if (spreadResult && spreadResult.ordersPlaced > 0) {
            this._log(`✓ Spread correction during ${context}: ${spreadResult.ordersPlaced} order(s) placed`);
            await this._persistAndRecoverIfNeeded();
        }
    }
}

/**
 * Cancel dust orders that have exceeded their cancellation delay.
 * Tracks first-detected timestamps per order and only cancels after DUST_CANCEL_DELAY_SEC.
 * @this {import('./dexbot_class').DEXBot}
 * @param {Object} [options] - Dust cancellation options
 * @param {import('./types').Order[]} [options.buy=[]] - Buy-side dust orders
 * @param {import('./types').Order[]} [options.sell=[]] - Sell-side dust orders
 * @returns {Promise<import('./types').DustCancelResult>}
 */
async function cancelDustOrders({ buy: buyDust = [], sell: sellDust = [] } = {}) {
    const delaySec = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;
    if (!Number.isFinite(delaySec) || delaySec < 0) {
        this._clearDustMaintenanceTimer();
        return { cancelledCount: 0, batchResult: null };
    }

    const now = Date.now();
    const delayMs = delaySec * 1_000;
    const allDust = [...buyDust, ...sellDust];
    const dustIds = new Set(allDust.map(o => o.orderId).filter(Boolean));

    for (const orderId of this._dustSinceMap.keys()) {
        if (!dustIds.has(orderId)) this._dustSinceMap.delete(orderId);
    }

    for (const order of allDust) {
        if (order.orderId && !this._dustSinceMap.has(order.orderId)) {
            this._dustSinceMap.set(order.orderId, now);
        }
    }

    const toCancel = allDust.filter(o => {
        if (!o.orderId) return false;
        // The map was just populated (lines 1446-1450) for every order in
        // allDust, so the get() below never returns undefined. The DUST_CANCEL_DELAY
        // window starts at firstSeen (when the order first appeared in the dust
        // set), not at this maintenance tick, so an order can only be cancelled
        // after the delay has elapsed since its initial detection.
        const firstSeen = this._dustSinceMap.get(o.orderId);
        return (now - firstSeen) >= delayMs;
    });

    if (toCancel.length === 0) {
        this._scheduleDustMaintenanceCheck();
        return { cancelledCount: 0, batchResult: null };
    }

    let cancelledCount = 0;
    const syntheticFills = [];
    for (const order of toCancel) {
        try {
            const cancelResult = await chainOrders.cancelOrder(this.account, this.privateKey, order.orderId);
            if (cancelResult?.verifiedAfterFailure) {
                const accountRef = this.accountId || this.account;
                const chainOpenOrders = await chainOrders.readOpenOrders(accountRef);
                await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders', { fillLockAlreadyHeld: true });
            } else {
                await this.manager.synchronizeWithChain({ orderId: order.orderId, clearSize: true }, 'cancelOrder');
            }

            syntheticFills.push({
                ...order,
                isPartial: true,
                isDelayedRotationTrigger: true,
                dustCancelTriggeredAt: now
            });
            this._dustSinceMap.delete(order.orderId);
            cancelledCount++;
            this._log(
                `[DUST-CANCEL] Cancelled dust order ${order.id} (${order.orderId}) ` +
                `as fully filled (delay=${delaySec}s, size=${order.size})`,
                'info'
            );
        } catch (err: any) {
            const errMsg = err?.message || '';
            if (isOrderDoesNotExistError(errMsg, order.orderId)) {
                this._dustSinceMap.delete(order.orderId);
                syntheticFills.push({
                    ...order,
                    isPartial: true,
                    isDelayedRotationTrigger: true,
                    dustCancelTriggeredAt: now,
                    dustRecoveredFromChain: true,
                });
                cancelledCount++;
                this._log(
                    `[DUST-CANCEL] Treated dust order ${order.id} (${order.orderId}) as gone from chain (${errMsg.slice(0, 80)})`,
                    'info'
                );
            } else {
                this._warn(`[DUST-CANCEL] Failed to cancel dust order ${order.id}: ${errMsg}`);
            }
        }
    }

    let batchResult = null;
    if (syntheticFills.length > 0) {
        const result = await this._processFillsWithBatching(
            syntheticFills, new Set(), `dust cancel [${syntheticFills.map(o => o.id).join(', ')}]`
        );
        batchResult = {
            abortedForIllegalState: result.aborted,
            abortedForAccountingFailure: result.aborted,
        };
        if (!result.aborted) {
            await this.manager.persistGrid();
        }
    } else if (cancelledCount > 0) {
        await this.manager.recalculateFunds();
        await this.manager.persistGrid();
    }

    if (cancelledCount > 0) {
        try {
            const freshHealth = await this.manager.checkGridHealth(null);
            const seenAt = Date.now();
            for (const order of [...freshHealth.buyDustOrders, ...freshHealth.sellDustOrders]) {
                if (order.orderId && !this._dustSinceMap.has(order.orderId)) {
                    this._dustSinceMap.set(order.orderId, seenAt);
                }
            }
        } catch (err: any) {
            this._warn(`[DUST-CANCEL] Failed to reseed dust timers after cancel: ${err.message}`);
        }
    }

    this._scheduleDustMaintenanceCheck();

    if (cancelledCount > 0 && this._dustSinceMap.size === 0 && !this._shuttingDown && !this._dustMaintenanceTimer) {
        const delayMs = GRID_LIMITS.DUST_CANCEL_DELAY_SEC * 1_000;
        this._dustMaintenanceTimer = setTimeout(() => {
            this._dustMaintenanceTimer = null;
            if (this._shuttingDown || !this.manager?._fillProcessingLock) return;
            this.manager._fillProcessingLock.acquire(async () => {
                if (!this._shuttingDown) {
                    await this._runGridMaintenance('dust-timer', { fillLockAlreadyHeld: true });
                }
            }).catch(err2 => this._warn(`Error during dust fallback timer: ${err2.message}`));
        }, delayMs);
    }
    return { cancelledCount, batchResult };
}

/**
 * Clear the dust maintenance timer if it is running.
 * @this {import('./dexbot_class').DEXBot}
 */
function clearDustMaintenanceTimer() {
    if (this._dustMaintenanceTimer) {
        clearTimeout(this._dustMaintenanceTimer);
        this._dustMaintenanceTimer = null;
    }
}

/**
 * Schedule the next dust maintenance check based on the earliest pending dust expiry.
 * @this {import('./dexbot_class').DEXBot}
 */
function scheduleDustMaintenanceCheck() {
    this._clearDustMaintenanceTimer();

    const delaySec = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;
    if (
        this._shuttingDown ||
        !this.manager ||
        !Number.isFinite(delaySec) ||
        delaySec < 0 ||
        this._dustSinceMap.size === 0
    ) {
        return;
    }
    // Note: do NOT gate on !this.manager._fillProcessingLock here. The timer
    // body re-validates and returns silently if the lock is missing, and the
    // .finally reschedules — so a transient lock outage self-heals on the
    // next tick once manager is reattached. Tightening the guard would skip
    // the timer entirely and orphan _dustSinceMap entries.

    const delayMs = delaySec * 1_000;
    const now = Date.now();
    let nextRunAt = Number.POSITIVE_INFINITY;

    for (const firstSeen of this._dustSinceMap.values()) {
        if (!Number.isFinite(firstSeen)) continue;
        nextRunAt = Math.min(nextRunAt, firstSeen + delayMs);
    }

    const nextDelayMs = Number.isFinite(nextRunAt)
        ? Math.max(0, nextRunAt - now)
        : delayMs;

    this._dustMaintenanceTimer = setTimeout(() => {
        this._dustMaintenanceTimer = null;
        if (this._shuttingDown || !this.manager?._fillProcessingLock) return;

        this.manager._fillProcessingLock.acquire(async () => {
            if (this._shuttingDown) return;
            await this._runGridMaintenance('dust-timer', { fillLockAlreadyHeld: true });
        }).catch(err => {
            // AssertionError must propagate so test mocks can fail the test
            // instead of silently passing. Other errors stay caught to keep
            // the timer chain alive and avoid unhandled-rejection shutdowns.
            if (err && (err.code === 'ERR_ASSERTION' || err.name === 'AssertionError')) {
                throw err;
            }
            this._warn(`Error during dust maintenance timer: ${err?.message || err}`);
        }).finally(() => {
            if (!this._shuttingDown) {
                this._scheduleDustMaintenanceCheck();
            }
        });
    }, nextDelayMs);
}

/**
 * Seed dust timers from partial order updates detected during sync.
 * Marks partial orders as potentially dusty if they fall below the dust threshold.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').Order[]} [updatedOrders=[]] - Orders that were updated during sync
 * @param {number} [detectedAt=Date.now()] - Timestamp when dust was detected
 * @returns {Promise<void>}
 */
async function seedDustTimersFromPartialUpdates(updatedOrders = [], detectedAt = Date.now()) {
    if (!this.manager || !Array.isArray(updatedOrders) || updatedOrders.length === 0) return;

    const partialOrders = updatedOrders.filter(order => order && order.state === ORDER_STATES.PARTIAL && order.orderId);
    if (partialOrders.length === 0) return;

    const { buyDustOrders, sellDustOrders } = await Grid.checkWindowDust(this.manager);
    const dustOrderIds = new Set([...buyDustOrders, ...sellDustOrders].map(order => order.orderId).filter(Boolean));

    for (const order of partialOrders) {
        if (!order?.orderId) continue;
        if (dustOrderIds.has(order.orderId)) {
            if (!this._dustSinceMap.has(order.orderId)) {
                this._dustSinceMap.set(order.orderId, detectedAt);
            }
        } else {
            this._dustSinceMap.delete(order.orderId);
        }
    }

    this._scheduleDustMaintenanceCheck();
}

/**
 * Run grid maintenance with idle detection and lock acquisition.
 * Checks if the bot is idle before proceeding, and acquires the fill processing lock.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string} [context='periodic'] - Context label for logging
 * @param {Object} [options] - Maintenance options
 * @param {boolean} [options.fillLockAlreadyHeld=false] - Skip fill lock acquisition if already held
 * @param {boolean} [options.skipIdle=false] - Skip idle delay check
 * @returns {Promise<void>}
 */
async function runGridMaintenance(
    context = 'periodic',
    options: { fillLockAlreadyHeld?: boolean; skipIdle?: boolean } = {}
) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Grid maintenance options must be an object');
    }
    const fillLockAlreadyHeld = options.fillLockAlreadyHeld === true;
    const skipIdle = options.skipIdle === true;
    if (!skipIdle) {
        const idleDelayMs = getMaintenanceIdleDelayMs(this);
        if (idleDelayMs > 0) {
            this._log(
                `[MAINT-IDLE] Deferring ${context} grid maintenance until ` +
                `${Math.ceil(idleDelayMs / 1000)}s of inactivity has passed`,
                'debug'
            );
            scheduleMaintenanceAfterIdle(this, context, options);
            return;
        }
    }

    try {
        if (!this.manager) return;

        // Lock-ordering contract:
        //   - When fillLockAlreadyHeld=false this function acquires
        //     _fillProcessingLock first, then _divergenceLock (canonical order).
        //   - When fillLockAlreadyHeld=true the caller must already hold
        //     _fillProcessingLock; only _divergenceLock is acquired here.
        // AsyncLock is NOT reentrant — acquiring in the reverse order anywhere
        // else in the bot would deadlock against the path above.
        const runWithDivergenceLock = async () => {
            // Re-check orders size under the divergence lock to avoid a TOCTOU
            // race with concurrent order mutations. The previous placement
            // (before any lock acquisition) could observe a stale empty
            // grid and silently skip maintenance while fills were in flight.
            if (!this.manager.orders || this.manager.orders.size === 0) return;
            await this._executeMaintenanceLogic(context);
        };

        if (fillLockAlreadyHeld) {
            await this.manager._divergenceLock.acquire(runWithDivergenceLock);
        } else {
            await this.manager._fillProcessingLock.acquire(async () => {
                await this.manager._divergenceLock.acquire(runWithDivergenceLock);
            });
        }
    } catch (err: any) {
        this._warn(`Error during ${context} grid maintenance: ${err.message}`);
        throw err;
    }
}

const _lastBtsAcquisitionTimestamps = new Map();

/**
 * Check if the bot's BTS balance is below the minimum threshold and trigger acquisition.
 * Only applies to non-BTS pairs. Uses hysteresis: triggers at 1× min_BTS_value,
 * fills to BTS_ACQUIRE_TARGET_MULTIPLIER × min_BTS_value.
 * @this {import('./dexbot_class').DEXBot}
 * @returns {Promise<void>}
 */
async function checkBtsBalanceAndAcquire() {
    if (this.config.dryRun) return;
    if (this.config.assetA === 'BTS' || this.config.assetB === 'BTS') return;

    const cooldownMs = (TIMING.BTS_ACQUIRE_COOLDOWN_MIN || 60) * 60 * 1000;
    const now = Date.now();

    // Prune every expired entry in the map, not just the current bot's.
    // Otherwise entries for bots that acquired BTS and then stopped calling
    // (removed from bots.json, supervisor restart with a different roster)
    // would persist forever. The map is bounded by the number of unique bot
    // keys that ever acquired BTS, so this O(n) sweep is cheap.
    for (const [key, ts] of _lastBtsAcquisitionTimestamps) {
        if ((now - ts) >= cooldownMs) {
            _lastBtsAcquisitionTimestamps.delete(key);
        }
    }

    const botKey = this.config.botKey || this.config.name;
    const lastAcq = _lastBtsAcquisitionTimestamps.get(botKey);
    if (lastAcq && (now - lastAcq) < cooldownMs) return;

    if (!this.manager || !this.manager.btsBalance) return;

    const targetBuy = Math.max(0, this.config.activeOrders?.buy || 1);
    const targetSell = Math.max(0, this.config.activeOrders?.sell || 1);
    const totalTarget = targetBuy + targetSell;

    const minBtsVal = calculateOrderCreationFees(
        this.config.assetA, this.config.assetB, totalTarget,
        FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER
    );
    if (minBtsVal <= 0) return;

    const effectiveMin = (this.config.min_BTS_value > 0) ? this.config.min_BTS_value : minBtsVal;
    const btsFree = this.manager.btsBalance.free || 0;
    const triggerAt = effectiveMin * FEE_PARAMETERS.BTS_ACQUIRE_THRESHOLD;
    if (btsFree >= triggerAt) return;

    const target = effectiveMin * FEE_PARAMETERS.BTS_ACQUIRE_TARGET_MULTIPLIER;
    const deficit = Math.max(0, target - btsFree);
    this._log(
        `[BTS-ACQ] BTS balance ${Format.formatAmount8(btsFree)} below threshold ${Format.formatAmount8(triggerAt)}. ` +
        `Acquiring ${Format.formatAmount8(deficit)} BTS (target: ${Format.formatAmount8(target)})`,
        'info'
    );
    _lastBtsAcquisitionTimestamps.set(botKey, Date.now());
    await acquireBts.call(this, deficit);
}

/**
 * Acquire BTS by swapping one of the trading pair assets through an AMM pool.
 * Tries both assets for a BTS pool, picks the best (lowest price impact).
 * @this {import('./dexbot_class').DEXBot}
 * @param {number} deficit - Amount of BTS needed (float)
 * @returns {Promise<void>}
 */
async function acquireBts(deficit) {
    if (deficit <= 0) return;
    const { BitShares } = require('./bitshares_client');
    if (!BitShares || !BitShares.db) return;

    const coreAssetId = NATIVE_CLIENT.CHAIN.CORE_ASSET_ID;
    const assets = [
        { id: this.assets?.assetA?.id, free: this.manager.accountTotals?.sellFree || 0, precision: this.assets?.assetA?.precision, symbol: this.config.assetA },
        { id: this.assets?.assetB?.id, free: this.manager.accountTotals?.buyFree || 0, precision: this.assets?.assetB?.precision, symbol: this.config.assetB }
    ];

    const candidates = [];
    for (const asset of assets) {
        if (!asset.id || asset.free <= 0) continue;
        try {
            const poolData = await BitShares.db.get_liquidity_pool_by_asset_ids(asset.id, coreAssetId);
            if (!poolData) continue;

            const isAssetA = String(poolData.asset_a) === String(asset.id) || String(poolData.asset_ids?.[0]) === String(asset.id);
            const assetReserveRaw = isAssetA ? (poolData.balance_a || poolData.reserves?.[0]?.amount) : (poolData.balance_b || poolData.reserves?.[1]?.amount);
            const btsReserveRaw = isAssetA ? (poolData.balance_b || poolData.reserves?.[1]?.amount) : (poolData.balance_a || poolData.reserves?.[0]?.amount);
            if (!assetReserveRaw || !btsReserveRaw) continue;

            const assetReserve = blockchainToFloat(assetReserveRaw, asset.precision);
            const btsReserve = blockchainToFloat(btsReserveRaw, BTS_PRECISION);
            const expectedReceive = Math.min(deficit, btsReserve * 0.5);
            const sellAmount = calculateSwapInAmount(deficit, btsReserve, assetReserve);
            if (sellAmount <= 0 || sellAmount > asset.free) continue;

            candidates.push({ asset, poolId: poolData.id, sellAmount, expectedReceive, priceImpact: sellAmount / assetReserve });
        } catch (e) { /* pool not found */ }
    }

    if (candidates.length === 0) {
        this._log(`[BTS-ACQ] CRITICAL: No BTS pool with sufficient liquidity for ${this.config.assetA} or ${this.config.assetB}`, 'error');
        return;
    }

    candidates.sort((a, b) => a.priceImpact - b.priceImpact);
    const best = candidates[0];

    const minReceive = best.expectedReceive * (1 - FEE_PARAMETERS.POOL_SLIPPAGE_TOLERANCE);
    const sellInt = floatToBlockchainInt(best.sellAmount, best.asset.precision);
    const minReceiveInt = floatToBlockchainInt(minReceive, BTS_PRECISION);
    const op = chainOrders.buildLiquidityPoolExchangeOp(this.accountId, best.poolId, sellInt, best.asset.id, minReceiveInt, coreAssetId);

    try {
        if (this.privateKey) {
            await chainOrders.executeBatch(this.account, this.privateKey, [op]);
        } else {
            this._log('[BTS-ACQ] CRITICAL: No signing method available', 'error');
            return;
        }
    } catch (err) {
        this._log(`[BTS-ACQ] Swap broadcast failed: ${err.message}`, 'error');
        return;
    }

    const orderType = (best.asset.id === this.assets?.assetA?.id) ? 'sell' : 'buy';
    if (this.manager.accountant) {
        this.manager.accountant.adjustTotalBalance(orderType, -best.sellAmount, 'bts-acquisition-swap-sell');
    }
    // Do NOT optimistically bump btsBalance.free/total here. expectedReceive is
    // a pre-swap estimate and may diverge from the actual fill (slippage, fees,
    // partial fills, broadcast/confirm failures). The next periodic
    // fetchAccountTotals() reconciles from chain truth. The bts-acquisition
    // cooldown in checkBtsBalanceAndAcquire prevents immediate re-trigger even
    // if the chain balance is still below the trigger threshold.

    this._log(`[BTS-ACQ] Acquired ~${Format.formatAmount8(best.expectedReceive)} BTS: sold ${Format.formatAmount8(best.sellAmount)} ${best.asset.symbol} via pool ${best.poolId}`, 'info');
}

export = {
    loadBotsConfigSnapshot,
    refreshDynamicWeightDistribution,
    performGridResync,
    updateBotGridResetMetadata,
    handlePendingTriggerReset,
    setupTriggerFileDetection,
    performPeriodicGridChecks,
    isOpenOrdersSyncLoopEnabled,
    startOpenOrdersSyncLoop,
    stopOpenOrdersSyncLoop,
    setupBlockchainFetchInterval,
    stopBlockchainFetchInterval,
    executeMaintenanceLogic,
    cancelDustOrders,
    isOrderDoesNotExistError,
    clearDustMaintenanceTimer,
    scheduleDustMaintenanceCheck,
    seedDustTimersFromPartialUpdates,
    runGridMaintenance,
    stopMarketAdapterPm2,
    releaseMarketAdapterRuntime,
    syncMarketAdapterOnPeriodicConfigCheck,
    findSnapshotBotForRuntimeConfig,
    runtimeConfigNeedsMarketAdapter,
    usesAmaGridPrice,
    checkBtsBalanceAndAcquire,
    acquireBts,
};
