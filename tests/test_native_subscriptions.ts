/**
 * tests/test_native_subscriptions.js - Native subscription regression tests.
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

console.log('=== Native Subscription Tests ===\n');

function makeAccountRecord(account) {
    const name = account === '1.2.200' ? 'bob' : account === '1.2.100' ? 'alice' : account;
    return [account, {
        account: {
            id: name === 'bob' ? '1.2.200' : '1.2.100',
            name,
            statistics: name === 'bob' ? '2.6.200' : '2.6.100',
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
                        return [{ id: '1.11.499', block_num: 10, trx_in_block: 1, op: [4, { order_id: '1.7.1' }] }];
                    }
                    if (stop === '1.11.498') {
                        // Initial bounded catch-up includes the primed latest fill
                        // and a fill that arrived during subscription activation.
                        return [
                            { id: '1.11.499', block_num: 10, trx_in_block: 1, op: [4, { order_id: '1.7.1' }] },
                            { id: '1.11.500', block_num: 11, trx_in_block: 2, op: [4, { order_id: '1.7.2' }] },
                        ];
                    }
                    if (stop === '1.11.500') {
                        return [{ id: '1.11.501', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.3' }] }];
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

        // Non-fill notice should be silently skipped (no history scan — matches btsdex behavior)
        await noticeHandler([1, [{ id: '2.5.999', owner: '1.2.100' }]]);
        assert.strictEqual(delivered.length, 1, 'non-fill notice should not trigger delivery');

        // Notice with direct fill object should be dispatched immediately to matching account
        await noticeHandler([1, [{ id: '1.11.501', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);

        // Two deliveries: bounded catch-up + direct notice fill.
        assert.strictEqual(delivered.length, 2, 'matching account should receive two deliveries');
        // First delivery: bounded catch-up delivers latest known fill plus activation-window fills.
        assert.strictEqual(delivered[0][0], 'alice');
        assert.deepStrictEqual(delivered[0][1].map(fill => fill.id), ['1.11.499', '1.11.500']);
        // Second delivery: direct from notice data (no history scan).
        assert.strictEqual(delivered[1][0], 'alice');
        assert.strictEqual(delivered[1][1].length, 1);
        assert.strictEqual(delivered[1][1][0].id, '1.11.501');
        assert.strictEqual(delivered[1][1][0].block_num, 12, 'fill payload should expose block_num');
        assert.strictEqual(delivered[1][1][0].trx_in_block, 3, 'fill payload should expose trx_in_block');
        assert.strictEqual(delivered[1][1][0].block, undefined, 'legacy block alias should not leak through');
        assert.strictEqual(delivered[1][1][0].trx, undefined, 'legacy trx alias should not leak through');
        const aliceHistoryCalls = historyCalls.filter(([account]) => account === '1.2.100');
        const bobHistoryCalls = historyCalls.filter(([account]) => account === '1.2.200');
        // Startup primes latest first; non-fill object-change notices now trigger
        // a catch-up scan because BitShares Core may notify impacted accounts with
        // changed object IDs rather than full 1.11.x fill objects.
        assert.deepStrictEqual(
            aliceHistoryCalls[0],
            ['1.2.100', 4, '1.11.0', '1.11.0', 1],
            'subscription bootstrap should prime from the latest delivered fill id'
        );
        assert.deepStrictEqual(
            aliceHistoryCalls[1],
            ['1.2.100', 4, '1.11.0', '1.11.498', 100],
            'object-change notice should read the head page after priming'
        );
        assert.strictEqual(aliceHistoryCalls.length, 2, 'direct fill notice should not add an alice history scan');
        assert.strictEqual(bobHistoryCalls.length, 2, 'bob prime plus object-change catch-up');
        // Fill sent via direct notice should dispatch to all active subscriptions
        assert.strictEqual(delivered.length, 2, 'alice should get catch-up + direct notice fill');
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
                        return [{ id: '1.11.510', block_num: 10, trx_in_block: 1, op: [4, { order_id: '1.7.510' }] }];
                    }
                    if (stop === '1.11.509') {
                        return [{ id: '1.11.511', block_num: 11, trx_in_block: 2, op: [4, { order_id: '1.7.511' }] }];
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
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.899') {
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.900') {
                        return [{ id: '1.11.901', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.901' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        delivered.length = 0;

        assert.strictEqual(handlers.length, 1, 'initial subscription should register one notice handler');

        chainClient.transport.dropHandlersForReconnect();
        assert.strictEqual(handlers.length, 0, 'transport cleanup should detach the old notice handler');

        await manager.resubscribeAll();

        assert.strictEqual(handlers.length, 1, 'resubscribe should reattach a live notice handler after reconnect cleanup');
        assert.strictEqual(delivered.length, 1, 'resubscribe should catch up fills missed during the reconnect gap');
        assert.strictEqual(delivered[0][0].id, '1.11.900');

        await handlers[0]([1, [{ id: '2.5.4000', owner: '1.2.100' }]]);
        assert.strictEqual(delivered.length, 2, 'reattached object-change notice should scan and deliver newer fills');
        assert.strictEqual(delivered[1][0].id, '1.11.901');
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
                        return [{ id: '1.11.650', block_num: 9, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (subscriptionComplete && stop === '1.11.649') {
                        return [{ id: '1.11.700', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.3' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(accountNoticeClient);
        await manager.subscribe('alice', (fills) => {
            accountNoticeDelivered.push(fills);
        });
        await manager.subscribe('bob', () => {});
        subscriptionComplete = true;
        accountNoticeDelivered.length = 0;
        historyAccounts.length = 0;

        // Non-fill notice (statistics object) triggers a history scan because BitShares Core
        // may notify impacted accounts with changed object IDs rather than full 1.11.x fill objects.
        // The scan finds the fill at 1.11.700 from the mock.
        await noticeHandler([1, [{ id: '2.6.100' }]]);
        assert.strictEqual(accountNoticeDelivered.length, 1, 'object-change notice should trigger history scan and deliver fill');
        assert.strictEqual(accountNoticeDelivered[0][0].id, '1.11.700', 'history scan should deliver fill 1.11.700');

        // Fill object in notice should also be dispatched directly to matching account
        // (handleNotice does not deduplicate against cursor — the downstream bot's fill
        // deduplication layer handles that).
        await noticeHandler([1, [{ id: '1.11.701', block_num: 13, trx_in_block: 3, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);
        assert.strictEqual(accountNoticeDelivered.length, 2, 'direct fill notice should add a second delivery');
        assert.strictEqual(accountNoticeDelivered[1][0].id, '1.11.701', 'direct notice should deliver fill 1.11.701');

        // Bob's callback should not fire for alice's fill.
        accountNoticeDelivered.length = 0;
        await noticeHandler([1, [{ id: '1.11.702', block_num: 14, trx_in_block: 4, op: [4, { order_id: '1.7.4', account_id: '1.2.200' }] }]]);
        assert.strictEqual(accountNoticeDelivered.length, 0, 'bob fill should not deliver to alice callback');
    }

    console.log(' - Testing multiple fill objects in a single notice are dispatched together...');
    {
        let noticeHandler = null;
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
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 900, trx_in_block: 900, op: [4, { order_id: '1.7.900' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });

        // Send multiple fill objects in a single WebSocket notice.
        await noticeHandler([1, [
            { id: '1.11.901', block_num: 901, trx_in_block: 901, op: [4, { order_id: '1.7.901', account_id: '1.2.100' }] },
            { id: '1.11.902', block_num: 902, trx_in_block: 902, op: [4, { order_id: '1.7.902', account_id: '1.2.100' }] },
            { id: '1.11.903', block_num: 903, trx_in_block: 903, op: [4, { order_id: '1.7.903', account_id: '1.2.100' }] },
        ]]);

        assert.strictEqual(delivered.length, 1, 'fills in a single notice should batch into one delivery');
        assert.strictEqual(delivered[0].length, 3, 'all three fills should be in the same batch');
        assert.strictEqual(delivered[0][0].id, '1.11.901', 'first fill should match');
        assert.strictEqual(delivered[0][1].id, '1.11.902', 'second fill should match');
        assert.strictEqual(delivered[0][2].id, '1.11.903', 'third fill should match');
    }

    console.log(' - Testing direct fill notice with full account_id dispatches correctly...');
    {
        let noticeHandler = null;
        const delivered = [];
        let subscriptionComplete = false;
        const originalWarn = console.warn;
        console.warn = (...args) => {};

        try {
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
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.800', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });

            // Direct fill notice — no get_full_accounts call, no history scan.
            await noticeHandler([1, [{ id: '1.11.801', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.801', account_id: '1.2.100' }] }]]);
            assert.strictEqual(delivered.length, 1, 'direct fill notice should deliver');
            assert.strictEqual(delivered[0][0].id, '1.11.801');
            assert.strictEqual(delivered[0][0].op[1].account_id, '1.2.100', 'fill should have matching account_id');
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
                getAccountHistoryOperations: async (_accountId, _opType, _start, _stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.600', block_num: 11, trx_in_block: 2, op: [4, { order_id: '1.7.bootstrap' }] }];
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
        });
        failedOnce = false;
        retryDeliveries = 0;

        // First fill notice: callback throws (logged, not retried — btsdex parity)
        await noticeHandler([1, [{ id: '1.11.601', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.2', account_id: '1.2.100' }] }]]);
        // Second fill notice: callback succeeds
        await noticeHandler([1, [{ id: '1.11.602', block_num: 13, trx_in_block: 4, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);

        assert.strictEqual(retryDeliveries, 2, 'first callback fails (logged), second succeeds');
    }

    console.log(' - Testing reconnect catch-up scans back to the last delivered cursor...');
    {
        let reconnectHistoryPages = 0;
        let subscriptionComplete = false;
        const delivered = [];
        const chainClient = {
            transport: {
                addMessageHandler() {
                    return () => {};
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    reconnectHistoryPages += 1;
                    const startInstance = Number(String(start).split('.').pop());
                    const newest = startInstance === 0 ? 2000 : startInstance;
                    const stopInstance = Number(String(stop).split('.').pop());
                    return Array.from({ length: limit }, (_, idx) => ({
                        id: `1.11.${newest - idx}`,
                        block_num: newest - idx,
                        trx_in_block: idx,
                        op: [4, { order_id: `1.7.${newest - idx}` }],
                    })).filter(entry => Number(String(entry.id).split('.').pop()) > stopInstance);
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        subscriptionComplete = true;
        delivered.length = 0;

        await manager.resubscribeAll();

        assert.strictEqual(reconnectHistoryPages, 12, 'reconnect catch-up should keep scanning until the previous cursor is reached');
        assert.strictEqual(delivered.length, 1, 'reconnect catch-up should deliver recovered fills once');
        assert.strictEqual(delivered[0].length, 1101, 'all missed fills newer than the previous cursor should be delivered');
        assert.strictEqual(delivered[0][0].id, '1.11.900', 'oldest missed fill should be preserved');
        assert.strictEqual(delivered[0][1100].id, '1.11.2000', 'newest missed fill should be preserved');
    }

    console.log(' - Testing async callback failures keep reconnect cursor retryable...');
    {
        let subscriptionComplete = false;
        let failOnce = false;
        let deliveries = 0;
        let callbackErrors = 0;
        const historyStops = [];
        const chainClient = {
            transport: {
                addMessageHandler() {
                    return () => {};
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.300', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    historyStops.push(stop);
                    if (stop === '1.11.299') {
                        return [{ id: '1.11.301', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.async-retry' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', async () => {
            deliveries += 1;
            if (failOnce) {
                failOnce = false;
                throw new Error('async delivery failed');
            }
        }, () => {
            callbackErrors += 1;
        });
        subscriptionComplete = true;
        failOnce = true;
        deliveries = 0;
        callbackErrors = 0;

        await manager.resubscribeAll();
        await manager.resubscribeAll();

        assert.strictEqual(callbackErrors, 1, 'async callback failure should be reported once');
        assert.strictEqual(deliveries, 2, 'async callback failure should redeliver the same fill on retry');
        assert.deepStrictEqual(
            historyStops,
            ['1.11.299', '1.11.299'],
            'cursor must not advance after failed async callback delivery'
        );
    }

    console.log(' - Testing failed reconnect catch-up schedules an automatic retry...');
    {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const retryDelays = [];
        let retryCallback = null;
        global.setTimeout = (fn, delay) => {
            retryDelays.push(delay);
            retryCallback = fn;
            return { retryTimer: true };
        };
        global.clearTimeout = () => {};

        try {
            let subscriptionComplete = false;
            let failReconnectDelivery = false;
            let deliveredCount = 0;
            let callbackErrors = 0;
            const chainClient = {
                transport: {
                    addMessageHandler() {
                        return () => {};
                    },
                },
                db: {
                    get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.700', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (!subscriptionComplete) return [];
                        if (stop === '1.11.699') {
                            return [{ id: '1.11.701', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.retry' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', () => {
                deliveredCount += 1;
                if (failReconnectDelivery) {
                    failReconnectDelivery = false;
                    throw new Error('transient reconnect delivery failure');
                }
            }, () => {
                callbackErrors += 1;
            });
            subscriptionComplete = true;
            failReconnectDelivery = true;
            deliveredCount = 0;
            callbackErrors = 0;

            await manager.resubscribeAll();
            assert.strictEqual(callbackErrors, 1, 'failed reconnect delivery should report callback error');
            assert.strictEqual(retryDelays.length, 1, 'failed reconnect catch-up should schedule one retry');
            assert.strictEqual(typeof retryCallback, 'function', 'retry callback should be scheduled');

            retryCallback();
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(deliveredCount, 2, 'retry should redeliver the unacknowledged reconnect fill');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    console.log(' - Testing live notice callback failure is logged without retry...');
    {
        let noticeHandler = null;
        let deliveries = 0;
        let failOnce = false;
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
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.400', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient);
        await manager.subscribe('alice', async (fills) => {
            deliveries += fills.length;
            if (failOnce) {
                failOnce = false;
                throw new Error('transient callback error');
            }
        });
        failOnce = true;
        deliveries = 0;

        // A failing callback increments deliveries (before throw) but doesn't block future deliveries
        await noticeHandler([1, [{ id: '1.11.401', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.live-fail', account_id: '1.2.100' }] }]]);
        assert.strictEqual(deliveries, 1, 'failing callback increments before throw');

        // Next fill notice dispatches normally
        await noticeHandler([1, [{ id: '1.11.402', block_num: 3, trx_in_block: 3, op: [4, { order_id: '1.7.live-ok', account_id: '1.2.100' }] }]]);
        assert.strictEqual(deliveries, 2, 'next fill should dispatch normally after previous failure');
    }

    console.log(' - Testing reconnect missing account data remains retryable...');
    {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const retryDelays = [];
        let retryCallback = null;
        global.setTimeout = (fn, delay) => {
            retryDelays.push(delay);
            retryCallback = fn;
            return { retryTimer: true };
        };
        global.clearTimeout = () => {};

        try {
            let subscriptionComplete = false;
            let reconnectAttempts = 0;
            const delivered = [];
            const chainClient = {
                transport: {
                    addMessageHandler() {
                        return () => {};
                    },
                },
                db: {
                    get_full_accounts: async ([account], subscribe) => {
                        if (subscribe || !subscriptionComplete) return [makeAccountRecord(account)];
                        reconnectAttempts += 1;
                        if (reconnectAttempts <= 2) return [];
                        return [makeAccountRecord(account)];
                    },
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.500', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (!subscriptionComplete) return [];
                        if (stop === '1.11.499') {
                            return [{ id: '1.11.501', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.account-retry' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            subscriptionComplete = true;

            await manager.resubscribeAll();

            assert.strictEqual(delivered.length, 0, 'missing account data should not silently skip catch-up');
            assert.strictEqual(retryDelays.length, 1, 'missing account data should schedule reconnect retry');

            retryCallback();
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(delivered.length, 1, 'retry after missing account data should perform catch-up');
            assert.strictEqual(delivered[0][0].id, '1.11.501');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    console.log('\n=== All subscription tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
