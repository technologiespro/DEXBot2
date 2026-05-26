'use strict';

const { NATIVE_CLIENT } = require('../constants');
const { SUBSCRIPTIONS, OPERATIONS } = NATIVE_CLIENT;

const SUBSCRIBE_CALLBACK_ID = SUBSCRIPTIONS.CALLBACK_ID;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;

function createSubscriptionManager(chainClient: any): any {
    const subscriptions = new Map();
    let unsubscribeNotice: any = null;
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

    // btsdex parity: use get_account_history (unfiltered) instead of
    // get_account_history_operations (type-filtered). The type-filtered API
    // walks a per-account linked list and may miss fill_order operations even
    // when they exist on chain for the account. The unfiltered API uses the
    // efficient by_op index and returns ALL operation types. We filter for
    // OP_FILL_ORDER client-side in processObjects.
    async function fetchFillHistoryEntries(accountId: string, cursorHistoryId: string, options: any = {}): Promise<any[]> {
        const fetchPage = chainClient.history?.getAccountHistory
            || chainClient.history?.get_account_history
            || ((...args: any[]) => chainClient.history.call('get_account_history', args));

        const entries = [];
        const seenIds = new Set();
        const cursorInstance = parseObjectIdInstance(cursorHistoryId);
        // Scan history using get_account_history (unfiltered, uses by_op index).
        // Parameters: (accountId, stop, limit, start)
        // API returns entries from start (newest) down to stop (cursor), with
        // start=0 being replaced by the server with the max/head operation ID.
        let startHistoryId = SUBSCRIPTIONS.HISTORY_API_OBJECT;
        let pagesFetched = 0;
        const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : null;

        console.log(`[subscriptions] fetchFillHistoryEntries: account=${accountId}, cursor=${cursorHistoryId}, start=${startHistoryId}, maxPages=${maxPages}`);

        while (true) {
            const page = await Promise.resolve(fetchPage(
                accountId,
                cursorHistoryId,
                SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX,
                startHistoryId
            ));
            pagesFetched++;

            const pageLen = Array.isArray(page) ? page.length : 0;
            console.log(`[subscriptions] fetchFillHistoryEntries: page ${pagesFetched} returned ${pageLen} entries (start=${startHistoryId}, stop=${cursorHistoryId})`);

            if (!Array.isArray(page) || page.length === 0) break;

            let allEntriesAtOrBeforeCursor = true;
            let skippedCount = 0;
            for (const entry of page) {
                if (!entry || !entry.id || seenIds.has(entry.id)) continue;
                seenIds.add(entry.id);

                // Only keep entries strictly newer than the cursor (already-delivered).
                const entryInstance = parseObjectIdInstance(entry.id);
                if (Number.isFinite(cursorInstance) && Number.isFinite(entryInstance) && entryInstance <= cursorInstance) {
                    skippedCount++;
                    continue;
                }

                allEntriesAtOrBeforeCursor = false;
                entries.push(entry);
            }
            if (skippedCount > 0) {
                console.log(`[subscriptions] fetchFillHistoryEntries: skipped ${skippedCount} entries at/before cursor (cursor=${cursorHistoryId})`);
            }

            if (page.length < SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX) {
                console.log(`[subscriptions] fetchFillHistoryEntries: last page (${page.length} < ${SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX})`);
                break;
            }
            if (maxPages !== null && pagesFetched >= maxPages) {
                console.log(`[subscriptions] fetchFillHistoryEntries: maxPages (${maxPages}) reached`);
                break;
            }
            // Stop if all entries on this page are at or before the cursor.
            if (allEntriesAtOrBeforeCursor) break;

            const oldestId = page[page.length - 1]?.id;
            const nextStartHistoryId = decrementObjectId(oldestId);
            if (!oldestId || !nextStartHistoryId || nextStartHistoryId === startHistoryId) break;
            startHistoryId = nextStartHistoryId;
        }

        console.log(`[subscriptions] fetchFillHistoryEntries: returning ${entries.length} operation(s) across ${pagesFetched} page(s) for ${accountId}`);
        return sortEntriesOldestFirst(entries);
    }

    async function primeLastDeliveredHistoryId(sub: any): Promise<string> {
        if (!sub?.accountId) return SUBSCRIPTIONS.HISTORY_API_OBJECT;

        // btsdex parity: use get_account_history (unfiltered) to find the
        // single most recent history entry. This seeds the cursor past "1.11.0"
        // so fetchFillHistoryEntries can scan from the latest entry forward.
        const fetchAnyPage = chainClient.history?.getAccountHistory
            || chainClient.history?.get_account_history
            || ((...args: any[]) => chainClient.history.call('get_account_history', args));
        try {
            const entries = await Promise.resolve(fetchAnyPage(
                sub.accountId,
                SUBSCRIPTIONS.HISTORY_API_OBJECT,
                1,
                SUBSCRIPTIONS.HISTORY_API_OBJECT
            ));
            const latestId = entries?.[0]?.id;
            if (latestId) {
                console.log(`[subscriptions] primeLastDeliveredHistoryId: resolved to ${latestId} for ${sub.accountName}`);
                return latestId;
            }
        } catch (err: any) {
            console.warn(`[subscriptions] primeLastDeliveredHistoryId: get_account_history failed for ${sub.accountName}: ${err.message}`);
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
    }

    function removeNoticeSubscription() {
        if (unsubscribeNotice) {
            unsubscribeNotice();
            unsubscribeNotice = null;
        }
    }

    /**
     * Check if a fill object's account_id matches the given account ID.
     * Each fill_order_operation has an `account_id` field identifying
     * the account whose order was filled.
     */
    function fillMatchesAccount(fill: any, accountId: string): boolean {
        const fillAccountId = fill?.op?.[1]?.account_id;
        return fillAccountId === accountId;
    }

    async function handleNotice(params: any): Promise<void> {
        if (!Array.isArray(params) || params.length < 2) {
            console.log('[subscriptions] handleNotice: skipping (invalid params)');
            return;
        }

        const [callbackId, data] = params;
        if (callbackId !== SUBSCRIBE_CALLBACK_ID) return;

        if (!Array.isArray(data) || data.length === 0) return;

        // Extract fill objects directly from notice data (mirrors btsdex behavior).
        // The BitShares node sends full 1.11.x operation history objects in the
        // notice when a fill occurs. We pass them straight to callbacks — no
        // history scan, no cursor tracking needed for live fills.
        const fillObjects: any[] = [];
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const op = item.op;
            if (Array.isArray(op) && op[0] === OP_FILL_ORDER) {
                fillObjects.push({
                    type: 'fill',
                    op: op,
                    block_num: item.block_num,
                    trx_in_block: item.trx_in_block,
                    id: item.id,
                });
            }
        }

        if (fillObjects.length === 0) return;

        console.log(`[subscriptions] handleNotice: dispatching ${fillObjects.length} fill(s) directly from notice data`);

        // Batch fills per-subscription and dispatch all at once (mirrors btsdex behavior
        // where a single callback receives all fills from one notice).
        for (const [, sub] of subscriptions) {
            if (!sub.active) continue;
            const subFills = fillObjects.filter((fill) => fillMatchesAccount(fill, sub.accountId));
            if (subFills.length === 0) continue;

            // Advance cursor to the latest fill in this batch so startup/refresh
            // processObjects does not re-fetch already-delivered fills.
            let latestId: string | null = null;
            let latestInstance = -1;
            for (const fill of subFills) {
                const inst = parseObjectIdInstance(fill.id);
                if (Number.isFinite(inst) && inst > latestInstance) {
                    latestInstance = inst;
                    latestId = fill.id;
                }
            }
            if (latestId && (!sub.lastDeliveredHistoryId || parseObjectIdInstance(latestId) > parseObjectIdInstance(sub.lastDeliveredHistoryId))) {
                sub.lastDeliveredHistoryId = latestId;
            }

            for (const callback of sub.callbacks) {
                try {
                    await Promise.resolve(callback(subFills));
                } catch (err: any) {
                    console.warn(`[subscriptions] handleNotice: callback error for ${sub.accountName}: ${err?.message}`);
                }
            }
        }
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
            // NOTE: Do NOT return early here. The notice data is just a trigger signal;
            // we must always scan fill history to catch actual fills, because the node
            // may send objects without string `id` fields (e.g. bare account/statistics objects).
            // Fall through to the account fetch + history scan below.
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
                console.log(`[subscriptions] processObjects: no history entries for ${sub.accountName} (cursor=${sub.lastDeliveredHistoryId})`);
                return;
            }

            const historyRange = history.length > 0
                ? `${history[0]?.id}..${history[history.length - 1]?.id}`
                : 'empty';
            console.log(`[subscriptions] processObjects: ${history.length} history entries for ${sub.accountName} range=${historyRange} cursor=${sub.lastDeliveredHistoryId}`);

            const fills = [];
            for (const entry of history) {
                if (!entry || !entry.op || !entry.id) continue;
                const opData = entry.op;
                if (Array.isArray(opData) && opData[0] === OP_FILL_ORDER) {
                    fills.push({
                        type: 'fill',
                        op: opData,
                        block_num: entry.block_num,
                        trx_in_block: entry.trx_in_block,
                        id: entry.id,
                    });
                }
            }

            // Advance cursor to the NEWEST history entry in this batch (any operation type).
            // This prevents re-fetching already-scanned operations on subsequent scans.
            // Future get_account_history calls use this cursor as the exclusive stop,
            // returning only entries with IDs > cursor (i.e., genuinely new entries).
            sub.lastDeliveredHistoryId = history[history.length - 1]?.id || sub.lastDeliveredHistoryId;

            if (fills.length > 0) {
                const fillIds = fills.map(f => f.id).join(', ');
                console.log(`[subscriptions] processObjects: dispatching ${fills.length} fill(s) to ${sub.callbacks.size} callback(s) for ${sub.accountName} cursor=${sub.lastDeliveredHistoryId} fills=[${fillIds}]`);
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

                // NOTE: No initial catch-up scan here — matching main+btsdex behavior.
                // The startup sync (synchronizeWithChain) handles all fills from downtime.
                // processObjects is called on reconnect (resubscribeEntry/resubscribeAll)
                // to catch fills missed during disconnect, at which point the grid is loaded.
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
