/**
 * tests/test_native_subscriptions.js - Native subscription regression tests.
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

console.log('=== Native Subscription Tests ===\n');

(async () => {
    let noticeHandler = null;
    const dbCalls = [];
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
                return [[account, {
                    account: {
                        id: account === 'bob' ? '1.2.200' : '1.2.100',
                        name: account,
                        statistics: account === 'bob' ? '2.6.200' : '2.6.100',
                    },
                }]];
            },
            get_objects: async ([id]) => {
                dbCalls.push(['get_objects', id]);
                return [{ id, most_recent_op: '1.11.500' }];
            },
            call: async (method, args) => {
                dbCalls.push([method, args]);
                assert.strictEqual(method, 'set_subscribe_callback');
                return null;
            },
        },
        history: {
            getAccountHistory: async (accountId, stop, limit, start) => {
                assert.strictEqual(accountId, '1.2.100');
                assert.strictEqual(start, '1.11.500');
                assert.ok(limit <= 100);
                return [
                    { id: '1.11.499', block_num: 10, trx_id: 1, op: [4, { order_id: '1.7.1' }] },
                    { id: '1.11.498', block_num: 9, trx_id: 1, op: [0, {}] },
                ];
            },
        },
    };

    const manager = createSubscriptionManager(chainClient);
    await manager.subscribe('alice', (fills) => {
        delivered.push(['alice', fills]);
    });
    await manager.subscribe('bob', (fills) => {
        delivered.push(['bob', fills]);
    });

    assert.strictEqual(typeof noticeHandler, 'function', 'notice handler should be registered');
    await noticeHandler([1, [{ id: '2.5.999', owner: '1.2.100' }]]);

    assert.strictEqual(delivered.length, 1, 'only the matching account should receive fills');
    assert.strictEqual(delivered[0][0], 'alice');
    assert.ok(Array.isArray(delivered[0][1]), 'subscriber should receive fills');
    assert.strictEqual(delivered[0][1].length, 1);
    assert.strictEqual(delivered[0][1][0].id, '1.11.499');

    delivered.length = 0;
    await noticeHandler([1, [{ id: '2.5.1000', owner: '1.2.100' }]]);
    assert.strictEqual(delivered.length, 0, 'duplicate history id should not be delivered twice');

    const accountNoticeDelivered = [];
    const accountNoticeHistoryAccounts = [];
    let accountNoticeHandler = null;
    const accountNoticeClient = {
        transport: {
            addMessageHandler(handler) {
                accountNoticeHandler = handler;
                return () => { accountNoticeHandler = null; };
            },
        },
        db: chainClient.db,
        history: {
            getAccountHistory: async (accountId, stop, limit, start) => {
                accountNoticeHistoryAccounts.push(accountId);
                assert.strictEqual(accountId, '1.2.100');
                assert.strictEqual(start, '1.11.500');
                assert.ok(limit <= 100);
                return [
                    { id: '1.11.700', block_num: 12, trx_id: 3, op: [4, { order_id: '1.7.3' }] },
                ];
            },
        },
    };
    const accountNoticeManager = createSubscriptionManager(accountNoticeClient);
    await accountNoticeManager.subscribe('alice', (fills) => {
        accountNoticeDelivered.push(fills);
    });

    await accountNoticeHandler([1, [{ id: '2.6.100' }]]);
    assert.strictEqual(accountNoticeDelivered.length, 1, 'account/statistics notices should trigger history fill scan');
    assert.strictEqual(accountNoticeDelivered[0][0].id, '1.11.700');

    await accountNoticeManager.subscribe('bob', () => {
        throw new Error('bob should not receive alice statistics notices');
    });
    accountNoticeDelivered.length = 0;
    accountNoticeHistoryAccounts.length = 0;
    await accountNoticeHandler([1, [{ id: '2.6.100' }]]);
    assert.strictEqual(accountNoticeDelivered.length, 0, 'duplicate alice statistics fill should stay deduped');
    assert.deepStrictEqual(accountNoticeHistoryAccounts, ['1.2.100'], 'alice statistics notices should not wake bob history scans');

    let retryNoticeHandler = null;
    let failedOnce = false;
    let retryDeliveries = 0;
    let callbackErrors = 0;
    const retryChainClient = {
        transport: {
            addMessageHandler(handler) {
                retryNoticeHandler = handler;
                return () => { retryNoticeHandler = null; };
            },
        },
        db: chainClient.db,
        history: {
            getAccountHistory: async () => [
                { id: '1.11.600', block_num: 11, trx_id: 2, op: [4, { order_id: '1.7.2' }] },
            ],
        },
    };
    const retryManager = createSubscriptionManager(retryChainClient);
    await retryManager.subscribe('alice', () => {
        retryDeliveries += 1;
        if (!failedOnce) {
            failedOnce = true;
            throw new Error('transient callback failure');
        }
    }, () => {
        callbackErrors += 1;
    });

    await retryNoticeHandler([1, [{ id: '2.5.1001', owner: '1.2.100' }]]);
    await retryNoticeHandler([1, [{ id: '2.5.1002', owner: '1.2.100' }]]);
    await retryNoticeHandler([1, [{ id: '2.5.1003', owner: '1.2.100' }]]);
    assert.strictEqual(callbackErrors, 1, 'callback failure should be reported to onError');
    assert.strictEqual(retryDeliveries, 2, 'fill should retry once after failed callback and dedupe after success');

    assert.ok(dbCalls.some(([method]) => method === 'set_subscribe_callback'), 'subscription RPC should be registered');
    assert.strictEqual(
        dbCalls.some(([method, account, subscribe]) => method === 'get_full_accounts' && account === 'alice' && subscribe === true),
        true,
        'subscription setup should subscribe the account on-chain'
    );
    assert.ok(
        dbCalls.some(([method, args]) => method === 'set_subscribe_callback' && Array.isArray(args) && args[1] === false),
        'subscription callback should not request universal object create/remove notices'
    );

    console.log('  PASS: callbacks receive deduped fill notices');
    console.log('\n=== All subscription tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
