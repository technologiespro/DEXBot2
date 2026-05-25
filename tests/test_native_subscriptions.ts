/**
 * tests/test_native_subscriptions.js - Native subscription regression tests.
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

console.log('=== Native Subscription Tests ===\n');

function makeAccountRecord(account) {
    return [account, {
        account: {
            id: account === 'bob' ? '1.2.200' : '1.2.100',
            name: account,
            statistics: account === 'bob' ? '2.6.200' : '2.6.100',
        },
    }];
}

(async () => {
    console.log(' - Testing delivered fill shape matches downstream expectations...');
    {
        let noticeHandler = null;
        const dbCalls = [];
        const historyCalls = [];
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account], subscribe) => {
                    dbCalls.push(['get_full_accounts', account, subscribe]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    assert.strictEqual(method, 'set_subscribe_callback');
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push([accountId, opType, start, stop, limit]);
                    if (accountId !== '1.2.100') return [];
                    if (limit === 1) {
                        return [{ id: '1.11.499', block_num: 10, trx_id: 1, op: [4, { order_id: '1.7.1' }] }];
                    }
                    if (stop === '1.11.0') {
                        // Initial bounded catch-up includes the primed latest fill
                        // and a fill that arrived during subscription activation.
                        return [
                            { id: '1.11.499', block_num: 10, trx_id: 1, op: [4, { order_id: '1.7.1' }] },
                            { id: '1.11.500', block_num: 11, trx_id: 2, op: [4, { order_id: '1.7.2' }] },
                        ];
                    }
                    if (stop === '1.11.500') {
                        return [{ id: '1.11.501', block_num: 12, trx_id: 3, op: [4, { order_id: '1.7.3' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(['alice', fills]);
        });
        await manager.subscribe('bob', () => {
            throw new Error('bob should not receive alice notices');
        });

        assert.strictEqual(typeof noticeHandler, 'function', 'notice handler should be registered');
        await noticeHandler([1, [{ id: '2.5.999', owner: '1.2.100' }]]);

        // Two deliveries: initial bounded catch-up + notice-triggered fetch.
        assert.strictEqual(delivered.length, 2, 'matching account should receive two deliveries');
        // First delivery: bounded catch-up delivers latest known fill plus activation-window fills.
        assert.strictEqual(delivered[0][0], 'alice');
        assert.deepStrictEqual(delivered[0][1].map(fill => fill.id), ['1.11.499', '1.11.500']);
        // Second delivery: notice-triggered fetch delivers fill newer than the catch-up cursor.
        assert.strictEqual(delivered[1][0], 'alice');
        assert.strictEqual(delivered[1][1].length, 1);
        assert.strictEqual(delivered[1][1][0].id, '1.11.501');
        assert.strictEqual(delivered[1][1][0].block_num, 12, 'fill payload should expose block_num');
        assert.strictEqual(delivered[1][1][0].trx_id, 3, 'fill payload should expose trx_id');
        assert.strictEqual(delivered[1][1][0].block, undefined, 'legacy block alias should not leak through');
        assert.strictEqual(delivered[1][1][0].trx, undefined, 'legacy trx alias should not leak through');
        // Startup primes latest first, then performs a bounded overlap fetch.
        assert.deepStrictEqual(
            historyCalls[0],
            ['1.2.100', 4, '1.11.0', '1.11.0', 1],
            'subscription bootstrap should prime from the latest delivered fill id'
        );
        assert.deepStrictEqual(
            historyCalls[1],
            ['1.2.100', 4, '1.11.0', '1.11.0', 100],
            'initial catch-up should read only the head page after priming'
        );
        // The notice-triggered fetch uses the delivered catch-up cursor as exclusive stop.
        const aliceNoticeHistoryCall = historyCalls.find(([, , , stop, limit]) => stop === '1.11.500' && limit === 100);
        assert.deepStrictEqual(
            aliceNoticeHistoryCall,
            ['1.2.100', 4, '1.11.0', '1.11.500', 100],
            'notice processing should fetch only fills newer than the catch-up cursor'
        );
        assert.ok(dbCalls.some(([method]) => method === 'set_subscribe_callback'), 'subscription RPC should be registered');
        assert.strictEqual(
            dbCalls.some(([method, account, subscribe]) => method === 'get_full_accounts' && account === 'alice' && subscribe === true),
            true,
            'subscription setup should subscribe the account on-chain'
        );
    }

    console.log(' - Testing first subscribe wires local callback and notice handler before remote activation...');
    {
        let noticeHandler = null;
        let callbackCountDuringRegister = -1;
        let noticeHandlerPresentDuringRegister = false;
        let manager = null;
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async (method) => {
                    assert.strictEqual(method, 'set_subscribe_callback');
                    const entry = manager.getSubscriptions().get('alice');
                    callbackCountDuringRegister = entry?.callbacks?.size ?? -1;
                    noticeHandlerPresentDuringRegister = typeof noticeHandler === 'function';
                    await noticeHandler([1, [{ id: '2.5.511', owner: '1.2.100' }]]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.510', block_num: 10, trx_id: 1, op: [4, { order_id: '1.7.510' }] }];
                    }
                    if (stop === '1.11.0') {
                        return [{ id: '1.11.511', block_num: 11, trx_id: 2, op: [4, { order_id: '1.7.511' }] }];
                    }
                    return [];
                },
            },
        };

        manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });

        assert.strictEqual(callbackCountDuringRegister, 1, 'initial subscribe should attach the local callback before remote activation');
        assert.strictEqual(noticeHandlerPresentDuringRegister, true, 'initial subscribe should install the local notice handler before remote activation');
        assert.strictEqual(delivered.length, 1, 'initial subscribe should catch up fills from the activation window');
        assert.strictEqual(delivered[0][0].id, '1.11.511', 'bounded catch-up should deliver fills newer than the overlap cursor');
    }

    console.log(' - Testing reconnect reattaches notice handler after transport cleanup...');
    {
        let handlers = [];
        const delivered = [];
        const dbCalls = [];
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    handlers.push(handler);
                    const unsubscribe = () => {
                        const idx = handlers.indexOf(handler);
                        if (idx !== -1) handlers.splice(idx, 1);
                    };
                    unsubscribe.isActive = () => handlers.includes(handler);
                    return unsubscribe;
                },
                dropHandlersForReconnect() {
                    handlers = [];
                },
            },
            db: {
                get_full_accounts: async ([account], subscribe) => {
                    dbCalls.push(['get_full_accounts', account, subscribe]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 1, trx_id: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.900') {
                        return [{ id: '1.11.901', block_num: 2, trx_id: 2, op: [4, { order_id: '1.7.901' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });

        assert.strictEqual(handlers.length, 1, 'initial subscription should register one notice handler');

        chainClient.transport.dropHandlersForReconnect();
        assert.strictEqual(handlers.length, 0, 'transport cleanup should detach the old notice handler');

        await manager.resubscribeAll();

        assert.strictEqual(handlers.length, 1, 'resubscribe should reattach a live notice handler after reconnect cleanup');
        assert.strictEqual(delivered.length, 1, 'resubscribe should catch up fills missed during the reconnect gap');
        assert.strictEqual(delivered[0][0].id, '1.11.901');

        await handlers[0]([1, [{ id: '2.5.4000', owner: '1.2.100' }]]);
        assert.strictEqual(delivered.length, 1, 'reattached notice handler should not redeliver the reconnect catch-up fill');
        assert.ok(
            dbCalls.filter(([method]) => method === 'set_subscribe_callback').length >= 2,
            'subscription callback should be registered again during reconnect'
        );
    }

    console.log(' - Testing account/statistics notices stay account-scoped...');
    {
        let noticeHandler = null;
        const historyAccounts = [];
        const accountNoticeDelivered = [];
        let subscriptionComplete = false;

        const accountNoticeClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                    historyAccounts.push(accountId);
                    if (accountId !== '1.2.100') return [];
                    if (limit === 1) {
                        return [{ id: '1.11.650', block_num: 9, trx_id: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (subscriptionComplete && stop === '1.11.650') {
                        return [{ id: '1.11.700', block_num: 12, trx_id: 3, op: [4, { order_id: '1.7.3' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(accountNoticeClient);
        await manager.subscribe('alice', (fills) => {
            accountNoticeDelivered.push(fills);
        });
        await manager.subscribe('bob', () => {
            throw new Error('bob should not receive alice statistics notices');
        });
        subscriptionComplete = true;
        accountNoticeDelivered.length = 0;
        historyAccounts.length = 0;

        await noticeHandler([1, [{ id: '2.6.100' }]]);
        assert.strictEqual(accountNoticeDelivered.length, 1, 'account/statistics notices should trigger history fill scan');
        assert.strictEqual(accountNoticeDelivered[0][0].id, '1.11.700');

        accountNoticeDelivered.length = 0;
        historyAccounts.length = 0;
        await noticeHandler([1, [{ id: '2.6.100' }]]);
        assert.strictEqual(accountNoticeDelivered.length, 0, 'duplicate alice statistics fill should stay deduped by cursor');
        assert.ok(historyAccounts.length > 0, 'alice statistics notices should scan alice history');
        assert.ok(historyAccounts.every((accountId) => accountId === '1.2.100'), 'alice statistics notices should not wake bob history scans');
    }

    console.log(' - Testing pagination catches bursts larger than the BitShares Core page limit...');
    {
        let noticeHandler = null;
        const delivered = [];
        const pageOne = [];
        for (let id = 1005; id >= 906; id--) {
            pageOne.push({ id: `1.11.${id}`, block_num: id, trx_id: id, op: [4, { order_id: `1.7.${id}` }] });
        }
        const pageTwo = [];
        for (let id = 905; id >= 901; id--) {
            pageTwo.push({ id: `1.11.${id}`, block_num: id, trx_id: id, op: [4, { order_id: `1.7.${id}` }] });
        }
        const historyCalls = [];
        let subscriptionComplete = false;
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push([accountId, opType, start, stop, limit]);
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 900, trx_id: 900, op: [4, { order_id: '1.7.900' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    if (start === '1.11.0') return pageOne.slice();
                    if (start === '1.11.905') return pageTwo.slice();
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        subscriptionComplete = true;
        delivered.length = 0;
        historyCalls.length = 0;

        await noticeHandler([1, [{ id: '2.5.2000', owner: '1.2.100' }]]);

        assert.strictEqual(delivered.length, 1, 'burst notice should still emit a single delivery batch');
        assert.strictEqual(delivered[0].length, 105, 'pagination should recover every new fill beyond the first 100');
        assert.strictEqual(delivered[0][0].id, '1.11.901', 'fills should be delivered oldest-first for deterministic downstream processing');
        assert.strictEqual(delivered[0][104].id, '1.11.1005');
        assert.deepStrictEqual(
            historyCalls,
            [
                ['1.2.100', 4, '1.11.0', '1.11.900', 100],
                ['1.2.100', 4, '1.11.905', '1.11.900', 100],
            ],
            'pagination should continue before the oldest page entry because BitShares Core treats start as inclusive'
        );
    }

    console.log(' - Testing get_full_accounts notice failures warn and retry without advancing cursor...');
    {
        let noticeHandler = null;
        let fullAccountCalls = 0;
        let warningCount = 0;
        const delivered = [];
        let subscriptionComplete = false;
        const originalWarn = console.warn;
        console.warn = (...args) => {
            if (String(args[0] || '').includes('[subscriptions] get_full_accounts')) warningCount++;
        };

        try {
            const chainClient = {
                transport: {
                    addMessageHandler(handler) {
                        noticeHandler = handler;
                        return () => { noticeHandler = null; };
                    },
                },
                db: {
                    get_full_accounts: async ([account], subscribe) => {
                        if (subscribe) return [makeAccountRecord(account)];
                        if (!subscriptionComplete) return [makeAccountRecord(account)];
                        fullAccountCalls++;
                        if (fullAccountCalls === 1) throw new Error('temporary rpc failure');
                        if (fullAccountCalls === 2) return [];
                        return [makeAccountRecord(account)];
                    },
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.800', block_num: 1, trx_id: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (!subscriptionComplete) return [];
                        if (stop === '1.11.800') {
                            return [{ id: '1.11.801', block_num: 2, trx_id: 2, op: [4, { order_id: '1.7.801' }] }];
                        }
                        if (stop === '1.11.801') return [];
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            subscriptionComplete = true;
            fullAccountCalls = 0;
            warningCount = 0;
            delivered.length = 0;

            await noticeHandler([1, [{ id: '2.5.3000', owner: '1.2.100' }]]);
            assert.strictEqual(delivered.length, 0, 'failed account refresh should not deliver fills');
            assert.strictEqual(warningCount, 2, 'failed and empty account refresh attempts should warn');

            await noticeHandler([1, [{ id: '2.5.3001', owner: '1.2.100' }]]);
            assert.strictEqual(delivered.length, 1, 'next successful notice should retry the unacknowledged fill');
            assert.strictEqual(delivered[0][0].id, '1.11.801');
        } finally {
            console.warn = originalWarn;
        }
    }

    console.log(' - Testing callback failures retry the same fill until success...');
    {
        let noticeHandler = null;
        let failedOnce = false;
        let retryDeliveries = 0;
        let callbackErrors = 0;
        const retryHistoryCalls = [];
        let subscriptionComplete = false;
        const retryChainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                    retryHistoryCalls.push([accountId, stop, limit]);
                    if (limit === 1) {
                        return [{ id: '1.11.600', block_num: 11, trx_id: 2, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    if (stop === '1.11.600') {
                        return [{ id: '1.11.601', block_num: 12, trx_id: 3, op: [4, { order_id: '1.7.2' }] }];
                    }
                    if (stop === '1.11.601') {
                        return [];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(retryChainClient);
        await manager.subscribe('alice', () => {
            retryDeliveries += 1;
            if (!failedOnce) {
                failedOnce = true;
                throw new Error('transient callback failure');
            }
        }, () => {
            callbackErrors += 1;
        });
        subscriptionComplete = true;
        failedOnce = false;
        retryDeliveries = 0;
        callbackErrors = 0;
        retryHistoryCalls.length = 0;

        await noticeHandler([1, [{ id: '2.5.1001', owner: '1.2.100' }]]);
        await noticeHandler([1, [{ id: '2.5.1002', owner: '1.2.100' }]]);
        await noticeHandler([1, [{ id: '2.5.1003', owner: '1.2.100' }]]);

        assert.strictEqual(callbackErrors, 1, 'callback failure should be reported to onError');
        assert.strictEqual(retryDeliveries, 2, 'fill should retry once after failed callback and dedupe after success');
        assert.deepStrictEqual(
            retryHistoryCalls,
            [
                ['1.2.100', '1.11.600', 100],
                ['1.2.100', '1.11.600', 100],
                ['1.2.100', '1.11.601', 100],
            ],
            'cursor should only advance after successful callback delivery'
        );
    }

    console.log('\n=== All subscription tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
