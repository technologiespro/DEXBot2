/**
 * modules/dexbot_class.js - DEXBot Core Engine
 *
 * Core trading bot implementation shared by bot.js (single) and dexbot.js (multi-bot).
 * Implements complete grid trading bot lifecycle.
 *
 * Responsibilities:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and order rotation
 * - Divergence detection and correction
 * - State persistence and recovery
 * - Market monitoring and health checks
 *
 * ===============================================================================
 * CORE CLASS: DEXBot
 * ===============================================================================
 *
 * LIFECYCLE METHODS:
 *   - constructor(config) - Initialize bot with configuration
 *   - run() - Start bot operation loop
 *   - shutdown() - Graceful shutdown
 *   - pause() - Pause bot operations
 *   - resume() - Resume bot operations
 *
 * CONFIGURATION:
 *   - loadBotConfig() - Load bot configuration from files
 *   - validateConfig() - Validate configuration values
 *
 * INITIALIZATION:
 *   - initialize() - Set up blockchain connection and grid
 *   - setupAccount() - Authenticate and load account
 *   - initializeOrderManager() - Create and initialize OrderManager
 *
 * ORDER OPERATIONS:
 *   - placeOrders() - Create and place new orders
 *   - updateOrders() - Modify existing orders
 *   - cancelOrders() - Cancel orders
 *   - processBatch() - Execute batch operations
 *
 * FILL PROCESSING:
 *   - processFills() - Handle order fill events
 *   - updateFromFill() - Update internal state from fill
 *   - processFilledOrders() - Comprehensive fill processing
 *
 * SYNCHRONIZATION:
 *   - syncFromBlockchain() - Sync grid state with blockchain
 *   - reconcileGrid() - Reconcile discrepancies
 *   - checkGridHealth() - Verify grid integrity
 *
 * REBALANCING:
 *   - rebalanceGrid() - Trigger grid rebalancing
 *   - rotateOrders() - Perform order rotation
 *   - checkSpreadCondition() - Verify spread limits
 *
 * MONITORING:
 *   - getMetrics() - Retrieve performance metrics
 *   - monitorHealth() - Check bot health status
 *   - detectDivergence() - Detect grid-blockchain divergence
 *
 * ===============================================================================
 *
 * HELPER FUNCTIONS (module-level):
 *   - normalizeBotEntry() - Normalize bot configuration object
 *   - validateBotConfig() - Validate configuration values
 *   - applyDefaults() - Apply default configuration values
 *
 * ===============================================================================
 *
 * STATE MANAGEMENT:
 * - Internal OrderManager maintains all state
 * - Persists grid snapshots to profiles/orders/{botKey}.json
 * - Recovers from persisted state on startup
 * - Real-time synchronization with blockchain
 *
 * ERROR HANDLING:
 * - Graceful error recovery
 * - Automatic reconnection on connection loss
 * - Anomaly detection and correction
 * - Detailed logging for debugging
 *
 * ===============================================================================
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const credentialPolicy = require('./credential_policy');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid } = require('./order');
const {
    retryPersistenceIfNeeded,
    initializeFeeCache,
    applyGridDivergenceCorrections
} = require('./order/utils/system');
const {
    hasExecutableActions,
    validateCreateTargetSlots
} = require('./order/utils/validate');
const {
    buildCreateOrderArgs,
    getOrderTypeFromUpdatedFlags,
    virtualizeOrder,
    correctAllPriceMismatches,
    convertToSpreadPlaceholder,
    buildOutsideInPairGroups,
    extractBatchOperationResults,
    buildFillKey
} = require('./order/utils/order');
const { validateOrderSize, calculateRotationOrderSizes } = require('./order/utils/math');
const {
    ProcessedFillStore,
    PROCESSED_FILL_PERSISTENCE_MODES
} = require('./order/processed_fill_store');
const DexbotFillRuntime = require('./dexbot_fill_runtime');
const DexbotMaintenanceRuntime = require('./dexbot_maintenance_runtime');
const CreditRuntime = require('./credit_runtime');
const {
    ORDER_STATES,
    ORDER_TYPES,
    REBALANCE_STATES,
    COW_ACTIONS,
    TIMING,
    MAINTENANCE,
    GRID_LIMITS,
    FILL_PROCESSING
} = require('./constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileStartupOrders } = require('./order/startup_reconcile');
const { AccountOrders, createBotKey } = require('./account_orders');
const { parseJsonWithComments } = require('./order/utils/system');
const { cloneWeightDistribution } = require('./order/utils/math');
const { normalizeBotEntry } = require('./bot_settings');
const Format = require('./order/format');

const PROFILES_BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

class DEXBot {
    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {Object} options - Optional settings
     * @param {string} options.logPrefix - Prefix for console logs (e.g., "[bot.js]")
     */
    constructor(config, options = {}) {
        // Validate critical config values before initialization
        this._validateStartupConfig(config);

        this.config = config;
        this._baseWeightDistribution = cloneWeightDistribution(config.weightDistribution) || { sell: 0.5, buy: 0.5 };
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;  // Will be initialized in start()
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        this._recentlyQueuedFills = new Map();
        this._fillCleanupCounter = 0;  // Deterministic cleanup tracking

        // Time-based configuration for fill processing (from constants.TIMING)
        this._fillDedupeWindowMs = TIMING.FILL_DEDUPE_WINDOW_MS;      // Window for deduplicating same fill events
        this._fillRecordRetentionMs = TIMING.FILL_RECORD_RETENTION_MS;  // Retain processed fill keys long enough to block replay
        this._processedFillPersistBatchMs = TIMING.PROCESSED_FILL_PERSIST_BATCH_MS;
        this._processedFillPersistBatchSize = TIMING.PROCESSED_FILL_PERSIST_BATCH_SIZE;
        this._processedFillStore = new ProcessedFillStore({
            batchMs: this._processedFillPersistBatchMs,
            batchSize: this._processedFillPersistBatchSize,
            warn: (message) => this._warn(message)
        });
        this._recentlyProcessedFills = this._processedFillStore.tracker;
        this._pendingProcessedFillWrites = this._processedFillStore.pendingWrites;

        this._incomingFillQueue = [];
        this.logPrefix = options.logPrefix || '';
        this._credentialDaemonWatchdogInterval = null;
        this._credentialDaemonDown = false;
        this._credentialRecoveryNeeded = false;
        this._credentialRecoveryInFlight = false;

        // Track order IDs whose grid slots were already freed by stale-order batch cleanup.
        // When a batch fails because an order no longer exists on-chain (filled between our
        // last sync and broadcast), the stale-cleanup converts the slot to VIRTUAL/SPREAD,
        // releasing committed funds back to chainFree. If a fill event later arrives for
        // that same order (orphan-fill), we must NOT credit the proceeds again — the capital
        // was already freed. Track IDs with timestamps and retain them for a cooldown window
        // to handle delayed history/RPC delivery of orphan fills.
        this._staleCleanedOrderIds = new Map();
        this._staleCleanupRetentionMs = Math.max(this._fillDedupeWindowMs || 0, 5 * 60 * 1000);

        // Metrics for monitoring lock contention and fill processing
        this._metrics = {
            fillsProcessed: 0,
            fillProcessingTimeMs: 0,
            batchesExecuted: 0,
            lockContentionEvents: 0,
            maxQueueDepth: 0
        };

        // Shutdown state
        this._shuttingDown = false;

        // Runtime handles for graceful lifecycle management
        this._blockchainFetchInterval = null;
        this._fillsUnsubscribe = null;
        this._triggerWatcher = null;
        this._triggerDebounceTimer = null;
        this._dustMaintenanceTimer = null;
        this._deferredGridResyncTimer = null;
        this._maintenanceIdleTimer = null;
        this._mainLoopActive = false;
        this._mainLoopPromise = null;
        this._creditRuntime = null;
        this._creditWatchdogInterval = null;

        // Pipeline state flags (used by maintenance gating)
        this._batchInFlight = false;
        this._batchRetryInFlight = false;
        this._recoverySyncInFlight = false;
        this._maintenanceCooldownCycles = 0;
        this._lastGridActivityAt = 0;

        // Tracks when each order first entered the dust state (orderId → timestamp ms).
        // Used by _cancelDustOrders to enforce DUST_CANCEL_DELAY_SEC.
        // Entries are pruned when an order recovers from dust or is cancelled.
        this._dustSinceMap = new Map();
    }

    /**
     * Validate startup configuration to catch errors early.
     * Ensures critical values are valid before bot starts.
     * @param {Object} config - Configuration object to validate
     * @throws {Error} If critical validation fails
     * @private
     */
    _validateStartupConfig(config) {
        const errors = [];

        // Validate startPrice is numeric or valid string mode
        const startPrice = config.startPrice;
        const validPriceModes = ['pool', 'book'];
        const legacyPriceModes = ['market', 'orderbook']; // accepted but normalized to 'book'
        const isPriceNumeric = typeof startPrice === 'number' && Number.isFinite(startPrice) && startPrice > 0;
        const isPriceMode = typeof startPrice === 'string' && [...validPriceModes, ...legacyPriceModes].includes(startPrice.toLowerCase());
        if (!isPriceNumeric && !isPriceMode) {
            errors.push(`startPrice must be a positive number or valid mode (${validPriceModes.join('/')}), got: ${startPrice}`);
        }

        // Validate assetA and assetB are present
        if (!config.assetA || typeof config.assetA !== 'string') {
            errors.push(`assetA must be a non-empty string, got: ${config.assetA}`);
        }
        if (!config.assetB || typeof config.assetB !== 'string') {
            errors.push(`assetB must be a non-empty string, got: ${config.assetB}`);
        }

        // Validate incrementPercent
        const increment = config.incrementPercent;
        if (!Number.isFinite(increment) || increment <= 0 || increment > 100) {
            errors.push(`incrementPercent must be between 0 and 100, got: ${increment}`);
        }

        // Throw all validation errors at once
        if (errors.length > 0) {
            throw new Error(`Config validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
        }
    }

    /**
     * Log a message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _log(msg, level = 'info') {
        if (level === 'warn') {
            this._warn(msg);
            return;
        }

        const line = this.logPrefix ? `${this.logPrefix} ${msg}` : msg;
        const logger = this.manager?.logger;
        if (logger && typeof logger.log === 'function') {
            logger.log(line, level);
            return;
        }
        if (level === 'error') {
            console.error(line);
            return;
        }

        console.log(line);
    }

    /**
     * Log a warning message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _warn(msg) {
        const line = this.logPrefix ? `${this.logPrefix} ${msg}` : msg;
        const logger = this.manager?.logger;
        if (logger && typeof logger.log === 'function') {
            logger.log(line, 'warn');
            return;
        }
        if (this.logPrefix) {
            console.warn(line);
        } else {
            console.warn(msg);
        }
    }

    /**
     * Persist the grid and trigger immediate recovery if validation fails.
     * Used during startup to ensure bot begins in a stable state.
     * @private
     */
    async _persistAndRecoverIfNeeded() {
        const validation = await this.manager.persistGrid();
        if (!validation.isValid) {
            this._warn(`Startup validation failed: ${validation.reason}. Triggering immediate recovery...`);
            // Trigger centralized recovery (Hard Reset)
            const recoveryValidation = await this.manager.accountant._performStateRecovery(this.manager);
            if (recoveryValidation.isValid) {
                this._log(`✓ Startup recovery successful. Persistent state restored.`);
                await this.manager.persistGrid();
            } else {
                this._warn(`Startup recovery failed: ${recoveryValidation.reason}. Bot proceeding with caution.`);
            }
        }
    }

    _getPipelineSignals() {
        return {
            incomingFillQueueLength: this._incomingFillQueue.length,
            shadowLocks: this.manager?.shadowOrderIds?.size || 0,
            batchInFlight: this._batchInFlight,
            retryInFlight: this._batchRetryInFlight,
            recoveryInFlight: this._recoverySyncInFlight,
            broadcasting: this.manager?._state?.isBroadcastingActive() || false
        };
    }

    _markGridActivity(reason = 'activity') {
        this._lastGridActivityAt = Date.now();
        this.manager?.logger?.log?.(`[MAINT-IDLE] Activity observed: ${reason}`, 'debug');
    }

    async _triggerStateRecoverySync(reason = 'state recovery sync') {
        if (!this.manager) return;

        if (this._recoverySyncInFlight) {
            this.manager.logger.log(`[RECOVERY] Skipping duplicate recovery request: ${reason}`, 'warn');
            return;
        }

        this._recoverySyncInFlight = true;
        try {
            this.manager.logger.log(`Triggering state recovery sync (${reason})...`, 'info');
            await this.manager.fetchAccountTotals(this.accountId);
            const openOrders = await chainOrders.readOpenOrders(this.accountId);
            await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: false });
            if (typeof this.manager.persistGrid === 'function') {
                await this.manager.persistGrid();
            }
        } finally {
            this._recoverySyncInFlight = false;
        }
    }

    async _abortFlowIfIllegalState(flowContext) {
        const illegalSignal = this.manager?.consumeIllegalStateSignal?.();
        if (!illegalSignal) {
            return false;
        }

        this.manager.logger.log(
            `[HARD-ABORT] ${flowContext} aborted due to illegal state (${illegalSignal.context}): ${illegalSignal.message}`,
            'error'
        );
        await this._triggerStateRecoverySync(`hard-abort ${flowContext}`);
        this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
        return true;
    }

    async _handleBatchHardAbort(err, phase = 'batch processing', opsCount = 0) {
        const baseResult = { executed: false, hadRotation: false };
        const opsInfo = opsCount > 0 ? ` with ${opsCount} ops` : '';

        if (err?.code === 'ILLEGAL_ORDER_STATE') {
            const illegalSignal = this.manager.consumeIllegalStateSignal?.();
            await this._triggerStateRecoverySync(illegalSignal?.message || `illegal order state during ${phase}${opsInfo}`);
            this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
            return { ...baseResult, abortedForIllegalState: true };
        }

        if (err?.code === 'ACCOUNTING_COMMITMENT_FAILED') {
            const accountingSignal = this.manager.consumeAccountingFailureSignal?.();
            const reason = accountingSignal
                ? `accounting lock failure (${accountingSignal.side} ${Format.formatAmount8(accountingSignal.amount)}) during ${accountingSignal.context}`
                : `accounting commitment lock failure during ${phase}${opsInfo}`;
            await this._triggerStateRecoverySync(reason);
            this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
            return { ...baseResult, abortedForAccountingFailure: true };
        }

        return null;
    }

    async _applyRecoverableGridUpdates(updates, context = 'recoverable-grid-update') {
        if (!this.manager || !Array.isArray(updates) || updates.length === 0) {
            return 0;
        }

        if (typeof this.manager.applyGridUpdateBatch === 'function') {
            await this.manager.applyGridUpdateBatch(updates, context);
            return updates.length;
        }

        let applied = 0;
        for (const update of updates) {
            if (typeof this.manager._updateOrder !== 'function') break;
            await this.manager._updateOrder(update, context);
            applied++;
        }
        return applied;
    }

    async _recoverExplicitStaleOrders(staleOrderIds, reason = 'stale order cleanup') {
        const staleIds = Array.from(staleOrderIds || []).filter(Boolean);
        if (staleIds.length === 0) {
            return { executed: false, hadRotation: false, stale: false };
        }

        this.manager.logger.log(
            `[COW] Stale order(s) detected: ${staleIds.join(', ')}. Applying targeted cleanup.`,
            'warn'
        );

        const updates = [];
        for (const orderId of staleIds) {
            this._staleCleanedOrderIds.set(orderId, Date.now());
        }

        for (const gridOrder of this.manager.orders.values()) {
            if (!gridOrder?.orderId || !staleOrderIds.has(gridOrder.orderId)) continue;
            updates.push({ ...virtualizeOrder(gridOrder), size: 0 });
        }

        if (updates.length > 0) {
            await this._applyRecoverableGridUpdates(updates, reason);
        } else {
            this.manager.logger.log(
                `[COW] No local grid slot matched stale order cleanup request (${staleIds.join(', ')}).`,
                'debug'
            );
        }

        return {
            executed: false,
            hadRotation: false,
            stale: true,
            recoveredByVirtualization: updates.length > 0
        };
    }

    async _recoverBatchSizeDrift(err) {
        const reason = `recoverable size drift during COW batch: ${err.message}`;
        this.manager.logger.log(
            `[COW] Recovering from on-chain size drift via recovery sync: ${err.message}`,
            'warn'
        );
        await this._triggerStateRecoverySync(reason);
        return {
            executed: false,
            hadRotation: false,
            recoveredBySync: true,
            reason: 'ORDER_SIZE_DRIFT'
        };
    }

    /**
     * Initialize bot state from storage and blockchain.
     * Consolidates common initialization logic for start() and startWithPrivateKey().
     * @private
     */
    async _initializeStartupState() {
        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });
        this._processedFillStore.configure({
            accountOrders: this.accountOrders,
            botKey: this.config.botKey
        });

        // Load persisted processed fills to prevent reprocessing after restart
        const loadedPersistedFills = this._processedFillStore.loadPersisted({
            minTimestamp: Date.now() - this._fillRecordRetentionMs
        });
        if (loadedPersistedFills > 0) {
            this._log(`Loaded ${loadedPersistedFills} persisted fill records to prevent reprocessing`);
        }

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .map((b, originalIdx) => b.active !== false ? normalizeBotEntry(b, originalIdx) : null)
            .filter(b => b !== null);

        await this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;
        }
        this._wireProcessedFillTracking();
        this.manager.startBootstrap();

        // Fetch account totals from blockchain at startup to initialize funds
        try {
            if (this.accountId && this.config.assetA && this.config.assetB) {
                await this.manager._initializeAssets();
                await this.manager.fetchAccountTotals(this.accountId);
                this._log('Fetched blockchain account balances at startup');
            }
        } catch (err) {
            this._warn(`Failed to fetch account totals at startup: ${err.message}`);
        }

        // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
        try {
            await initializeFeeCache([this.config || {}], BitShares);
        } catch (err) {
            this._warn(`Fee cache initialization failed: ${err.message}`);
        }

        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);

        // CRITICAL REPAIR: Strip fake orderIds where orderId === id (e.g. "slot-0")
        let repairedGrid = persistedGrid;
        if (persistedGrid && persistedGrid.length > 0) {
            let repairCount = 0;
            repairedGrid = persistedGrid.map(order => {
                if (order && order.orderId && order.orderId === order.id) {
                    repairCount++;
                    const repairedOrder = { ...order, orderId: '' };
                    if (repairedOrder.state === ORDER_STATES.ACTIVE || repairedOrder.state === ORDER_STATES.PARTIAL) {
                        repairedOrder.state = ORDER_STATES.VIRTUAL;
                    }
                    return repairedOrder;
                }
                return order;
            });
            if (repairCount > 0) {
                this._log(`[REPAIR] Stripped ${repairCount} fake orderId(s) from persisted grid to restore rebalancing logic.`);
            }
        }

        const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);
        const persistedBoundaryIdx = this.accountOrders.loadBoundaryIdx(this.config.botKey);

        return {
            persistedGrid: repairedGrid,
            persistedBtsFeesOwed,
            persistedBoundaryIdx
        };
    }

    _wireProcessedFillTracking() {
        return DexbotFillRuntime.wireProcessedFillTracking.call(this);
    }

    async _flushProcessedFillPersistence(reason = 'manual', options = {}) {
        return DexbotFillRuntime.flushProcessedFillPersistence.call(this, reason, options);
    }

    async _flushProcessedFillPersistenceForKeys(fillKeys, reason = 'manual-selected', options = {}) {
        return DexbotFillRuntime.flushProcessedFillPersistenceForKeys.call(this, fillKeys, reason, options);
    }

    _discardPendingProcessedFillPersistence(fillKeys) {
        return DexbotFillRuntime.discardPendingProcessedFillPersistence.call(this, fillKeys);
    }

    _buildOrphanFillFallbackKey(fill) {
        return DexbotFillRuntime.buildOrphanFillFallbackKey.call(this, fill);
    }

    async _applyReplaySafeFillAccounting(fill, fillOp, {
        missingKeyMessage,
        fallbackKeyMessage,
        replayMessage,
        errorMessage,
        logger = this.manager?.logger,
        missingKeyLevel = 'warn',
        fallbackKeyLevel = 'warn',
        replayLevel = 'debug',
        persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE,
        allowOrphanFallbackKey = false
    } = {}) {
        return DexbotFillRuntime.applyReplaySafeFillAccounting.call(this, fill, fillOp, {
            missingKeyMessage,
            fallbackKeyMessage,
            replayMessage,
            errorMessage,
            logger,
            missingKeyLevel,
            fallbackKeyLevel,
            replayLevel,
            persistenceMode,
            allowOrphanFallbackKey
        });
    }

    async _applyReplaySafeTrackedFillAccounting(fill, fillOp, {
        context,
        logger = this.manager?.logger,
        replayMessage,
        persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
    } = {}) {
        return DexbotFillRuntime.applyReplaySafeTrackedFillAccounting.call(this, fill, fillOp, {
            context,
            logger,
            replayMessage,
            persistenceMode
        });
    }

    async _applyReplaySafeOrphanFillAccounting(fill, fillOp, {
        context,
        logger = this.manager?.logger,
        replayMessage,
        persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
    } = {}) {
        return DexbotFillRuntime.applyReplaySafeOrphanFillAccounting.call(this, fill, fillOp, {
            context,
            logger,
            replayMessage,
            persistenceMode
        });
    }

    _refreshDynamicWeightDistribution(context = 'runtime') {
        return DexbotMaintenanceRuntime.refreshDynamicWeightDistribution.call(this, context);
    }

    /**
     * Finalize the bot startup after account and initial grid sync are complete.
     * Consolidates common logic for start() and startWithPrivateKey().
     * @private
     */
    async _finishStartupSequence(startupState) {
        let {
            persistedGrid,
            persistedBtsFeesOwed,
            persistedBoundaryIdx
        } = startupState;

        try {
            // CRITICAL: Activate fill listener EARLY - before ANY operations that place orders
            // This ensures fills during trigger reset and grid initialization are captured
            if (typeof this._fillsUnsubscribe === 'function') {
                await this._fillsUnsubscribe().catch(() => { });
            }
            this._fillsUnsubscribe = await chainOrders.listenForFills(this.account || undefined, this._createFillCallback(chainOrders));
            if (typeof this._fillsUnsubscribe !== 'function') {
                this._warn('Fill listener did not provide an unsubscribe handler. Shutdown cleanup may be incomplete.');
                this._fillsUnsubscribe = null;
            }
            this._log('Fill listener activated (ready to process fills during startup)');

            // CRITICAL: Handle any pending trigger file reset FIRST before any other startup operations
            const hadTriggerReset = await this._handlePendingTriggerReset();

            // CRITICAL: After trigger reset, skip normal startup - grid is already fully initialized
            // The trigger reset already did: grid init, order placement, sync, and persistence
            if (hadTriggerReset) {
                this._log('Trigger reset completed. Skipping normal startup grid initialization.');

                // Post-bootstrap validation and fill processing
                await this.manager._fillProcessingLock.acquire(async () => {
                    // STEP 1: Check for fills that occurred during trigger reset
                    // These are orders that got filled while Grid.recalculateGrid() was running.
                    // The filled slots need new orders placed on them.
                    if (this._incomingFillQueue.length > 0) {
                        this._log(`[POST-RESET] ${this._incomingFillQueue.length} fill(s) detected during trigger reset. Processing...`);

                        // Process fills - this will place new orders on the filled slots
                        // Use normal fill processing since bootstrap is complete
                        const fills = this._incomingFillQueue.splice(0);
                        let requiresOpenOrdersSync = false;
                        for (const fill of fills) {
                            if (!fill || fill.op?.[0] !== 4) continue;

                            const fillOp = fill.op[1];
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);

                            if (!gridOrder) {
                                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing
                                 this._log(`[POST-RESET] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                     context: 'POST-RESET',
                                     logger: { log: this._log.bind(this) },
                                     replayMessage: (op) => `[POST-RESET] Replay detected for orphan fill ${op.order_id}; skipping duplicate credit`
                                 });
                                 if (accountingResult.status === 'missing_key') {
                                     requiresOpenOrdersSync = true;
                                 }
                                continue;
                            }

                            this._log(`[POST-RESET] Processing fill for ${gridOrder.type} order ${gridOrder.id} at price ${gridOrder.price}`);

                             const accountingResult = await this._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                                 context: 'POST-RESET',
                                 logger: { log: this._log.bind(this) },
                                 replayMessage: (op) => `[POST-RESET] Replay detected for ${op.order_id}; skipping duplicate rebalance`
                             });
                             if (accountingResult.status === 'missing_key') {
                                 requiresOpenOrdersSync = true;
                                 continue;
                             }
                             if (accountingResult.status !== 'applied') {
                                 continue;
                             }

                            // Process this fill through the full rebalance pipeline
                            // This will shift the boundary and place a new order on the filled slot
                            this._refreshDynamicWeightDistribution('post-reset fill rebalance');
                            const rebalanceResult = await this.manager.processFilledOrders([gridOrder], new Set());

                            const batchResult = await this._executeBatchIfNeeded(rebalanceResult, `[POST-RESET] fill ${gridOrder.id}`);
                            if (batchResult?.abortedForIllegalState || batchResult?.abortedForAccountingFailure) {
                                this._warn('[POST-RESET] Aborted batch due to illegal state; skipping grid persistence this cycle');
                                continue;
                            }
                        }

                        if (requiresOpenOrdersSync) {
                            this._log('[POST-RESET] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
                            const postResetChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                            const syncResult = await this.manager.syncFromOpenOrders(postResetChainOpenOrders);
                            if (syncResult.filledOrders?.length > 0) {
                                this._refreshDynamicWeightDistribution('post-reset open-orders fallback');
                                const rebalanceResult = await this.manager.processFilledOrders(syncResult.filledOrders, new Set());
                                await this._executeBatchIfNeeded(rebalanceResult, '[POST-RESET] open-orders fallback');
                            }
                        }

                        await this._flushProcessedFillPersistence('post-reset-batch');

                        await this.manager.persistGrid();
                    }

                    // STEP 2: Spread check AFTER fills are processed
                    await this.manager.recalculateFunds();
                    this._refreshDynamicWeightDistribution('post-reset spread check');
                    const spreadResult = await this.manager.checkSpreadCondition(
                        BitShares,
                        this.updateOrdersOnChainPlan.bind(this)
                    );
                    if (spreadResult && spreadResult.ordersPlaced > 0) {
                        this._log(`✓ Spread correction after trigger reset: ${spreadResult.ordersPlaced} order(s) placed`);
                        await this._persistAndRecoverIfNeeded();
                    }
                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                });

                await this._setupTriggerFileDetection();
                await this._setupCreditRuntime();
                await this._refreshAndSyncCreditRuntime();
                this._setupBlockchainFetchInterval();
                this._setupCreditWatchdogInterval();
                this._setupCredentialDaemonWatchdogInterval();

                if (this._isOpenOrdersSyncLoopEnabled()) {
                    this._startOpenOrdersSyncLoop();
                } else {
                    this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
                }
                this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);
                return; // Skip normal startup path
            }

            // Restore persisted BTS fee
            // SAFE: Done at startup before orders are created, and within fill lock when needed
            this.manager.resetFunds();
            // CRITICAL FIX: Restore BTS fees owed from persistence
            if (persistedBtsFeesOwed && persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = Number(persistedBtsFeesOwed);
            }

            if (!this.config.dryRun && !this.accountId) {
                throw new Error('Cannot start bot without a resolved account ID');
            }

            // Use this.accountId which was set during initialize()
            const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

            let shouldRegenerate = false;
            if (!persistedGrid || persistedGrid.length === 0) {
                shouldRegenerate = true;
                this._log('No persisted grid found. Generating new grid.');
            } else {
                await this.manager._initializeAssets();
                const decision = await decideStartupGridAction({
                    persistedGrid,
                    chainOpenOrders,
                    manager: this.manager,
                    logger: { log: (msg) => this._log(msg) },
                    storeGrid: async (orders) => {
                        // Temporarily replace manager.orders to persist the specific orders
                        const originalOrders = this.manager.orders;
                        this.manager.orders = new Map(orders.map(o => [o.id, o]));
                        await this.manager.persistGrid();
                        this.manager.orders = originalOrders;
                    },
                    attemptResumeFn: attemptResumePersistedGridByPriceMatch,
                });
                shouldRegenerate = decision.shouldRegenerate;

                if (shouldRegenerate && chainOpenOrders.length === 0) {
                    this._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
                }
            }

            // Restore BTS fees owed ONLY if we're NOT regenerating the grid
            if (!shouldRegenerate) {
                // CRITICAL: Restore BTS fees owed from blockchain operations
                if (persistedBtsFeesOwed > 0) {
                    this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                    this._log(`✓ Restored BTS fees owed: ${Format.formatAmount8(persistedBtsFeesOwed)} BTS`);
                }
            } else {
                this._log(`ℹ Grid regenerating - resetting BTS fees to clean state`);
                this.manager.funds.btsFeesOwed = 0;
            }

            // CRITICAL: Use fill lock during ENTIRE startup synchronization to prevent races.
            // This includes grid init, finishBootstrap, and maintenance - all in one atomic block.
            // Lock order: _fillProcessingLock → _divergenceLock (canonical order, same as _consumeFillQueue)
            await this.manager._fillProcessingLock.acquire(async () => {
                try {
                    this._refreshDynamicWeightDistribution('startup');
                    if (shouldRegenerate) {
                        await this.manager._initializeAssets();

                        if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                            this._log('Generating new grid and syncing with existing on-chain orders...');
                            await Grid.initializeGrid(this.manager);
                            await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                            const rebalanceResult = await reconcileStartupOrders({
                                manager: this.manager,
                                config: this.config,
                                account: this.account,
                                privateKey: this.privateKey,
                                chainOrders,
                                chainOpenOrders,
                            });

                            await this._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (regenerated grid)');
                        } else {
                            this._log('Generating new grid and placing initial orders on-chain...');
                            await this.placeInitialOrders();
                        }
                        await this._persistAndRecoverIfNeeded();
                    } else {
                        this._log('Found active session. Loading and syncing existing grid.');
                        await Grid.loadGrid(this.manager, persistedGrid, persistedBoundaryIdx);
                        let startupChainOpenOrders = chainOpenOrders;
                        const syncResult = await this.manager.synchronizeWithChain(startupChainOpenOrders, 'readOpenOrders');

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                            this._refreshDynamicWeightDistribution('startup fill rebalance');
                            const startupFillRebalance = await this.manager.processFilledOrders(syncResult.filledOrders, new Set(), { skipAccountTotalsUpdate: true });
                            const batchResult = await this._executeBatchIfNeeded(startupFillRebalance, 'startup sync fill rebalance');

                            if (!batchResult?.abortedForIllegalState && !batchResult?.abortedForAccountingFailure && !batchResult?.skippedNoActions) {
                                // Refresh open orders so startup reconcile works with post-batch chain reality
                                // and avoids reconciling against a stale pre-batch snapshot.
                                startupChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                                await this.manager.synchronizeWithChain(startupChainOpenOrders, 'readOpenOrders');
                            }
                        }

                        const rebalanceResult = await reconcileStartupOrders({
                            manager: this.manager,
                            config: this.config,
                            account: this.account,
                            privateKey: this.privateKey,
                            chainOrders,
                            chainOpenOrders: startupChainOpenOrders,
                        });

                        await this._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (loaded grid)');

                        await this._persistAndRecoverIfNeeded();
                    }

                    this.manager.finishBootstrap();

                    // Perform initial grid maintenance (thresholds, divergence, spread, health)
                    // Consolidated into shared logic to ensure consistent behavior at boot and runtime.
                    // CRITICAL: Pass lockAlreadyHeld since we're inside _fillProcessingLock.acquire()
                    await this._runGridMaintenance('startup', { fillLockAlreadyHeld: true });

                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                } finally {
                    // CRITICAL: Always clear bootstrap flag, even on error
                    this.manager.finishBootstrap();
                }
            });

            await this._setupTriggerFileDetection();
            await this._setupCreditRuntime();
            await this._refreshAndSyncCreditRuntime();
            this._setupBlockchainFetchInterval();
            this._setupCreditWatchdogInterval();
            this._setupCredentialDaemonWatchdogInterval();

            if (this._isOpenOrdersSyncLoopEnabled()) {
                this._startOpenOrdersSyncLoop();
            } else {
                this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
            }
            this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);

        } catch (err) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    /**
     * Create the fill callback for listenForFills.
     * Separated from start() to allow deferred activation after startup completes.
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @returns {Function} Async callback for processing fills
     * @private
     */
    _createFillCallback(chainOrders) {
        return DexbotFillRuntime.createFillCallback.call(this, chainOrders);
    }

    /**
     * Consume and process the fill queue with deduplication and sequential rebalancing.
     * Protected by AsyncLock to ensure single consumer.
     *
     * FLOW:
     * 1. Deduplicates fills using fillKey tracking and time window
     * 2. Syncs filled orders from history or open orders mode
     * 3. Handles price mismatches via correctAllPriceMismatches
     * 4. Processes fills sequentially with interruptible rebalancing (merges new work between fills)
     * 5. Periodically cleans old fill records to prevent memory leaks
     *
     * Atomic lock behavior: If already processing or has waiters, returns immediately (no double-queuing)
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @private
     */
    async _consumeFillQueue(chainOrders) {
        // ATOMIC: Only attempt lock acquisition if queue has work
        // This prevents unnecessary lock contention on empty queues
        if (this._incomingFillQueue.length === 0) {
            return;
        }

        // Check shutdown state
        if (this._shuttingDown) {
            this._warn('Fill processing skipped: shutdown in progress');
            return;
        }

        let pendingFillKeysForCurrentCycle = new Set();
        try {
            // BOOTSTRAP OPTIMIZATION: During bootstrap, prioritize fill processing over grid-wide checks
            // Process fills immediately with side-only rebalancing (no expensive full grid recalculations)
            if (this.manager._state.isBootstrapping()) {
                // During bootstrap: skip lock contention checks, process fills directly
                await this.manager._fillProcessingLock.acquire(async () => {
                    if (!this.manager._state.isBootstrapping()) return; // bootstrap finished while waiting for lock
                    await this._processFillsWithBootstrapMode(chainOrders);
                });
                return;
            }

            // NORMAL MODE: Non-blocking check if lock already has waiters
            // This prevents unbounded queue growth while still ensuring processing
            // Note: We DO proceed if lock is held but has no waiters - we'll wait our turn
            if (this.manager._fillProcessingLock.getQueueLength() > 0) {
                this._metrics.lockContentionEvents++;
                return;
            }

            await this.manager._fillProcessingLock.acquire(async () => {
                while (this._incomingFillQueue.length > 0) {
                    const batchStartTime = Date.now();

                    // Track max queue depth
                    this._metrics.maxQueueDepth = Math.max(this._metrics.maxQueueDepth, this._incomingFillQueue.length);

                    // 1. Take snapshot of current work (ATOMIC: splice removes and returns fills atomically)
                    const allFills = this._incomingFillQueue.splice(0);  // Atomically clear and get all fills

                    const validFills = [];
                    const processedFillKeys = new Set();
                    pendingFillKeysForCurrentCycle = new Set();
                    let requiresOpenOrdersSync = false;

                    // 2. Filter and Deduplicate (Standard Logic)
                    for (const fill of allFills) {
                        if (fill && fill.op && fill.op[0] === FILL_PROCESSING.OPERATION_TYPE) {
                            const fillOp = fill.op[1];

                            // ACCOUNT VALIDATION: Verify the filled order belongs to this bot's account/grid
                            // Only process fills for orders we actually manage
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);
                            if (!gridOrder) {
                                // Check if this order was already freed by stale-order batch cleanup.
                                // When a batch fails due to a stale order reference, the cleanup converts the
                                // slot to VIRTUAL/SPREAD, releasing committed funds to chainFree. If we also
                                // credit the fill proceeds here, we double-count the capital.
                                const staleMarkedAt = this._staleCleanedOrderIds.get(fillOp.order_id);
                                const staleAgeMs = Date.now() - staleMarkedAt;
                                if (Number.isFinite(staleMarkedAt) && staleAgeMs <= this._staleCleanupRetentionMs) {
                                    this.manager.logger.log(
                                        `[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${fillOp.order_id} ` +
                                        `(funds already freed by batch cleanup, age=${staleAgeMs}ms)`,
                                        'warn'
                                    );
                                    continue;
                                }

                                // Entry exists but expired: remove and process as normal orphan fill.
                                if (this._staleCleanedOrderIds.has(fillOp.order_id)) {
                                    this._staleCleanedOrderIds.delete(fillOp.order_id);
                                }

                                // Legitimate orphan fill: order was virtualized during sequential processing
                                // but a fill arrived afterward. Credit proceeds to maintain fund tracking.
                                 this.manager.logger.log(`[ORPHAN-FILL] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                     context: 'ORPHAN-FILL',
                                     replayMessage: (op) => `[ORPHAN-FILL] Replay detected for ${op.order_id}; skipping duplicate credit`
                                 });
                                 if (accountingResult.status === 'missing_key') {
                                     requiresOpenOrdersSync = true;
                                 }
                                // Don't add to validFills - we can't do rebalancing without a grid slot
                                // But the funds are now credited, preventing fund invariant violation
                                continue;
                            }

                            // Process both maker and taker fills for our grid orders
                            // Grid validation ensures we only process fills belonging to our account
                            // Taker fills are included because the bot may execute market orders or act as taker
                            const roleStr = fillOp.is_maker ? 'maker' : 'taker';
                            this.manager.logger.log(`Processing ${roleStr} fill for order ${fillOp.order_id}`, 'debug');

                            const fillKey = buildFillKey(fill);
                            if (!fillKey) {
                                this.manager.logger.log(
                                    `[FILL] Missing history id for order ${fillOp.order_id} block ${fill.block_num}; deferring to open-orders sync`,
                                    'warn'
                                );
                                requiresOpenOrdersSync = true;
                                continue;
                            }
                            const now = Date.now();
                            if (this._recentlyQueuedFills.has(fillKey)) {
                                const lastProcessed = this._recentlyQueuedFills.get(fillKey);
                                if (now - lastProcessed < this._fillDedupeWindowMs) {
                                    this.manager.logger.log(`Skipping duplicate fill for ${fillOp.order_id} (processed ${now - lastProcessed}ms ago)`, 'debug');
                                    continue;
                                }
                            }

                            if (processedFillKeys.has(fillKey)) continue;

                            processedFillKeys.add(fillKey);
                            this._recentlyQueuedFills.set(fillKey, now);
                            validFills.push(fill);

                            // Log info
                            const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                            const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                            const fillLogger = this.manager?.logger;
                            if (fillLogger && typeof fillLogger.log === 'function') {
                                fillLogger.log(`\n===== FILL DETECTED =====`, 'info');
                                fillLogger.log(`Order ID: ${fillOp.order_id}`, 'info');
                                fillLogger.log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`, 'info');
                                fillLogger.log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`, 'info');
                                fillLogger.log(`=========================\n`, 'info');
                            } else {
                                console.log(`\n===== FILL DETECTED =====`);
                                console.log(`Order ID: ${fillOp.order_id}`);
                                console.log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`);
                                console.log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                                console.log(`=========================\n`);
                            }
                        }
                    }

                    // Clean up short-lived queue dedupe cache to prevent memory leak.
                    const cleanupTimestamp = Date.now();
                    let cleanedCount = 0;
                    for (const [key, timestamp] of this._recentlyQueuedFills) {
                        if (cleanupTimestamp - timestamp > this._fillDedupeWindowMs) {
                            this._recentlyQueuedFills.delete(key);
                            cleanedCount++;
                        }
                    }
                    if (cleanedCount > 0) {
                        this.manager.logger.log(`Cleaned ${cleanedCount} old queued fill records. Remaining: ${this._recentlyQueuedFills.size}`, 'debug');
                    }

                    if (validFills.length === 0 && !requiresOpenOrdersSync) continue; // Loop back for more

                    // 3. Sync and Collect Filled Orders
                    let allFilledOrders = [];
                    let ordersNeedingCorrection = [];
                    const fillMode = chainOrders.getFillProcessingMode();

                    const processValidFills = async (fillsToSync) => {
                        let resolvedOrders = [];
                        if (fillMode === 'history') {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');
                            for (const fill of fillsToSync) {
                                const resultHistory = await this.manager.syncFromFillHistory(fill, {
                                    persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.MANUAL
                                });
                                const fillKey = buildFillKey({
                                    orderId: fill?.op?.[1]?.order_id,
                                    blockNum: fill?.block_num,
                                    historyId: fill?.id
                                });
                                if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                                await this._seedDustTimersFromPartialUpdates(resultHistory.updatedOrders, Date.now());
                                if (resultHistory.filledOrders) resolvedOrders.push(...resultHistory.filledOrders);
                                if (resultHistory.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                            }
                        }

                        if (fillMode !== 'history' || requiresOpenOrdersSync) {
                            if (fillMode === 'history' && requiresOpenOrdersSync) {
                                this.manager.logger.log(
                                    'Falling back to open-orders sync for fill(s) missing replay-safe history identifiers',
                                    'warn'
                                );
                            }
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                            const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                            const resultOpenOrders = await this.manager.syncFromOpenOrders(chainOpenOrders);
                            await this._seedDustTimersFromPartialUpdates(resultOpenOrders.updatedOrders, Date.now());
                            if (resultOpenOrders.filledOrders) resolvedOrders.push(...resultOpenOrders.filledOrders);
                            if (resultOpenOrders.ordersNeedingCorrection) ordersNeedingCorrection.push(...resultOpenOrders.ordersNeedingCorrection);
                        }
                        return resolvedOrders;
                    };

                    this.manager.pauseFundRecalc();
                    try {
                        allFilledOrders = await processValidFills(validFills);

                        // 4. Handle Price Corrections
                        if (ordersNeedingCorrection.length > 0) {
                            const correctionResult = await correctAllPriceMismatches(
                                this.manager, this.account, this.privateKey, chainOrders
                            );
                            if (correctionResult.failed > 0) this.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                        }

                    } finally {
                        await this.manager.recalculateFunds();
                        await this.manager.resumeFundRecalc();
                    }

                    // 5. Fixed-Cap Fill Rebalance
                    // - 1..MAX_FILL_BATCH_SIZE fills: unified full-set planning
                    // - larger bursts: fixed-size chunking at MAX_FILL_BATCH_SIZE
                    if (allFilledOrders.length > 0) {
                        const maxBatch = Math.max(1, FILL_PROCESSING.MAX_FILL_BATCH_SIZE || 1);
                        const totalFills = allFilledOrders.length;

                        const useUnifiedPlan = totalFills <= maxBatch;
                        const modeLabel = useUnifiedPlan ? 'unified' : 'chunked';
                        this.manager.logger.log(
                            `Processing ${totalFills} filled orders (${modeLabel}, baseBatch=${useUnifiedPlan ? totalFills : maxBatch})...`,
                            'info'
                        );

                        let anyRotations = false;
                        let abortedFillCycle = false;

                        this.manager.pauseFundRecalc();
                        try {
                            let i = 0;
                            while (i < totalFills) {
                                const remaining = totalFills - i;
                                let currentBatchSize;

                                if (useUnifiedPlan) {
                                    currentBatchSize = remaining;
                                } else {
                                    currentBatchSize = Math.min(maxBatch, remaining);
                                }

                                const batchEnd = Math.min(i + currentBatchSize, totalFills);
                                const fillBatch = allFilledOrders.slice(i, batchEnd);
                                i = batchEnd;

                                const batchIds = fillBatch.map(f => f.id).join(', ');
                                this.manager.logger.log(
                                    `>>> Processing fill set [${batchIds}] (${i}/${totalFills})`,
                                    'info'
                                );

                                // For chunked mode, exclude fills planned for later chunks to reduce churn.
                                const batchIdSet = new Set(fillBatch.map(f => f.id));
                                const fullExcludeSet = new Set();
                                if (!useUnifiedPlan) {
                                    for (const other of allFilledOrders) {
                                        if (batchIdSet.has(other.id)) continue;
                                        if (other.orderId) fullExcludeSet.add(other.orderId);
                                        if (other.id) fullExcludeSet.add(other.id);
                                    }
                                }

                                this.manager.logger.logFundsStatus(this.manager, `BEFORE fill set processing [${batchIds}]`);

                                this._refreshDynamicWeightDistribution(`fill set [${batchIds}]`);
                                const rebalanceResult = await this.manager.processFilledOrders(fillBatch, fullExcludeSet);

                                this.manager.logger.logFundsStatus(
                                    this.manager,
                                    `AFTER rebalanceOrders calculated for fill set [${batchIds}] (planned: ${rebalanceResult.ordersToPlace?.length || 0} new, ${rebalanceResult.ordersToRotate?.length || 0} rotations)`
                                );

                                const batchResult = await this._executeBatchIfNeeded(rebalanceResult, `fill set [${batchIds}]`);

                                if (batchResult?.abortedForIllegalState || batchResult?.abortedForAccountingFailure) {
                                    this.manager.logger.log(
                                        `[HARD-ABORT] Fill set [${batchIds}] aborted due to critical state. ` +
                                        'Skipping persistence and ending current fill cycle.',
                                        'error'
                                    );
                                    abortedFillCycle = true;
                                    break;
                                }

                                if (batchResult.hadRotation) {
                                    anyRotations = true;
                                    this.manager.logger.logFundsStatus(this.manager, `AFTER rotation completed for fill set [${batchIds}]`);
                                }
                                const batchFillKeys = new Set(fillBatch.map(filledOrder => buildFillKey({
                                    orderId: filledOrder?.orderId,
                                    blockNum: filledOrder?.blockNum,
                                    historyId: filledOrder?.historyId
                                })).filter(Boolean));
                                await this._flushProcessedFillPersistenceForKeys(batchFillKeys, `fill set [${batchIds}]`);
                                await this.manager.persistGrid();
                            }
                         } finally {
                             await this.manager.resumeFundRecalc();
                         }

                        if (abortedFillCycle && pendingFillKeysForCurrentCycle.size > 0) {
                            await this._flushProcessedFillPersistenceForKeys(
                                pendingFillKeysForCurrentCycle,
                                'fill-batch-aborted-after-verified-sync'
                            );
                            this.manager.logger.log(
                                `[FILL-DEDUP] Persisted verified fill keys after aborted fill cycle; grid persistence remains guarded separately.`,
                                'warn'
                            );
                        } else if (pendingFillKeysForCurrentCycle.size > 0) {
                            await this._flushProcessedFillPersistenceForKeys(
                                pendingFillKeysForCurrentCycle,
                                'fill-batch-committed'
                            );
                        }

                        // 6. Rebalance Recovery Loop (Sequential Extensions)
                        // DISABLED FOR SEQUENTIAL: Each sequential fill already triggers a full rebalance with proper
                        // boundary shift. An additional recovery loop with EMPTY fills causes the boundary to remain
                        // at the last fill's position, leading to wrong operation types (updates instead of rotations)
                        // and operations on the wrong side.
                        //
                        // In the future, recovery loop can be re-enabled for single fills if needed, but ONLY
                        // if it passes the actual fills to processFilledOrders so the boundary shifts correctly.
                        // For now: Each fill = full rebalance with boundary shift = complete correction in one pass.
                        // CRITICAL: Do NOT run spread correction here during sequential fill processing.
                        // The rebalance from each fill should maintain spread naturally. Running spread correction
                        // immediately after creates new orders that may get filled by market before next cycle,
                        // causing cascading fills and potentially SPREAD slots becoming PARTIAL (error condition).
                        // Spread correction runs in the main loop instead.
                        const fullFillCount = allFilledOrders.filter(o =>
                            o && o.isPartial !== true
                        ).length;
                        const shouldRunPostFillChecks = !abortedFillCycle && fullFillCount > 0 && anyRotations;

                        if (shouldRunPostFillChecks) {
                            // SAFE: Called inside _fillProcessingLock.acquire(), no concurrent fund modifications
                            await this.manager.recalculateFunds();

                            // Check grid health only if pipeline is empty (no pending fills, no pending operations)
                            const pipelineStatus = this.manager.isPipelineEmpty(this._getPipelineSignals());
                            if (pipelineStatus.isEmpty) {
                                const healthResult = await this.manager.checkGridHealth(
                                    this.updateOrdersOnChainPlan.bind(this)
                                );
                                const dustCancelResult = await this._cancelDustOrders({
                                    buy: healthResult.buyDustOrders,
                                    sell: healthResult.sellDustOrders,
                                });
                                if (dustCancelResult?.batchResult?.abortedForIllegalState || dustCancelResult?.batchResult?.abortedForAccountingFailure) {
                                    abortedFillCycle = true;
                                }
                            } else {
                                // Pipeline not empty - defer grid health check to prevent premature modifications
                                // This is NORMAL and EXPECTED during high-activity periods
                                const health = this.manager.getPipelineHealth();
                                this.manager.logger.log(
                                    `Deferring grid health check: ${pipelineStatus.reasons.join(', ')}. ` +
                                    `Blocked for: ${health.blockedDurationHuman}`,
                                    'debug'
                                );
                            }
                        }

                        // Run grid maintenance after fills to rebuild degraded grid.
                        // CRITICAL FIX (commit a946c33): Replaced inline divergence checks with centralized
                        // _runGridMaintenance call to ensure pipeline protection applies consistently.
                        // Before: Divergence checks ran immediately after fills, causing race-to-resize
                        // After: Grid maintenance waits for isPipelineEmpty() before structural changes
                        // Run only when the cycle contains at least one full fill.
                        if (shouldRunPostFillChecks && !abortedFillCycle) {
                            await this._runGridMaintenance('post-fill', { fillLockAlreadyHeld: true });
                        }
                    } else if (pendingFillKeysForCurrentCycle.size > 0) {
                        await this._flushProcessedFillPersistenceForKeys(
                            pendingFillKeysForCurrentCycle,
                            'fill-batch-no-rotations'
                        );
                    }

                    await retryPersistenceIfNeeded(this.manager);

                    // Periodically clean up old fill records after processing N fills.
                    // Counter is protected by _fillProcessingLock during fill consumption.
                    this._fillCleanupCounter += validFills.length;

                    const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                        ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                        : 100; // Default: every 100 fills

                    if (this._fillCleanupCounter >= cleanupThreshold) {
                        try {
                            await this.accountOrders.cleanOldProcessedFills(this.config.botKey, TIMING.FILL_RECORD_RETENTION_MS);
                            this._fillCleanupCounter = 0;  // Reset counter after cleanup (success or retry on next batch if failed)
                        } catch (err) {
                            this.manager?.logger?.log(`Warning: Fill cleanup failed (will retry): ${err.message}`, 'warn');
                        }
                    }

                    // Update metrics
                    this._metrics.fillsProcessed += validFills.length;
                    this._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                    // Prune expired stale-cleaned order IDs after each processing cycle.
                    // Keep entries for a retention window to protect against delayed orphan-fill delivery.
                    if (this._staleCleanedOrderIds.size > 0) {
                        const now = Date.now();
                        let prunedCount = 0;
                        for (const [orderId, markedAt] of this._staleCleanedOrderIds) {
                            if (!Number.isFinite(markedAt) || now - markedAt > this._staleCleanupRetentionMs) {
                                this._staleCleanedOrderIds.delete(orderId);
                                prunedCount++;
                            }
                        }
                        if (prunedCount > 0) {
                            this.manager.logger.log(
                                `[STALE-CLEANUP] Pruned ${prunedCount} expired stale-cleaned order IDs ` +
                                `(retention=${this._staleCleanupRetentionMs}ms, remaining=${this._staleCleanedOrderIds.size})`,
                                'debug'
                            );
                        }
                    }

                } // End while(_incomingFillQueue)

                this._markGridActivity('fill processing end');
            });
        } catch (err) {
            const isCredentialOutage = this._isCredentialDaemonError(err);
            if (pendingFillKeysForCurrentCycle.size > 0) {
                const flushReason = isCredentialOutage
                    ? 'credential-outage-verified-fills'
                    : 'fill-cycle-error-verified-fills';

                if (isCredentialOutage) {
                    this._credentialRecoveryNeeded = true;
                    this._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
                }

                try {
                    await this._flushProcessedFillPersistenceForKeys(
                        pendingFillKeysForCurrentCycle,
                        flushReason,
                        { throwOnError: true }
                    );
                    const credentialSuffix = isCredentialOutage
                        ? '; grid persistence is suspended until recovery'
                        : '';
                    this.manager?.logger?.log?.(
                        `[FILL-DEDUP] Persisted ${pendingFillKeysForCurrentCycle.size} verified processed-fill write(s) after fill cycle error${credentialSuffix}.`,
                        isCredentialOutage ? 'warn' : 'info'
                    );
                } catch (flushErr) {
                    this.manager?.logger?.log?.(
                        `[FILL-DEDUP] Failed to persist verified fill keys during fill error handling: ${flushErr.message}`,
                        'warn'
                    );
                }
            }

            if (isCredentialOutage && pendingFillKeysForCurrentCycle.size === 0) {
                this._credentialRecoveryNeeded = true;
                this._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
            }
            this._log(`Error processing fills: ${err.message}`);
            const logger = this.manager?.logger;
            if (logger && typeof logger.log === 'function') {
                logger.log(`Error processing fills: ${err.message}`, 'error');
                if (err.stack) logger.log(err.stack, 'error');
            } else {
                console.error('CRITICAL: Error processing fills (logger unavailable):', err);
            }
        }

        // Post-processing: If new fills arrived while processing, schedule another cycle
        // SAFE: Done outside lock context, no async work in finally block
        if (!this._shuttingDown && this._incomingFillQueue.length > 0) {
            // Schedule consumer restart asynchronously (not in finally block)
            setImmediate(() => this._consumeFillQueue(chainOrders).catch(err => {
                this._log(`Error in deferred consumer restart: ${err.message}`);
                if (this.manager && this.manager.logger) {
                    this.manager.logger.log(`Deferred consumer restart failed: ${err.message}`, 'error');
                }
            }));
        }
    }

    /**
     * Process fills during bootstrap phase using simple rotation.
     *
     * BOOTSTRAP MODE STRATEGY:
     * - Use pre-calculated grid sizes (no new math)
     * - When fill occurs: rotate opposite-side capital to cover the gap
     * - When BUY fills → rotate highest active BUY to next SELL slot
     * - When SELL fills → rotate highest active SELL to next BUY slot
     * - Maintain grid coverage with original slot sizes
     * - No rebalancing, no resizing - just rotation
     *
     * This ensures:
     * - Opposite-side reaction immediate (inventory balance)
     * - Grid sizes stay consistent with startup calculation
     * - Fast response during bootstrap without expensive calculations
     *
     * @param {Object} chainOrders - Chain orders instance for broadcasting
     * @returns {Promise<void>}
     */
    async _processFillsWithBootstrapMode(chainOrders) {
        if (this._incomingFillQueue.length === 0) return;

        const startTime = Date.now();
        const fills = this._incomingFillQueue.splice(0);
        const validFills = [];
        const processedFillKeys = new Set();
        let requiresOpenOrdersSync = false;
        const ORDER_TYPES = require('./constants').ORDER_TYPES;

        // 1. Validate and deduplicate fills
        for (const fill of fills) {
            if (!fill || fill.op?.[0] !== 4) continue;

            const fillOp = fill.op[1];
            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                Array.from(this.manager.orders.values()).find(o => o.orderId === fillOp.order_id);

            if (!gridOrder) {
                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing
                 this.manager.logger.log(`[BOOTSTRAP] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                     context: 'BOOTSTRAP'
                 });
                 if (accountingResult.status === 'missing_key') {
                     requiresOpenOrdersSync = true;
                 }
                continue;
            }

            const accountingResult = await this._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                context: 'BOOTSTRAP',
                replayMessage: (op) => `[BOOTSTRAP] Replay detected for ${op.order_id}; skipping duplicate bootstrap rotation`
            });
            if (accountingResult.status === 'missing_key') {
                requiresOpenOrdersSync = true;
                continue;
            }
            if (accountingResult.status !== 'applied') {
                continue;
            }

            if (processedFillKeys.has(accountingResult.fillKey)) continue;
            processedFillKeys.add(accountingResult.fillKey);
            validFills.push({ ...fill, gridOrder });

            const fillType = gridOrder.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL';
            this._log(`[BOOTSTRAP] Fill detected: ${fillType} order (${fillOp.is_maker ? 'maker' : 'taker'})`);
         }

        if (requiresOpenOrdersSync) {
            this._log('[BOOTSTRAP] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
            const bootstrapChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
            const syncResult = await this.manager.syncFromOpenOrders(bootstrapChainOpenOrders);
            if (syncResult.filledOrders?.length > 0) {
                const queuedOrderIds = new Set(validFills.map(fill => fill?.gridOrder?.orderId).filter(Boolean));
                for (const filledOrder of syncResult.filledOrders) {
                    if (!filledOrder?.orderId || queuedOrderIds.has(filledOrder.orderId)) continue;
                    validFills.push({ gridOrder: filledOrder });
                    queuedOrderIds.add(filledOrder.orderId);
                }
            }
        }

        await this._flushProcessedFillPersistence('bootstrap-batch');

        if (validFills.length === 0) return;

        // Refresh dynamic weights so rotation orders use live weight distribution
        this._refreshDynamicWeightDistribution('bootstrap fill');

        // 2. Process fills with simple rotation (use fresh weights for sizing)
        try {
            this._log(`[BOOTSTRAP] Processing ${validFills.length} fill(s) with simple rotation`, 'info');

            const ordersToPlace = [];

            for (const fill of validFills) {
                const filledOrder = fill.gridOrder;
                const filledType = filledOrder.type;
                const oppositeType = filledType === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;

                // Mark filled slot as VIRTUAL (released)
                await this.manager._updateOrder(
                    { ...virtualizeOrder(filledOrder), size: 0 },
                    'bootstrap-fill',
                    { skipAccounting: false, fee: 0 }
                );

                // Find highest active order on opposite side (closest to market)
                const allOrders = Array.from(this.manager.orders.values());
                const activeOpposite = allOrders.filter(o =>
                    o.type === oppositeType &&
                    o.orderId &&
                    o.state === ORDER_STATES.ACTIVE
                );

                if (activeOpposite.length === 0) {
                    this._log(`[BOOTSTRAP] No active ${oppositeType} orders to rotate`, 'debug');
                    continue;
                }

                // Sort to find market-closest (highest price for SELL, lowest price for BUY)
                activeOpposite.sort((a, b) =>
                    oppositeType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price
                );

                const surplusOrder = activeOpposite[0];

                // Find empty slot on opposite side (VIRTUAL with no orderId)
                const emptySlotsOpposite = allOrders.filter(o =>
                    o.type === oppositeType &&
                    !o.orderId &&
                    o.state === ORDER_STATES.VIRTUAL
                );

                if (emptySlotsOpposite.length === 0) {
                    this._log(`[BOOTSTRAP] No empty ${oppositeType} slots to rotate into`, 'debug');
                    continue;
                }

                // Sort to find best slot (closest to market)
                emptySlotsOpposite.sort((a, b) =>
                    oppositeType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price
                );

                const targetSlot = emptySlotsOpposite[0];

                // Recalculate size using fresh dynamic weights (same logic as normal path)
                const oppositeSide = oppositeType === ORDER_TYPES.BUY ? 'buy' : 'sell';
                const ctx = await Grid._getSizingContext(this.manager, oppositeSide);
                const allOppositeSlots = allOrders
                    .filter(o => o.type === oppositeType)
                    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
                const targetIdx = allOppositeSlots.findIndex(s => s.id === targetSlot.id);
                const rotationSize = (ctx && ctx.budget > 0 && targetIdx >= 0)
                    ? calculateRotationOrderSizes(ctx.budget, 0, allOppositeSlots.length, oppositeType, this.manager.config, 0, ctx.precision)[targetIdx]
                    : targetSlot.size;

                this._log(`[BOOTSTRAP] Rotating ${surplusOrder.id} → ${targetSlot.id} (${oppositeType} ${Format.formatAmount8(rotationSize)})`, 'info');

                // Mark surplus as released
                await this.manager._updateOrder(
                    { ...virtualizeOrder(surplusOrder), size: 0 },
                    'bootstrap-rotate',
                    { skipAccounting: false, fee: 0 }
                );

                // Create rotation order with weight-adjusted size
                ordersToPlace.push({
                    id: targetSlot.id,
                    type: oppositeType,
                    price: targetSlot.price,
                    size: rotationSize
                });
            }

            // Broadcast rotation orders
            if (ordersToPlace.length > 0) {
                const sizes = ordersToPlace.map(o => `${o.type}:${Format.formatAmount8(o.size)}`).join(' ');
                this._log(`[BOOTSTRAP] Broadcasting ${ordersToPlace.length} rotation order(s) - sizes: ${sizes}`, 'info');
                await this.updateOrdersOnChainPlan({ ordersToPlace });
            }

            this._metrics.fillsProcessed += validFills.length;
            this._metrics.fillProcessingTimeMs += Date.now() - startTime;

        } catch (err) {
            this._warn(`[BOOTSTRAP] Error processing fills: ${err.message}`);
            this.manager.logger.log(`[BOOTSTRAP] Fill error: ${err.message}`, 'error');
        }
    }

    /**
     * Set up account identifier and configure global context.
     * @param {string} accountName - The name of the account to set up
     * @private
     */
    async _setupAccountContext(accountName) {
        const accId = await chainOrders.resolveAccountId(accountName);

        if (!accId) {
            throw new Error(`Unable to resolve account id for '${accountName}'`);
        }

        await chainOrders.setPreferredAccount(accId, accountName);
        this.account = accountName;
        this.accountId = accId;
        this._log(`Initialized DEXBot for account: ${this.account}`);
    }

    /**
     * Initialize the bot by connecting to BitShares and setting up the account.
     * @param {string|Object|Buffer} [vaultSecret=null] - The unlock secret for authentication.
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails or preferredAccount is missing.
     */
    async initialize(vaultSecret = null) {
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);
        if (this.config && this.config.preferredAccount) {
            try {
                let privateKey = null;

                if (vaultSecret) {
                    privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, vaultSecret);
                } else if (await chainKeys.isDaemonResponsive()) {
                    try {
                        const sessionId = await chainKeys.probeAccountInDaemon(this.config.preferredAccount);
                        const botHmacSecret = credentialPolicy.loadBotHmacSecret(
                            this.config.preferredAccount,
                            path.join(__dirname, '..', 'profiles', 'daemon-policies.json'),
                            { quiet: true }
                        );
                        privateKey = chainKeys.createDaemonSigningToken(this.config.preferredAccount, {
                            sessionId,
                            botHmacSecret,
                        });
                    } catch (err) {
                        this._warn(`Credential daemon probe failed: ${err.message}. Falling back to interactive authentication.`);
                    }
                }

                if (!privateKey) {
                    const unlockSecret = await chainKeys.authenticate();
                    privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, unlockSecret);
                }

                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err) {
                if (chainKeys.isMasterPasswordFailure(err)) {
                    throw err;
                }
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.js has fallback to selectAccount, bot.js throws
                if (typeof chainOrders.selectAccount === 'function') {
                    const accountData = await chainOrders.selectAccount();
                    this.privateKey = accountData.privateKey;
                    await this._setupAccountContext(accountData.accountName);
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
    }

    /**
     * Places initial orders on the blockchain.
     * @returns {Promise<void>}
     */
    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;
        }
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            this._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
        }

        this._refreshDynamicWeightDistribution('initial order placement');
        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            await this.manager.persistGrid();
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        // Place in outside->center pair mode when both sides are available.
        const orderGroups = this._buildOutsideInPairGroupsForOrders(ordersToActivate);

        for (const group of orderGroups) {
            await this.updateOrdersOnChainPlan({ ordersToPlace: group });
        }

        await this.manager.persistGrid();
        this.manager.finishBootstrap();
    }

    _buildOutsideInPairGroupsForOrders(orders) {
        return buildOutsideInPairGroups(orders, {
            isValid: Boolean,
            getType: o => o.type,
            getPrice: o => o.price,
        });
    }

    _buildOutsideInPairGroupsForCreateEntries(createEntries) {
        return buildOutsideInPairGroups(createEntries, {
            isValid: e => Boolean(e?.context?.order),
            getType: e => e.context.order.type,
            getPrice: e => e.context.order.price,
        });
    }

    _extractOperationResults(result, warnContext = '') {
        const extracted = extractBatchOperationResults(result);

        if (Array.isArray(extracted)) return extracted;

        if (result) {
            const resultType = Array.isArray(result) ? 'array' : typeof result;
            const keySummary = (resultType === 'object' && !Array.isArray(result))
                ? Object.keys(result).slice(0, 8).join(',')
                : '';
            const contextSuffix = warnContext ? ` (${warnContext})` : '';
            const keysSuffix = keySummary ? `; keys=[${keySummary}]` : '';
            this.manager?.logger?.log(
                `[COW] Unrecognized operation_results shape${contextSuffix}; defaulting to empty results. resultType=${resultType}${keysSuffix}`,
                'warn'
            );
        }

        return [];
    }

    // Pair mode applies only when create contexts include both BUY and SELL.
    // Single-side create batches intentionally remain a single executeBatch.
    _shouldExecuteCreatePairMode(opContexts) {
        if (!Array.isArray(opContexts) || opContexts.length < 2) return false;
        if (!opContexts.every(ctx => ctx?.kind === 'create' && ctx?.order)) return false;

        let hasBuy = false;
        let hasSell = false;
        for (const ctx of opContexts) {
            if (ctx.order.type === ORDER_TYPES.BUY) hasBuy = true;
            if (ctx.order.type === ORDER_TYPES.SELL) hasSell = true;
            if (hasBuy && hasSell) return true;
        }
        return false;
    }

    async _executeOperationsWithStrategy(operations, opContexts) {
        if (!this._shouldExecuteCreatePairMode(opContexts)) {
            const result = await chainOrders.executeBatch(this.account, this.privateKey, operations);
            return { result, opContexts };
        }

        const createEntries = [];
        for (let i = 0; i < operations.length; i++) {
            createEntries.push({
                operation: operations[i],
                context: opContexts[i],
            });
        }

        const groups = this._buildOutsideInPairGroupsForCreateEntries(createEntries);
        const mergedOperationResults = [];
        const mergedRawResults = [];
        const mergedContexts = [];

        // Grouped execution is fail-fast, but NOT atomic across groups.
        // Each group is a separate on-chain transaction; if a later group fails,
        // earlier groups may already be confirmed on-chain.

        for (let idx = 0; idx < groups.length; idx++) {
            const group = groups[idx];
            const groupOps = group.map(e => e.operation);
            const groupContexts = group.map(e => e.context);
            this.manager.logger.log(
                `[COW] Broadcasting create pair group ${idx + 1}/${groups.length} (${groupOps.length} op${groupOps.length > 1 ? 's' : ''}, outside->center)`,
                'info'
            );
            let groupResult;
            try {
                groupResult = await chainOrders.executeBatch(this.account, this.privateKey, groupOps);
            } catch (err) {
                const groupsBroadcast = idx;
                const groupsTotal = groups.length;
                const broadcastedOperationCount = mergedContexts.length;
                this.manager.logger.log(
                    `[COW] Grouped create execution failed at group ${idx + 1}/${groupsTotal}; ${groupsBroadcast} group(s) already broadcast (${broadcastedOperationCount} op context(s)). Partial on-chain state is possible.`,
                    'error'
                );
                err.partialOnChainState = groupsBroadcast > 0;
                err.groupsBroadcast = groupsBroadcast;
                err.groupsTotal = groupsTotal;
                err.broadcastedOperationCount = broadcastedOperationCount;
                throw err;
            }
            const groupOpResults = this._extractOperationResults(groupResult);

            mergedOperationResults.push(...groupOpResults);
            mergedRawResults.push(groupResult?.raw || null);
            mergedContexts.push(...groupContexts);
        }

        return {
            result: {
                success: true,
                raw: {
                    grouped: true,
                    groupsExecuted: groups.length,
                    groupResults: mergedRawResults,
                },
                operation_results: mergedOperationResults,
                grouped: true,
                groupsExecuted: groups.length
            },
            opContexts: mergedContexts
        };
    }

    /**
     * Validate that operations can be executed with available funds before broadcasting.
     * Checks sufficient available funds for all operations.
     * @param {Array} operations - Operations to validate
     * @param {Object} assetA - Asset A metadata (id, precision, symbol)
     * @param {Object} assetB - Asset B metadata (id, precision, symbol)
     * @returns {Object} { isValid: boolean, summary: string }
     * @private
     */
    _validateOperationFunds(operations, assetA, assetB) {
        if (!operations || operations.length === 0) {
            return { isValid: true, summary: 'No operations to validate' };
        }

        const { blockchainToFloat, floatToBlockchainInt, quantizeFloat } = require('./order/utils/math');
        const snap = this.manager.getChainFundsSnapshot();
        const netRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };
        const runningRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };
        const peakRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };

        // Sum amounts and check individual order sizes
        for (const op of operations) {
            if (!op?.op_data) continue;

            let sellAssetId = null;
            let sellAmountInt = 0;

            if (op.op_name === 'limit_order_create') {
                sellAssetId = op.op_data.amount_to_sell?.asset_id;
                sellAmountInt = op.op_data.amount_to_sell?.amount;
            } else if (op.op_name === 'limit_order_update') {
                // In limit_order_update, new_price.base is the amount to sell
                sellAssetId = op.op_data.new_price?.base?.asset_id;
                sellAmountInt = op.op_data.new_price?.base?.amount;
            }

            if (sellAssetId && (sellAmountInt !== undefined && sellAmountInt !== null)) {
                const precision = (sellAssetId === assetA.id) ? assetA.precision : assetB.precision;
                const assetSymbol = (sellAssetId === assetA.id) ? assetA.symbol : assetB.symbol;

                // CRITICAL SAFETY CHECK: Ensure amount is greater than zero
                if (Number(sellAmountInt) <= 0) {
                    return {
                        isValid: false,
                        summary: `[VALIDATION] CRITICAL: Zero amount order detected for ${assetSymbol} (assetId=${sellAssetId})`,
                        violations: [{ asset: assetSymbol, sizeInt: sellAmountInt, reason: 'Zero amount' }]
                    };
                }

                // Track signed per-op deltas in operation order.
                // CREATE consumes full amount; UPDATE consumes/releases delta.
                let signedDelta = 0;
                if (op.op_name === 'limit_order_update') {
                    const deltaAssetId = op.op_data.delta_amount_to_sell?.asset_id;
                    const deltaSellInt = op.op_data.delta_amount_to_sell?.amount;
                    if (deltaAssetId === sellAssetId && Number.isFinite(Number(deltaSellInt))) {
                        signedDelta = blockchainToFloat(deltaSellInt, precision);
                    }
                } else {
                    signedDelta = blockchainToFloat(sellAmountInt, precision);
                }

                netRequiredFunds[sellAssetId] = quantizeFloat(
                    (netRequiredFunds[sellAssetId] || 0) + signedDelta,
                    precision
                );

                runningRequiredFunds[sellAssetId] = quantizeFloat(
                    (runningRequiredFunds[sellAssetId] || 0) + signedDelta,
                    precision
                );

                const nextPeak = Math.max(
                    Number(peakRequiredFunds[sellAssetId] || 0),
                    Number(runningRequiredFunds[sellAssetId] || 0)
                );
                peakRequiredFunds[sellAssetId] = quantizeFloat(nextPeak, precision);
            }
        }

        // Calculate available funds - CRITICAL FIX: Check against FREE balance, not free+required
        // Bug: Previous logic added requiredFunds to available, making validation meaningless
        // Correct logic: available = chainFree (current free balance)
        // If required > available, batch will fail on execution
        const availableFunds = {
            [assetA.id]: quantizeFloat(snap.chainFreeSell || 0, assetA.precision),
            [assetB.id]: quantizeFloat(snap.chainFreeBuy || 0, assetB.precision)
        };

        // Check for fund violations using quantized comparison
        const fundViolations = [];
        for (const assetId in peakRequiredFunds) {
            const required = peakRequiredFunds[assetId];
            const netRequired = netRequiredFunds[assetId] || 0;
            const available = availableFunds[assetId] || 0;

            // Use precision-aware comparison
            const prec = (assetId === assetA.id) ? assetA.precision : assetB.precision;
            if (floatToBlockchainInt(required, prec) > floatToBlockchainInt(available, prec)) {
                fundViolations.push({
                    asset: assetId === assetA.id ? assetA.symbol : assetB.symbol,
                    required,
                    netRequired,
                    available,
                    deficit: quantizeFloat(required - available, prec)
                });
            }
        }

        if (fundViolations.length > 0) {
            let summary = `[VALIDATION] Fund validation FAILED:\n`;
            for (const v of fundViolations) {
                summary += `  ${v.asset}: peakRequired=${Format.formatAmount8(v.required)}, netRequired=${Format.formatAmount8(v.netRequired)}, available=${Format.formatAmount8(v.available)}, deficit=${Format.formatAmount8(v.deficit)}\n`;
            }
            return { isValid: false, summary: summary.trim(), violations: fundViolations };
        }

        const summary = `[VALIDATION] PASSED: ${operations.length} operations`;
        return { isValid: true, summary };
    }

    _resolveIdealSizeForValidation(orderLike, fallbackSize = null) {
        const candidates = [
            orderLike?.idealSize,
            orderLike?.order?.idealSize,
            orderLike?.size,
            orderLike?.order?.size,
            fallbackSize
        ];

        for (const candidate of candidates) {
            const numeric = Number(candidate);
            if (Number.isFinite(numeric) && numeric > 0) {
                return numeric;
            }
        }

        return null;
    }

    _validateOrderSizeForExecution(size, type, orderLike = null, fallbackSize = null) {
        return validateOrderSize(
            size,
            type,
            this.manager.assets,
            GRID_LIMITS.MIN_ORDER_SIZE_FACTOR || 50,
            this._resolveIdealSizeForValidation(orderLike, fallbackSize),
            GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5
        );
    }

    async _executeBatchIfNeeded(rebalanceResult, contextLabel = 'rebalance') {
        if (!hasExecutableActions(rebalanceResult)) {
            this.manager?.logger?.log?.(`[COW] No actions needed for ${contextLabel}`, 'debug');
            // Clear REBALANCING state even when there are no actions to execute.
            // _applySafeRebalanceCOW sets REBALANCING before calling the COW engine;
            // if the engine returns an empty actions list (not aborted), the state
            // would otherwise remain stuck at REBALANCING permanently, blocking
            // all subsequent fill processing and rebalance attempts.
            this.manager?._clearWorkingGridRef?.();
            return { executed: false, hadRotation: false, skippedNoActions: true };
        }
        return await this.updateOrdersOnChainBatch(rebalanceResult);
    }

    _isCredentialDaemonWriteRequired() {
        return chainKeys.isDaemonSigningToken(this.privateKey);
    }

    _suspendGridPersistenceForCredentialOutage(reason) {
        if (typeof this.manager?.suspendGridPersistence === 'function') {
            this.manager.suspendGridPersistence(reason);
        }
    }

    _resumeGridPersistenceAfterCredentialRecovery(reason) {
        if (typeof this.manager?.resumeGridPersistence === 'function') {
            this.manager.resumeGridPersistence(reason);
        }
    }

    async _ensureCredentialDaemonWritable(contextLabel = 'write batch') {
        if (!this._isCredentialDaemonWriteRequired()) {
            return;
        }

        const token = this.privateKey;
        try {
            await chainKeys.probeAccountInDaemon(
                token.accountName,
                Math.min(5000, TIMING.DAEMON_STARTUP_TIMEOUT_MS || 5000),
                { socketPath: token.socketPath }
            );
        } catch (err) {
            const message = `Credential daemon unavailable before ${contextLabel}: ${err.message}`;
            this._credentialDaemonDown = true;
            this._credentialRecoveryNeeded = true;
            this._suspendGridPersistenceForCredentialOutage(message);
            this.manager?.logger?.log?.(`[CREDENTIAL] ${message}. Write operations paused; re-unlock with node pm2.`, 'error');
            const wrapped = new Error(message);
            wrapped.code = 'CREDENTIAL_DAEMON_UNAVAILABLE';
            wrapped.cause = err;
            throw wrapped;
        }
    }

    _isCredentialDaemonError(err) {
        if (!err) return false;
        if (err.code === 'CREDENTIAL_DAEMON_UNAVAILABLE') return true;
        const message = String(err.message || '');
        return /Credential daemon|Daemon connection failed|daemon .*unavailable|dexbot-cred-daemon\.sock|ECONNREFUSED|ENOENT/.test(message);
    }

    async _runCredentialRecoveryAfterDaemonRestored() {
        if (this._credentialRecoveryInFlight || !this._credentialRecoveryNeeded || this._shuttingDown) {
            return;
        }

        this._credentialRecoveryInFlight = true;
        try {
            this.manager?.logger?.log?.(
                '[CREDENTIAL] Credential daemon restored; reconciling chain state before resuming write batches.',
                'info'
            );
            this._resumeGridPersistenceAfterCredentialRecovery('credential recovery started');
            const runRecovery = async () => {
                await this._triggerStateRecoverySync('credential daemon restored');
                await this._runGridMaintenance('credential-recovery', { fillLockAlreadyHeld: true });
            };
            if (this.manager?._fillProcessingLock) {
                await this.manager._fillProcessingLock.acquire(runRecovery);
            } else {
                await runRecovery();
            }
            this._credentialRecoveryNeeded = false;
            this.manager?.logger?.log?.('[CREDENTIAL] Credential recovery sync complete.', 'info');
        } catch (err) {
            this._credentialRecoveryNeeded = true;
            this._suspendGridPersistenceForCredentialOutage(`credential recovery failed: ${err.message}`);
            this.manager?.logger?.log?.(
                `[CREDENTIAL] Credential recovery sync failed: ${err.message}. Writes remain guarded by preflight.`,
                'error'
            );
        } finally {
            this._credentialRecoveryInFlight = false;
        }
    }

    _setupCredentialDaemonWatchdogInterval() {
        if (this._credentialDaemonWatchdogInterval) {
            clearInterval(this._credentialDaemonWatchdogInterval);
            this._credentialDaemonWatchdogInterval = null;
        }

        if (!this._isCredentialDaemonWriteRequired()) {
            this._credentialDaemonDown = false;
            return;
        }

        const intervalMs = Math.max(30_000, Number(TIMING.CREDENTIAL_DAEMON_WATCHDOG_MS) || 60_000);
        const probe = async () => {
            if (this._shuttingDown || !this._isCredentialDaemonWriteRequired()) return;
            const token = this.privateKey;
            try {
                await chainKeys.probeAccountInDaemon(
                    token.accountName,
                    2000,
                    { socketPath: token.socketPath }
                );
                if (this._credentialDaemonDown) {
                    this.manager?.logger?.log?.('[CREDENTIAL] Credential daemon responsive again.', 'info');
                }
                this._credentialDaemonDown = false;
                await this._runCredentialRecoveryAfterDaemonRestored();
            } catch (err) {
                if (!this._credentialDaemonDown) {
                    const errMsg = String(err.message || '');
                    let hint = '';
                    if (errMsg.includes('ENOENT')) {
                        hint = `Socket file missing at ${token.socketPath}. The credential daemon process may have been killed (e.g. by stray Ctrl-C). Restart it with: node pm2 restart dexbot-cred. If the problem persists, check the daemon log: profiles/logs/dexbot-cred.log`;
                    } else if (errMsg.includes('ECONNREFUSED')) {
                        hint = `Connection refused at ${token.socketPath}. The daemon may be in a zombie state or restarting. Try: node pm2 restart dexbot-cred.`;
                    } else if (errMsg.includes('timeout')) {
                        hint = `Probe timed out. The daemon may be under heavy load or blocked. Check profiles/logs/dexbot-cred.log.`;
                    } else {
                        hint = `Write operations will remain paused until re-unlocked with node pm2.`;
                    }

                    this.manager?.logger?.log?.(
                        `[CREDENTIAL] Credential daemon watchdog failed: ${err.message}. ${hint}`,
                        'error'
                    );
                }
                this._credentialDaemonDown = true;
                this._suspendGridPersistenceForCredentialOutage(`credential daemon watchdog failed: ${err.message}`);
            }
        };

        this._credentialDaemonWatchdogInterval = setInterval(() => {
            probe().catch(err => {
                this.manager?.logger?.log?.(`[CREDENTIAL] Credential daemon watchdog error: ${err.message}`, 'warn');
            });
        }, intervalMs);
        if (typeof this._credentialDaemonWatchdogInterval.unref === 'function') {
            this._credentialDaemonWatchdogInterval.unref();
        }
        void probe();
        this._log(`Credential daemon watchdog started (${Math.round(intervalMs / 1000)}s interval)`);
    }

    _stopCredentialDaemonWatchdogInterval() {
        if (this._credentialDaemonWatchdogInterval) {
            clearInterval(this._credentialDaemonWatchdogInterval);
            this._credentialDaemonWatchdogInterval = null;
        }
    }

    /**
     * Executes a batch of order operations on the blockchain using COW pattern.
     * Master grid is only updated after successful blockchain confirmation.
     * @param {Object} rebalanceResult - COW result containing workingGrid + actions.
     * @returns {Promise<Object>} The batch result.
     */
    async updateOrdersOnChainBatch(rebalanceResult) {
        if (!rebalanceResult || !rebalanceResult.workingGrid) {
            const reason = 'NON_COW_PAYLOAD';
            this.manager?.logger?.log?.(
                `[COW] Rejected non-COW batch payload. Use updateOrdersOnChainPlan() for plan inputs.`,
                'error'
            );
            return { executed: false, aborted: true, reason };
        }

        return await this._updateOrdersOnChainBatchCOW(rebalanceResult);
    }

    /**
     * Converts simple plan payloads (place/update/rotate/cancel) into a COW batch.
     * Used by spread/divergence maintenance and bootstrap helpers.
     * @param {Object|Array} plan - Plan object or array of ordersToPlace
     * @returns {Promise<Object>} Batch execution result
     */
    async updateOrdersOnChainPlan(plan) {
        const cowResult = this._buildCowResultFromPlan(plan);
        return await this._updateOrdersOnChainBatchCOW(cowResult);
    }

    _buildActionsFromPlan(plan) {
        const normalizedPlan = Array.isArray(plan)
            ? { ordersToPlace: plan }
            : (plan || {});

        const {
            ordersToPlace = [],
            ordersToRotate = [],
            ordersToUpdate = [],
            ordersToCancel = []
        } = normalizedPlan;

        const actions = [];

        for (const o of ordersToCancel) {
            if (o?.orderId) {
                actions.push({ type: COW_ACTIONS.CANCEL, id: o.id, orderId: o.orderId });
            }
        }

        for (const r of ordersToRotate) {
            const oldOrder = r?.oldOrder || r;
            const id = oldOrder?.id || r?.id;
            const orderId = oldOrder?.orderId || r?.orderId;
            const newGridId = r?.newGridId || id;
            const newSize = Number.isFinite(Number(r?.newSize))
                ? Number(r.newSize)
                : Number(r?.size || oldOrder?.size || 0);
            const newPrice = Number.isFinite(Number(r?.newPrice))
                ? Number(r.newPrice)
                : Number(r?.price || oldOrder?.price);
            const orderType = r?.type || oldOrder?.type;

            if (!id || !orderId || !newGridId || !orderType || !Number.isFinite(newPrice) || !(newSize > 0)) continue;

            actions.push({
                type: COW_ACTIONS.UPDATE,
                id,
                orderId,
                newGridId,
                newSize,
                newPrice,
                order: {
                    id: newGridId,
                    type: orderType,
                    price: newPrice,
                    size: newSize
                }
            });
        }

        for (const o of ordersToUpdate) {
            const partialOrder = o?.partialOrder || o;
            const id = o?.id || partialOrder?.id;
            const orderId = o?.orderId || partialOrder?.orderId;
            const orderType = o?.type || partialOrder?.type;
            const newSize = Number.isFinite(Number(o?.newSize))
                ? Number(o.newSize)
                : Number(partialOrder?.size || 0);

            if (!id || !orderId) continue;

            actions.push({
                type: COW_ACTIONS.UPDATE,
                id,
                orderId,
                newSize,
                order: {
                    ...(partialOrder || {}),
                    id,
                    orderId,
                    type: orderType,
                    size: newSize
                }
            });
        }

        // Run CREATE actions after UPDATE actions so same-batch downsizes can
        // release balance before placements consume it.
        for (const o of ordersToPlace) {
            if (!o?.id) continue;
            actions.push({ type: COW_ACTIONS.CREATE, id: o.id, order: o });
        }

        return actions;
    }

    _buildCowResultFromPlan(plan) {
        const { WorkingGrid } = require('./order/working_grid');
        const workingGrid = new WorkingGrid(this.manager.orders, {
            baseVersion: Number.isFinite(Number(this.manager._gridVersion)) ? this.manager._gridVersion : 0
        });
        const workingBoundary = this.manager.boundaryIdx;
        const actions = this._buildActionsFromPlan(plan);

        // Project planned actions into working grid so COW commit carries intended transitions.
        for (const action of actions) {
            if (action.type === COW_ACTIONS.CANCEL) {
                const current = workingGrid.get(action.id);
                if (!current) continue;
                workingGrid.set(action.id, convertToSpreadPlaceholder(current));
            } else if (action.type === COW_ACTIONS.CREATE) {
                if (!action.id || !action.order) continue;
                const current = workingGrid.get(action.id) || { id: action.id };
                workingGrid.set(action.id, {
                    ...current,
                    ...action.order,
                    id: action.id,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null
                });
            } else if (action.type === COW_ACTIONS.UPDATE) {
                if (action.newGridId && action.newGridId !== action.id) {
                    const current = workingGrid.get(action.id);
                    if (current) {
                        workingGrid.set(action.id, convertToSpreadPlaceholder(current));
                    }

                    const targetId = action.newGridId;
                    const targetCurrent = workingGrid.get(targetId) || { id: targetId };
                    const rotatedSize = Number.isFinite(Number(action.newSize))
                        ? Number(action.newSize)
                        : Number(targetCurrent.size || 0);
                    const rotatedPrice = Number.isFinite(Number(action.newPrice))
                        ? Number(action.newPrice)
                        : Number(action.order?.price ?? targetCurrent.price);

                    workingGrid.set(targetId, {
                        ...targetCurrent,
                        ...(action.order || {}),
                        id: targetId,
                        size: rotatedSize,
                        price: rotatedPrice,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: null
                    });
                    continue;
                }

                const current = workingGrid.get(action.id);
                if (!current) continue;
                const newSize = Number.isFinite(Number(action.newSize))
                    ? Number(action.newSize)
                    : Number(current.size || 0);
                workingGrid.set(action.id, {
                    ...current,
                    ...(action.order || {}),
                    id: action.id,
                    orderId: action.orderId || current.orderId,
                    size: newSize
                });
            }
        }

        return {
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary,
            actions
        };
    }

    _restoreSkippedUpdateSlotsInWorkingGrid(workingGrid, skippedSlotIds, skippedCount = 0) {
        if (!workingGrid || !skippedSlotIds || skippedSlotIds.size === 0) {
            return;
        }

        const masterVersion = Number.isFinite(Number(this.manager?._gridVersion))
            ? Number(this.manager._gridVersion)
            : undefined;

        for (const slotId of skippedSlotIds) {
            workingGrid.syncFromMaster(this.manager.orders, slotId, masterVersion);
        }

        this.manager.logger.log(
            `[COW] Restored ${skippedSlotIds.size} slot(s) after ${skippedCount} skipped update action(s).`,
            'debug'
        );
    }

    /**
     * COW broadcast: Execute blockchain operations and commit working grid on success.
     * Master grid is ONLY updated after successful blockchain confirmation.
     * @param {Object} cowResult - COW result with workingGrid, actions, etc.
     * @returns {Promise<Object>} The batch result.
     * @private
     */
    async _updateOrdersOnChainBatchCOW(cowResult) {
        const { workingGrid, workingIndexes, workingBoundary, actions } = cowResult;

        if (this.config.dryRun) {
            const cancelCount = actions.filter(a => a.type === COW_ACTIONS.CANCEL).length;
            const createCount = actions.filter(a => a.type === COW_ACTIONS.CREATE).length;
            const updateCount = actions.filter(a => a.type === COW_ACTIONS.UPDATE).length;
            if (cancelCount > 0) this.manager.logger.log(`Dry run: would cancel ${cancelCount} orders`, 'info');
            if (createCount > 0) this.manager.logger.log(`Dry run: would place ${createCount} new orders`, 'info');
            if (updateCount > 0) this.manager.logger.log(`Dry run: would update ${updateCount} orders`, 'info');
            return { executed: true, hadRotation: false };
        }

        const createSlotValidation = validateCreateTargetSlots(actions, this.manager?.orders);
        if (!createSlotValidation.isValid) {
            for (const violation of createSlotValidation.violations) {
                this.manager.logger.log(
                    `[COW] Rejecting CREATE for occupied slot ${violation.targetId}: ` +
                    `existing orderId=${violation.currentOrderId}, type=${violation.currentType}, state=${violation.currentState}`,
                    'error'
                );
            }

            return {
                executed: false,
                aborted: true,
                reason: 'CREATE_SLOT_OCCUPIED',
                violations: createSlotValidation.violations,
                hadRotation: false
            };
        }

        const { assetA, assetB } = this.manager.assets;
        const operations = [];
        const opContexts = [];
        const skippedUpdateSlotIds = new Set();
        let skippedUpdateCount = 0;

        // Collect IDs to lock from actions
        const idsToLock = new Set();
        for (const action of actions) {
            if (action.type === COW_ACTIONS.CANCEL && action.orderId) {
                idsToLock.add(action.orderId);
                if (action.id) idsToLock.add(action.id);
            } else if (action.type === COW_ACTIONS.CREATE && action.id) {
                idsToLock.add(action.id);
            } else if (action.type === COW_ACTIONS.UPDATE && action.orderId) {
                idsToLock.add(action.orderId);
                if (action.id) idsToLock.add(action.id);
            }
        }

        // Apply shadow locks
        this.manager.lockOrders(idsToLock);

        try {
            this._batchInFlight = true;
            this._markGridActivity('batch start');
            this.manager._setRebalanceState(REBALANCE_STATES.BROADCASTING);
            this.manager.startBroadcasting();

            // Build operations from actions
            for (const action of actions) {
                if (action.type === COW_ACTIONS.CANCEL) {
                    try {
                        const op = await chainOrders.buildCancelOrderOp(this.account, action.orderId);
                        operations.push(op);
                        const order = this.manager.orders.get(action.id) || { id: action.id, orderId: action.orderId };
                        opContexts.push({ kind: 'cancel', order });
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare cancel op for ${action.id}: ${err.message}`, 'error');
                    }
                } else if (action.type === COW_ACTIONS.CREATE) {
                    try {
                        const order = action.order;
                        const sizeValidation = this._validateOrderSizeForExecution(
                            order.size,
                            order.type,
                            order,
                            order.size
                        );
                        if (!sizeValidation.isValid) {
                            this.manager.logger.log(
                                `Skipping create op for ${action.id}: ${sizeValidation.reason}`,
                                'warn'
                            );
                            continue;
                        }
                        const args = buildCreateOrderArgs(order, assetA, assetB);
                        const buildResult = await chainOrders.buildCreateOrderOp(
                            this.account,
                            args.amountToSell,
                            args.sellAssetId,
                            args.minToReceive,
                            args.receiveAssetId,
                            null
                        );
                        if (!buildResult) {
                            this.manager.logger.log(
                                `Skipping create op for ${action.id}: amounts would round to 0 on blockchain`,
                                'warn'
                            );
                            continue;
                        }
                        operations.push(buildResult.op);
                        opContexts.push({ kind: 'create', id: order.id, order, args, finalInts: buildResult.finalInts });
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare create op for ${action.id}: ${err.message}`, 'error');
                    }
                } else if (action.type === COW_ACTIONS.UPDATE) {
                    try {
                        // Rotation update: move existing on-chain order to a new slot/price.
                        if (action.newGridId && action.newGridId !== action.id) {
                            const masterOrder = this.manager.orders.get(action.id);
                            const orderType = action.order?.type || masterOrder?.type;
                            const newPrice = Number.isFinite(Number(action.newPrice))
                                ? Number(action.newPrice)
                                : Number(action.order?.price);
                            const newSize = Number.isFinite(Number(action.newSize))
                                ? Number(action.newSize)
                                : Number(action.order?.size || 0);

                            if (!masterOrder || !action.orderId || !orderType || !Number.isFinite(newPrice) || newSize <= 0) {
                                continue;
                            }

                            const rotationSizeValidation = this._validateOrderSizeForExecution(
                                newSize,
                                orderType,
                                action.order,
                                newSize
                            );
                            if (!rotationSizeValidation.isValid) {
                                this.manager.logger.log(
                                    `Skipping rotation update ${action.id} -> ${action.newGridId}: ${rotationSizeValidation.reason}`,
                                    'warn'
                                );
                                continue;
                            }

                            const { amountToSell, minToReceive } = buildCreateOrderArgs(
                                { type: orderType, size: newSize, price: newPrice },
                                assetA,
                                assetB
                            );

                            const buildResult = await chainOrders.buildUpdateOrderOp(
                                this.account,
                                action.orderId,
                                { amountToSell, minToReceive, newPrice, orderType },
                                masterOrder.rawOnChain || null
                            );
                            if (!buildResult) {
                                skippedUpdateCount++;
                                if (action.id) skippedUpdateSlotIds.add(action.id);
                                if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                                this.manager.logger.log(
                                    `[COW] Skipping rotation update ${action.id} -> ${action.newGridId}: no blockchain delta`,
                                    'debug'
                                );
                                continue;
                            }

                            operations.push(buildResult.op);
                            opContexts.push({
                                kind: 'rotation',
                                rotation: {
                                    oldOrder: { ...masterOrder },
                                    newGridId: action.newGridId,
                                    newPrice,
                                    newSize,
                                    type: orderType
                                },
                                finalInts: buildResult.finalInts
                            });
                            continue;
                        }

                        const newSize = Number.isFinite(Number(action.newSize))
                            ? Number(action.newSize)
                            : Number(action.order?.size || 0);

                        const masterOrder = this.manager.orders.get(action.id);
                        const orderType = action.order?.type || masterOrder?.type;
                        const cachedRawOnChain = masterOrder?.rawOnChain || action.order?.rawOnChain || null;

                        const op = await chainOrders.buildUpdateOrderOp(
                            this.account,
                            action.orderId,
                            { amountToSell: newSize, orderType },
                            cachedRawOnChain
                        );
                        if (!op) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            this.manager.logger.log(
                                `[COW] Skipping size update ${action.id} (${action.orderId}): no blockchain delta`,
                                'debug'
                            );
                            continue;
                        }
                        operations.push(op.op);
                        const partialOrder = masterOrder || {
                            id: action.id,
                            orderId: action.orderId,
                            type: orderType
                        };
                        opContexts.push({ kind: 'size-update', updateInfo: { partialOrder, newSize }, finalInts: op.finalInts });
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare update op for ${action.id}: ${err.message}`, 'error');
                    }
                }
            }

            if (skippedUpdateCount > 0) {
                this._restoreSkippedUpdateSlotsInWorkingGrid(workingGrid, skippedUpdateSlotIds, skippedUpdateCount);
            }

            if (operations.length === 0) {
                this.manager._setRebalanceState(REBALANCE_STATES.NORMAL);
                return { executed: false, hadRotation: false };
            }

            // Validate funds before broadcasting
            const validation = this._validateOperationFunds(operations, assetA, assetB);
            this.manager.logger.log(validation.summary, validation.isValid ? 'info' : 'warn');

            if (!validation.isValid) {
                this.manager.logger.log(`Skipping batch broadcast: ${validation.violations.length} fund violation(s) detected`, 'warn');
                this.manager._setRebalanceState(REBALANCE_STATES.NORMAL);
                return { executed: false, hadRotation: false };
            }

            await this._ensureCredentialDaemonWritable('COW batch broadcast');

            // Execute batch
            this.manager.logger.log(`[COW] Broadcasting batch with ${operations.length} operations...`, 'info');
            const execution = await this._executeOperationsWithStrategy(operations, opContexts);
            const result = execution.result;
            const executedContexts = execution.opContexts;

            // Process results and commit on success
            this.manager.pauseFundRecalc();
            try {
                this.manager._throwOnIllegalState = true;
                
                if (result.success) {
                    // SUCCESS: Commit working grid to master (atomic swap)
                    this.manager.logger.log('[COW] Blockchain success - committing working grid to master', 'info');
                    // RC-FIX: skipRecalc prevents invariant violation before optimistic accounting
                    await this.manager._commitWorkingGrid(
                        workingGrid,
                        workingIndexes,
                        workingBoundary,
                        { skipRecalc: true }
                    );
                    
                    // Commitment accounting is handled in real-time by
                    // updateOptimisticFreeBalance when capital is committed to orders.
                    // The old post-batch deduction path was removed to avoid double-counting.

                    // Process batch results for logging/metrics
                    const batchResult = await this._processBatchResults(result, executedContexts);
                    
                    // Persist to disk
                    await this.manager.persistGrid();
                    
                    this._metrics.batchesExecuted++;
                    this.manager._clearWorkingGridRef();
                    
                    return { executed: true, hadRotation: true, ...batchResult };
                } else {
                    // FAILURE: Working grid discarded, master unchanged
                    this.manager.logger.log('[COW] Blockchain failed - working grid discarded, master unchanged', 'warn');
                    this.manager._clearWorkingGridRef();
                    return { executed: false, hadRotation: false, ...result };
                }
            } finally {
                this.manager._throwOnIllegalState = false;
                // Keep broadcasting true during resumeFundRecalc to skip invariant checks
                // that would fail due to stale accountTotals (not yet refreshed from blockchain)
                await this.manager.resumeFundRecalc();
                this.manager.stopBroadcasting();
                const createCount = actions.filter(a => a.type === COW_ACTIONS.CREATE).length;
                const cancelCount = actions.filter(a => a.type === COW_ACTIONS.CANCEL).length;
                this.manager.logger.logFundsStatus(this.manager, `AFTER COW batch (created=${createCount}, cancelled=${cancelCount})`);
            }

        } catch (err) {
            this.manager.logger.log(`[COW] Batch transaction failed: ${err.message}`, 'error');
            if (err?.partialOnChainState) {
                this.manager.logger.log(
                    `[COW] Non-atomic grouped execution detected (${err.groupsBroadcast}/${err.groupsTotal} groups broadcast). Local rollback cannot undo confirmed on-chain operations; next sync/reconcile will converge state.`,
                    'warn'
                );
            }
            this.manager.stopBroadcasting();
            this.manager._clearWorkingGridRef();

            // Handle hard abort
            const hardAbortResult = await this._handleBatchHardAbort(err, 'COW batch processing', operations.length);
            if (hardAbortResult) return hardAbortResult;

            // Check for stale orders — filled in the ~1.5s broadcast window after our plan was built.
            const staleOrderIds = new Set();
            const patterns = [
                /Limit order (1\.7\.\d+) does not exist/g,
                /Unable to find Object (1\.7\.\d+)/g,
                /object (1\.7\.\d+) (?:does not exist|not found)/gi
            ];
            for (const pattern of patterns) {
                let m;
                while ((m = pattern.exec(err.message)) !== null) {
                    staleOrderIds.add(m[1]);
                }
            }

            // "Cannot deduct all or more from order than order contains" means the order still
            // exists, but its on-chain size shrank during the broadcast window. That is not an
            // explicit stale/missing-order signal, so reconcile from chain instead of virtualizing.
            if (/Cannot deduct all or more from order than order contains/.test(err.message)) {
                return await this._recoverBatchSizeDrift(err, opContexts);
            }

            if (staleOrderIds.size > 0) {
                // Recover explicit missing-order failures without aborting the entire fill cycle.
                // Use the manager update path so indexes, working-grid sync, accounting, and
                // persistence stay coherent.
                return await this._recoverExplicitStaleOrders(staleOrderIds, 'cow-stale-order-cleanup');
            }

            throw err;
        } finally {
            this._batchInFlight = false;
            this._markGridActivity('batch end');
            this.manager.unlockOrders(idsToLock);
        }
    }

    /**
     * Process results from batch transaction execution.
     * Updates order state, synchronizes with chain, and deducts BTS fees.
     * @param {Object} result - Transaction result from executeBatch
     * @param {Array} opContexts - Operation context array with operation metadata (must be 1:1 with result.operation_results)
     * @returns {Object} Result with { executed: boolean, hadRotation: boolean }
     * @private
     */
    async _processBatchResults(result, opContexts) {
        const results = this._extractOperationResults(result, '_processBatchResults');
        const { getAssetFees } = require('./order/utils/math');
        // IMPORTANT: Call without amount to get fee schedule fields
        // ({ createFee, updateFee, ... }), not proceeds projection fields.
        const btsFeeData = getAssetFees('BTS');
        let hadRotation = false;
        let updateOperationCount = 0;

        const updatesToApply = [];

        for (let i = 0; i < opContexts.length; i++) {
            const ctx = opContexts[i];
            const res = results[i];

            if (ctx.kind === 'cancel') {
                this.manager.logger.log(`Cancelled surplus order ${ctx.order.id} (${ctx.order.orderId})`, 'info');
                const oldOrder = ctx.order;
                const committedOrder = oldOrder?.id ? this.manager.orders.get(oldOrder.id) : null;

                // The COW commit already updated manager.orders. Apply ONLY the optimistic
                // accounting transition using pre-commit -> committed order states.
                if (oldOrder && committedOrder && this.manager.accountant) {
                    await this.manager.accountant.updateOptimisticFreeBalance(
                        oldOrder,
                        committedOrder,
                        'fill-cancel',
                        btsFeeData?.cancelFee || 0,
                        false
                    );
                }
            }
            else if (ctx.kind === 'size-update') {
                const oldOrder = ctx.updateInfo.partialOrder;
                const ord = this.manager.orders.get(oldOrder.id);

                // Apply optimistic accounting from pre-commit -> committed state,
                // including blockchain update fee deduction.
                if (oldOrder && ord && this.manager.accountant) {
                    await this.manager.accountant.updateOptimisticFreeBalance(
                        oldOrder,
                        ord,
                        'order-update',
                        btsFeeData.updateFee,
                        false
                    );
                }

                if (ord) {
                    const updatedSlot = { ...ord, size: ctx.updateInfo.newSize };
                    // Update rawOnChain cache with new integers
                    if (ctx.finalInts) {
                        updatedSlot.rawOnChain = {
                            id: ord.orderId,
                            for_sale: String(ctx.finalInts.sell),
                            sell_price: {
                                base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                            }
                        };
                    }
                    updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
                }
                this.manager.logger.log(`Size update complete: ${ctx.updateInfo.partialOrder.orderId}`, 'info');
                updateOperationCount++;
            }
            else if (ctx.kind === 'create') {
                const chainOrderId = res && res[1];
                if (chainOrderId) {
                    // synchronizeWithChain handles the full VIRTUAL -> ACTIVE transition
                    // including orderId assignment and fee deduction.
                    await this.manager.synchronizeWithChain({
                        gridOrderId: ctx.order.id, chainOrderId, expectedType: ctx.order.type, fee: btsFeeData.createFee
                    }, 'createOrder');

                    // After sync, apply rawOnChain metadata if available
                    if (ctx.finalInts) {
                        const syncedOrder = this.manager.orders.get(ctx.order.id);
                        if (syncedOrder) {
                            updatesToApply.push({
                                order: {
                                    ...syncedOrder,
                                    rawOnChain: {
                                        id: chainOrderId,
                                        for_sale: String(ctx.finalInts.sell),
                                        sell_price: {
                                            base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                            quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                                        }
                                    }
                                },
                                context: 'post-placement-metadata'
                            });
                        }
                    }
                    this.manager.logger.log(`Placed ${ctx.order.type} order ${ctx.order.id} -> ${chainOrderId}`, 'info');
                }
            }
            else if (ctx.kind === 'rotation') {
                hadRotation = true;
                const { rotation } = ctx;
                const { oldOrder, newPrice, newGridId, newSize, type } = rotation;

                if (!newGridId) {
                    // Size correction only
                    const ord = this.manager.orders.get(oldOrder.id || rotation.id);

                    // Apply optimistic accounting from pre-commit -> committed state,
                    // including blockchain update fee deduction.
                    if (oldOrder && ord && this.manager.accountant) {
                        await this.manager.accountant.updateOptimisticFreeBalance(
                            oldOrder,
                            ord,
                            'order-update',
                            btsFeeData.updateFee,
                            false
                        );
                    }

                    if (ord) {
                        const updatedSlot = { ...ord, size: newSize };
                        // Update rawOnChain cache with new integers
                        if (ctx.finalInts) {
                            updatedSlot.rawOnChain = {
                                id: ord.orderId,
                                for_sale: String(ctx.finalInts.sell),
                                sell_price: {
                                    base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                    quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                                }
                            };
                        }
                        updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
                    }
                    updateOperationCount++;
                    continue;
                }

                // Full rotation: old slot was virtualized in the committed working grid.
                // Activate the destination slot with the existing on-chain orderId.
                const slot = this.manager.orders.get(newGridId);
                if (!slot) {
                    this.manager.logger.log(
                        `[ROTATION] Destination slot ${newGridId} missing from master grid after COW commit - skipping activation, sync will reconcile`,
                        'error'
                    );
                    // Still clear source orderId to prevent a stale chain reference persisting
                    if (oldOrder?.id && oldOrder.id !== newGridId) {
                        const staleSource = this.manager.orders.get(oldOrder.id);
                        if (staleSource?.orderId) {
                            updatesToApply.push({
                                order: { ...staleSource, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null },
                                context: 'post-rotation-source-clear'
                            });
                        }
                    }
                    continue;
                }
                const updatedSlot = {
                    ...slot,
                    id: newGridId,
                    type,
                    size: newSize,
                    price: newPrice,
                    state: ORDER_STATES.ACTIVE,
                    orderId: oldOrder?.orderId || slot.orderId || null
                };

                if (ctx.finalInts) {
                    updatedSlot.rawOnChain = {
                        id: updatedSlot.orderId,
                        for_sale: String(ctx.finalInts.sell),
                        sell_price: {
                            base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                            quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                        }
                    };
                }

                if (oldOrder && updatedSlot && this.manager.accountant) {
                    await this.manager.accountant.updateOptimisticFreeBalance(
                        oldOrder,
                        updatedSlot,
                        'order-update',
                        btsFeeData.updateFee,
                        false
                    );
                }

                // Ensure rotation source slot is cleared in master state.
                // COW projection may keep source slots ACTIVE when target keeps a non-zero
                // virtual size, but after a successful on-chain rotation the source orderId
                // must no longer remain attached to the old slot.
                if (oldOrder?.id && oldOrder.id !== newGridId) {
                    const currentSource = this.manager.orders.get(oldOrder.id);
                    if (currentSource && currentSource.orderId) {
                        updatesToApply.push({
                            order: {
                                ...currentSource,
                                state: ORDER_STATES.VIRTUAL,
                                orderId: null,
                                rawOnChain: null
                            },
                            context: 'post-rotation-source-clear'
                        });
                    }
                }

                updatesToApply.push({ order: updatedSlot, context: 'post-rotation-metadata' });
            }
        }

        // Apply all collected updates in a single batch
        if (updatesToApply.length > 0) {
            await this.manager.applyGridUpdateBatch(
                updatesToApply.map(u => u.order), 
                'batch-results-process',
                { skipAccounting: true }
            );
        }

        return {
            executed: true,
            hadRotation,
            updateOperationCount
        };
    }

    /**
     * Perform grid recalculation triggered by trigger file.
     * Reloads config from disk, recalculates grid, resets funds, and removes trigger file.
     * Must be called with _fillProcessingLock already held.
     * @returns {Promise<boolean>} True if resync succeeded
     * @private
     */
    async _performGridResync(options = {}) {
        return DexbotMaintenanceRuntime.performGridResync.call(this, options);
    }

    /**
     * Handle any pending trigger file reset at startup.
     * This is called FIRST during startup before any grid operations.
     * @returns {Promise<boolean>} True if trigger reset completed successfully, false otherwise
     * @private
     */
    async _handlePendingTriggerReset() {
        return DexbotMaintenanceRuntime.handlePendingTriggerReset.call(this);
    }

    /**
     * Setup trigger file detection for grid reset.
     * Monitors the trigger file and performs grid resync when it's created.
     * @private
     */
    async _setupTriggerFileDetection() {
        return DexbotMaintenanceRuntime.setupTriggerFileDetection.call(this);
    }

    /**
     * Starts the bot's operation.
     * @param {string|Object|Buffer} [vaultSecret=null] - The unlock secret.
     * @returns {Promise<void>}
     */
    async start(vaultSecret = null) {
        await this.initialize(vaultSecret);
        await this._runStartupSequence();
    }

    /**
     * Start bot with a pre-decrypted private key.
     * Alternative to start(vaultSecret) when the signing secret is already available.
     * @param {string|Object} privateKey - Pre-decrypted private key or daemon signing token
     * @returns {Promise<void>}
     */
    async startWithPrivateKey(privateKey) {
        // Initialize account data with provided private key
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

        if (this.config && this.config.preferredAccount) {
            try {
                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                throw err;
            }
        } else {
            throw new Error('No preferredAccount configured');
        }

        await this._runStartupSequence();
    }

    /**
     * Common startup sequence logic shared between start() and startWithPrivateKey().
     * @private
     */
    async _runStartupSequence() {
        try {
            const startupState = await this._initializeStartupState();
            await this._finishStartupSequence(startupState);
        } catch (err) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    /**
     * Perform periodic grid checks: fund thresholds, spread condition, grid health.
     * Called by the periodic blockchain fetch interval to check if grid needs updates.
     *
     * IMPORTANT: This method MUST only be called from within _fillProcessingLock.acquire()
     * (specifically from _setupBlockchainFetchInterval). It passes fillLockAlreadyHeld
     * to avoid deadlock with _consumeFillQueue which uses the same lock ordering.
     *
     * @private
     */
    async _performPeriodicGridChecks() {
        return DexbotMaintenanceRuntime.performPeriodicGridChecks.call(this);
    }

    _isOpenOrdersSyncLoopEnabled() {
        return DexbotMaintenanceRuntime.isOpenOrdersSyncLoopEnabled.call(this);
    }

    /**
     * Start the open-orders watchdog sync loop.
     * Uses fill lock contention checks to avoid competing with fill processing.
     * @private
     */
    _startOpenOrdersSyncLoop() {
        return DexbotMaintenanceRuntime.startOpenOrdersSyncLoop.call(this);
    }

    /**
     * Stop the open-orders watchdog sync loop.
     * @private
     */
    async _stopOpenOrdersSyncLoop() {
        return DexbotMaintenanceRuntime.stopOpenOrdersSyncLoop.call(this);
    }

    /**
     * Set up periodic blockchain account balance fetch interval.
     * Fetches available funds at regular intervals to keep blockchain variables up-to-date.
     * @private
     */
    _setupBlockchainFetchInterval() {
        return DexbotMaintenanceRuntime.setupBlockchainFetchInterval.call(this);
    }

    /**
     * Stop the periodic blockchain fetch interval.
     * @private
     */
    _stopBlockchainFetchInterval() {
        return DexbotMaintenanceRuntime.stopBlockchainFetchInterval.call(this);
    }

    async _releaseMarketAdapterRuntime(context = 'shutdown') {
        return DexbotMaintenanceRuntime.releaseMarketAdapterRuntime.call(this, this.config?.botKey || this.config?.name, context);
    }

    _getCreditRuntime() {
        const lending = this.config?.debtPolicy?.lending;
        const enabledPolicy = Array.isArray(lending)
            && lending.length > 0
            && lending.every((item) => typeof item?.collateralAsset === 'string' && item.collateralAsset.length > 0);
        if (!enabledPolicy) {
            this._creditRuntime = null;
            return null;
        }
        if (!this._creditRuntime) {
            this._creditRuntime = new CreditRuntime(this, {
                stateDir: path.join(PROFILES_DIR, 'credit_runtime'),
            });
        }
        return this._creditRuntime;
    }

    async _setupCreditRuntime() {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return null;
        }
        await runtime.loadState();
        return runtime;
    }

    async _refreshAndSyncCreditRuntime() {
        const runtime = this._getCreditRuntime();
        if (!runtime) return;
        try {
            await runtime.refreshState();
        } catch (err) {
            this._warn(`Credit runtime refresh/sync failed: ${err.message}`);
        }
    }

    async _runCreditRuntimeMaintenance(context = 'periodic', options = {}) {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return null;
        }
        return runtime.runMaintenance(context, options);
    }

    _setupCreditWatchdogInterval() {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return;
        }
        const intervalMin = Number(this.config?.TIMING?.CREDIT_DEAL_CHECK_INTERVAL_MIN ?? TIMING.CREDIT_DEAL_CHECK_INTERVAL_MIN);
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            this._log('Credit deal watchdog disabled by configuration (TIMING.CREDIT_DEAL_CHECK_INTERVAL_MIN <= 0)');
            return;
        }
        if (this._creditWatchdogInterval) {
            clearInterval(this._creditWatchdogInterval);
            this._creditWatchdogInterval = null;
        }
        const intervalMs = intervalMin * 60 * 1000;
        this._creditWatchdogInterval = setInterval(async () => {
            try {
                await runtime.runCreditWatchdog();
            } catch (err) {
                this._warn(`Credit watchdog error: ${err.message}`);
            }
        }, intervalMs);
        this._log(`Credit deal watchdog started (${intervalMin}min interval)`);
    }

    _stopCreditWatchdogInterval() {
        if (this._creditWatchdogInterval) {
            clearInterval(this._creditWatchdogInterval);
            this._creditWatchdogInterval = null;
        }
    }

    async requestGridReset(reason = 'structural change', options = {}) {
        if (!this.manager || typeof this._performGridResync !== 'function') {
            return { skipped: true, reason: 'grid resync unavailable' };
        }

        const message = reason ? `[CR-RESET] ${reason}` : '[CR-RESET] grid reset requested';
        // Manual/programmatic resets should advance the persisted center baseline
        // before rebuilding the grid, unless a caller explicitly disables it.
        this._log(`${message}; rebuilding grid from fresh on-chain state`, 'info');
        const resetOptions = {
            ...options,
            refreshCenterPrice: options.refreshCenterPrice !== false,
        };

        if (options.fillLockAlreadyHeld || !this.manager._fillProcessingLock) {
            return this._performGridResync(resetOptions);
        }

        return this.manager._fillProcessingLock.acquire(async () => this._performGridResync(resetOptions));
    }

    /**
     * Get current metrics for monitoring and debugging.
     * @returns {Object} Metrics snapshot
     */
    getMetrics() {
        return {
            ...this._metrics,
            queueDepth: this._incomingFillQueue.length,
            fillProcessingLockActive: this.manager?._fillProcessingLock?.isLocked() || false,
            divergenceLockActive: this.manager?._divergenceLock?.isLocked() || false,
            shadowLocksActive: this.manager?.shadowOrderIds?.size || 0,
            recentFillsTracked: this._recentlyProcessedFills.size
        };
    }

    /**
     * Execute grid maintenance checks in strict order with pipeline consensus.
     *
     * CRITICAL DESIGN: All structural grid modifications are deferred until the pipeline
     * is empty to prevent "race-to-resize" conditions where the bot attempts to reallocate
     * temporary fund surpluses from filled orders before their counter-orders/rotations
     * are placed.
     *
     * MAINTENANCE SEQUENCE:
     * 1. Fund Recalculation (ALWAYS) - Updates internal fund metrics
     * 2. Pipeline Check (GATE) - Verifies no pending operations
     * 3. Health Check (IF IDLE) - Detects and cleans dust orders
     * 4. Divergence Detection (IF IDLE) - Identifies structural mismatches
     * 5. Grid Resizing (IF IDLE) - Applies size corrections on-chain
     * 6. Spread Correction (IF IDLE) - Corrects spread after structural work completes
     *
     * WHY PIPELINE CONSENSUS MATTERS:
     * - After a fill, funds temporarily show a "surplus" from the filled order
     * - If grid maintenance runs immediately, it sees the surplus and triggers a resize
     * - The resize attempts to allocate funds that will be consumed by pending counter-orders
     * - This causes cascading trades, fund accounting errors, and grid instability
     * - Solution: Wait for pipeline to empty (all rotations placed) before resizing
     *
     * TIMEOUT SAFETY:
     * - clearStalePipelineOperations() clears stuck operations after 5-minute timeout
     * - Called before pipeline check to prevent indefinite blocking
     * - See manager.clearStalePipelineOperations() for details
     *
     * @param {string} context - Maintenance context for logging ('startup', 'periodic', 'post-fill')
     * @private
     */
    async _executeMaintenanceLogic(context) {
        return DexbotMaintenanceRuntime.executeMaintenanceLogic.call(this, context);
    }

    /**
     * Cancel dust partial orders that have exceeded DUST_CANCEL_DELAY_SEC, treating each
     * as a fully-filled slot so the grid can place a fresh counter-order there.
     *
     * Behaviour by GRID_LIMITS.DUST_CANCEL_DELAY_SEC:
     *   -1  Disabled — returns immediately without action.
     *    0  Cancel on first detection (no delay).
     *    N  Cancel after N continuous seconds in dust state.
     *
     * The timer is tracked per orderId in this._dustSinceMap.  Orders that recover
     * from dust (size grows back above threshold) have their timer reset automatically.
     *
     * After a successful cancel the order slot is virtualised (size=0, state=VIRTUAL)
     * and a synthetic delayed-rotation event is sent through the normal fill pipeline.
     *
     * @param {{ buy: Array, sell: Array }} dustOrders - Dust order lists from checkGridHealth.
     * @returns {Promise<{cancelledCount: number, batchResult: Object|null}>}
     * @private
     */
    async _cancelDustOrders({ buy: buyDust = [], sell: sellDust = [] } = {}) {
        return DexbotMaintenanceRuntime.cancelDustOrders.call(this, { buy: buyDust, sell: sellDust });
    }

    _clearDustMaintenanceTimer() {
        return DexbotMaintenanceRuntime.clearDustMaintenanceTimer.call(this);
    }

    _scheduleDustMaintenanceCheck() {
        return DexbotMaintenanceRuntime.scheduleDustMaintenanceCheck.call(this);
    }

    /**
     * Seed dust timers immediately when a fill/update first leaves an order in dust state,
     * instead of waiting for the next maintenance cycle to discover it.
     * @param {Array<Object>} updatedOrders
     * @param {number} [detectedAt=Date.now()]
     * @returns {Promise<void>}
     * @private
     */
    async _seedDustTimersFromPartialUpdates(updatedOrders = [], detectedAt = Date.now()) {
        return DexbotMaintenanceRuntime.seedDustTimersFromPartialUpdates.call(this, updatedOrders, detectedAt);
    }

    /**
     * Perform grid maintenance: fund thresholds, spread condition, grid health, divergence.
     * Consolidates maintenance checks used during startup, periodic updates, and post-fill.
     *
     * ENTRY POINTS:
     * 1. Startup (line ~681): After grid initialization, ensures grid is healthy
     * 2. Periodic (line ~2682): Every BLOCKCHAIN_FETCH_INTERVAL_MIN (default 240 min)
     * 3. Post-Fill (line ~1059): After order fills are rotated
     *
     * PIPELINE PROTECTION:
     * All maintenance operations inside _executeMaintenanceLogic respect isPipelineEmpty().
     * This prevents grid modifications while fills/rotations/corrections are pending.
     * See _executeMaintenanceLogic documentation for detailed rationale.
     *
     * LOCK ORDERING:
     * - Canonical order: _fillProcessingLock → _divergenceLock
     * - This function handles lock acquisition based on fillLockAlreadyHeld parameter
     * - When called from post-fill context, fill lock is already held
     * - When called from periodic context, both locks must be acquired
     * - Matches the order used in _consumeFillQueue to prevent deadlocks
     *
     * @param {string} context - Maintenance context for logging (e.g. 'startup', 'periodic', 'post-fill')
     * @param {Object} options - Maintenance options
     * @private
     */
    async _runGridMaintenance(context = 'periodic', options = {}) {
        return DexbotMaintenanceRuntime.runGridMaintenance.call(this, context, options);
    }

    /**
     * Gracefully shutdown the bot.
     * Waits for current fill processing to complete, persists state, and stops intervals.
     * @returns {Promise<void>}
     */
    async shutdown() {
        this._log('Initiating graceful shutdown...');
        this._shuttingDown = true;
        this._processedFillStore.setShuttingDown(true);

        // Stop accepting new work
        this._stopBlockchainFetchInterval();

        if (this._triggerDebounceTimer) {
            clearTimeout(this._triggerDebounceTimer);
            this._triggerDebounceTimer = null;
        }

        if (this._deferredGridResyncTimer) {
            clearTimeout(this._deferredGridResyncTimer);
            this._deferredGridResyncTimer = null;
        }

        if (this._maintenanceIdleTimer) {
            clearTimeout(this._maintenanceIdleTimer);
            this._maintenanceIdleTimer = null;
        }

        this._clearDustMaintenanceTimer();
        this._stopCreditWatchdogInterval();
        this._stopCredentialDaemonWatchdogInterval();

        if (this._creditRuntime) {
            try {
                await this._creditRuntime.shutdown();
            } catch (err) {
                this._warn(`Failed to persist credit runtime state: ${err.message}`);
            }
        }

        if (this._triggerWatcher && typeof this._triggerWatcher.close === 'function') {
            try {
                this._triggerWatcher.close();
            } catch (err) {
                this._warn(`Failed to close trigger watcher: ${err.message}`);
            } finally {
                this._triggerWatcher = null;
            }
        }

        if (typeof this._fillsUnsubscribe === 'function') {
            try {
                await this._fillsUnsubscribe();
            } catch (err) {
                this._warn(`Failed to unsubscribe fill listener: ${err.message}`);
            } finally {
                this._fillsUnsubscribe = null;
            }
        }

        try {
            await this._stopOpenOrdersSyncLoop();
        } catch (err) {
            this._warn(`Error while stopping open-orders sync loop: ${err.message}`);
        }

        try {
            await this._releaseMarketAdapterRuntime('shutdown');
        } catch (err) {
            this._warn(`Error while releasing market adapter runtime: ${err.message}`);
        }

        // Wait for current fill processing to complete
        try {
            if (!this.manager?._fillProcessingLock) {
                this._warn('Shutdown lock skipped: manager or fillProcessingLock unavailable');
            } else {
                await this.manager._fillProcessingLock.acquire(async () => {
                    this._log('Fill processing lock acquired for shutdown');

                    // Log any remaining queued fills
                    if (this._incomingFillQueue.length > 0) {
                        this._warn(`${this._incomingFillQueue.length} fills queued but not processed at shutdown`);
                    }

                    await this._flushProcessedFillPersistence('shutdown');

                    // Persist final state
                    if (this.manager && this.accountOrders && this.config?.botKey) {
                        try {
                            await this.manager.persistGrid();
                            this._log('Final grid snapshot persisted');
                        } catch (err) {
                            this._warn(`Failed to persist final state: ${err.message}`);
                        }
                    }
                });
            }
        } catch (err) {
            this._warn(`Error during shutdown lock acquisition: ${err.message}`);
        }

        // Log final metrics
        const metrics = this.getMetrics();
        this._log(`Shutdown complete. Final metrics: fills=${metrics.fillsProcessed}, batches=${metrics.batchesExecuted}, ` +
            `avgProcessingTime=${metrics.fillsProcessed > 0 ? Format.formatMetric2(metrics.fillProcessingTimeMs / metrics.fillsProcessed) : 0}ms, ` +
            `lockContentions=${metrics.lockContentionEvents}, maxQueueDepth=${metrics.maxQueueDepth}`);
    }
}

module.exports = DEXBot;
module.exports.normalizeBotEntry = require('./bot_settings').normalizeBotEntry;
