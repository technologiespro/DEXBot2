#!/usr/bin/env node
'use strict';

/**
 * scripts/shadow_test.js — Differential shadow testing for native BitShares client
 *
 * Runs both the btsdex library and the native bitshares-native library in parallel,
 * issuing identical DB + history queries every 30 seconds. Deep-compares responses
 * and logs mismatches with full context.
 *
 * Usage:
 *   node scripts/shadow_test.js [--duration-hours=N] [--interval-sec=N] [--node=URL]
 *   node scripts/shadow_test.js --record-fixtures   (record btsdex responses to JSON for CI)
 *
 * Environment:
 *   DEXBOT_NATIVE_CHAIN=1 — enables native library (always enabled for this script)
 */

let BitSharesLib;
try {
    BitSharesLib = require('btsdex');
} catch (_) {
    console.error('shadow_test requires optional legacy package btsdex for differential comparison.');
    console.error('Install btsdex separately or use recorded fixtures for CI.');
    process.exit(1);
}
const native = require('../modules/bitshares-native');

const DURATION_HOURS = parseInt(process.argv.find(a => a.startsWith('--duration-hours='))?.split('=')[1] || '6', 10);
const INTERVAL_SEC = parseInt(process.argv.find(a => a.startsWith('--interval-sec='))?.split('=')[1] || '30', 10);
const NODE_URL = process.argv.find(a => a.startsWith('--node='))?.split('=')[1] || 'wss://cloud.xbts.io/ws';
const RECORD_FIXTURES = process.argv.includes('--record-fixtures');

const outputDir = `${__dirname}/../profiles/shadow_test`;
const fixtureDir = `${__dirname}/../tests/fixtures/shadow`;
const fs = require('fs');
const path = require('path');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}
if (RECORD_FIXTURES && !fs.existsSync(fixtureDir)) {
    fs.mkdirSync(fixtureDir, { recursive: true });
}

const logPath = path.join(outputDir, `shadow_${Date.now()}.jsonl`);
const reportPath = path.join(outputDir, 'shadow_report.json');
const fixturePath = RECORD_FIXTURES ? path.join(fixtureDir, 'btsdex_responses.json') : null;

let totalQueries = 0;
let mismatchCount = 0;
const mismatches = [];
const fixtureResponses = RECORD_FIXTURES ? [] : null;
const startTime = Date.now();

function deepCompare(a, b, path = '') {
    if (a === b) return null;
    if (a == null || b == null) return { path, a, b, reason: 'null vs non-null' };
    if (typeof a !== typeof b) return { path, a: `${typeof a}:${JSON.stringify(a)}`, b: `${typeof b}:${JSON.stringify(b)}`, reason: 'type mismatch' };

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length, reason: 'array length' };
        for (let i = 0; i < a.length; i++) {
            const diff = deepCompare(a[i], b[i], `${path}[${i}]`);
            if (diff) return diff;
        }
        return null;
    }

    if (typeof a === 'object' && a !== null) {
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        if (keysA.join(',') !== keysB.join(',')) {
            const onlyA = keysA.filter(k => !keysB.includes(k));
            const onlyB = keysB.filter(k => !keysA.includes(k));
            return { path, onlyInA: onlyA, onlyInB: onlyB, reason: 'key mismatch' };
        }
        for (const key of keysA) {
            const diff = deepCompare(a[key], b[key], `${path}.${key}`);
            if (diff) return diff;
        }
        return null;
    }

    if (typeof a === 'number' && typeof b === 'number') {
        if (Math.abs(a - b) < 0.0001) return null;
    }

    return { path, a: JSON.stringify(a), b: JSON.stringify(b), reason: 'value mismatch' };
}

function logMismatch(method, params, btsdexResult, nativeResult, diff) {
    const entry = {
        timestamp: new Date().toISOString(),
        method,
        params: JSON.stringify(params),
        diff,
        btsdexSnippet: JSON.stringify(btsdexResult).slice(0, 500),
        nativeSnippet: JSON.stringify(nativeResult).slice(0, 500),
    };
    mismatches.push(entry);
    mismatchCount++;
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

async function runQuery(btsdexClient, nativeClient, queryName, queryFn) {
    let btsdexResult = null;
    let nativeResult = null;
    let btsdexError = null;
    let nativeError = null;

    const name = queryName;

    try {
        btsdexResult = await queryFn(btsdexClient);
    } catch (e) {
        btsdexError = e.message;
    }

    try {
        nativeResult = await queryFn(nativeClient);
    } catch (e) {
        nativeError = e.message;
    }

    totalQueries++;

    if (RECORD_FIXTURES && btsdexResult) {
        fixtureResponses.push({
            method: name,
            params: params || [],
            response: btsdexResult,
        });
    }

    if (btsdexError && nativeError) {
        return;
    }

    if ((btsdexError && !nativeError) || (!btsdexError && nativeError)) {
        logMismatch(name, [], { error: btsdexError }, { error: nativeError }, { path: 'error', reason: 'one-sided error' });
        return;
    }

    const diff = deepCompare(btsdexResult, nativeResult);
    if (diff) {
        logMismatch(name, [], btsdexResult, nativeResult, diff);
    }
}

async function runShadowTest() {
    console.log(`Shadow test starting: ${DURATION_HOURS}h duration, ${INTERVAL_SEC}s interval`);
    console.log(`Node: ${NODE_URL}`);
    console.log(`Log: ${logPath}`);

    const endTime = startTime + DURATION_HOURS * 3600 * 1000;

    // Connect btsdex
    console.log('Connecting btsdex...');
    await BitSharesLib.connect([NODE_URL], false);

    // Connect native read-only
    console.log('Connecting native read-only...');
    const nativeClient = native.createReadOnlyClient({ nodes: [NODE_URL] });
    await nativeClient.connect();

    console.log('Both clients connected. Starting query loop...');

    const testAssetIds = ['1.3.0', '1.3.1', '1.3.2'];
    const testSymbols = ['BTS', 'USD'];
    const testAccount = '1.2.0';

    while (Date.now() < endTime) {
        const cycleStart = Date.now();

        // Database queries
        await runQuery(BitSharesLib, nativeClient, 'get_assets', (c) => {
            if (c.db && c.db.get_assets) return c.db.get_assets(testAssetIds);
            return c.db('get_assets', [testAssetIds]);
        });

        await runQuery(BitSharesLib, nativeClient, 'lookup_asset_symbols', (c) => {
            if (c.db && c.db.lookup_asset_symbols) return c.db.lookup_asset_symbols(testSymbols);
            return c.db('lookup_asset_symbols', [testSymbols]);
        });

        await runQuery(BitSharesLib, nativeClient, 'get_full_accounts', (c) => {
            if (c.db && c.db.get_full_accounts) return c.db.get_full_accounts([testAccount], false);
            return c.db('get_full_accounts', [[testAccount], false]);
        });

        await runQuery(BitSharesLib, nativeClient, 'get_order_book', (c) => {
            if (c.db && c.db.get_order_book) return c.db.get_order_book('1.3.0', '1.3.1', 5);
            return c.db('get_order_book', ['1.3.0', '1.3.1', 5]);
        });

        await runQuery(BitSharesLib, nativeClient, 'get_ticker', (c) => {
            if (c.db && c.db.get_ticker) return c.db.get_ticker('1.3.0', '1.3.1');
            return c.db('get_ticker', ['1.3.0', '1.3.1']);
        });

        await runQuery(BitSharesLib, nativeClient, 'getGlobalProperties', (c) => {
            if (c.db && c.db.getGlobalProperties) return c.db.getGlobalProperties();
            return c.db('getGlobalProperties', []);
        });

        await runQuery(BitSharesLib, nativeClient, 'get_dynamic_global_properties', (c) => {
            if (c.db && c.db.get_dynamic_global_properties) return c.db.get_dynamic_global_properties();
            return c.db('get_dynamic_global_properties', []);
        });

        // History queries
        await runQuery(BitSharesLib, nativeClient, 'getMarketHistory', (c) => {
            if (c.history && c.history.getMarketHistory) {
                return c.history.getMarketHistory('1.3.0', '1.3.1', 3600, Date.now() - 86400000, Date.now());
            }
            return c.history('getMarketHistory', ['1.3.0', '1.3.1', 3600, new Date(Date.now() - 86400000).toISOString(), new Date().toISOString()]);
        });

        const elapsed = (Date.now() - cycleStart) / 1000;
        const remaining = Math.max(0, INTERVAL_SEC * 1000 - (Date.now() - cycleStart));

        const hoursLeft = ((endTime - Date.now()) / 3600000).toFixed(1);
        console.log(`[${new Date().toISOString()}] Queries: ${totalQueries}, Mismatches: ${mismatchCount} | Cycle: ${elapsed.toFixed(1)}s | ${hoursLeft}h remaining`);

        if (mismatchCount > 100) {
            console.error(`Too many mismatches (${mismatchCount}), stopping shadow test.`);
            break;
        }

        if (Date.now() < endTime) {
            await new Promise(r => setTimeout(r, remaining));
        }
    }

    // Cleanup
    try { nativeClient.disconnect(); } catch (_) {}
    try { BitSharesLib.disconnect(); } catch (_) {}

    // Write report
    const report = {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationHours: DURATION_HOURS,
        totalQueries,
        mismatches: mismatchCount,
        mismatchRate: totalQueries > 0 ? (mismatchCount / totalQueries * 100).toFixed(2) + '%' : '0%',
        recentMismatches: mismatches.slice(-20),
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nShadow test complete. Report: ${reportPath}`);
    console.log(`Total: ${totalQueries} queries, ${mismatchCount} mismatches (${report.mismatchRate})`);

    if (RECORD_FIXTURES) {
        fs.writeFileSync(fixturePath, JSON.stringify(fixtureResponses, null, 2));
        console.log(`Fixtures written: ${fixturePath} (${fixtureResponses.length} entries)`);
    }

    if (mismatchCount === 0) {
        console.log('Eligible to proceed to Phase 3.');
    }
}

runShadowTest().catch(err => {
    console.error('Shadow test failed:', err);
    process.exit(1);
});
