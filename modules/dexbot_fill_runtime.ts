const { buildFillKey } = require('./order/utils/order');
const { PROCESSED_FILL_PERSISTENCE_MODES } = require('./order/processed_fill_store');
const { NATIVE_CLIENT } = require('./constants');

/**
 * Wire processed fill tracking into the manager and processed fill store.
 * Establishes the bidirectional link between the runtime's processed fill store
 * and the OrderManager's processed fill tracker.
 * @this {import('./dexbot_class').DEXBot}
 */
function wireProcessedFillTracking() {
    if (!this.manager) return;

    this._processedFillStore.configure({
        accountOrders: this.accountOrders,
        botKey: this.config?.botKey
    });

    this._processedFillStore.mergeTracker(this.manager.processedFillTracker);

    this.manager.processedFillTracker = this._recentlyProcessedFills;
    this.manager.processedFillStore = this._processedFillStore;
}

/**
 * Flush all pending processed fill writes to persistent storage.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string} [reason='manual'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flush
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistence(reason = 'manual', options = {}) {
    this._processedFillStore.setShuttingDown(this._shuttingDown);
    await this._processedFillStore.flush(reason, options);
}

/**
 * Flush pending processed fill writes for specific fill keys.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string[]|Set<string>} fillKeys - Fill keys to flush
 * @param {string} [reason='manual-selected'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flushKeys
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistenceForKeys(fillKeys, reason = 'manual-selected', options = {}) {
    this._processedFillStore.setShuttingDown(this._shuttingDown);
    await this._processedFillStore.flushKeys(fillKeys, reason, options);
}

/**
 * Discard pending processed fill writes for specific fill keys from the queue.
 * @this {import('./dexbot_class').DEXBot}
 * @param {string[]|Set<string>} fillKeys - Fill keys to discard
 */
function discardPendingProcessedFillPersistence(fillKeys) {
    this._processedFillStore.discardKeys(fillKeys);
}

/**
 * Build a degraded orphan fill replay key when the standard fill history id is missing.
 * The fallback key is derived from order_id, block_num, pays/receives amounts and asset IDs.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @returns {string|null} Orphan fallback key or null if insufficient data
 */
function buildOrphanFillFallbackKey(fill) {
    const fillOp = fill?.op?.[1];
    const orderId = fillOp?.order_id;
    const blockNum = fill?.block_num;
    const paysAssetId = fillOp?.pays?.asset_id;
    const paysAmount = fillOp?.pays?.amount;
    const receivesAssetId = fillOp?.receives?.asset_id;
    const receivesAmount = fillOp?.receives?.amount;
    const makerRole = fillOp?.is_maker === false ? 'taker' : 'maker';
    // Include operation-type ID, transaction-in-block index, and
    // operation-in-transaction index to reduce collision risk when
    // multiple fills match on order + amounts + block number.
    const opType = fill?.op?.[0];
    const trxInBlock = fill?.trx_in_block;
    const opInTrx = fill?.op_in_trx;
    if (!orderId || blockNum == null || !paysAssetId || paysAmount == null || !receivesAssetId || receivesAmount == null) {
        return null;
    }
    return `orphan:${orderId}:${blockNum}:${paysAssetId}:${paysAmount}:${receivesAssetId}:${receivesAmount}:${makerRole}:${opType ?? ''}:${trxInBlock ?? ''}:${opInTrx ?? ''}`;
}

/**
 * Apply fill accounting with replay-safe deduplication.
 * Prevents the same fill from being accounted twice across restarts or re-syncs.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {Function} [options.missingKeyMessage] - Callback to generate log message when fill key is missing
 * @param {Function} [options.fallbackKeyMessage] - Callback to generate log message when fallback key is used
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {Function} [options.errorMessage] - Callback to generate log message on error
 * @param {Object} [options.logger] - Logger instance
 * @param {string} [options.missingKeyLevel='warn'] - Log level for missing key messages
 * @param {string} [options.fallbackKeyLevel='warn'] - Log level for fallback key messages
 * @param {string} [options.replayLevel='debug'] - Log level for replay messages
 * @param {string} [options.persistenceMode='immediate'] - Processed fill persistence mode
 * @param {boolean} [options.allowOrphanFallbackKey=false] - Allow degraded orphan fallback key
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeFillAccounting(fill, fillOp, {
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
    let fillKey = buildFillKey(fill);
    let usedFallbackKey = false;

    if (!fillKey && allowOrphanFallbackKey) {
        fillKey = buildOrphanFillFallbackKey.call(this, fill);
        usedFallbackKey = Boolean(fillKey);
        if (usedFallbackKey && fallbackKeyMessage) {
            logger?.log?.(fallbackKeyMessage(fillOp, fill, fillKey), fallbackKeyLevel);
        }
    }

    if (!fillKey) {
        if (missingKeyMessage) {
            logger?.log?.(missingKeyMessage(fillOp, fill), missingKeyLevel);
        }
        return { status: 'missing_key', fillKey: null };
    }

    try {
        const applied = await this.manager.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
        if (!applied) {
            if (replayMessage) {
                logger?.log?.(replayMessage(fillOp, fill, fillKey), replayLevel);
            }
            return { status: 'duplicate', fillKey };
        }

        return { status: 'applied', fillKey, usedFallbackKey };
    } catch (err: any) {
        if (errorMessage) {
            logger?.log?.(errorMessage(fillOp, fill, err), 'error');
            return { status: 'error', fillKey, error: err };
        }
        throw err;
    }
}

/**
 * Apply replay-safe fill accounting for tracked fills (with fill history id).
 * Wraps applyReplaySafeFillAccounting with context and default message builders.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='batched'] - Processed fill persistence mode
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeTrackedFillAccounting(fill, fillOp, {
    context,
    logger = this.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
} = {}) {
    return applyReplaySafeFillAccounting.call(this, fill, fillOp, {
        logger,
        missingKeyMessage: (op) => `[${context}] Missing fill history id for ${op.order_id}; deferring to open-orders sync`,
        replayMessage,
        errorMessage: (op, _fill, err) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
        persistenceMode
    });
}

/**
 * Apply replay-safe fill accounting for orphan fills (missing fill history id).
 * Uses a degraded orphan fallback key when the standard key is unavailable.
 * @this {import('./dexbot_class').DEXBot}
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='immediate'] - Processed fill persistence mode
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeOrphanFillAccounting(fill, fillOp, {
    context,
    logger = this.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE
} = {}) {
    return applyReplaySafeFillAccounting.call(this, fill, fillOp, {
        logger,
        missingKeyMessage: (op) => `[${context}] Missing fill history id and orphan fallback key for ${op.order_id}; deferring to open-orders sync`,
        fallbackKeyMessage: (op) => `[${context}] Missing fill history id for orphan fill ${op.order_id}; using degraded orphan replay key for proceeds-only accounting`,
        replayMessage,
        errorMessage: (op, _fill, err) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
        persistenceMode,
        allowOrphanFallbackKey: true
    });
}

/**
 * Create a fill callback handler for blockchain subscription events.
 * Queues incoming fills and triggers fill queue consumption.
 * @this {import('./dexbot_class').DEXBot}
 * @param {Object} chainOrders - Chain orders module
 * @returns {Function} Async callback function accepting an array of fill events
 */
function createFillCallback(chainOrders) {
    return async (fills) => {
        if (this._shuttingDown) {
            return;
        }

        if (this.manager && !this.config.dryRun && Array.isArray(fills) && fills.length > 0) {
            const maxQueueDepth = Number(NATIVE_CLIENT?.SUBSCRIPTIONS?.MAX_INCOMING_FILL_QUEUE || 1000);
            if (this._incomingFillQueue.length + fills.length > maxQueueDepth) {
                const message = `Incoming fill queue back-pressure: ${this._incomingFillQueue.length} queued + ${fills.length} incoming exceeds limit ${maxQueueDepth}`;
                this._warn(message);
                throw new Error(message);
            }
            this._markGridActivity?.('fill queued');
            this._incomingFillQueue.push(...fills);
            this._consumeFillQueue(chainOrders).catch(err => {
                this._warn(`Fill queue consume failed: ${err.message}`);
            });
        }
    };
}

export = {
    wireProcessedFillTracking,
    flushProcessedFillPersistence,
    flushProcessedFillPersistenceForKeys,
    discardPendingProcessedFillPersistence,
    buildOrphanFillFallbackKey,
    applyReplaySafeFillAccounting,
    applyReplaySafeTrackedFillAccounting,
    applyReplaySafeOrphanFillAccounting,
    createFillCallback
};
