const fs = require('fs');
const path = require('path');
const { BitShares } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const Grid = require('./order/grid');
const { ORDER_STATES, TIMING, MAINTENANCE, GRID_LIMITS } = require('./constants');
const { retryPersistenceIfNeeded, applyGridDivergenceCorrections } = require('./order/utils/system');
const Format = require('./order/format');
const { virtualizeOrder } = require('./order/utils/order');
const { parseJsonWithComments } = require('./account_bots');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const PROFILES_BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');

function performGridResync() {
    const self = this;
    let success = false;
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
                }
            } catch (e) {
                self._warn(`Failed to reload config during resync (using current settings): ${e.message}`);
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

    let resetSucceeded = false;
    await this.manager._fillProcessingLock.acquire(async () => {
        resetSucceeded = await this._performGridResync();
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
                            this.manager._fillProcessingLock.acquire(async () => {
                                const ok = await this._performGridResync();
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
                            const chainOpenOrders = await readOpenOrdersFn.call(chainOrders, this.accountId);
                            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                            if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                this._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                                const batchResult = await this._executeBatchIfNeeded(rebalanceResult, 'open-orders sync fill rebalance');
                                if (!batchResult?.abortedForIllegalState && !batchResult?.abortedForAccountingFailure && !batchResult?.skippedNoActions) {
                                    await this.manager.persistGrid();
                                }
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
                        const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch');

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
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
        const healthResult = await this.manager.checkGridHealth(this.updateOrdersOnChainPlan.bind(this));
        if (await this._abortFlowIfIllegalState(`${context} health check`)) return;
        const dustCancelResult = await this._cancelDustOrders({
            buy: healthResult.buyDustOrders,
            sell: healthResult.sellDustOrders,
        });
        if (dustCancelResult?.batchResult?.abortedForIllegalState || dustCancelResult?.batchResult?.abortedForAccountingFailure) {
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
    runGridMaintenance
};
