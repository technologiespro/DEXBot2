const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BitShares } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const Grid = require('./order/grid');
const { ORDER_STATES, TIMING, MAINTENANCE, GRID_LIMITS } = require('./constants');
const { retryPersistenceIfNeeded, applyGridDivergenceCorrections, loadAmaCenterSnapshot } = require('./order/utils/system');
const { isPm2Runtime } = require('./order/logger');
const { getSharedMarketAdapterRuntime } = require('./launcher/market_adapter_runtime');
const {
    resetMarketAdapterWhitelistCache,
    isBotDynamicWeightWhitelisted,
} = require('./market_adapter_whitelist');
const Format = require('./order/format');
const { virtualizeOrder } = require('./order/utils/order');
const { parseJsonWithComments } = require('./order/utils/system');
const { cloneWeightDistribution } = require('./order/utils/math');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');
const LOGS_DIR = path.join(PROFILES_DIR, 'logs');
const ROOT = path.join(__dirname, '..');
const MARKET_ADAPTER_APP_NAME = 'dexbot-adapter';
const MARKET_ADAPTER_SCRIPT = path.join(__dirname, '..', 'market_adapter', 'market_adapter.js');
const MARKET_ADAPTER_ERROR_FILE = path.join(LOGS_DIR, 'dexbot-adapter-error.log');
const MARKET_ADAPTER_OUT_FILE = path.join(LOGS_DIR, 'dexbot-adapter.log');
function usesAmaGridPrice(bot) {
    const gridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

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

function runtimeConfigNeedsMarketAdapter(snapshot, config) {
    const snapshotBot = findSnapshotBotForRuntimeConfig(snapshot, config);
    if (snapshotBot) {
        return usesAmaGridPrice(snapshotBot);
    }
    return usesAmaGridPrice(config);
}

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

function runPm2Command(args) {
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

async function getPm2ProcessNames() {
    const { stdout } = await runPm2Command(['jlist']);
    return parsePm2JlistOutput(stdout);
}

async function startMarketAdapterPm2() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    await runPm2Command([
        'start',
        MARKET_ADAPTER_SCRIPT,
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
    ]);
}

async function stopMarketAdapterPm2() {
    await runPm2Command(['delete', MARKET_ADAPTER_APP_NAME]);
}

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
        } catch (err) {
            pm2QueryFailed = true;
            this._warn(`Could not query PM2 for ${MARKET_ADAPTER_APP_NAME}: ${err.message}. Using a direct PM2 action.`);
        }

        if (!snapshot.exists || !snapshot.needsMarketAdapter) {
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
            this._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are active.`, 'info');
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
    } catch (err) {
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
            nextWeights = liveWeights;
            source = 'dynamic';
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

function readTriggerMetadata(triggerFile) {
    try {
        const raw = fs.readFileSync(triggerFile, 'utf8').trim();
        if (!raw) {
            // An empty trigger is the legacy/manual CLI reset signal.
            return { isManual: true, payload: null };
        }

        const payload = JSON.parse(raw);
        const source = String(payload?.source || '').trim();
        return {
            isManual: source !== 'market_adapter/market_adapter.js',
            payload,
        };
    } catch (_) {
        return { isManual: true, payload: null };
    }
}

function refreshAmaCenterSnapshotForManualReset(botKey) {
    if (!botKey) return false;

    // Manual resets should advance the persisted center baseline to the latest
    // AMA output before the grid is rebuilt. The raw AMA value remains intact
    // in amaCenterPrice for diagnostics.
    const snapshotPath = path.join(PROFILES_DIR, 'orders', `${botKey}.dynamicgrid.json`);
    let snapshotRaw;
    try {
        snapshotRaw = fs.readFileSync(snapshotPath, 'utf8');
    } catch (_) {
        return false;
    }

    let snapshot;
    try {
        snapshot = JSON.parse(snapshotRaw);
    } catch (_) {
        return false;
    }

    const amaCenterPrice = Number(snapshot?.amaCenterPrice);
    if (!Number.isFinite(amaCenterPrice) || amaCenterPrice <= 0) {
        return false;
    }

    const currentCenterPrice = Number(snapshot?.centerPrice);
    if (Number.isFinite(currentCenterPrice) && currentCenterPrice === amaCenterPrice) {
        return true;
    }

    const updatedSnapshot = {
        ...snapshot,
        centerPrice: amaCenterPrice,
        updatedAt: new Date().toISOString(),
    };

    const tmpPath = `${snapshotPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(updatedSnapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, snapshotPath);
    return true;
}

function performGridResync(options = {}) {
    const self = this;
    let success = false;
    const refreshCenterPrice = !!options.refreshCenterPrice;
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
            } catch (e) {
                self._warn(`Failed to reload config during resync (using current settings): ${e.message}`);
            }

            if (refreshCenterPrice) {
                if (refreshAmaCenterSnapshotForManualReset(self.config?.botKey)) {
                    self._log('Refreshed AMA center snapshot for manual grid reset.', 'info');
                } else {
                    self._warn('Manual grid reset requested but AMA center snapshot could not be refreshed.');
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

            if (fs.existsSync(self.triggerFile)) {
                fs.unlinkSync(self.triggerFile);
                self._log('Removed trigger file.');
            }
        } catch (err) {
            self._log(`Error during triggered resync: ${err.message}`, 'error');
        } finally {
            self.manager.finishBootstrap();
        }

        return success;
    })();
}

async function handlePendingTriggerReset() {
    if (!fs.existsSync(this.triggerFile)) {
        return false;
    }

    this._log('Pending trigger file detected. Processing reset before startup...');
    const triggerInfo = readTriggerMetadata(this.triggerFile);

    let resetSucceeded = false;
    await this.manager._fillProcessingLock.acquire(async () => {
        resetSucceeded = await this._performGridResync({
            refreshCenterPrice: triggerInfo.isManual,
        });
    });

    if (!resetSucceeded) {
        this._warn('Pending trigger reset failed. Continuing with normal startup path.');
    }

    return resetSucceeded;
}

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
                                const ok = await this._performGridResync({
                                    refreshCenterPrice: triggerInfo.isManual,
                                });
                                if (!ok) {
                                    this._warn('Runtime trigger reset failed; retaining existing grid state.');
                                }
                            }).catch(err => {
                                this._warn(`Trigger reset lock error: ${err.message}`);
                            });
                        }, 200);
                    }
                }
            } catch (err) {
                this._warn(`fs.watch handler error: ${err && err.message ? err.message : err}`);
            }
        });
    } catch (err) {
        this._warn(`Failed to setup file watcher: ${err.message}`);
    }
}

async function performPeriodicGridChecks() {
    await this._runGridMaintenance('periodic', { fillLockAlreadyHeld: true });
}

function isOpenOrdersSyncLoopEnabled() {
    return !!TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED;
}

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
                            this._markGridActivity?.('open-orders sync');
                            try {
                                const chainOpenOrders = await readOpenOrdersFn.call(chainOrders, this.accountId);
                                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                                if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                    this._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                    refreshDynamicWeightDistribution.call(this, 'open-orders sync rebalance');
                                    const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                                    const batchResult = await this._executeBatchIfNeeded(rebalanceResult, 'open-orders sync fill rebalance');
                                    if (!batchResult?.abortedForIllegalState && !batchResult?.abortedForAccountingFailure && !batchResult?.skippedNoActions) {
                                        await this.manager.persistGrid();
                                    }
                                }
                            } finally {
                                this._markGridActivity?.('open-orders sync end');
                            }
                        });
                    }
                }
            } catch (err) {
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

async function stopOpenOrdersSyncLoop() {
    this._mainLoopActive = false;
    if (this._mainLoopPromise) {
        await this._mainLoopPromise;
    }
}

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
                this._markGridActivity?.('periodic account fetch');
                await this.manager.fetchAccountTotals(this.accountId);
                this._markGridActivity?.('periodic account fetch end');

                let chainOpenOrders = [];
                if (!this.config.dryRun) {
                    try {
                        this._markGridActivity?.('periodic open-orders sync');
                        chainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                        const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch');

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                            refreshDynamicWeightDistribution.call(this, 'periodic blockchain fetch rebalance');
                            const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                            const batchResult = await this._executeBatchIfNeeded(rebalanceResult, 'periodic sync fill rebalance');
                            if (!batchResult?.abortedForIllegalState && !batchResult?.abortedForAccountingFailure && !batchResult?.skippedNoActions) {
                                await this.manager.persistGrid();
                            }
                        }

                        if (syncResult.unmatchedChainOrders && syncResult.unmatchedChainOrders.length > 0) {
                            this._log(`Periodic sync: ${syncResult.unmatchedChainOrders.length} chain order(s) not in grid (surplus/divergence)`, 'warn');
                        }
                    } catch (err) {
                        this._warn(`Error reading open orders during periodic fetch: ${err.message}`);
                    } finally {
                        this._markGridActivity?.('periodic open-orders sync end');
                    }
                }

                await this._performPeriodicGridChecks();
            });
        } catch (err) {
            this._warn(`Error during periodic blockchain fetch: ${err && err.message ? err.message : err}`);
        }
    }, intervalMs);

    this._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
}

function stopBlockchainFetchInterval() {
    if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
        clearInterval(this._blockchainFetchInterval);
        this._blockchainFetchInterval = null;
        this._log('Stopped periodic blockchain fetch interval');
    }
}

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
    return Math.max(0, nextRunAt - now);
}

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

function scheduleMaintenanceAfterIdle(ctx, context, options = {}) {
    if (!ctx || ctx._shuttingDown || ctx._maintenanceIdleTimer || !ctx.manager?._fillProcessingLock) return;

    const delayMs = getMaintenanceIdleDelayMs(ctx);
    if (!(delayMs > 0)) return;

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
                ctx._warn('Deferred trigger reset still blocked or failed; retaining existing grid state.');
            }
        }).catch(err => {
            ctx._warn(`Deferred trigger reset lock error: ${err.message}`);
        });
    }, delayMs);
}

async function executeMaintenanceLogic(context) {
    await this.manager.recalculateFunds();
    this.manager.clearStalePipelineOperations();

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
            this._log(
                `[DUST-CANCEL] Deferring ${context} structural maintenance until dust timer completes` +
                (delayMs !== null ? ` (next check in ${Math.ceil(delayMs / 1000)}s)` : ''),
                'info'
            );
            scheduleDeferredGridResync(this);
            return;
        }

        try {
            const persistedGridData = this.accountOrders.loadBotGrid(this.config.botKey, true) || [];
            const calculatedGrid = Array.from(this.manager.orders.values());
            const divergence = await Grid.monitorDivergence(this.manager, calculatedGrid, persistedGridData);

            if (divergence.needsUpdate) {
                if (divergence.buy.ratio || divergence.sell.ratio) {
                    this._log(`Grid update triggered by funds during ${context} (buy: ${divergence.buy.ratio}, sell: ${divergence.sell.ratio})`);
                }
                if (divergence.buy.rms || divergence.sell.rms) {
                    this._log(`Grid update triggered by structural divergence during ${context}: buy=${Format.formatPrice6(divergence.buy.metric)}, sell=${Format.formatPrice6(divergence.sell.metric)}`);
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
                } catch (err) {
                    this._warn(`Error applying divergence corrections during ${context}: ${err.message}`);
                }
            }
        } catch (err) {
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
        const firstSeen = this._dustSinceMap.get(o.orderId) ?? now;
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
                await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
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
        } catch (err) {
            this._warn(`[DUST-CANCEL] Failed to cancel dust order ${order.id}: ${err.message}`);
        }
    }

    let batchResult = null;
    if (syntheticFills.length > 0) {
        refreshDynamicWeightDistribution.call(this, 'dust cancel rebalance');
        const rebalanceResult = await this.manager.processFilledOrders(syntheticFills, new Set());
        batchResult = await this._executeBatchIfNeeded(rebalanceResult, `dust cancel [${syntheticFills.map(o => o.id).join(', ')}]`);
        if (!batchResult?.abortedForIllegalState && !batchResult?.abortedForAccountingFailure) {
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
        } catch (err) {
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

function clearDustMaintenanceTimer() {
    if (this._dustMaintenanceTimer) {
        clearTimeout(this._dustMaintenanceTimer);
        this._dustMaintenanceTimer = null;
    }
}

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
            this._warn(`Error during dust maintenance timer: ${err.message}`);
        }).finally(() => {
            if (!this._shuttingDown) {
                this._scheduleDustMaintenanceCheck();
            }
        });
    }, nextDelayMs);
}

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

async function runGridMaintenance(context = 'periodic', options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Grid maintenance options must be an object');
    }
    const fillLockAlreadyHeld = options.fillLockAlreadyHeld === true;
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

    try {
        if (!this.manager || !this.manager.orders || this.manager.orders.size === 0) return;

        const runWithDivergenceLock = async () => {
            await this.manager._divergenceLock.acquire(async () => {
                await this._executeMaintenanceLogic(context);
            });
        };

        if (fillLockAlreadyHeld) {
            await runWithDivergenceLock();
        } else {
            await this.manager._fillProcessingLock.acquire(async () => {
                await runWithDivergenceLock();
            });
        }
    } catch (err) {
        this._warn(`Error during ${context} grid maintenance: ${err.message}`);
    }
}

module.exports = {
    loadBotsConfigSnapshot,
    refreshDynamicWeightDistribution,
    performGridResync,
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
};
