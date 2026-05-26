'use strict';

const { NATIVE_CLIENT } = require('../constants');
const { SUBSCRIPTIONS, OPERATIONS } = NATIVE_CLIENT;

const SUBSCRIBE_CALLBACK_ID = SUBSCRIPTIONS.CALLBACK_ID;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;
const OP_HISTORY_REGEX = new RegExp('^' + SUBSCRIPTIONS.OPERATION_HISTORY_PREFIX.replace('.', '\\.') + '\\.');

function createSubscriptionManager(chainClient: any): any {
    const subscriptions = new Map();
    let unsubscribeNotice: any = null;
    let noticeActive = false;
    const reconnectRetryDelayMs = Number.isFinite(SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        ? Math.max(1000, SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        : 5000;

    function parseObjectIdInstance(id: any): number {
        if (typeof id !== 'string') return Number.NaN;
        const match = id.match(/\.(\d+)$/);
        return match ? Number(match[1]) : Number.NaN;
    }

    function sortEntriesOldestFirst(entries: any[]): any[] {
        return entries.sort((left: any, right: any) => {
            const leftInstance = parseObjectIdInstance(left?.id);
            const rightInstance = parseObjectIdInstance(right?.id);
            if (!Number.isFinite(leftInstance) || !Number.isFinite(rightInstance)) {
                return String(left?.id || '').localeCompare(String(right?.id || ''));
            }
            return leftInstance - rightInstance;
        });
    }

    function decrementObjectId(id: any): string | null {
        if (typeof id !== 'string') return null;
        const match = id.match(/^(.+\.)(\d+)$/);
        if (!match) return null;
        const instance = Number(match[2]);
        if (!Number.isSafeInteger(instance) || instance <= 0) return null;
        return `${match[1]}${instance - 1}`;
    }

    function warnSubscription(sub: any, message: string, err: any = null): void {
        const account = sub?.accountName || sub?.accountId || 'unknown';
        const detail = err?.message ? `: ${err.message}` : '';
        console.warn(`[subscriptions] ${message} for ${account}${detail}`);
    }

    async function fetchFullAccountWithRetry(sub: any, subscribe: boolean = false): Promise<any> {
        const accountRef = sub.accountId || sub.accountName;
        let lastErr = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const accounts = await chainClient.db.get_full_accounts([accountRef], subscribe);
                const account = accounts?.[0]?.[1];
                if (account) return account;
                warnSubscription(sub, `get_full_accounts returned no account data on attempt ${attempt}`);
            } catch (err: any) {
                lastErr = err;
                warnSubscription(sub, `get_full_accounts failed on attempt ${attempt}`, err);
            }
        }

        if (lastErr) throw lastErr;
        return null;
    }

    async function fetchFillHistoryEntries(accountId: string, cursorHistoryId: string, options: any = {}): Promise<any[]> {
        const fetchPage = chainClient.history?.getAccountHistoryOperations
            || chainClient.history?.get_account_history_operations
            || ((...args: any[]) => chainClient.history.call('get_account_history_operations', args));

        const entries = [];
        const seenIds = new Set();
        const cursorInstance = parseObjectIdInstance(cursorHistoryId);
        // Scan the fill history range [start = oldest, stop = cursor] and return
        // entries whose instance is strictly greater than the cursor's instance.
        // The BitShares API returns entries from stop (newest) down to start (oldest).
        let startHistoryId = SUBSCRIPTIONS.HISTORY_API_OBJECT;
        let pagesFetched = 0;
        const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : null;

        console.log(`[subscriptions] fetchFillHistoryEntries: account=${accountId}, cursor=${cursorHistoryId}, start=${startHistoryId}, maxPages=${maxPages}`);

        while (true) {
            const page = await Promise.resolve(fetchPage(
                accountId,
                OP_FILL_ORDER,
                startHistoryId,
                cursorHistoryId,
                SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX
            ));
            pagesFetched++;

            const pageLen = Array.isArray(page) ? page.length : 0;
            console.log(`[subscriptions] fetchFillHistoryEntries: page ${pagesFetched} returned ${pageLen} entries (start=${startHistoryId}, stop=${cursorHistoryId})`);

            if (!Array.isArray(page) || page.length === 0) break;

            let allEntriesAtOrBeforeCursor = true;
            for (const entry of page) {
                if (!entry || !entry.id || seenIds.has(entry.id)) continue;
                seenIds.add(entry.id);

                // Only keep entries strictly newer than the cursor (already-delivered fills).
                const entryInstance = parseObjectIdInstance(entry.id);
                if (Number.isFinite(cursorInstance) && Number.isFinite(entryInstance) && entryInstance <= cursorInstance) continue;

                allEntriesAtOrBeforeCursor = false;
                entries.push(entry);
            }

            if (page.length < SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX) {
                console.log(`[subscriptions] fetchFillHistoryEntries: last page (${page.length} < ${SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX})`);
                break;
            }
            if (maxPages !== null && pagesFetched >= maxPages) {
                console.log(`[subscriptions] fetchFillHistoryEntries: maxPages (${maxPages}) reached`);
                break;
            }
            // Stop if all entries on this page are at or before the cursor —
            // we've caught up to the latest delivered fill, no need to scan further into history.
            if (allEntriesAtOrBeforeCursor) break;

            const oldestId = page[page.length - 1]?.id;
            const nextStartHistoryId = decrementObjectId(oldestId);
            if (!oldestId || !nextStartHistoryId || nextStartHistoryId === startHistoryId) break;
            startHistoryId = nextStartHistoryId;
        }

        console.log(`[subscriptions] fetchFillHistoryEntries: returning ${entries.length} fill entries across ${pagesFetched} page(s) for ${accountId}`);
        return sortEntriesOldestFirst(entries);
    }

    async function primeLastDeliveredHistoryId(sub: any): Promise<string> {
        if (!sub?.accountId) return SUBSCRIPTIONS.HISTORY_API_OBJECT;

        // Primary: use get_account_history_operations filtered to fills
        const fetchFillPage = chainClient.history?.getAccountHistoryOperations
            || chainClient.history?.get_account_history_operations
            || ((...args: any[]) => chainClient.history.call('get_account_history_operations', args));
        const latestFillEntries = await Promise.resolve(fetchFillPage(
            sub.accountId,
            OP_FILL_ORDER,
            SUBSCRIPTIONS.HISTORY_API_OBJECT,
            SUBSCRIPTIONS.HISTORY_API_OBJECT,
            1
        ));
        const latestFillId = latestFillEntries?.[0]?.id;
        if (latestFillId) {
            console.log(`[subscriptions] primeLastDeliveredHistoryId: resolved via get_account_history_operations to ${latestFillId} for ${sub.accountName}`);
            return latestFillId;
        }

        // Fallback: use get_account_history (any operation type) to find the most
        // recent history entry. This seeds the cursor past "1.11.0" so that
        // fetchFillHistoryEntries can scan from the latest entry forward.
        console.log(`[subscriptions] primeLastDeliveredHistoryId: get_account_history_operations returned no fills, trying get_account_history fallback for ${sub.accountName}`);
        try {
            const fetchAnyPage = chainClient.history?.getAccountHistory
                || chainClient.history?.get_account_history
                || ((...args: any[]) => chainClient.history.call('get_account_history', args));
            const entries = await Promise.resolve(fetchAnyPage(
                sub.accountId,
                SUBSCRIPTIONS.HISTORY_API_OBJECT,
                1,
                SUBSCRIPTIONS.HISTORY_API_OBJECT
            ));
            const fallbackId = entries?.[0]?.id;
            if (fallbackId) {
                console.log(`[subscriptions] primeLastDeliveredHistoryId: fallback resolved to ${fallbackId} for ${sub.accountName}`);
                return fallbackId;
            }
        } catch (err: any) {
            console.warn(`[subscriptions] primeLastDeliveredHistoryId: get_account_history fallback failed for ${sub.accountName}: ${err.message}`);
        }

        console.log(`[subscriptions] primeLastDeliveredHistoryId: no history found, using HISTORY_API_OBJECT for ${sub.accountName}`);
        return SUBSCRIPTIONS.HISTORY_API_OBJECT;
    }

    function ensureNoticeSubscription() {
        if (unsubscribeNotice) {
            if (typeof unsubscribeNotice.isActive !== 'function' || unsubscribeNotice.isActive()) return;
            unsubscribeNotice = null;
        }
        unsubscribeNotice = chainClient.transport.addMessageHandler(handleNotice);
        noticeActive = true;
    }

    function removeNoticeSubscription() {
        if (unsubscribeNotice) {
            unsubscribeNotice();
            unsubscribeNotice = null;
        }
        noticeActive = false;
    }

    async function handleNotice(params: any): Promise<void> {
        if (!Array.isArray(params) || params.length < 2) {
            console.log('[subscriptions] handleNotice: skipping (invalid params)');
            return;
        }

        const [callbackId, data] = params;

        if (callbackId !== SUBSCRIBE_CALLBACK_ID) {
            return;
        }

        const activeCount = Array.from(subscriptions.values()).filter(s => s.active).length;
        console.log(`[subscriptions] handleNotice: received notice (callbackId=${callbackId}, activeSubs=${activeCount}, dataLen=${Array.isArray(data) ? data.length : 'N/A'})`);

        for (const [, sub] of subscriptions) {
            if (!sub.active) continue;
            if (!shouldProcessNoticeForSubscription(sub, data)) continue;

            console.log(`[subscriptions] handleNotice: processing for ${sub.accountName} (accountId=${sub.accountId})`);

            try {
                await processObjects(sub, data, { throwOnError: true });
            } catch (err: any) {
                console.warn(`[subscriptions] handleNotice: processObjects failed for ${sub.accountName}: ${err?.message}`);
                if (sub.onError && !err?.subscriptionErrorReported) {
                    try { sub.onError(err); } catch (_: any) {}
                }
                scheduleReconnectRetry(sub, err);
            }
        }
    }

    function shouldProcessNoticeForSubscription(sub: any, data: any): boolean {
        if (!Array.isArray(data) || !sub.accountId) return true;

        let sawFillObject = false;
        let sawKnownAccountObject = false;
        let sawAccountScopedObject = false;
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const id = typeof item.id === 'string' ? item.id : null;
            if (!id) continue;

            if (OP_HISTORY_REGEX.test(id)) {
                sawFillObject = true;
                if (item.op && Array.isArray(item.op) && item.op[0] === OP_FILL_ORDER && item.op[1] && item.op[1].account_id === sub.accountId) {
                    return true;
                }
                continue;
            }

            if (/^(1\.2|2\.6)\.\d+$/.test(id)) {
                sawAccountScopedObject = true;
            }

            if (id === sub.accountId || id === sub.statisticsId) {
                sawKnownAccountObject = true;
            }
        }

        if (sawKnownAccountObject) return true;
        if (sawAccountScopedObject) return false;
        // History objects (1.11.x) may arrive as thin notices without full op data
        // (no `owner` or `op` fields). We cannot reliably determine the account from
        // the notice alone, so always trigger a history scan to avoid missing fills.
        if (sawFillObject) return true;
        return true;
    }

    async function processObjects(sub: any, data: any, options: any = {}): Promise<void> {
        if (!data || !Array.isArray(data)) return;

        const noticeObjectIds = [];
        for (const item of data) {
            if (!item) continue;
            const id = typeof item === 'object' ? item.id : item;
            if (typeof id !== 'string') continue;
            noticeObjectIds.push(id);
        }

        if (noticeObjectIds.length === 0) {
            console.log(`[subscriptions] processObjects: no identifiable object IDs in notice data for ${sub.accountName} (dataLen=${data?.length}, types=${data.map((d: any) => typeof d).join(',')})`);
            return;
        }

        try {
            const accData = await fetchFullAccountWithRetry(sub, false);
            if (!accData) {
                console.warn(`[subscriptions] processObjects: get_full_accounts returned no data for ${sub.accountName}`);
                if (options.throwOnError) {
                    throw new Error('get_full_accounts returned no account data');
                }
                return;
            }
            const accountId = accData.account?.id || sub.accountId;
            if (!accountId) {
                console.warn(`[subscriptions] processObjects: no account id after fetch for ${sub.accountName}`);
                if (options.throwOnError) {
                    throw new Error('get_full_accounts returned no account id');
                }
                return;
            }
            sub.accountId = accountId;
            sub.statisticsId = accData.account?.statistics || sub.statisticsId || null;

            if (!sub.lastDeliveredHistoryId) {
                sub.lastDeliveredHistoryId = await primeLastDeliveredHistoryId(sub);
                console.log(`[subscriptions] processObjects: primed lastDeliveredHistoryId=${sub.lastDeliveredHistoryId} for ${sub.accountName}`);
            }

            const history = await fetchFillHistoryEntries(accountId, sub.lastDeliveredHistoryId, options);
            if (history.length === 0) {
                console.log(`[subscriptions] processObjects: no fill history entries for ${sub.accountName} (cursor=${sub.lastDeliveredHistoryId})`);
                return;
            }

            const fills = [];
            for (const entry of history) {
                if (!entry || !entry.op || !entry.id) continue;
                const opData = entry.op;
                if (Array.isArray(opData) && opData[0] === OP_FILL_ORDER) {
                    fills.push({
                        type: 'fill',
                        op: opData,
                        block_num: entry.block_num,
                        trx_id: entry.trx_id,
                        id: entry.id,
                    });
                }
            }

            if (fills.length > 0) {
                console.log(`[subscriptions] processObjects: dispatching ${fills.length} fill(s) to ${sub.callbacks.size} callback(s) for ${sub.accountName}`);
                const failed = [];
                for (const callback of sub.callbacks) {
                    try {
                        await Promise.resolve(callback(fills));
                    } catch (err: any) {
                        console.warn(`[subscriptions] processObjects: callback error for ${sub.accountName}: ${err?.message}`);
                        failed.push(err);
                    }
                }

                if (failed.length > 0) {
                    if (sub.onError) {
                        for (const err of failed) {
                            try { sub.onError(err); } catch (_: any) {}
                        }
                    }
                    if (options.throwOnError) {
                        failed[0].subscriptionErrorReported = true;
                        throw failed[0];
                    }
                    return;
                }

                sub.lastDeliveredHistoryId = fills[fills.length - 1]?.id || sub.lastDeliveredHistoryId;
                console.log(`[subscriptions] processObjects: advanced cursor to ${sub.lastDeliveredHistoryId} for ${sub.accountName}`);
            } else {
                console.log(`[subscriptions] processObjects: history had entries but none were FILL_ORDER operations for ${sub.accountName}`);
            }
        } catch (err: any) {
            console.warn(`[subscriptions] processObjects: error for ${sub.accountName}: ${err?.message}`);
            if (sub.onError && !err?.subscriptionErrorReported) {
                try { sub.onError(err); } catch (_: any) {}
            }
            if (options.throwOnError) throw err;
        }
    }

    function clearReconnectRetry(entry: any): void {
        if (!entry?.reconnectRetryTimer) return;
        clearTimeout(entry.reconnectRetryTimer);
        entry.reconnectRetryTimer = null;
    }

    function scheduleReconnectRetry(entry: any, err: any): void {
        if (!entry || entry.reconnectRetryTimer || !entry.active || entry.callbacks?.size === 0) return;

        entry.reconnectRetryTimer = setTimeout(() => {
            entry.reconnectRetryTimer = null;
            resubscribeEntry(entry, 'retry').catch((retryErr: any) => {
                console.warn('[subscriptions] Failed to resubscribe', entry.accountName, retryErr.message);
                scheduleReconnectRetry(entry, retryErr);
            });
        }, reconnectRetryDelayMs);
        if (typeof entry.reconnectRetryTimer.unref === 'function') {
            entry.reconnectRetryTimer.unref();
        }

        warnSubscription(entry, `scheduled reconnect retry in ${reconnectRetryDelayMs}ms`, err);
    }

    /**
     * Centralized subscription refresh: set_subscribe_callback then re-subscribe ALL active accounts.
     * cancel_all_subscriptions(false, false) inside set_subscribe_callback clears
     * _subscribed_accounts for every account. Every active entry must be re-subscribed after
     * every call, not just the current one.
     */
    async function refreshSubscriptions(): Promise<any[]> {
        const failures = [];
        ensureNoticeSubscription();
        await chainClient.db.call('set_subscribe_callback', [
            SUBSCRIBE_CALLBACK_ID,
            false,
        ]);
        for (const [, subEntry] of subscriptions) {
            if (!subEntry.active) continue;
            try {
                await chainClient.db.get_full_accounts([subEntry.accountName], true);
            } catch (err: any) {
                console.warn('[subscriptions] Failed to re-subscribe account after set_subscribe_callback for', subEntry.accountName, err.message);
                failures.push({ entry: subEntry, err });
            }
        }
        return failures;
    }

    async function resubscribeEntry(entry: any, reason: string = 'reconnect') {
        if (!entry?.active) return;

        try {
            const accounts = await chainClient.db.get_full_accounts([entry.accountName], true);
            if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                entry.accountId = accounts[0][1].account.id;
                entry.statisticsId = accounts[0][1].account.statistics || null;
            }
        } catch (err: any) {
            console.warn('[subscriptions] Failed to refresh account data for', entry.accountName, err.message);
        }

        const refreshFailures = await refreshSubscriptions();
        const entryRefreshFailure = refreshFailures.find((failure: any) => failure.entry === entry);
        if (entryRefreshFailure) throw entryRefreshFailure.err;
        for (const failure of refreshFailures) {
            scheduleReconnectRetry(failure.entry, failure.err);
        }

        await processObjects(entry, [entry.accountId], {
            throwOnError: true,
        });
        clearReconnectRetry(entry);
        if (reason === 'retry') {
            console.warn('[subscriptions] Reconnect retry restored subscription', entry.accountName);
        }
    }

    async function subscribe(accountName: string, callback: any, onError: any = null): Promise<any> {
        if (!accountName || typeof accountName !== 'string') {
            throw new Error('accountName is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('callback function is required');
        }

        let entry = subscriptions.get(accountName);
        const createdEntry = !entry;
        if (!entry) {
            entry = {
                accountName,
                accountId: null,
                statisticsId: null,
                lastDeliveredHistoryId: SUBSCRIPTIONS.HISTORY_API_OBJECT,
                active: false,
                callbacks: new Set(),
                onError: null,
                reconnectRetryTimer: null,
            };
            subscriptions.set(accountName, entry);

            const accounts = await chainClient.db.get_full_accounts([accountName], true);
            if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                entry.accountId = accounts[0][1].account.id;
                entry.statisticsId = accounts[0][1].account.statistics || null;
            }
            if (!entry.accountId) {
                subscriptions.delete(accountName);
                throw new Error(`Could not resolve subscribed account: ${accountName}`);
            }

        }

        entry.callbacks.add(callback);
        if (onError) entry.onError = onError;

        if (createdEntry) {
            try {
                // Prime the cursor BEFORE remote activation. Any fill that lands between
                // primeLastDeliveredHistoryId and set_subscribe_callback has an ID > latestFillId
                // and will be caught by the catch-up below. The cursor is decremented so that
                // the catch-up includes the primed fill itself (as an exclusive stop boundary).
                const latestFillId = await primeLastDeliveredHistoryId(entry);
                entry.lastDeliveredHistoryId = latestFillId
                    ? (decrementObjectId(latestFillId) || latestFillId)
                    : SUBSCRIPTIONS.HISTORY_API_OBJECT;

                entry.active = !!entry.accountId;

                const refreshFailures = await refreshSubscriptions();
                const entryRefreshFailure = refreshFailures.find((failure: any) => failure.entry === entry);
                if (entryRefreshFailure) throw entryRefreshFailure.err;
                for (const failure of refreshFailures) {
                    scheduleReconnectRetry(failure.entry, failure.err);
                }

                // Catch up on fills that landed during the activation window.
                await processObjects(entry, [entry.accountId], { maxPages: 1 });
            } catch (err: any) {
                entry.callbacks.delete(callback);
                if (entry.onError === onError) {
                    entry.onError = null;
                }
                if (entry.callbacks.size === 0) {
                    entry.active = false;
                    subscriptions.delete(accountName);
                    if (subscriptions.size === 0) {
                        removeNoticeSubscription();
                    }
                }
                throw new Error(`Failed to register subscription callback: ${err.message}`);
            }
        }

        return () => unsubscribe(accountName, callback);
    }

    async function unsubscribe(accountName: string, callback?: any): Promise<void> {
        const entry = subscriptions.get(accountName);
        if (!entry) return;

        if (callback) {
            entry.callbacks.delete(callback);
        } else {
            entry.callbacks.clear();
        }

        if (entry.callbacks.size === 0) {
            entry.active = false;
            clearReconnectRetry(entry);
            subscriptions.delete(accountName);

            if (subscriptions.size === 0) {
                removeNoticeSubscription();
            }
        }
    }

    async function resubscribeAll() {
        // Refresh account data for every active entry first (before any RPC calls
        // that might race with each other on the same connection).
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            try {
                const accounts = await chainClient.db.get_full_accounts([entry.accountName], true);
                if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                    entry.accountId = accounts[0][1].account.id;
                    entry.statisticsId = accounts[0][1].account.statistics || null;
                }
            } catch (err: any) {
                console.warn('[subscriptions] Failed to refresh account data for', entry.accountName, err.message);
            }
        }

        // Centralized subscription setup — one set_subscribe_callback + re-subscribe all.
        const refreshFailures = await refreshSubscriptions();
        const refreshFailureEntries = new Set(refreshFailures.map((failure: any) => failure.entry));
        for (const failure of refreshFailures) {
            scheduleReconnectRetry(failure.entry, failure.err);
        }

        // Catch-up scan for each entry.
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            if (refreshFailureEntries.has(entry)) continue;
            try {
                await processObjects(entry, [entry.accountId], {
                    throwOnError: true,
                });
                clearReconnectRetry(entry);
            } catch (err: any) {
                console.warn('[subscriptions] Failed to resubscribe', entry.accountName, err.message);
                scheduleReconnectRetry(entry, err);
            }
        }
    }

    async function onReconnect() {
        await resubscribeAll();
    }

    return {
        subscribe,
        unsubscribe,
        onReconnect,
        resubscribeAll,
        removeNoticeSubscription,
        getSubscriptions: () => new Map(subscriptions),
    };
}

export = { createSubscriptionManager };
