'use strict';

const { OP_FILL_ORDER } = require('./serial/chain_constants');

const SUBSCRIBE_CALLBACK_ID = 1;

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
            } catch (err) {
                if (sub.onError) {
                    try { sub.onError(err); } catch (_) {}
                }
            }
        }
    }

    function shouldProcessNoticeForSubscription(sub, data) {
        if (!Array.isArray(data) || !sub.accountId) return true;

        let sawFillObject = false;
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const id = typeof item.id === 'string' ? item.id : null;
            if (!id || !/^2\.5\./.test(id)) continue;
            sawFillObject = true;
            if (item.owner && item.owner === sub.accountId) {
                return true;
            }
        }

        return !sawFillObject;
    }

    async function processObjects(sub, data) {
        if (!data || !Array.isArray(data)) return;

        const objectIds = [];
        for (const item of data) {
            if (!item) continue;
            const id = typeof item === 'object' ? item.id : item;
            if (typeof id !== 'string') continue;

            const parts = id.split('.');
            if (parts.length === 3 && parts[0] === '2' && parts[1] === '5') {
                objectIds.push(id);
            }
        }

        if (objectIds.length === 0) return;

        try {
            const accounts = await chainClient.db.get_full_accounts([sub.accountId || sub.accountName], false);
            if (!accounts || !accounts[0] || !accounts[0][1]) return;

            const accData = accounts[0][1];
            const accountId = accData.account?.id || sub.accountId;
            if (!accountId) return;

            const historyId = accData.account?.statistics
                ? await getHistoryId(accountId)
                : null;

            if (!historyId) return;

            const history = await chainClient.history.getAccountHistory(
                accountId,
                '1.11.0',
                Math.min(100, Math.max(10, objectIds.length * 5)),
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
                    } catch (err) {
                        failed.push(err);
                    }
                }

                if (failed.length > 0) {
                    if (sub.onError) {
                        for (const err of failed) {
                            try { sub.onError(err); } catch (_) {}
                        }
                    }
                    return;
                }

                for (const fill of fills) {
                    delivered.add(fill.id);
                }
            }

            if (delivered.size > 500) {
                const trimmed = Array.from(delivered).slice(-250);
                lastDeliveredByAccount.set(accountId, new Set(trimmed));
            } else {
                lastDeliveredByAccount.set(accountId, delivered);
            }
        } catch (_) {}

        async function getHistoryId(accId) {
            try {
                const full = await chainClient.db.get_full_accounts([accId], false);
                if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.statistics) {
                    const statsId = full[0][1].account.statistics;
                    const stats = await chainClient.db.get_objects([statsId]);
                    if (stats && stats[0] && stats[0].most_recent_op) {
                        return stats[0].most_recent_op;
                    }
                }
            } catch (_) {}
            return '1.11.0';
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
                active: false,
                callbacks: new Set(),
                onError: null,
            };
            subscriptions.set(accountName, entry);

            const accounts = await chainClient.db.get_full_accounts([accountName], true);
            if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                entry.accountId = accounts[0][1].account.id;
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
            } catch (err) {
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
                    entry.active = true;
                }
            } catch (_) {}

            try {
                await chainClient.db.call('set_subscribe_callback', [
                    SUBSCRIBE_CALLBACK_ID,
                    false,
                ]);
                ensureNoticeSubscription();
            } catch (_) {}
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
        getSubscriptions: () => new Map(subscriptions),
    };
}

module.exports = { createSubscriptionManager };
