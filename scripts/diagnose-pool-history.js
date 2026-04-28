#!/usr/bin/env node
'use strict';

/**
 * Diagnostic: Inspect raw BitShares pool history API responses for pool 1.19.133.
 *
 * Usage: node scripts/diagnose-pool-history.js [--pool <id>] [--limit <n>]
 */

const { BitShares, waitForConnected } = require('../modules/bitshares_client');

const POOL_ID = process.argv.includes('--pool')
    ? process.argv[process.argv.indexOf('--pool') + 1]
    : '1.19.133';

const LIMIT = process.argv.includes('--limit')
    ? Number(process.argv[process.argv.indexOf('--limit') + 1])
    : 10;

const LP_OP_TYPE = 63;

function fmt(obj) {
    try { return JSON.stringify(obj); } catch (_) { return String(obj); }
}

function inspectRow(row, index) {
    if (!row) {
        console.log(`  [${index}] NULL/undefined row`);
        return;
    }
    console.log(`\n  [${index}] ──────────────────────────────────────`);
    console.log(`    sequence: ${row.sequence}`);
    console.log(`    time:     ${row.time}`);
    console.log(`    op_type:  ${row.op?.op?.[0] || row.op_type || 'n/a'}`);

    if (Array.isArray(row.op?.op)) {
        const opPayload = row.op.op[1];
        console.log(`    op.payload: ${fmt(opPayload)}`);
    } else if (row.op?.op) {
        console.log(`    op.op format: ${typeof row.op.op} => ${fmt(row.op.op)}`);
    } else {
        console.log('    op.op:  MISSING');
    }

    if (Array.isArray(row.op?.result)) {
        const resultPayload = row.op.result[1];
        console.log(`    op.result: ${fmt(resultPayload)}`);
    } else if (row.op?.result) {
        console.log(`    op.result format: ${typeof row.op.result} => ${fmt(row.op.result)}`);
    } else {
        console.log('    op.result: MISSING');
    }

    // Full row dump (compact)
    console.log(`    FULL: ${fmt(row).slice(0, 500)}`);
}

async function main() {
    console.log('══════════════════════════════════════════════');
    console.log(` Pool History Diagnostic — pool ${POOL_ID}`);
    console.log(` Limit: ${LIMIT} rows per call`);
    console.log('══════════════════════════════════════════════');

    const start = Date.now();
    console.log('\nConnecting to BitShares...');
    await waitForConnected(30000);
    console.log(`Connected (${Date.now() - start}ms)`);

    // ── Test 1: get_liquidity_pool_history (with op_type filter) ─────
    console.log(`\n\n═══ TEST 1: get_liquidity_pool_history(poolId, null, null, ${LIMIT}, 63) ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, LIMIT, LP_OP_TYPE
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows)) {
            rows.slice(0, 5).forEach((r, i) => inspectRow(r, i));
        } else {
            console.log(`  Raw: ${fmt(rows).slice(0, 500)}`);
        }
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    // ── Test 2: get_liquidity_pool_history (without op_type filter) ──
    console.log(`\n\n═══ TEST 2: get_liquidity_pool_history(poolId, null, null, ${LIMIT}) — no op_type ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, LIMIT
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows)) {
            rows.slice(0, 5).forEach((r, i) => inspectRow(r, i));
        } else {
            console.log(`  Raw: ${fmt(rows).slice(0, 500)}`);
        }
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    // ── Test 3: Try reversed args order (if applicable) ───────────────
    console.log(`\n\n═══ TEST 3: get_liquidity_pool_history with different arg combos ═══`);
    // Some APIs expect different parameter order
    try {
        // Try the method signature lookup
        const historyApis = Object.keys(BitShares.history || {})
            .filter(k => typeof BitShares.history[k] === 'function');
        console.log(`Available BitShares.history methods:`);
        historyApis.forEach(m => console.log(`  - ${m}`));
    } catch (err) {
        console.log(`Could not list methods: ${err.message}`);
    }

    // ── Test 4: Try get_account_history for pool account ───────────
    console.log(`\n\n═══ TEST 4: get_account_history_by_operations for pool account ═══`);
    try {
        // Pool "account" is 1.19.133 — try account history API
        if (typeof BitShares.history.get_account_history_by_operations === 'function') {
            const rows = await BitShares.history.get_account_history_by_operations(
                POOL_ID, [LP_OP_TYPE], '1.19.0', '1.19.999', LIMIT
            );
            console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
            if (Array.isArray(rows)) {
                rows.slice(0, 3).forEach((r, i) => inspectRow(r, i));
            }
        } else {
            console.log('get_account_history_by_operations NOT available');
        }
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    // ── Test 5: Try get_relative_account_history ─────────────────
    console.log(`\n\n═══ TEST 5: get_relative_account_history ═══`);
    try {
        if (typeof BitShares.history.get_relative_account_history === 'function') {
            const rows = await BitShares.history.get_relative_account_history(
                POOL_ID, 0, LIMIT, 0
            );
            console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
            if (Array.isArray(rows)) {
                rows.slice(0, 3).forEach((r, i) => inspectRow(r, i));
            }
        } else {
            console.log('get_relative_account_history NOT available');
        }
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    // ── Test 6: Last 24h of trades — try to query recent only ─────
    console.log(`\n\n═══ TEST 6: Last 100 results with larger limit ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, 100, LP_OP_TYPE
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows) && rows.length > 0) {
            // Show first, last, and total count
            console.log(`  First row time: ${rows[0]?.time || 'n/a'}`);
            console.log(`  Last row time:  ${rows[rows.length - 1]?.time || 'n/a'}`);
            // Check how many have valid op data
            let withSell = 0, withReceived = 0;
            for (const r of rows) {
                const opPayload = Array.isArray(r?.op?.op) ? r.op.op[1] : null;
                if (opPayload?.amount_to_sell) withSell++;
                const resultPayload = Array.isArray(r?.op?.result) ? r.op.result[1] : null;
                const received = Array.isArray(resultPayload?.received)
                    ? resultPayload.received[0]
                    : (resultPayload?.received || null);
                if (received) withReceived++;
            }
            console.log(`  Rows with amount_to_sell: ${withSell}`);
            console.log(`  Rows with received:      ${withReceived}`);
        }
    } catch (err) {
        console.log(`ERROR: ${err.message}`);
    }

    console.log('\n══════════════════════════════════════════════');
    console.log('Diagnostic complete.');
    console.log('══════════════════════════════════════════════');
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
