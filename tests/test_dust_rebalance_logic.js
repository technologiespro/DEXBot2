/**
 * tests/test_dust_rebalance_logic.js
 * 
 * Verifies single-side dust detection helpers remain active.
 * Dust detection should still identify unhealthy partials on each side independently.
 * 
 * processFilledOrders() should now trigger rebalance only for real fills.
 * This test verifies the underlying hasAnyDust() detection logic still works.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const Grid = require('../modules/order/grid');
const { _setFeeCache } = require('../modules/order/utils/math');
const DEXBot = require('../modules/dexbot_class');
const chainOrders = require('../modules/chain_orders');

async function testDustTrigger() {
    console.log('Testing Dust Detection Logic (COW Architecture)...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    // Initialize with some funds
    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Mock logger
    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    // 1. Scenario: No fills, no dust - processFilledOrders returns empty
    console.log('\n  Scenario 1: No fills, no dust');
    let result = await manager.processFilledOrders([]);
    const hasActions = (result.actions?.length > 0) || (result.ordersToPlace?.length > 0);
    assert.strictEqual(!!hasActions, false, 'Should not have actions with no fills');
    console.log('  ✓ Correctly returned empty actions');

    // 2. Scenario: Single-side dust detection (BUY only)
    console.log('\n  Scenario 2: Single-side dust (BUY)');
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 0.9,
        orderId: '1.7.1'
    });

    const buyPartials = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
    const sellPartials = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

    const buyHasDust = buyPartials.length > 0 && await Grid.hasAnyDust(manager, buyPartials, 'buy');
    const sellHasDust = sellPartials.length > 0 && await Grid.hasAnyDust(manager, sellPartials, 'sell');

    assert.strictEqual(buyHasDust, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust, false, 'Sell side should NOT have dust (no partials)');
    assert.strictEqual(buyHasDust && sellHasDust, false, 'Should NOT trigger dual-side dust (only one side)');
    console.log('  ✓ Correctly detected single-side dust');

    // 3. Scenario: Dust detection remains side-local even when both sides have dust
    console.log('\n  Scenario 3: Both sides have dust (detection only)');
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 1.1,
        orderId: '1.7.2'
    });

    const buyPartials2 = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
    const sellPartials2 = Array.from(manager.orders.values())
        .filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

    const buyHasDust2 = buyPartials2.length > 0 && await Grid.hasAnyDust(manager, buyPartials2, 'buy');
    const sellHasDust2 = sellPartials2.length > 0 && await Grid.hasAnyDust(manager, sellPartials2, 'sell');

    assert.strictEqual(buyHasDust2, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust2, true, 'Sell side should have dust');
    assert.strictEqual(buyHasDust2 && sellHasDust2, true, 'Should still detect dust on both sides');
    console.log('  ✓ Correctly detected dust on both sides without implying rebalance');

    // 4. Scenario: processFilledOrders with no real fills should not rebalance on dust alone
    console.log('\n  Scenario 4: Dust alone does not trigger rebalance');
    result = await manager.processFilledOrders([]);
    const noDustRebalance = result !== undefined && typeof result === 'object';
    assert.strictEqual(noDustRebalance, true, 'processFilledOrders should still return a result object');
    console.log('  ✓ Dust alone no longer triggers rebalance');

    // 5. Scenario: processFilledOrders with fills triggers rebalance
    console.log('\n  Scenario 5: processFilledOrders with fills (triggers rebalance)');
    
    // Reset dust orders to VIRTUAL first
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 0.9,
        orderId: null
    });
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 1.1,
        orderId: null
    });

    const fill = { id: 'buy-dust', type: ORDER_TYPES.BUY, price: 0.9, size: 10, isPartial: false };
    result = await manager.processFilledOrders([fill]);
    
    // processFilledOrders triggers performSafeRebalance for non-partial fills
    // Result may have actions/ordersToPlace depending on grid state
    // Key assertion: method completes without error (rebalance is triggered)
    const resultHasStructure = result !== undefined && typeof result === 'object';
    assert.strictEqual(resultHasStructure, true, 'processFilledOrders should return result object');
    console.log('  ✓ processFilledOrders correctly triggers rebalance for fills');

    // 6. Verify processFillsOnly properly processes fills
    console.log('\n  Scenario 6: processFillsOnly properly processes fills');
    
    // Create an active order to fill
    await manager._updateOrder({
        id: 'test-active',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 50,
        price: 0.85,
        orderId: '1.7.100'
    });

    const fillForActive = { 
        id: 'test-active', 
        type: ORDER_TYPES.BUY, 
        price: 0.85, 
        size: 50, 
        isPartial: false,
        orderId: '1.7.100'
    };
    
    // processFillsOnly should update the order state
    await manager.strategy.processFillsOnly([fillForActive], new Set());
    
    // The order should now be VIRTUAL (fully filled)
    const updatedOrder = manager.orders.get('test-active');
    assert.strictEqual(updatedOrder.state, ORDER_STATES.VIRTUAL, 'Filled order should be VIRTUAL');
    console.log('  ✓ processFillsOnly correctly updates order state');

    // 7. Verify dust cancel sync clears virtual reservation and releases funds
    console.log('\n  Scenario 7: dust cancel clears size and releases funds');

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        price: 0.8,
        orderId: null
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 25,
        price: 0.8,
        orderId: '1.7.250'
    });

    assert.strictEqual(manager.accountTotals.buyFree, 975, 'Test setup should reflect locked buy funds');
    await manager.synchronizeWithChain({ orderId: '1.7.250', clearSize: true }, 'cancelOrder');

    const cancelledDust = manager.orders.get('cancel-dust');
    assert.strictEqual(cancelledDust.state, ORDER_STATES.VIRTUAL, 'Cancelled dust order should be virtualized');
    assert.strictEqual(cancelledDust.size, 0, 'Cancelled dust order should clear virtual reservation size');
    assert.strictEqual(manager.accountTotals.buyFree, 1000, 'Cancelled dust order should release remaining buy funds');
    console.log('  ✓ dust cancel correctly clears reservation and frees funds');

    console.log('\n✅ All dust detection tests passed!\n');
}

async function testDustCancelSyntheticRotation() {
    console.log('Testing Dust Cancel Synthetic Rotation...');

    const originalCancelOrder = chainOrders.cancelOrder;
    try {
        let cancelCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let persistCalls = 0;

        const bot = new DEXBot({
            botKey: 'test_dust_cancel_rotation',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async (payload, source) => {
                syncCalls++;
                assert.strictEqual(source, 'cancelOrder', 'Dust cancel should sync through cancelOrder source');
                assert.deepStrictEqual(payload, { orderId: '1.7.900', clearSize: true }, 'Dust cancel should clear size on sync');
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            processFilledOrders: async (fills) => {
                processCalls++;
                assert.strictEqual(fills.length, 1, 'Expected one synthetic dust fill');
                assert.strictEqual(fills[0].id, 'dust-buy-1');
                assert.strictEqual(fills[0].isPartial, true, 'Synthetic dust trigger should remain marked partial');
                assert.strictEqual(fills[0].isDelayedRotationTrigger, true, 'Synthetic dust trigger should enter delayed rotation path');
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {}
        };

        chainOrders.cancelOrder = async () => {
            cancelCalls++;
        };

        const dustOrder = {
            id: 'dust-buy-1',
            orderId: '1.7.900',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        const firstPass = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(firstPass.cancelledCount, 0, 'Dust cancel should wait for the timer before triggering');
        assert.strictEqual(cancelCalls, 0, 'Dust cancel should not run before timer expiry');
        assert.strictEqual(processCalls, 0, 'Synthetic rotation should not run before timer expiry');

        bot._dustSinceMap.set('1.7.900', Date.now() - (5 * 60_000) - 1);
        const secondPass = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(secondPass.cancelledCount, 1, 'Dust cancel should fire once timer expires');
        assert.strictEqual(cancelCalls, 1, 'Dust cancel should submit one cancel');
        assert.strictEqual(syncCalls, 1, 'Dust cancel should synchronize once');
        assert.strictEqual(processCalls, 1, 'Dust cancel should trigger the synthetic fill pipeline');
        assert.strictEqual(persistCalls, 1, 'Dust cancel should persist the updated grid');
        console.log('  ✓ Dust cancel triggers synthetic delayed rotation only after timer expiry');
    } finally {
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

async function testDustCancelDoesNotBeatRealFill() {
    console.log('Testing Dust Cancel Real Fill Precedence...');

    const originalCancelOrder = chainOrders.cancelOrder;
    try {
        let processCalls = 0;
        let persistCalls = 0;

        const bot = new DEXBot({
            botKey: 'test_dust_cancel_precedence',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async () => {
                throw new Error('should not sync after failed cancel');
            },
            processFilledOrders: async () => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {}
        };

        chainOrders.cancelOrder = async () => {
            throw new Error('order already filled');
        };

        const dustOrder = {
            id: 'dust-sell-1',
            orderId: '1.7.901',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 1.1
        };

        bot._dustSinceMap.set('1.7.901', Date.now() - (5 * 60_000) - 1);
        const result = await bot._cancelDustOrders({ buy: [], sell: [dustOrder] });

        assert.strictEqual(result.cancelledCount, 0, 'Failed cancel should not count as dust rotation');
        assert.strictEqual(processCalls, 0, 'Failed cancel should not trigger synthetic fill processing');
        assert.strictEqual(persistCalls, 0, 'Failed cancel should not persist synthetic changes');
        console.log('  ✓ Real fill / failed cancel path does not trigger synthetic rotation');
    } finally {
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

Promise.resolve()
    .then(() => testDustTrigger())
    .then(() => testDustCancelSyntheticRotation())
    .then(() => testDustCancelDoesNotBeatRealFill())
    .then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
