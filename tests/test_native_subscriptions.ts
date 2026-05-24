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
                    if (stop === '1.11.499') {
                        return [{ id: '1.11.500', block_num: 11, trx_id: 2, op: [4, { order_id: '1.7.2' }] }];
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

        assert.strictEqual(delivered.length, 1, 'matching account should receive one delivery');
        assert.strictEqual(delivered[0][0], 'alice');
        assert.strictEqual(delivered[0][1].length, 1);
        assert.strictEqual(delivered[0][1][0].id, '1.11.500');
        assert.strictEqual(delivered[0][1][0].block_num, 11, 'fill payload should expose block_num');
        assert.strictEqual(delivered[0][1][0].trx_id, 2, 'fill payload should expose trx_id');
        assert.strictEqual(delivered[0][1][0].block, undefined, 'legacy block alias should not leak through');
        assert.strictEqual(delivered[0][1][0].trx, undefined, 'legacy trx alias should not leak through');
        assert.deepStrictEqual(
            historyCalls[0],
            ['1.2.100', 4, '1.11.0', '1.11.0', 1],
            'subscription bootstrap should prime from the latest delivered fill id'
        );
        const aliceNoticeHistoryCall = historyCalls.find(([accountId, , , , limit]) => accountId === '1.2.100' && limit === 100);
        assert.deepStrictEqual(
            aliceNoticeHistoryCall,
            ['1.2.100', 4, '1.11.0', '1.11.499', 100],
            'notice processing should fetch only fills newer than the primed cursor'
        );
        assert.ok(dbCalls.some(([method]) => method === 'set_subscribe_callback'), 'subscription RPC should be registered');
        assert.strictEqual(
            dbCalls.some(([method, account, subscribe]) => method === 'get_full_accounts' && account === 'alice' && subscribe === true),
            true,
            'subscription setup should subscribe the account on-chain'
        );
    }

    console.log(' - Testing account/statistics notices stay account-scoped...');
    {
        let noticeHandler = null;
        const historyAccounts = [];
        const accountNoticeDelivered = [];

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
                getAccountHistoryOperations: async (accountId, _opType, _start, stop) => {
                    historyAccounts.push(accountId);
                    if (accountId !== '1.2.100') return [];
                    if (stop === '1.11.0') {
                        return [{ id: '1.11.650', block_num: 9, trx_id: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.650') {
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

        await noticeHandler([1, [{ id: '2.6.100' }]]);
        assert.strictEqual(accountNoticeDelivered.length, 1, 'account/statistics notices should trigger history fill scan');
        assert.strictEqual(accountNoticeDelivered[0][0].id, '1.11.700');

        accountNoticeDelivered.length = 0;
        historyAccounts.length = 0;
        await noticeHandler([1, [{ id: '2.6.100' }]]);
        assert.strictEqual(accountNoticeDelivered.length, 0, 'duplicate alice statistics fill should stay deduped by cursor');
        assert.deepStrictEqual(historyAccounts, ['1.2.100'], 'alice statistics notices should not wake bob history scans');
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

        await noticeHandler([1, [{ id: '2.5.2000', owner: '1.2.100' }]]);

        assert.strictEqual(delivered.length, 1, 'burst notice should still emit a single delivery batch');
        assert.strictEqual(delivered[0].length, 105, 'pagination should recover every new fill beyond the first 100');
        assert.strictEqual(delivered[0][0].id, '1.11.901', 'fills should be delivered oldest-first for deterministic downstream processing');
        assert.strictEqual(delivered[0][104].id, '1.11.1005');
        assert.deepStrictEqual(
            historyCalls.slice(1),
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

        await noticeHandler([1, [{ id: '2.5.1001', owner: '1.2.100' }]]);
        await noticeHandler([1, [{ id: '2.5.1002', owner: '1.2.100' }]]);
        await noticeHandler([1, [{ id: '2.5.1003', owner: '1.2.100' }]]);

        assert.strictEqual(callbackErrors, 1, 'callback failure should be reported to onError');
        assert.strictEqual(retryDeliveries, 2, 'fill should retry once after failed callback and dedupe after success');
        assert.deepStrictEqual(
            retryHistoryCalls,
            [
                ['1.2.100', '1.11.0', 1],
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
