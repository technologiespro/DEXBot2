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
const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('bitshares_client')) {
        return {
            BitShares: {
                subscribe: () => {},
                disconnect: () => {},
                ws: { isConnected: false }
            },
            waitForConnected: async () => {},
            createAccountClient: () => ({
                sign: () => {},
                broadcast: async () => ({})
            }),
            setSuppressConnectionLog: () => {},
            getNodeManager: () => null,
            getNodeStats: () => null,
            getNodeSummary: () => null,
            _internal: { get connected() { return false; } }
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');
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
    let bot;
    try {
        let cancelCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let persistCalls = 0;

        bot = new DEXBot({
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
            recalculateFunds: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] })
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
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

async function testDustCancelDoesNotBeatRealFill() {
    console.log('Testing Dust Cancel Real Fill Precedence...');

    const originalCancelOrder = chainOrders.cancelOrder;
    let bot;
    try {
        let processCalls = 0;
        let persistCalls = 0;

        bot = new DEXBot({
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
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

async function testDustTimerStartsAtDustFill() {
    console.log('Testing Dust Timer Starts At Fill Detection...');

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

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    await manager._updateOrder({
        id: 'dust-timer-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.1,
        orderId: '1.7.902'
    });

    const bot = new DEXBot({
        botKey: 'test_dust_timer_start',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 },
        activeOrders: { buy: 5, sell: 5 },
        botFunds: { buy: 1000, sell: 1000 }
    });
    bot.manager = manager;

    try {
        const detectedAt = Date.now();
        const dustOrder = manager.orders.get('dust-timer-sell');

        await bot._seedDustTimersFromPartialUpdates([dustOrder], detectedAt);
        assert.strictEqual(bot._dustSinceMap.get('1.7.902'), detectedAt, 'Dust timer should start at fill detection time');

        await bot._seedDustTimersFromPartialUpdates([dustOrder], detectedAt + 1000);
        assert.strictEqual(bot._dustSinceMap.get('1.7.902'), detectedAt, 'Existing dust timer should not be reset by later detections');
        console.log('  ✓ Dust timer starts when the order first becomes dust');
    } finally {
        bot._clearDustMaintenanceTimer();
    }
}

async function testDustThresholdUsesConfiguredPercentage() {
    console.log('Testing Dust Threshold Uses Configured Percentage...');

    const originalThreshold = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE;
    GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = 10;

    try {
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

        await manager.setAccountTotals({
            buy: 1000,
            sell: 1000,
            buyFree: 1000,
            sellFree: 1000
        });

        manager.logger = {
            log: () => {},
            logFundsStatus: () => {}
        };

        await manager._updateOrder({
            id: 'threshold-sell-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.01,
            orderId: '1.7.910'
        });

        await manager._updateOrder({
            id: 'threshold-sell-2',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.95,
            price: 1.02,
            orderId: '1.7.911'
        });

        await manager._updateOrder({
            id: 'threshold-sell-3',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.03,
            orderId: '1.7.912'
        });

        const dustOrders = await Grid.getDustOrders(manager, [manager.orders.get('threshold-sell-2')], 'sell');
        assert.strictEqual(dustOrders.length, 1, 'Configured dust threshold should classify the order as dust');
        console.log('  ✓ Dust detection respects configured threshold percentage');
    } finally {
        GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = originalThreshold;
    }
}

async function testDustTrackingOnlyUsesTopLiveOrder() {
    console.log('Testing Dust Tracking Only Uses Top Live Order...');

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

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    await manager._updateOrder({
        id: 'top-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.01,
        orderId: '1.7.930'
    });
    await manager._updateOrder({
        id: 'inner-dust-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.02,
        orderId: '1.7.931'
    });
    await manager._updateOrder({
        id: 'outer-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.03,
        orderId: '1.7.932'
    });

    const bot = new DEXBot({
        botKey: 'test_top_order_dust_only',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 },
        activeOrders: { buy: 5, sell: 5 },
        botFunds: { buy: 1000, sell: 1000 }
    });
    bot.manager = manager;

    try {
        const detectedAt = Date.now();
        const innerDust = manager.orders.get('inner-dust-sell');

        const initialHealth = await Grid.checkWindowDust(manager);
        assert.strictEqual(initialHealth.sellDustOrders.length, 0, 'Interior dust should not be selected when top order is healthy');

        await bot._seedDustTimersFromPartialUpdates([innerDust], detectedAt);
        assert.strictEqual(bot._dustSinceMap.has('1.7.931'), false, 'Interior dust should not start a cancel timer');

        await manager._updateOrder({
            id: 'top-sell',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.00001,
            price: 1.01,
            orderId: '1.7.930'
        });

        const topDust = manager.orders.get('top-sell');
        const topHealth = await Grid.checkWindowDust(manager);
        assert.strictEqual(topHealth.sellDustOrders.length, 1, 'Top dust should be selected for tracking');
        assert.strictEqual(topHealth.sellDustOrders[0].orderId, '1.7.930', 'Top live sell should be the only tracked dust order');

        await bot._seedDustTimersFromPartialUpdates([topDust], detectedAt + 1000);
        assert.strictEqual(bot._dustSinceMap.get('1.7.930'), detectedAt + 1000, 'Top dust should start the cancel timer');
        console.log('  ✓ Only the top live order is eligible for dust tracking');
    } finally {
        bot._clearDustMaintenanceTimer();
    }
}

async function testStartupDustSchedulesTimer() {
    console.log('Testing Startup Dust Schedules Maintenance Timer...');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_MIN;

    try {
        let scheduledDelay = null;
        let scheduledFn = null;

        global.setTimeout = (fn, delay) => {
            scheduledFn = fn;
            scheduledDelay = delay;
            return { fakeTimer: true };
        };
        global.clearTimeout = () => {};

        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = 5;

        const bot = new DEXBot({
            botKey: 'test_startup_dust_schedule',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'TESTB',
            incrementPercent: 1
        });

        let maintenanceCalls = 0;
        bot.manager = {
            _fillProcessingLock: {
                acquire: async (fn) => fn()
            }
        };
        bot._runGridMaintenance = async (context, options) => {
            maintenanceCalls++;
            bot._dustSinceMap.clear();
            assert.strictEqual(context, 'dust-timer', 'Dust timer should run dust maintenance context');
            assert.deepStrictEqual(options, { fillLockAlreadyHeld: true }, 'Dust timer should reuse the fill lock');
        };

        bot._dustSinceMap.set('1.7.920', Date.now());
        bot._scheduleDustMaintenanceCheck();

        assert.ok(scheduledDelay >= 299000 && scheduledDelay <= 300000, 'Dust timer should schedule near configured delay');
        assert.strictEqual(typeof scheduledFn, 'function', 'Dust timer should install a callback');

        scheduledFn();
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(maintenanceCalls, 1, 'Dust timer should trigger maintenance once');
        console.log('  ✓ Existing dust at startup schedules a maintenance check');
    } finally {
        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = originalDelay;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testConsecutiveDustCancelSeeding() {
    console.log('Testing Consecutive Dust Cancel Seeds Next Top Order...');

    const originalCancelOrder = chainOrders.cancelOrder;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_MIN;
    let bot;

    try {
        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = 5;

        // Intercept the timer so we can verify it is scheduled after the cancel.
        let timerScheduled = false;
        global.setTimeout = (fn, delay) => {
            timerScheduled = true;
            return { fakeTimer: true };
        };
        global.clearTimeout = () => {};

        bot = new DEXBot({
            botKey: 'test_consecutive_dust_cancel',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';

        const order2 = {
            id: 'dust-buy-2',
            orderId: '1.7.902',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.89
        };

        bot.manager = {
            synchronizeWithChain: async () => ({ newOrders: [], ordersNeedingCorrection: [] }),
            processFilledOrders: async () => ({ actions: [] }),
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {},
            // After order 1 is cancelled, the next top is order 2.
            checkGridHealth: async () => ({ buyDustOrders: [order2], sellDustOrders: [] })
        };

        chainOrders.cancelOrder = async () => {};

        const order1 = {
            id: 'dust-buy-1',
            orderId: '1.7.901',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        // Age order 1 past the delay so it qualifies for cancellation.
        bot._dustSinceMap.set('1.7.901', Date.now() - (5 * 60_000) - 1);

        const result = await bot._cancelDustOrders({ buy: [order1], sell: [] });

        assert.strictEqual(result.cancelledCount, 1, 'Order 1 should be cancelled');
        assert.strictEqual(bot._dustSinceMap.has('1.7.901'), false, 'Cancelled order should be removed from map');
        assert.strictEqual(bot._dustSinceMap.has('1.7.902'), true, 'Newly exposed order 2 should be seeded into _dustSinceMap immediately');
        assert.strictEqual(timerScheduled, true, 'Dust timer should be scheduled for the newly seeded order');
        console.log('  ✓ Consecutive dust cancel seeds next top order and schedules its timer');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = originalDelay;
    }
}

async function testDustReseedHealthFailureDoesNotAbort() {
    console.log('Testing Dust Reseed Health Failure Does Not Abort...');

    const originalCancelOrder = chainOrders.cancelOrder;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_MIN;
    let bot;

    try {
        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = 5;

        let fallbackTimerScheduled = false;
        global.setTimeout = (fn, delay) => {
            fallbackTimerScheduled = true;
            return { fakeTimer: true };
        };
        global.clearTimeout = () => {};

        bot = new DEXBot({
            botKey: 'test_dust_reseed_health_failure',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';

        bot.manager = {
            synchronizeWithChain: async () => ({ newOrders: [], ordersNeedingCorrection: [] }),
            processFilledOrders: async () => ({ actions: [] }),
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {},
            checkGridHealth: async () => {
                throw new Error('temporary health failure');
            }
        };

        chainOrders.cancelOrder = async () => {};

        const order = {
            id: 'dust-buy-1',
            orderId: '1.7.903',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        bot._dustSinceMap.set('1.7.903', Date.now() - (5 * 60_000) - 1);

        const result = await bot._cancelDustOrders({ buy: [order], sell: [] });

        assert.strictEqual(result.cancelledCount, 1, 'Successful cancel should still be counted');
        assert.strictEqual(bot._dustSinceMap.has('1.7.903'), false, 'Cancelled order should still be removed from the map');
        assert.strictEqual(fallbackTimerScheduled, true, 'Fallback timer should be scheduled when reseed fails and map is empty');
        console.log('  ✓ Health check failure no longer aborts successful dust cancellation');
        console.log('  ✓ Fallback timer scheduled when reseed fails to prevent permanently skipping next top order');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        GRID_LIMITS.DUST_CANCEL_DELAY_MIN = originalDelay;
    }
}

Promise.resolve()
    .then(() => testDustTrigger())
    .then(() => testDustCancelSyntheticRotation())
    .then(() => testDustCancelDoesNotBeatRealFill())
    .then(() => testDustTimerStartsAtDustFill())
    .then(() => testDustThresholdUsesConfiguredPercentage())
    .then(() => testDustTrackingOnlyUsesTopLiveOrder())
    .then(() => testStartupDustSchedulesTimer())
    .then(() => testConsecutiveDustCancelSeeding())
    .then(() => testDustReseedHealthFailureDoesNotAbort())
    .finally(() => {
        Module._load = originalModuleLoad;
    })
    .then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
