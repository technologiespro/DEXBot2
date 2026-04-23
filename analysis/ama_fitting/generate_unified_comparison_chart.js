const fs   = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

// Shared chart HTML generation
const { generateHTML } = require('../../market_adapter/lp_chart_core_uplot');
const { MARKET_ADAPTER_DATA_DIR } = require('../../market_adapter/data_paths');

/**
 * UNIFIED COMPARISON CHART GENERATOR — Synthetic analysis mode
 *
 * Shows four AMA strategies on the same price chart using the shared dark-theme style.
 * This script now exists only for the synthetic XRP/BTS comparison workflow.
 *
 * The supported LP-data chart workflow is:
 *   npm run lp:chart -- --data <lp-export.json>
 *
 * Synthetic mode keeps the fixed fallback strategies:
 *   1. MAX AREA/MAXDIST                (orange, solid)
 *   2. MAX PROD/MAXDIST                (blue, dash)        ← primary (band + stats)
 *   3. MAX AREA/MAXDIST (capped band)  (green, longdash)
 *   4. MAX PROD/MAXDIST (capped band)  (red, longdashdot)
 *
 * Usage:
 *   npm run ama:chart:synthetic
 */

const DATA_DIR = MARKET_ADAPTER_DATA_DIR;

// Fallback strategies used by the synthetic comparison workflow.
const FALLBACK_STRATEGIES = [
    { name: 'FAST',   erPeriod: 15,  fastPeriod: 5, slowPeriod: 30, color: '#26a69a', dash: 'dot'   },
    { name: 'MEDIUM', erPeriod: 50,  fastPeriod: 5, slowPeriod: 30, color: '#fb8c00', dash: 'solid' },
    { name: 'SLOW',   erPeriod: 100, fastPeriod: 2, slowPeriod: 30, color: '#9E9E9E', dash: 'dash'  },
];

// ─── Data loaders ─────────────────────────────────────────────────────────────

function loadData(filename) {
    const raw  = fs.readFileSync(path.join(DATA_DIR, filename));
    const json = JSON.parse(raw);
    return json.map(candle => ({
        timestamp: candle[0], open: candle[1], high: candle[2],
        low: candle[3], close: candle[4], volume: candle[5],
    }));
}

function generateSyntheticPair(btsData, xrpData) {
    const xrpMap = new Map();
    xrpData.forEach(c => xrpMap.set(c.timestamp, c));

    const synthetic = [];
    btsData.forEach(bts => {
        const xrp = xrpMap.get(bts.timestamp);
        if (xrp) {
            synthetic.push({
                timestamp: bts.timestamp,
                open:  bts.open  / xrp.open,
                high:  bts.high  / xrp.low,
                low:   bts.low   / xrp.high,
                close: bts.close / xrp.close,
            });
        }
    });

    return synthetic.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Metrics (console output only) ───────────────────────────────────────────

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0, maxDriftDown = 0, areaAbove = 0, areaBelow = 0;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const ama       = amaValues[i];
        const driftUp   = (candles[i].high - ama) / ama;
        const driftDown = (ama - candles[i].low)  / ama;
        if (driftUp   > maxDriftUp)   maxDriftUp   = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;
        if (candles[i].high > ama) areaAbove += driftUp;
        if (candles[i].low  < ama) areaBelow += driftDown;
    }

    return { maxDriftUp, maxDriftDown, areaAbove, areaBelow,
             totalArea: areaAbove + areaBelow,
             maxDistance: Math.max(maxDriftUp, maxDriftDown) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run() {
    console.log('════════════════════════════════════════════════');
    console.log(' Unified Comparison Chart Generator (Synthetic)');
    console.log('════════════════════════════════════════════════\n');

    let candles, meta, outFile, STRATEGIES;

    try {
        candles = generateSyntheticPair(loadData('BTS_USDT.json'), loadData('XRP_USDT.json'));
    } catch (e) {
        console.error('Error loading synthetic comparison data:', e.message);
        process.exitCode = 1;
        return;
    }
    meta    = { pool: null, assetA: { symbol: 'XRP' }, assetB: { symbol: 'BTS' },
                intervalSeconds: 14400, fetchedAt: new Date().toISOString() };
    outFile = path.join(__dirname, '..', 'charts', 'lp_chart_4h_UNIFIED_COMPARISON.html');
    STRATEGIES = [...FALLBACK_STRATEGIES];
    console.log(`Data:        MEXC synthetic XRP/BTS (${candles.length} candles)`);

    // ── Calculate AMAs + metrics ──────────────────────────────────────────────
    const closes = candles.map(c => c.close);
    const amaResults = [];

    console.log('');
    for (const [i, strategy] of STRATEGIES.entries()) {
        const values  = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candles);
        amaResults.push({ ...strategy, lineWidth: i === 0 ? 2 : 1.5, values });

        console.log(`${strategy.name}`);
        console.log(`   ├─ Total Area:     ${metrics.totalArea.toFixed(2)}%`);
        console.log(`   ├─ Max UP:         ${(metrics.maxDriftUp   * 100).toFixed(2)}%`);
        console.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        console.log(`   └─ Band Factor:    ${(metrics.maxDistance  * 200).toFixed(2)}%\n`);
    }

    // ── Convert candles to array format expected by generateHTML ──────────────
    const candleArrays = candles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0]);

    // ── Generate and write HTML ───────────────────────────────────────────────
    console.log(`Generating chart (${amaResults.length} AMAs)...`);
    const html = generateHTML(meta, candleArrays, amaResults);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    console.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    console.log(`Open:        file://${outFile}`);
}

run();
