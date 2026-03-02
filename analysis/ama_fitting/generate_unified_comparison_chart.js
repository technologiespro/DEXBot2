const fs   = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');

// Shared chart HTML generation
const { generateHTML } = require('../../market_adapter/lp_chart_core');

/**
 * UNIFIED COMPARISON CHART GENERATOR
 *
 * Shows four AMA strategies on the same price chart using the shared dark-theme style.
 * Strategies are loaded from the optimizer results JSON when using --data,
 * with linear and capped winners:
 *   1. MAX AREA/MAXDIST                (orange, solid)
 *   2. MAX PROD/MAXDIST                (blue, dash)        ← primary (band + stats)
 *   3. MAX AREA/MAXDIST (capped band)  (green, longdash)
 *   4. MAX PROD/MAXDIST (capped band)  (red, longdashdot)
 *
 * Falls back to hardcoded defaults when no results file is found.
 *
 * Usage:
 *   node generate_unified_comparison_chart.js --data ../../market_adapter/data/lp_pool_133_1h.json
 *   node generate_unified_comparison_chart.js --data ../../market_adapter/data/lp_pool_133_4h.json
 *   node generate_unified_comparison_chart.js   (MEXC synthetic fallback)
 */

const DATA_DIR = path.join(__dirname, 'data');

// Fallback strategies used when no optimizer results file exists
const FALLBACK_STRATEGIES = [
    { name: 'FAST',   erPeriod: 15,  fastPeriod: 5, slowPeriod: 30, color: '#26a69a', dash: 'dot'   },
    { name: 'MEDIUM', erPeriod: 50,  fastPeriod: 5, slowPeriod: 30, color: '#fb8c00', dash: 'solid' },
    { name: 'SLOW',   erPeriod: 100, fastPeriod: 2, slowPeriod: 30, color: '#9E9E9E', dash: 'dash'  },
];

/**
 * Load representative strategies from an optimizer results JSON.
 * Returns null if the file doesn't exist or has no results.
 * Order: AREA first, PROD second (PROD becomes primary/index-0 after reorder in run()).
 */
function strategiesFromResults(resultsPath) {
    if (!fs.existsSync(resultsPath)) return null;
    const json = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const meta = json.meta;
    if (!meta) return null;

    const strategies = [];

    function add(key, label, color, dash) {
        const r = meta[key];
        if (!r) return;
        strategies.push({ name: label, erPeriod: r.er, fastPeriod: r.fast, slowPeriod: r.slow, color, dash });
    }

    const areaCap = Number.isFinite(meta.areaCapPct) ? meta.areaCapPct : null;
    const prodCap = Number.isFinite(meta.prodCapPct)  ? meta.prodCapPct  : null;
    add('bestProdMaxDist',       'MAX PROD/MAXDIST',                                  '#42a5f5', 'dash');        // blue   — primary
    add('bestAreaMaxDist',       'MAX AREA/MAXDIST',                                  '#fb8c00', 'solid');       // orange
    add('bestAreaMaxDistCapped', areaCap === null ? 'MAX AREA/MAXDIST (cap)' : `MAX AREA/MAXDIST (<=${areaCap.toFixed(1)}%)`, '#66bb6a', 'longdash');    // green
    add('bestProdMaxDistCapped', prodCap === null ? 'MAX PROD/MAXDIST (cap)' : `MAX PROD/MAXDIST (<=${prodCap.toFixed(1)}%)`, '#ef5350', 'longdashdot'); // red

    return strategies.length ? strategies : null;
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

function loadData(filename) {
    const raw  = fs.readFileSync(path.join(DATA_DIR, filename));
    const json = JSON.parse(raw);
    return json.map(candle => ({
        timestamp: candle[0], open: candle[1], high: candle[2],
        low: candle[3], close: candle[4], volume: candle[5],
    }));
}

// Load Kibana LP candle export { meta, candles: [[ts,o,h,l,c,vol],...] }
function loadLpData(filePath) {
    const json    = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const candles = json.candles ?? json;
    return {
        candles: candles.map(c => ({
            timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
        })),
        meta: json.meta ?? null,
    };
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
    const dataArgIdx = process.argv.indexOf('--data');
    const dataFile   = dataArgIdx !== -1 ? process.argv[dataArgIdx + 1] : null;

    console.log('════════════════════════════════════════════════');
    console.log(' Unified Comparison Chart Generator');
    console.log('════════════════════════════════════════════════\n');

    let candles, meta, outFile, STRATEGIES;

    if (dataFile) {
        // ── LP candle data mode ───────────────────────────────────────────────
        try {
            const loaded = loadLpData(path.resolve(dataFile));
            candles = loaded.candles;
            meta    = loaded.meta ?? {
                pool: null,
                assetA: { symbol: '?' }, assetB: { symbol: '?' },
                intervalSeconds: 3600, fetchedAt: new Date().toISOString(),
            };
            outFile = path.join(__dirname, `chart_lp_${path.basename(dataFile, '.json')}.html`);

            const resultsFile = path.join(__dirname, `optimization_results_${path.basename(dataFile, '.json')}.json`);
            const fromResults = strategiesFromResults(resultsFile);
            STRATEGIES = fromResults ?? FALLBACK_STRATEGIES;

            console.log(`Data:        ${path.basename(dataFile)}  (${candles.length} candles)`);
            if (fromResults) {
                console.log(`Strategies:  loaded from ${path.basename(resultsFile)}`);
                fromResults.forEach(s => console.log(`  ${s.name.padEnd(28)} ER=${s.erPeriod}  Fast=${s.fastPeriod}  Slow=${s.slowPeriod}`));
            } else {
                console.log(`Strategies:  results file not found — using fallback`);
            }
        } catch (e) {
            console.error('Error loading LP data:', e.message);
            return;
        }
    } else {
        // ── MEXC synthetic pair mode ──────────────────────────────────────────
        try {
            candles = generateSyntheticPair(loadData('BTS_USDT.json'), loadData('XRP_USDT.json'));
        } catch (e) {
            console.error('Error loading MEXC data:', e.message);
            return;
        }
        meta    = { pool: null, assetA: { symbol: 'XRP' }, assetB: { symbol: 'BTS' },
                    intervalSeconds: 14400, fetchedAt: new Date().toISOString() };
        outFile = path.join(__dirname, 'chart_4h_UNIFIED_COMPARISON.html');
        STRATEGIES = [...FALLBACK_STRATEGIES];
        console.log(`Data:        MEXC synthetic XRP/BTS (${candles.length} candles)`);
    }

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
    fs.writeFileSync(outFile, html);

    console.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    console.log(`Open:        file://${outFile}`);
}

run();
