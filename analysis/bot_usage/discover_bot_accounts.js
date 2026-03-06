#!/usr/bin/env node
'use strict';

/**
 * DEXBOT ACCOUNT DISCOVERY
 *
 * Scans all active BitShares accounts across the last N days to find
 * which accounts are running DEXBot or DEXBot2 staggered-orders strategy.
 *
 * Pipeline:
 *   1. Kibana (parallel):
 *        Q1 — top 100 accounts by limit_order_create count
 *        Q2 — top 100 accounts by limit_order_cancel count
 *        Q3 — top 100 accounts by fill_order count
 *   2. Merge & pre-filter:
 *        creates ≥ MIN_CREATES  AND  cancel/create ratio ≥ 0.25
 *        (grid bots cancel ~100% of placed orders on each recalculation)
 *   3. Grid analysis (parallel, batches of 5):
 *        Fetch 200 raw orders per candidate → per-session geometric spacing test
 *   4. BitShares: resolve account IDs → names (batch db.get_objects call)
 *   5. Rank by DEX score and print table
 *
 * Usage:
 *   node analysis/bot_usage/discover_bot_accounts.js
 *   node analysis/bot_usage/discover_bot_accounts.js --days 14
 *   node analysis/bot_usage/discover_bot_accounts.js --days 7 --min-creates 10 --top 50
 *   node analysis/bot_usage/discover_bot_accounts.js --no-grid   (fast: counts only)
 */

const {
    kibanaSearch,
    buildOrderPriceQuery,
    buildTopSellerAccountsQuery,
    buildTopCancellerAccountsQuery,
    buildTopFilledAccountsQuery,
    DEFAULT_CONFIG,
} = require('./kibana_bot_queries');

// ─── Configuration ────────────────────────────────────────────────────────────

const BTS_NODE    = 'wss://dex.iobanker.com/ws';
const KIBANA_CFG  = { ...DEFAULT_CONFIG, timeout: 30000 };

const ASSET_PRECISION = {
    '1.3.0':    5,   // BTS
    '1.3.5537': 4,   // IOB.XRP
    '1.3.5969': 4,   // XBTSX.XRP
};
const DEFAULT_PRECISION = 8;

function getPrec(id) { return ASSET_PRECISION[id] ?? DEFAULT_PRECISION; }

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { days: 14, minCreates: 20, top: 30, skipGrid: false };
    for (let i = 0; i < args.length; i++) {
        if      (args[i] === '--days'        && args[i + 1]) opts.days       = parseInt(args[++i], 10);
        else if (args[i] === '--min-creates' && args[i + 1]) opts.minCreates = parseInt(args[++i], 10);
        else if (args[i] === '--top'         && args[i + 1]) opts.top        = parseInt(args[++i], 10);
        else if (args[i] === '--no-grid')                    opts.skipGrid   = true;
    }
    return opts;
}

// ─── Grid analysis helpers (self-contained, no external import) ───────────────

function hitPrice(hit, sellPrec, recvPrec) {
    const op   = hit._source?.operation_history?.op_object;
    const sell = op?.amount_to_sell?.amount;
    const recv = op?.min_to_receive?.amount;
    if (!sell || !recv || sell <= 0 || recv <= 0) return null;
    return (recv / Math.pow(10, recvPrec)) / (sell / Math.pow(10, sellPrec));
}

function spacingStats(prices) {
    if (prices.length < 3) return { isGrid: false, score: 0, count: prices.length };
    const s = [...prices].sort((a, b) => a - b);
    const u = [s[0]];
    for (let i = 1; i < s.length; i++) {
        if (Math.abs((s[i] - s[i - 1]) / s[i - 1]) > 1e-5) u.push(s[i]);
    }
    if (u.length < 3) return { isGrid: false, score: 0, count: prices.length };
    const lr   = [];
    for (let i = 1; i < u.length; i++) lr.push(Math.log(u[i] / u[i - 1]));
    const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
    const vari = lr.reduce((s, r) => s + (r - mean) ** 2, 0) / lr.length;
    const cv   = mean > 1e-10 ? Math.sqrt(vari) / mean : Infinity;
    const isGrid = cv < 0.35 && u.length >= 4;
    return {
        count:               prices.length,
        uniqueCount:         u.length,
        impliedIncrementPct: (Math.exp(mean) - 1) * 100,
        minPrice: u[0], maxPrice: u[u.length - 1],
        cv, isGrid,
        score: isGrid ? Math.max(0, Math.min(100, Math.round((1 - cv) * 100))) : 0,
    };
}

/**
 * Session-aware grid spacing analysis.
 * Groups hits by 2-minute proximity, finds the best-scoring session.
 */
function analyzeGrid(hits, sellPrec, recvPrec) {
    if (!hits || hits.length < 3) return { isGrid: false, score: 0, count: hits?.length ?? 0 };
    const SESSION_GAP = 2 * 60 * 1000;

    const entries = hits.map(h => {
        const p = hitPrice(h, sellPrec, recvPrec);
        const t = h._source?.block_data?.block_time
            ? new Date(h._source.block_data.block_time).getTime() : null;
        return p && t ? { p, t } : null;
    }).filter(Boolean).sort((a, b) => a.t - b.t);

    if (entries.length < 3) return { isGrid: false, score: 0, count: entries.length };

    const sessions = [[entries[0]]];
    for (let i = 1; i < entries.length; i++) {
        if (entries[i].t - entries[i - 1].t > SESSION_GAP) sessions.push([]);
        sessions[sessions.length - 1].push(entries[i]);
    }

    let best = null;
    for (const sess of sessions) {
        if (sess.length < 4) continue;
        const stats = spacingStats(sess.map(e => e.p));
        if (!best || stats.score > best.score || (stats.score === best.score && stats.cv < best.cv)) {
            best = stats;
        }
    }

    if (!best) best = spacingStats(entries.map(e => e.p));
    return { ...best, totalOrders: entries.length, sessionCount: sessions.length };
}

function analyzeBatching(hits) {
    if (!hits.length) return { maxBatch: 0, avgBatch: 0 };
    const counts = {};
    for (const h of hits) {
        const t = h._source?.block_data?.block_time;
        if (t) counts[t] = (counts[t] ?? 0) + 1;
    }
    const vals = Object.values(counts);
    return {
        maxBatch: Math.max(...vals),
        avgBatch: vals.reduce((a, b) => a + b, 0) / vals.length,
    };
}

// ─── DEXBot score ─────────────────────────────────────────────────────────────

function dexScore(creates, fills, cancels, gridScore, maxBatch) {
    let s = 0;
    s += Math.round(gridScore * 0.4);                        // grid quality  (0–40)
    if (maxBatch >= 4)      s += 20;                         // batch size    (0–20)
    else if (maxBatch >= 2) s += 10;
    if (creates >= 50)  s += 20; else if (creates >= 20) s += 10; // volume (0–20)
    const fr = creates > 0 ? fills / creates : 0;
    if (fr >= 0.03 && fr <= 0.95) s += 20;                  // fill rate     (0–20)
    return Math.min(100, s);
}

// ─── Account resolution ───────────────────────────────────────────────────────

async function resolveNames(ids) {
    let BTS;
    try { BTS = require('btsdex'); } catch { return {}; }

    const map = {};
    try {
        await BTS.connect(BTS_NODE);
        // BitShares db.get_objects accepts an array of IDs
        const objects = await BTS.db.get_objects(ids);
        for (const obj of (objects ?? [])) {
            if (obj?.id && obj?.name) map[obj.id] = obj.name;
        }

        // Resolve extra asset precisions while connected
        const toCheck = ['IOB.XRP', 'HONEST.MONEY', 'XBTSX.XRP', 'XBTSX.USDT', 'USD', 'CNY'];
        for (const sym of toCheck) {
            try {
                const a = await BTS.assets[sym];
                if (a?.id && !(a.id in ASSET_PRECISION)) {
                    ASSET_PRECISION[a.id] = a.precision;
                }
            } catch (_) {}
        }
    } catch (e) {
        console.warn(`  [warn] Name resolution failed: ${e.message}`);
    } finally {
        try { BTS.disconnect(); } catch (_) {}
    }
    return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    const opts      = parseArgs();
    const lookbackH = opts.days * 24;

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(' DEXBot Account Discovery Scan');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(` Kibana:      https://kibana.bitshares.dev`);
    console.log(` Lookback:    ${opts.days} days`);
    console.log(` Min creates: ${opts.minCreates}`);
    console.log(` Top N:       ${opts.top} candidates for grid analysis`);
    console.log(` Grid scan:   ${opts.skipGrid ? 'disabled' : 'enabled'}`);
    console.log(` Timestamp:   ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
    console.log('');

    // ── Phase 1: Discovery queries ─────────────────────────────────────────────

    console.log('Phase 1: Querying Kibana for top active accounts...');

    const [createRes, cancelRes, fillRes] = await Promise.all([
        kibanaSearch(KIBANA_CFG, buildTopSellerAccountsQuery(lookbackH, 200, opts.minCreates)),
        kibanaSearch(KIBANA_CFG, buildTopCancellerAccountsQuery(lookbackH, 200, 5)),
        kibanaSearch(KIBANA_CFG, buildTopFilledAccountsQuery(lookbackH, 200, 3)),
    ]);

    const createBuckets = createRes?.aggregations?.by_account?.buckets ?? [];
    const cancelBuckets = cancelRes?.aggregations?.by_account?.buckets ?? [];
    const fillBuckets   = fillRes?.aggregations?.by_account?.buckets   ?? [];

    console.log(`  Creates: ${createBuckets.length} accounts with ≥${opts.minCreates} creates`);
    console.log(`  Cancels: ${cancelBuckets.length} accounts with ≥5 cancels`);
    console.log(`  Fills:   ${fillBuckets.length} accounts with ≥3 fills`);

    // ── Phase 2: Merge & pre-filter ────────────────────────────────────────────

    console.log('\nPhase 2: Merging and filtering candidates...');

    const accounts = {};  // id → { creates, cancels, fills }
    for (const b of createBuckets) accounts[b.key] = { creates: b.doc_count, cancels: 0, fills: 0 };
    for (const b of cancelBuckets) {
        if (!accounts[b.key]) accounts[b.key] = { creates: 0, cancels: 0, fills: 0 };
        accounts[b.key].cancels = b.doc_count;
    }
    for (const b of fillBuckets) {
        if (!accounts[b.key]) accounts[b.key] = { creates: 0, cancels: 0, fills: 0 };
        accounts[b.key].fills = b.doc_count;
    }

    // Pre-filter: must have creates ≥ minCreates AND meaningful cancel activity
    const candidates = Object.entries(accounts)
        .filter(([, s]) => s.creates >= opts.minCreates && s.cancels >= Math.max(3, s.creates * 0.2))
        .map(([id, s]) => ({
            id,
            creates: s.creates,
            cancels: s.cancels,
            fills:   s.fills,
            cancelRatio: s.cancels / Math.max(s.creates, 1),
            fillRate:    s.creates > 0 ? (s.fills / s.creates * 100) : 0,
        }))
        .sort((a, b) => b.creates - a.creates);

    console.log(`  Total unique accounts:   ${Object.keys(accounts).length}`);
    console.log(`  After filter:            ${candidates.length} candidates`);
    console.log(`  Will analyze top:        ${Math.min(opts.top, candidates.length)}`);

    const toAnalyze = candidates.slice(0, opts.top);

    // ── Phase 3: Grid analysis ─────────────────────────────────────────────────

    const results = toAnalyze.map(c => ({ ...c, gridScore: 0, impliedInc: null, maxBatch: 0, dexScore: 0 }));

    if (!opts.skipGrid) {
        console.log('\nPhase 3: Grid analysis (batches of 5)...');

        const BATCH = 5;
        for (let i = 0; i < results.length; i += BATCH) {
            const slice = results.slice(i, i + BATCH);
            process.stdout.write(`  [${i + 1}–${Math.min(i + BATCH, results.length)}/${results.length}] `);

            const priceResults = await Promise.all(
                slice.map(r => kibanaSearch(KIBANA_CFG, buildOrderPriceQuery(r.id, lookbackH, null, 200)))
            );

            for (let j = 0; j < slice.length; j++) {
                const r    = slice[j];
                const hits = priceResults[j]?.hits?.hits ?? [];

                // Separate buy side (selling BTS=1.3.0) from sell side
                const buyHits  = hits.filter(h =>
                    h._source?.operation_history?.op_object?.amount_to_sell?.asset_id === '1.3.0'
                );
                const sellHits = hits.filter(h =>
                    h._source?.operation_history?.op_object?.amount_to_sell?.asset_id !== '1.3.0'
                );

                // Detect asset precisions for this account's pair
                const sellAssetId = sellHits[0]
                    ?._source?.operation_history?.op_object?.amount_to_sell?.asset_id
                    ?? buyHits[0]?._source?.operation_history?.op_object?.min_to_receive?.asset_id;

                const btsPrc = getPrec('1.3.0');
                const aPrc   = getPrec(sellAssetId ?? '');

                // Use the side with more data for grid detection
                const primaryHits = buyHits.length >= sellHits.length ? buyHits : sellHits;
                const [pSell, pRecv] = buyHits.length >= sellHits.length
                    ? [btsPrc, aPrc] : [aPrc, btsPrc];

                const grid  = analyzeGrid(primaryHits, pSell, pRecv);
                const batch = analyzeBatching(hits);

                // Detect main trading pair
                const pairAssets = new Set(hits.flatMap(h => {
                    const op = h._source?.operation_history?.op_object;
                    return [op?.amount_to_sell?.asset_id, op?.min_to_receive?.asset_id].filter(Boolean);
                }));
                r.pairAssets = [...pairAssets];

                r.gridScore  = grid.score;
                r.impliedInc = grid.impliedIncrementPct ?? null;
                r.cv         = grid.cv ?? null;
                r.maxBatch   = batch.maxBatch;
                r.dexScore   = dexScore(r.creates, r.fills, r.cancels, grid.score, batch.maxBatch);
                r.ordersFetched = hits.length;

                process.stdout.write('.');
            }
            console.log('');
        }
    } else {
        // Without grid: assign a simpler heuristic score
        for (const r of results) {
            const fr = r.fillRate / 100;
            r.dexScore = Math.min(70,
                (Math.min(r.creates, 100) / 100 * 20) +
                (Math.min(r.cancelRatio, 1.5) / 1.5 * 30) +
                (fr >= 0.03 && fr <= 0.95 ? 20 : 0)
            );
        }
    }

    // Sort by DEX score
    results.sort((a, b) => b.dexScore - a.dexScore || b.creates - a.creates);

    // ── Phase 4: Resolve account names ────────────────────────────────────────

    console.log('\nPhase 4: Resolving account names...');
    const allIds  = results.map(r => r.id);
    const nameMap = await resolveNames(allIds);
    for (const r of results) r.name = nameMap[r.id] ?? r.id;

    // ── Phase 5: Output ───────────────────────────────────────────────────────

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log(' Discovery Results — Ranked by DEX Score');
    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log('');

    // Print by DEX score tier
    const tiers = [
        { label: 'HIGH confidence (80+) — almost certainly DEXBot/DEXBot2', min: 80, max: 101 },
        { label: 'MEDIUM confidence (50–79) — likely a grid bot',           min: 50, max:  80 },
        { label: 'LOW confidence (25–49) — some automation detected',       min: 25, max:  50 },
        { label: 'WEAK signal (<25) — create/cancel pattern, no grid',     min:  0, max:  25 },
    ];

    for (const tier of tiers) {
        const group = results.filter(r => r.dexScore >= tier.min && r.dexScore < tier.max);
        if (!group.length) continue;

        console.log(` ── ${tier.label}`);
        console.log('');

        const hdr = ' #   Name                  ID              Creates  Fills  Cancel  Fill%  C/C   MaxBatch  Incr%  Grid  DEX';
        console.log(hdr);
        console.log(' ' + '─'.repeat(hdr.length - 1));

        group.forEach((r, i) => {
            const rank    = String(results.indexOf(r) + 1).padStart(2);
            const name    = r.name.padEnd(22).slice(0, 22);
            const id      = r.id.padEnd(14);
            const creates = String(r.creates).padStart(7);
            const fills   = String(r.fills).padStart(6);
            const cancels = String(r.cancels).padStart(7);
            const fr      = (r.fillRate.toFixed(1) + '%').padStart(5);
            const cr      = r.cancelRatio.toFixed(2).padStart(4);
            const batch   = String(r.maxBatch || '-').padStart(9);
            const inc     = (r.impliedInc != null ? r.impliedInc.toFixed(2) + '%' : 'n/a').padStart(6);
            const grid    = String(r.gridScore).padStart(5);
            const dex     = String(r.dexScore).padStart(4);
            console.log(` ${rank}  ${name}  ${id}  ${creates}  ${fills}  ${cancels}  ${fr}  ${cr}  ${batch}  ${inc}  ${grid}  ${dex}`);
        });
        console.log('');
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    const high   = results.filter(r => r.dexScore >= 80).length;
    const medium = results.filter(r => r.dexScore >= 50 && r.dexScore < 80).length;
    const low    = results.filter(r => r.dexScore >= 25 && r.dexScore < 50).length;

    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log(` Total candidates scanned:  ${results.length}`);
    console.log(` HIGH (80+):   ${high}  accounts — almost certainly DEXBot/DEXBot2`);
    console.log(` MEDIUM (50+): ${medium}  accounts — likely grid bots`);
    console.log(` LOW (25+):    ${low}  accounts — weak signal`);
    console.log('');
    console.log(' Columns:');
    console.log('   C/C = cancel/create ratio  (grid bots: ~1.0)');
    console.log('   Incr% = implied grid increment from price spacing');
    console.log('   Grid = grid quality 0-100  |  DEX = DEXBot confidence 0-100');
    console.log('');
}

run().then(() => process.exit(0)).catch(e => {
    console.error('\n[fatal]', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
});
