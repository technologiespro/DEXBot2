const assert = require('assert');

const { extractBatchOperationResults } = require('../modules/order/utils/order');

const ORDER_ID = '1.7.12345';

function run() {
    console.log('Running extractBatchOperationResults tests...');

    // ---- Successful extraction paths ----

    // 1. Result with operation_results at top level (signing_client.js proxy broadcast)
    {
        const result = { operation_results: [[1, ORDER_ID]], ref_block_num: 100 };
        const ops = extractBatchOperationResults(result);
        assert(Array.isArray(ops) && ops.length === 1, 'Path 1: should extract top-level operation_results');
        assert.strictEqual(ops[0][1], ORDER_ID, 'Path 1: should have correct order ID');
        console.log('  ✓ Path 1: operation_results at top level');
    }

    // 2. Result with raw.operation_results (executeViaDaemonToken wrapper + daemon response)
    {
        const result = {
            success: true,
            raw: { ref_block_num: 100, operation_results: [[1, ORDER_ID]] },
            operation_results: [[1, ORDER_ID]]
        };
        const ops = extractBatchOperationResults(result);
        assert(Array.isArray(ops) && ops.length === 1, 'Path 2: should extract from top-level operation_results');
        assert.strictEqual(ops[0][1], ORDER_ID, 'Path 2: should have correct order ID');
        console.log('  ✓ Path 2: daemon-mediated with top-level operation_results');
    }

    // 2b. Result with raw.operation_results but no top-level (simulate executeViaDaemonToken without top-level extraction)
    {
        const result = {
            success: true,
            raw: { ref_block_num: 100, operation_results: [[1, ORDER_ID]] }
            // no top-level operation_results
        };
        const ops = extractBatchOperationResults(result);
        assert(Array.isArray(ops) && ops.length === 1, 'Path 2b: should fallback to raw.operation_results');
        assert.strictEqual(ops[0][1], ORDER_ID, 'Path 2b: should have correct order ID');
        console.log('  ✓ Path 2b: daemon-mediated with raw.operation_results fallback');
    }

    // 3. Transaction confirmation from chain: trx.operation_results nested in raw
    {
        const result = {
            success: true,
            raw: {
                id: 'abc123', block_num: 123, trx_num: 0,
                trx: { operation_results: [[1, ORDER_ID]] }
            }
        };
        const ops = extractBatchOperationResults(result);
        assert(Array.isArray(ops) && ops.length === 1, 'Path 3: should extract from raw.trx.operation_results');
        assert.strictEqual(ops[0][1], ORDER_ID, 'Path 3: should have correct order ID');
        console.log('  ✓ Path 3: raw.trx.operation_results fallback');
    }

    // 4. Unsupported direct trx.operation_results at result level
    {
        const result = {
            trx: { operation_results: [[1, ORDER_ID]] }
        };
        // This shape is NOT directly handled by extractBatchOperationResults
        // It's handled by chain_orders.js extractBatch and daemon's executeOperationsWithClient
        // So it should return null
        const ops = extractBatchOperationResults(result);
        assert.strictEqual(ops, null, 'Path 4: direct trx shape should return null (no top-level or raw)');
        console.log('  ✓ Path 4: direct trx.operation_results correctly returns null');
    }

    // 5. Array result with nested trx
    {
        const result = [{ trx: { operation_results: [[1, ORDER_ID]] } }];
        const ops = extractBatchOperationResults(result);
        assert(Array.isArray(ops) && ops.length === 1, 'Path 5: should extract from array[0].trx.operation_results');
        assert.strictEqual(ops[0][1], ORDER_ID, 'Path 5: should have correct order ID');
        console.log('  ✓ Path 5: array result with trx.operation_results');
    }

    // ---- Failure/edge cases ----

    // 6. Null result
    {
        const ops = extractBatchOperationResults(null);
        assert.strictEqual(ops, null, 'Path 6: null result should return null');
        console.log('  ✓ Path 6: null result returns null');
    }

    // 7. Undefined result
    {
        const ops = extractBatchOperationResults(undefined);
        assert.strictEqual(ops, null, 'Path 7: undefined result should return null');
        console.log('  ✓ Path 7: undefined result returns null');
    }

    // 8. Empty object
    {
        const ops = extractBatchOperationResults({});
        assert.strictEqual(ops, null, 'Path 8: empty object should return null');
        console.log('  ✓ Path 8: empty object returns null');
    }

    // === CRITICAL BUG CASE ===
    // 9. Daemon response with EMPTY operation_results array
    // This simulates the case where broadcast_transaction (async void version) returns
    // no useful data, and both the signing_client and daemon produce empty arrays.
    {
        const result = {
            success: true,
            raw: null,
            operation_results: []
        };
        const ops = extractBatchOperationResults(result);
        // BUG: previously returned [] (truthy), which caused || [] to short-circuit
        // and then operationResults[0][1] threw or produced undefined
        assert.strictEqual(ops, null,
            'Path 9: empty operation_results should return null, NOT an empty array');
        console.log('  ✓ Path 9: empty operation_results correctly returns null [BUG FIX]');
    }

    // 10. Signing client broadcast with empty opResults (node returned void)
    // When broadcast_transaction returns void, signing_client wraps: { operation_results: [] }
    {
        const result = { operation_results: [] };
        const ops = extractBatchOperationResults(result);
        assert.strictEqual(ops, null,
            'Path 10: signing client empty opResults should return null');
        console.log('  ✓ Path 10: signing client empty operation_results returns null [BUG FIX]');
    }

    // 11. Raw with empty trx.operation_results
    {
        const result = {
            success: true,
            raw: { id: 'abc', block_num: 1, trx_num: 0, trx: { operation_results: [] } }
        };
        const ops = extractBatchOperationResults(result);
        assert.strictEqual(ops, null,
            'Path 11: raw.trx with empty operation_results should return null');
        console.log('  ✓ Path 11: empty trx.operation_results returns null');
    }

    // 12. Array result with empty trx.operation_results
    {
        const result = [{ trx: { operation_results: [] } }];
        const ops = extractBatchOperationResults(result);
        assert.strictEqual(ops, null,
            'Path 12: array result with empty operation_results should return null');
        console.log('  ✓ Path 12: array result with empty trx.operation_results returns null');
    }

    // ---- Caller integration tests ----

    // 13. Simulate _createOrderFromGrid caller with normal result
    {
        const result = { success: true, raw: null, operation_results: [[1, ORDER_ID]] };
        const operationResults = extractBatchOperationResults(result) || [];
        const chainOrderId = operationResults[0] && operationResults[0][1];
        assert.strictEqual(chainOrderId, ORDER_ID, 'Path 13: caller should get correct chainOrderId');
        console.log('  ✓ Path 13: _createOrderFromGrid caller normal path works');
    }

    // 14. Simulate _createOrderFromGrid caller with BUG CASE (empty operations)
    {
        const result = { success: true, raw: null, operation_results: [] };
        const operationResults = extractBatchOperationResults(result) || [];
        const chainOrderId = operationResults[0] && operationResults[0][1];
        assert.strictEqual(chainOrderId, undefined,
            'Path 14: caller should get undefined chainOrderId for empty results');
        assert(Array.isArray(operationResults) && operationResults.length === 0,
            'Path 14: fallback should produce empty array');
        console.log('  ✓ Path 14: _createOrderFromGrid caller correctly handles empty results');
    }

    // 15. Simulate _extractOperationResults (dexbot_class.js) with BUG CASE
    {
        const result = { success: true, raw: null, operation_results: [] };
        const extracted = extractBatchOperationResults(result);
        // _extractOperationResults checks: if (Array.isArray(extracted)) return extracted;
        // With the fix, extracted is null, so it goes to the warning path
        const isArray = Array.isArray(extracted);
        assert.strictEqual(isArray, false, 'Path 15: extracted should not be an array for empty results');
        assert.strictEqual(extracted, null, 'Path 15: extracted should be null for empty results');
        console.log('  ✓ Path 15: _extractOperationResults correctly gets null for empty results');
    }

    console.log('\nAll extractBatchOperationResults tests passed ✓');
}

try {
    run();
} catch (err) {
    console.error('\n✗ extractBatchOperationResults tests failed');
    console.error(err);
    process.exit(1);
}
