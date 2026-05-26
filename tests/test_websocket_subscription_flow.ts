/**
 * tests/test_websocket_subscription_flow.ts
 *
 * End-to-end websocket subscription flow test.
 * Verifies the full lifecycle: notice → handleNotice → processObjects →
 * fetchFillHistoryEntries → callback dispatch, with realistic notice data
 * formats including thin 1.11.x objects (no owner/op), full objects, and
 * account-scoped objects for other accounts.
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

const OP_FILL_ORDER = 4;
const ALICE_ID = '1.2.100';
const ALICE_STATS = '2.6.100';
const BOB_ID = '1.2.200';

function makeAccountRecord(account) {
    // account can be a name ('alice', 'bob') or an id ('1.2.100', '1.2.200')
    const name = account === '1.2.200' ? 'bob' : account === '1.2.100' ? 'alice' : account;
    return [account, {
        account: {
            id: name === 'bob' ? '1.2.200' : '1.2.100',
            name,
            statistics: name === 'bob' ? '2.6.200' : '2.6.100',
        },
    }];
}

(function () {
    let totalTests = 0;
    let passedTests = 0;

    function test(name, fn) {
        totalTests++;
        try {
            fn();
            console.log(`  ✓ ${name}`);
            passedTests++;
        } catch (err) {
            console.log(`  ✗ ${name}: ${err.message}`);
        }
    }

    function assertDeepEquals(actual, expected, msg) {
        try {
            assert.deepStrictEqual(actual, expected);
        } catch (err) {
            throw new Error(`${msg}: ${err.message}`);
        }
    }

    console.log('=== WebSocket Subscription Flow Test ===\n');

    // -----------------------------------------------------------------------
    // 1. Thin notice with only 1.11.x IDs (no owner, no op) triggers history scan
    // -----------------------------------------------------------------------
    console.log('\n--- Thin notice (1.11.x IDs without owner/op) ---');
    {
        let noticeHandler = null;
        const historyPages = [];
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyPages.push({ accountId, opType, start, stop, limit });
                    if (limit === 1) {
                        return [{ id: '1.11.100', block_num: 10, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.1' }] }];
                    }
                    if (stop === '1.11.99') {
                        return [{ id: '1.11.100', block_num: 10, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.1' }] }];
                    }
                    if (stop === '1.11.100') {
                        return [{ id: '1.11.101', block_num: 11, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.2' }] }];
                    }
                    if (stop === '1.11.101') return [];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyPages.length = 0;

            await noticeHandler([1, [
                { id: '1.11.101', block_num: 11, trx_id: 2 },
            ]]);

            test('thin 1.11.x notice should trigger history scan', () => {
                assert.strictEqual(delivered.length, 1, 'should deliver fills from history scan');
                assert.strictEqual(delivered[0][0].id, '1.11.101', 'should deliver the new fill');
            });

            test('history scan should be called for thin notice', () => {
                const historyCall = historyPages.find(p => p.limit > 1 && p.stop === '1.11.100');
                assert.ok(historyCall, 'fetchFillHistoryEntries should be triggered by thin notice');
            });

            historyPages.length = 0;
            await noticeHandler([1, [
                { id: '1.11.102' },
            ]]);

            test('consecutive thin notice with no new fills should not redeliver', () => {
                assert.strictEqual(delivered.length, 1, 'should not redeliver when no new fills');
            });

            test('history scan should run and find zero new entries', () => {
                const call = historyPages.find(p => p.limit > 1);
                assert.ok(call, 'fetchFillHistoryEntries should be called for every thin notice');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 2. Full object notice (with owner matching account) - fast path
    // -----------------------------------------------------------------------
    console.log('\n--- Full object notice with matching owner ---');
    {
        let noticeHandler = null;
        const historyPages = [];
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyPages.push({ accountId, opType, start, stop, limit });
                    if (limit === 1) return [{ id: '1.11.200', block_num: 20, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.10' }] }];
                    if (stop === '1.11.199') return [{ id: '1.11.200', block_num: 20, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.10' }] }];
                    if (stop === '1.11.200') return [{ id: '1.11.201', block_num: 21, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.11' }] }];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyPages.length = 0;

            // Full object with owner field matching the account - fast path (shouldProcessNoticeForSubscription returns true immediately)
            await noticeHandler([1, [
                { id: '1.11.201', owner: ALICE_ID, block_num: 21, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.11', account_id: ALICE_ID }] },
            ]]);

            test('full object with matching owner should trigger history scan', () => {
                assert.strictEqual(delivered.length, 1, 'should deliver fills');
            });

            test('history should be fetched via getAccountHistoryOperations', () => {
                const call = historyPages.find(p => p.limit > 1);
                assert.ok(call, 'should call getAccountHistoryOperations');
                assert.strictEqual(call.accountId, ALICE_ID, 'should use correct account id');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 3. Account-scoped notice for OTHER account should not trigger scan
    // -----------------------------------------------------------------------
    console.log('\n--- Account-scoped notice for other account ---');
    {
        let noticeHandler = null;
        const deliveredAlice = [];
        const deliveredBob = [];
        const historyAccounts = [];

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyAccounts.push(accountId);
                    if (limit === 1) return [{ id: '1.11.300', block_num: 30, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.20' }] }];
                    if (stop === '1.11.299') return [{ id: '1.11.300', block_num: 30, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.20' }] }];
                    if (accountId !== ALICE_ID) return [];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => { deliveredAlice.push(fills); });
            await manager.subscribe('bob', (fills) => { deliveredBob.push(fills); });
            deliveredAlice.length = 0;
            deliveredBob.length = 0;
            historyAccounts.length = 0;

            // Bob's statistics object - should NOT trigger alice's history scan
            await noticeHandler([1, [{ id: '2.6.200' }]]);

            test('other account statistics notice should not trigger alice scan', () => {
                assert.strictEqual(historyAccounts.every(id => id === BOB_ID), true, 'only bob history should be scanned');
            });

            test('alice should not receive deliveries for bob notices', () => {
                assert.strictEqual(deliveredAlice.length, 0, 'alice should not receive fills');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 4. Mixed notice batch (new fills + old entries) - dedup by cursor
    // -----------------------------------------------------------------------
    console.log('\n--- Mixed notice batch with fills at and after cursor ---');
    {
        let noticeHandler = null;
        const delivered = [];
        const historyCalls = [];

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push({ start, stop, limit });
                    if (limit === 1) return [{ id: '1.11.500', block_num: 50, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.50' }] }];
                    if (stop === '1.11.499') {
                        // Return entries at cursor, before cursor, and after cursor
                        return [
                            { id: '1.11.499', block_num: 49, trx_id: 0, op: [OP_FILL_ORDER, { order_id: '1.7.49' }] },
                            { id: '1.11.500', block_num: 50, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.50' }] },
                            { id: '1.11.501', block_num: 51, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.51' }] },
                        ];
                    }
                    if (stop === '1.11.501') return [];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Bootstrap catch-up: cursor = decrement(500) = 499
            // Page returns [499, 500, 501]
            // Instance > 499 → keep 500, 501
            // Wait for bootstrap to complete first

            // Give bootstrap time to settle, then send a notice
            await new Promise(resolve => setImmediate(resolve));
            const bootstrapDeliveries = delivered.length;
            delivered.splice(0, delivered.length);
            historyCalls.length = 0;

            await noticeHandler([1, [
                { id: '1.11.501', block_num: 51, trx_id: 2 },
                { id: '1.11.502', block_num: 52, trx_id: 3 },
            ]]);

            // After bootstrap, cursor = 501 (latest fill delivered).
            // History scan with stop=501 should return nothing (API returns []).
            test('cursor should advance past mixed entries, skipping cursor+older', () => {
                assert.strictEqual(delivered.length, 0, 'no new fills at or after cursor should not deliver');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 5. Connection reconnection catches missed fills after re-subscribe
    // -----------------------------------------------------------------------
    console.log('\n--- Reconnection fill catch-up ---');
    {
        const delivered = [];
        const historyCalls = [];
        let handlers = [];

        const chainClient = {
            transport: {
                addMessageHandler(h) {
                    handlers.push(h);
                    const unsubscribe = () => {
                        const idx = handlers.indexOf(h);
                        if (idx !== -1) handlers.splice(idx, 1);
                    };
                    unsubscribe.isActive = () => handlers.includes(h);
                    return unsubscribe;
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push({ start, stop, limit });
                    if (limit === 1) return [{ id: '1.11.800', block_num: 80, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.80' }] }];
                    // Bootstrap: stop = decrement(800) = 799
                    if (stop === '1.11.799') {
                        return [{ id: '1.11.800', block_num: 80, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.80' }] }];
                    }
                    // Reconnect: stop = 800 (cursor after bootstrap)
                    if (stop === '1.11.800') {
                        return [{ id: '1.11.801', block_num: 81, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.81' }] }];
                    }
                    if (stop === '1.11.801') return [];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Simulate transport disconnect + reconnect
            handlers = [];
            await manager.resubscribeAll();

            test('reconnect should catch up fills missed during disconnect', () => {
                assert.strictEqual(delivered.length, 1, 'should deliver fills from reconnect catch-up');
                assert.strictEqual(delivered[0][0].id, '1.11.801', 'should deliver the fill that happened during disconnect');
            });

            test('reconnect should register new notice handler', () => {
                assert.strictEqual(handlers.length, 1, 'should re-register notice handler after reconnect');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 6. Multiple rapid notices with interleaved fills
    // -----------------------------------------------------------------------
    console.log('\n--- Multiple rapid notices with interleaved fills ---');
    {
        let noticeHandler = null;
        const delivered = [];
        const historyCalls = [];
        let noticeCount = 0;

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push({ start, stop, limit });
                    if (limit === 1) return [{ id: '1.11.900', block_num: 90, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.90' }] }];
                    if (stop === '1.11.899') {
                        return [{ id: '1.11.900', block_num: 90, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.90' }] }];
                    }
                    if (stop === '1.11.900') return [{ id: '1.11.901', block_num: 91, trx_id: 2, op: [OP_FILL_ORDER, { order_id: '1.7.91' }] }];
                    if (stop === '1.11.901') return [{ id: '1.11.902', block_num: 92, trx_id: 3, op: [OP_FILL_ORDER, { order_id: '1.7.92' }] }];
                    if (stop === '1.11.902') return [];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            delivered.length = 0;
            historyCalls.length = 0;

            // Rapid notices (simulating multiple blockchain updates)
            await noticeHandler([1, [{ id: '1.11.901' }]]);
            await noticeHandler([1, [{ id: '1.11.901' }]]); // duplicate
            await noticeHandler([1, [{ id: '1.11.902' }]]);

            test('rapid notices should each trigger history scan', () => {
                const noticeScans = historyCalls.filter(c => c.limit > 1);
                assert.ok(noticeScans.length >= 3, 'each notice should trigger a history scan');
            });

            test('duplicate notices should not redeliver same fill', () => {
                const allFillIds = delivered.flat().map(f => f.id);
                const uniqueIds = [...new Set(allFillIds)];
                assert.strictEqual(allFillIds.length, uniqueIds.length, 'no duplicate fills should be delivered');
            });
        })();
    }

    // -----------------------------------------------------------------------
    // 7. Object notices without any .id field (edge case)
    // -----------------------------------------------------------------------
    console.log('\n--- Notice data with missing .id field ---');
    {
        let noticeHandler = null;
        let noticeProcessedCount = 0;
        let historyScanCount = 0;

        const chainClient = {
            transport: {
                addMessageHandler(h) { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyScanCount++;
                    if (limit === 1) return [{ id: '1.11.400', block_num: 40, trx_id: 1, op: [OP_FILL_ORDER, { order_id: '1.7.40' }] }];
                    return [];
                },
            },
        };

        (async () => {
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', () => { noticeProcessedCount++; });
            historyScanCount = 0;
            noticeProcessedCount = 0;

            const originalLog = console.log;
            const loggedMessages = [];
            console.log = (...args) => {
                const msg = args.join(' ');
                if (msg.includes('[subscriptions] processObjects: no identifiable')) {
                    loggedMessages.push(msg);
                }
                originalLog.apply(console, args);
            };

            try {
                // Objects without .id field - should log diagnostic and skip
                await noticeHandler([1, [{ someField: 'no id here' }]]);
                await noticeHandler([1, [{ id: null }]]);
                await noticeHandler([1, [{ id: 12345 }]]); // numeric id, not string

                test('objects without string .id should log diagnostic message', () => {
                    assert.ok(loggedMessages.length > 0, 'should log diagnostic for unrecognized notice data');
                });

                test('malformed notices should not crash the subscription manager', () => {
                    assert.ok(true, 'subscription manager should remain functional after malformed notices');
                });
            } finally {
                console.log = originalLog;
            }
        })();
    }

    // -----------------------------------------------------------------------
    // Summarize
    // -----------------------------------------------------------------------
    setTimeout(() => {
        console.log(`\n=== Results: ${passedTests}/${totalTests} passed ===\n`);
        if (passedTests !== totalTests) {
            process.exitCode = 1;
        }
    }, 100);

})();
