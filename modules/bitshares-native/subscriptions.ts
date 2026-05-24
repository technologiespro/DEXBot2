'use strict';

const { NATIVE_CLIENT } = require('../constants');
const { SUBSCRIPTIONS, OPERATIONS } = NATIVE_CLIENT;

const SUBSCRIBE_CALLBACK_ID = SUBSCRIPTIONS.CALLBACK_ID;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;
const FILL_OBJECT_REGEX = new RegExp('^' + SUBSCRIPTIONS.FILL_OBJECT_PREFIX.replace('.', '\\.') + '\\.');

function createSubscriptionManager(chainClient) {
    const subscriptions = new Map();
    let unsubscribeNotice = null;
    let noticeActive = false;
    const lastDeliveredByAccount = new Map();

    function ensureNoticeSubscription() {
        if (noticeActive) return;
        if (!unsubscribeNotice) {
            unsubscribeNotice = chainClient.transport.addMessageHandler(handleNotice);
        }
        noticeActive = true;
    }

    function removeNoticeSubscription() {
        if (unsubscribeNotice) {
            unsubscribeNotice();
            unsubscribeNotice = null;
        }
        noticeActive = false;
    }

    async function handleNotice(params) {
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

    function shouldProcessNoticeForSubscription(sub, data) {
        if (!Array.isArray(data) || !sub.accountId) return true;

        let sawFillObject = false;
        let sawKnownAccountObject = false;
        let sawAccountScopedObject = false;
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const id = typeof item.id === 'string' ? item.id : null;
            if (!id) continue;

            if (FILL_OBJECT_REGEX.test(id)) {
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

    async function processObjects(sub, data) {
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
            const accounts = await chainClient.db.get_full_accounts([sub.accountId || sub.accountName], false);
            if (!accounts || !accounts[0] || !accounts[0][1]) return;

            const accData = accounts[0][1];
            const accountId = accData.account?.id || sub.accountId;
            if (!accountId) return;
            sub.accountId = accountId;
            sub.statisticsId = accData.account?.statistics || sub.statisticsId || null;

            const historyId = accData.account?.statistics
                ? await getHistoryId(accountId)
                : null;

            if (!historyId) return;

            const history = await chainClient.history.getAccountHistory(
                accountId,
                SUBSCRIPTIONS.HISTORY_API_OBJECT,
                Math.min(SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX, Math.max(SUBSCRIPTIONS.HISTORY_LOOKBACK_MIN, noticeObjectIds.length * 5)),
                historyId
            );

            if (!Array.isArray(history)) return;

            const delivered = lastDeliveredByAccount.get(accountId) || new Set();
            const fills = [];
            for (const entry of history) {
                if (!entry || !entry.op || !entry.id || delivered.has(entry.id)) continue;
                const opData = entry.op;
                if (Array.isArray(opData) && opData[0] === OP_FILL_ORDER) {
                    fills.push({
                        type: 'fill',
                        op: opData,
                        block: entry.block_num,
                        trx: entry.trx_id,
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

                for (const fill of fills) {
                    delivered.add(fill.id);
                }
            }

            if (delivered.size > SUBSCRIPTIONS.DELIVERED_CACHE_MAX) {
                const trimmed = Array.from(delivered).slice(-SUBSCRIPTIONS.DELIVERED_CACHE_TRIM);
                lastDeliveredByAccount.set(accountId, new Set(trimmed));
            } else {
                lastDeliveredByAccount.set(accountId, delivered);
            }
        } catch (err: any) {
            if (sub.onError) {
                try { sub.onError(err); } catch (_: any) {}
            }
        }

        async function getHistoryId(accId) {
            // Note: account_statistics.most_recent_op is account_history_id_type (2.9.x),
            // but get_account_history expects operation_history_id_type (1.11.x).
            // The API treats a default-constructed operation_history_id_type (1.11.0)
            // as "start from most recent" (max). Use that instead to avoid type mismatch
            // API errors that would silently drop fills.
            return SUBSCRIPTIONS.HISTORY_API_OBJECT;
        }
    }

    async function subscribe(accountName, callback, onError = null) {
        if (!accountName || typeof accountName !== 'string') {
            throw new Error('accountName is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('callback function is required');
        }

        let entry = subscriptions.get(accountName);
        if (!entry) {
            entry = {
                accountName,
                accountId: null,
                statisticsId: null,
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

            try {
                await chainClient.db.call('set_subscribe_callback', [
                    SUBSCRIBE_CALLBACK_ID,
                    false,
                ]);
                entry.active = !!entry.accountId;
            } catch (err: any) {
                subscriptions.delete(accountName);
                throw new Error(`Failed to register subscription callback: ${err.message}`);
            }

            ensureNoticeSubscription();
        }

        entry.callbacks.add(callback);
        if (onError) entry.onError = onError;

        return () => unsubscribe(accountName, callback);
    }

    async function unsubscribe(accountName, callback) {
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
