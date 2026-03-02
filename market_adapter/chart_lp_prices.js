/**
 * CHART LP PRICE DATA
 *
 * Reads the exported LP candle data and generates an interactive Plotly HTML chart.
 * Opens in your default browser automatically.
 *
 * Usage:
 *   node market_adapter/chart_lp_prices.js
 *   node market_adapter/chart_lp_prices.js --file market_adapter/data/lp_prices_BTS_XBTSX_XRP.json
 *   node market_adapter/chart_lp_prices.js --no-open   (generate HTML without opening browser)
 *
 * Chart shows:
 *   - Price line (VWAP per bucket)
 *   - 4 AMA overlays (from optimization_results_lp_pool_133_1h.json)
 *   - AMA deviation % lines (bottom subplot, one per AMA)
 *   - Volume bars (middle subplot)
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');

// AMA from existing analysis module
const { calculateAMA } = require('../analysis/ama_fitting/ama');

// Shared chart HTML generation (also used by analysis/ama_fitting/generate_unified_comparison_chart.js)
const { generateHTML } = require('./lp_chart_core');

// ─── AMA Configs ──────────────────────────────────────────────────────────────
// All 4 winners from optimization_results_lp_pool_133_1h.json
// Primary (index 0) = MAX PROD/MAXDIST — used for band and stats box
const AMA_CONFIGS = [
    { name: 'MAX PROD/MAXDIST',       erPeriod: 90,  fastPeriod: 10,  slowPeriod: 100,  color: '#42a5f5', dash: 'dash',        lineWidth: 2   },
    { name: 'MAX AREA/MAXDIST',       erPeriod: 185, fastPeriod: 10,  slowPeriod: 100,  color: '#fb8c00', dash: 'solid',       lineWidth: 1.5 },
    { name: 'MAX AREA/MAXDIST (cap)', erPeriod: 40,  fastPeriod: 9.5, slowPeriod: 97.5, color: '#66bb6a', dash: 'longdash',    lineWidth: 1.5 },
    { name: 'MAX PROD/MAXDIST (cap)', erPeriod: 25,  fastPeriod: 10,  slowPeriod: 92.5, color: '#ef5350', dash: 'longdashdot', lineWidth: 1.5 },
];

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
    const args   = process.argv.slice(2);
    let dataFile = null;
    let noOpen   = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) {
            dataFile = path.resolve(args[i + 1]);
            i++;
        } else if (args[i] === '--no-open') {
            noOpen = true;
        } else if (!args[i].startsWith('--')) {
            dataFile = path.resolve(args[i]);
        }
    }

    return { dataFile, noOpen };
}

// ─── Find Latest Data File ────────────────────────────────────────────────────

function findDataFile() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) return null;

    const files = fs.readdirSync(dataDir)
        .filter(f => (f.startsWith('lp_pool_') || f.startsWith('lp_prices_')) && f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dataDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);  // newest first

    return files.length > 0 ? path.join(dataDir, files[0].name) : null;
}

// ─── Open in Browser ──────────────────────────────────────────────────────────

function openInBrowser(filePath) {
    const url = `file://${filePath}`;
    // Linux: xdg-open, macOS: open, Windows: start
    const cmd = process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32'  ? `start "" "${url}"` :
                                                `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.warn(`  Could not auto-open browser: ${err.message}`);
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run() {
    const { dataFile: argFile, noOpen } = parseArgs();

    // Locate data file
    const dataFile = argFile ?? findDataFile();
    if (!dataFile) {
        console.error('No data file found. Run fetch first:');
        console.error('  node market_adapter/fetch_lp_data.js');
        process.exit(1);
    }
    if (!fs.existsSync(dataFile)) {
        console.error(`File not found: ${dataFile}`);
        process.exit(1);
    }

    console.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);

    const raw    = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const { meta, candles } = raw;

    if (!candles || candles.length === 0) {
        console.error('No candles in data file.');
        process.exit(1);
    }

    const poolLabel = meta.pool ? `pool ${meta.pool}` : `${meta.assetA.symbol}/${meta.assetB.symbol}`;
    console.log(`  ${candles.length} candles · ${poolLabel}`);

    // Calculate all 4 AMAs on close prices
    const closes     = candles.map(c => c[4]);
    const amaResults = AMA_CONFIGS.map(cfg => ({
        ...cfg,
        values: calculateAMA(closes, cfg),
    }));

    const lastClose = closes[closes.length - 1];
    for (const a of amaResults) {
        const lastAMA  = a.values[a.values.length - 1];
        const deviation = ((lastClose - lastAMA) / lastAMA) * 100;
        console.log(`  ${a.name.padEnd(24)} AMA: ${lastAMA.toFixed(6)}  dev: ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);
    }

    // Generate HTML
    const html    = generateHTML(meta, candles, amaResults);
    const suffix  = meta.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta.assetA.symbol}_${meta.assetB.symbol}`;
    const outFile = path.join(__dirname, `lp_chart_${suffix}.html`).replace(/\./g, '_').replace('_html', '.html');
    fs.writeFileSync(outFile, html);

    console.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);

    if (!noOpen) {
        console.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        console.log(`Open manually: file://${outFile}`);
    }
}

run();
