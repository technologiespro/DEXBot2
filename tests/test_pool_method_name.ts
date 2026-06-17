#!/usr/bin/env node
const assert = require('assert');

/**
 * Regression test: verify consumer code dispatches
 * get_liquidity_pools_by_both_assets (the real method name)
 * rather than the old non-existent get_liquidity_pool_by_asset_ids.
 */
async function main() {
    let callCount = 0;
    let lastArgs: any[] = [];

    const mockClient = {
        db: {
            lookup_asset_symbols: async (symbols: string[]) =>
                symbols.map(s => ({ id: s === 'BTS' ? '1.3.0' : '1.3.100', precision: 4 })),
            get_assets: async (ids: string[]) =>
                ids.map(id => ({ id: String(id), precision: 4 })),
            get_liquidity_pools_by_both_assets: async (...args: any[]) => {
                callCount++;
                lastArgs = args;
                return [
                    { id: '1.19.1', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 100, balance_b: 200 },
                    { id: '1.19.42', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 1000000, balance_b: 2000000 },
                    { id: '1.19.99', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 500, balance_b: 300 },
                ];
            },
            get_objects: async () => [],
        }
    };

    const { derivePoolPrice } = require('../modules/order/utils/system');
    const result = await derivePoolPrice(mockClient, 'BTS', 'ASSET');

    assert.ok(callCount > 0, 'get_liquidity_pools_by_both_assets was called by derivePoolPrice');
    assert.strictEqual(lastArgs[0], '1.3.0', 'first arg is asset A id');
    assert.strictEqual(lastArgs[1], '1.3.100', 'second arg is asset B id');
    assert.strictEqual(lastArgs[2], undefined, 'no limit (fetch all pools to pick highest-funded)');
    assert.strictEqual(result, 2, 'price = floatB/floatA = 200/100 = 2');

    console.log('test_pool_method_name passed');
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });
