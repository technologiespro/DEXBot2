const PROCESSED_FILL_PERSISTENCE_MODES = Object.freeze({
    IMMEDIATE: 'immediate',
    BATCHED: 'batched'
});

function resolveProcessedFillPersistenceMode(options = {}) {
    if (options?.persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.BATCHED) {
        return PROCESSED_FILL_PERSISTENCE_MODES.BATCHED;
    }
    if (options?.persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE) {
        return PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE;
    }
    return options?.deferPersistence === true
        ? PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
        : PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE;
}

class ProcessedFillStore {
    constructor({
        batchMs,
        batchSize,
        warn
    } = {}) {
        this.tracker = new Map();
        this.pendingWrites = new Map();
        this._batchMs = batchMs;
        this._batchSize = batchSize;
        this._warn = typeof warn === 'function' ? warn : () => {};
        this._persistTimer = null;
        this._flushPromise = Promise.resolve();
        this._accountOrders = null;
        this._botKey = null;
        this._shuttingDown = false;
    }

    configure({ accountOrders, botKey } = {}) {
        this._accountOrders = accountOrders || null;
        this._botKey = botKey || null;
    }

    setShuttingDown(value) {
        this._shuttingDown = value === true;
    }

    loadPersisted({ forceReload = false, minTimestamp = null } = {}) {
        if (!this._accountOrders || !this._botKey) return 0;

        const persistedFills = this._accountOrders.loadProcessedFills(this._botKey, {
            forceReload,
            minTimestamp
        });

        for (const [fillKey, timestamp] of persistedFills) {
            const existing = this.tracker.get(fillKey);
            if (existing === undefined || timestamp > existing) {
                this.tracker.set(fillKey, timestamp);
            }
        }

        return persistedFills.size;
    }

    mergeTracker(sourceTracker) {
        if (!(sourceTracker instanceof Map) || sourceTracker === this.tracker) return;

        for (const [fillKey, timestamp] of sourceTracker) {
            const existing = this.tracker.get(fillKey);
            if (existing === undefined || timestamp > existing) {
                this.tracker.set(fillKey, timestamp);
            }
        }
    }

    async persist(fillKey, timestamp, { mode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE } = {}) {
        if (!this._accountOrders || !this._botKey || !fillKey) return;

        this._queue(fillKey, timestamp);
        if (mode === PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE) {
            await this.flush('fill-persist', { throwOnError: true });
        }
    }

    discard(fillKey, timestamp) {
        const queuedTimestamp = this.pendingWrites.get(fillKey);
        if (queuedTimestamp === undefined) return;
        if (timestamp !== undefined && queuedTimestamp > timestamp) return;
        this.pendingWrites.delete(fillKey);
    }

    async flush(reason = 'manual', { throwOnError = false } = {}) {
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }

        if (!this._accountOrders || !this._botKey) {
            await this._flushPromise;
            return;
        }

        if (this.pendingWrites.size === 0) {
            await this._flushPromise;
            return;
        }

        const batch = new Map(this.pendingWrites);
        this.pendingWrites.clear();
        let flushError = null;

        const flushWork = async () => {
            try {
                await this._accountOrders.updateProcessedFillsBatch(this._botKey, batch);
            } catch (err) {
                flushError = err;
                for (const [fillKey, timestamp] of batch) {
                    const queuedTimestamp = this.pendingWrites.get(fillKey);
                    if (queuedTimestamp === undefined || timestamp > queuedTimestamp) {
                        this.pendingWrites.set(fillKey, timestamp);
                    }
                }
                this._warn(`[FILL-DEDUP] Failed to flush ${batch.size} processed fill record(s) (${reason}): ${err.message}`);
                this._schedule();
            }
        };

        this._flushPromise = this._flushPromise.then(flushWork, flushWork);
        await this._flushPromise;
        if (flushError && throwOnError) {
            throw flushError;
        }
    }

    _queue(fillKey, timestamp) {
        const existing = this.pendingWrites.get(fillKey);
        if (existing === undefined || timestamp > existing) {
            this.pendingWrites.set(fillKey, timestamp);
        }

        if (this.pendingWrites.size >= this._batchSize) {
            void this.flush('batch-size');
            return;
        }

        this._schedule();
    }

    _schedule() {
        if (this._persistTimer || this._shuttingDown || this.pendingWrites.size === 0) return;

        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            void this.flush('timer');
        }, this._batchMs);
    }
}

module.exports = {
    ProcessedFillStore,
    PROCESSED_FILL_PERSISTENCE_MODES,
    resolveProcessedFillPersistenceMode
};
