const { buildFillKey } = require('./order/utils/order');
const { PROCESSED_FILL_PERSISTENCE_MODES } = require('./order/processed_fill_store');

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

async function flushProcessedFillPersistence(reason = 'manual', options = {}) {
    this._processedFillStore.setShuttingDown(this._shuttingDown);
    await this._processedFillStore.flush(reason, options);
}

function buildOrphanFillFallbackKey(fill) {
    const fillOp = fill?.op?.[1];
    const orderId = fillOp?.order_id;
    const blockNum = fill?.block_num;
    const paysAssetId = fillOp?.pays?.asset_id;
    const paysAmount = fillOp?.pays?.amount;
    const receivesAssetId = fillOp?.receives?.asset_id;
    const receivesAmount = fillOp?.receives?.amount;
    const makerRole = fillOp?.is_maker === false ? 'taker' : 'maker';
    if (!orderId || blockNum == null || !paysAssetId || paysAmount == null || !receivesAssetId || receivesAmount == null) {
        return null;
    }
    return `orphan:${orderId}:${blockNum}:${paysAssetId}:${paysAmount}:${receivesAssetId}:${receivesAmount}:${makerRole}`;
}

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
    } catch (err) {
        if (errorMessage) {
            logger?.log?.(errorMessage(fillOp, fill, err), 'error');
            return { status: 'error', fillKey, error: err };
        }
        throw err;
    }
}

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

async function applyReplaySafeOrphanFillAccounting(fill, fillOp, {
    context,
    logger = this.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
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

function createFillCallback(chainOrders) {
    return async (fills) => {
        if (this._shuttingDown) {
            return;
        }

        if (this.manager && !this.config.dryRun && Array.isArray(fills) && fills.length > 0) {
            this._markGridActivity?.('fill queued');
            this._incomingFillQueue.push(...fills);
            this._consumeFillQueue(chainOrders).catch(err => {
                this._warn(`Fill queue consume failed: ${err.message}`);
            });
        }
    };
}

module.exports = {
    wireProcessedFillTracking,
    flushProcessedFillPersistence,
    buildOrphanFillFallbackKey,
    applyReplaySafeFillAccounting,
    applyReplaySafeTrackedFillAccounting,
    applyReplaySafeOrphanFillAccounting,
    createFillCallback
};
