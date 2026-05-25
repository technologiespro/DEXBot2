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

    async function fetchFillHistoryEntries(accountId: string, stopHistoryId: string): Promise<any[]> {
        const fetchPage = chainClient.history?.getAccountHistoryOperations
            || chainClient.history?.get_account_history_operations
            || ((...args: any[]) => chainClient.history.call('get_account_history_operations', args));

        const entries = [];
        const seenIds = new Set();
        let startHistoryId = SUBSCRIPTIONS.HISTORY_API_OBJECT;

        while (true) {
            const page = await Promise.resolve(fetchPage(
                accountId,
                OP_FILL_ORDER,
                startHistoryId,
                stopHistoryId,
                SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX
            ));

            if (!Array.isArray(page) || page.length === 0) break;

            for (const entry of page) {
                if (!entry || !entry.id || seenIds.has(entry.id) || entry.id === stopHistoryId) continue;
                seenIds.add(entry.id);
                entries.push(entry);
            }

            if (page.length < SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX) break;

            const oldestId = page[page.length - 1]?.id;
            const nextStartHistoryId = decrementObjectId(oldestId);
            if (!oldestId || !nextStartHistoryId || oldestId === stopHistoryId || nextStartHistoryId === startHistoryId) break;
            startHistoryId = nextStartHistoryId;
        }

        return sortEntriesOldestFirst(entries);
    }

    async function primeLastDeliveredHistoryId(sub: any): Promise<string> {
        if (!sub?.accountId) return SUBSCRIPTIONS.HISTORY_API_OBJECT;
        const fetchPage = chainClient.history?.getAccountHistoryOperations
            || chainClient.history?.get_account_history_operations
            || ((...args: any[]) => chainClient.history.call('get_account_history_operations', args));
        const latestFillEntries = await Promise.resolve(fetchPage(
            sub.accountId,
            OP_FILL_ORDER,
            SUBSCRIPTIONS.HISTORY_API_OBJECT,
            SUBSCRIPTIONS.HISTORY_API_OBJECT,
            1
        ));
        return latestFillEntries?.[0]?.id || SUBSCRIPTIONS.HISTORY_API_OBJECT;
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
        if (!Array.isArray(params) || params.length < 2) return;

        const [callbackId, data] = params;

        if (callbackId !== SUBSCRIBE_CALLBACK_ID) return;

        for (const [, sub] of subscriptions) {
            if (!sub.active) continue;
            if (!shouldProcessNoticeForSubscription(sub, data)) continue;

            try {
                await processObjects(sub, data);
            } catch (err: any) {
                if (sub.onError) {
                    try { sub.onError(err); } catch (_: any) {}
                }
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
                if (item.owner && item.owner === sub.accountId) {
                    return true;
                }
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
        return !sawFillObject;
    }

    async function processObjects(sub: any, data: any): Promise<void> {
        if (!data || !Array.isArray(data)) return;

        const noticeObjectIds = [];
        for (const item of data) {
            if (!item) continue;
            const id = typeof item === 'object' ? item.id : item;
            if (typeof id !== 'string') continue;
            noticeObjectIds.push(id);
        }

        if (noticeObjectIds.length === 0) return;

        try {
            const accData = await fetchFullAccountWithRetry(sub, false);
            if (!accData) return;
            const accountId = accData.account?.id || sub.accountId;
            if (!accountId) return;
            sub.accountId = accountId;
            sub.statisticsId = accData.account?.statistics || sub.statisticsId || null;

            if (!sub.lastDeliveredHistoryId) {
                sub.lastDeliveredHistoryId = await primeLastDeliveredHistoryId(sub);
            }

            const history = await fetchFillHistoryEntries(accountId, sub.lastDeliveredHistoryId);
            if (history.length === 0) return;

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
                const failed = [];
                for (const callback of sub.callbacks) {
                    try {
                        await Promise.resolve(callback(fills));
                    } catch (err: any) {
                        failed.push(err);
                    }
                }

                if (failed.length > 0) {
                    if (sub.onError) {
                        for (const err of failed) {
                            try { sub.onError(err); } catch (_: any) {}
                        }
                    }
                    return;
                }

                sub.lastDeliveredHistoryId = fills[fills.length - 1]?.id || sub.lastDeliveredHistoryId;
            }
        } catch (err: any) {
            if (sub.onError) {
                try { sub.onError(err); } catch (_: any) {}
            }
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

            entry.lastDeliveredHistoryId = await primeLastDeliveredHistoryId(entry);
        }

        entry.callbacks.add(callback);
        if (onError) entry.onError = onError;

        if (createdEntry) {
            try {
                ensureNoticeSubscription();
                await chainClient.db.call('set_subscribe_callback', [
                    SUBSCRIBE_CALLBACK_ID,
                    false,
                ]);
                entry.active = !!entry.accountId;
                await processObjects(entry, [entry.accountId]);
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
            subscriptions.delete(accountName);

            if (subscriptions.size === 0) {
                removeNoticeSubscription();
            }
        }
    }

    async function resubscribeAll() {
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;

            try {
                const accounts = await chainClient.db.get_full_accounts([entry.accountName], true);
                if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                    entry.accountId = accounts[0][1].account.id;
                    entry.statisticsId = accounts[0][1].account.statistics || null;
                    entry.active = true;
                }
            } catch (_: any) {}

            try {
                await chainClient.db.call('set_subscribe_callback', [
                    SUBSCRIBE_CALLBACK_ID,
                    false,
                ]);
                ensureNoticeSubscription();
                await processObjects(entry, [entry.accountId]);
            } catch (err: any) {
                console.warn('[subscriptions] Failed to resubscribe', entry.accountName, err.message);
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
