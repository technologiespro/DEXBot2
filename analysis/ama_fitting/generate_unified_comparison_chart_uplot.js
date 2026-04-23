'use strict';

const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');
const { generateHTML } = require('../../market_adapter/lp_chart_core_uplot');

const FALLBACK_STRATEGIES = [
    { name: 'FAST',   erPeriod: 15,  fastPeriod: 5, slowPeriod: 30, color: '#26a69a', dash: 'dot'   },
    { name: 'MEDIUM', erPeriod: 50,  fastPeriod: 5, slowPeriod: 30, color: '#fb8c00', dash: 'solid' },
    { name: 'SLOW',   erPeriod: 100, fastPeriod: 2, slowPeriod: 30, color: '#9E9E9E', dash: 'dash'  },
];

function loadData(filePath) {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    const json = JSON.parse(raw);
    return json.map((candle) => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
    }));
}

function showHelp() {
    console.log(`
Unified Comparison Chart Generator (Synthetic, uPlot)

Usage:
  node analysis/ama_fitting/generate_unified_comparison_chart_uplot.js \\
    --bts-file <path/to/BTS.json> \\
    --xrp-file <path/to/XRP.json> \\
    [--output FILE] [--quiet]

Options:
  --bts-file FILE   BTS candle JSON input
  --xrp-file FILE   XRP candle JSON input
  --output FILE     Output HTML file
  --quiet           Suppress output
    `);
}

function parseArgs(argv = process.argv.slice(2)) {
    const cfg = {
        btsFile: null,
        xrpFile: null,
        outFile: null,
        quiet: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--bts-file' && argv[i + 1]) {
            cfg.btsFile = argv[++i];
        } else if (arg === '--xrp-file' && argv[i + 1]) {
            cfg.xrpFile = argv[++i];
        } else if (arg === '--output' && argv[i + 1]) {
            cfg.outFile = path.resolve(argv[++i]);
        } else if (arg === '--quiet') {
            cfg.quiet = true;
        } else if (arg === '--help' || arg === '-h') {
            cfg.help = true;
        }
    }

    return cfg;
}

function generateSyntheticPair(btsData, xrpData) {
    const xrpMap = new Map();
    xrpData.forEach((c) => xrpMap.set(c.timestamp, c));

    const synthetic = [];
    btsData.forEach((bts) => {
        const xrp = xrpMap.get(bts.timestamp);
        if (xrp) {
            synthetic.push({
                timestamp: bts.timestamp,
                open: bts.open / xrp.open,
                high: bts.high / xrp.low,
                low: bts.low / xrp.high,
                close: bts.close / xrp.close,
            });
        }
    });

    return synthetic.sort((a, b) => a.timestamp - b.timestamp);
}

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0, maxDriftDown = 0, areaAbove = 0, areaBelow = 0;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const driftUp = (candles[i].high - ama) / ama;
        const driftDown = (ama - candles[i].low) / ama;
        if (driftUp > maxDriftUp) maxDriftUp = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;
        if (candles[i].high > ama) areaAbove += driftUp;
        if (candles[i].low < ama) areaBelow += driftDown;
    }

    return {
        maxDriftUp,
        maxDriftDown,
        areaAbove,
        areaBelow,
        totalArea: areaAbove + areaBelow,
        maxDistance: Math.max(maxDriftUp, maxDriftDown),
    };
}

function defaultUplotComparisonChartPath() {
    return path.join(__dirname, '..', 'charts', 'lp_chart_4h_UNIFIED_COMPARISON.explicit.html');
}

function generateUnifiedComparisonChartUplot(options = {}) {
    const logger = options.logger ?? console;
    let candles = Array.isArray(options.candles) && options.candles.length ? options.candles : null;
    let sourceLabel = 'explicit candle input';
    if (!candles) {
        const btsFile = options.btsFile || options.btsDataFile;
        const xrpFile = options.xrpFile || options.xrpDataFile;
        if (!btsFile || !xrpFile) {
            throw new Error('Synthetic uPlot comparison requires --bts-file and --xrp-file');
        }
        candles = generateSyntheticPair(loadData(btsFile), loadData(xrpFile));
        sourceLabel = `${path.basename(btsFile)} + ${path.basename(xrpFile)}`;
    }
    const outFile = options.outFile ? path.resolve(options.outFile) : defaultUplotComparisonChartPath();
    const strategies = Array.isArray(options.strategies) && options.strategies.length
        ? options.strategies
        : [...FALLBACK_STRATEGIES];

    logger.log(`Data:        ${sourceLabel} (${candles.length} candles)`);

    const closes = candles.map((c) => c.close);
    const amaResults = [];

    logger.log('');
    for (const [i, strategy] of strategies.entries()) {
        const values = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candles);
        amaResults.push({ ...strategy, lineWidth: i === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Area:     ${metrics.totalArea.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const meta = options.meta || {
        pool: null,
        assetA: { symbol: 'XRP' },
        assetB: { symbol: 'BTS' },
        intervalSeconds: 14400,
        fetchedAt: new Date().toISOString(),
    };
    const candleArrays = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0]);
    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    const html = generateHTML(meta, candleArrays, amaResults);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    logger.log(`Open:        file://${outFile}`);

    return { outFile, candles, amaResults, meta, candleArrays };
}

function run() {
    const { btsFile, xrpFile, outFile, quiet, help } = parseArgs();
    if (help) {
        showHelp();
        return;
    }
    if (!btsFile || !xrpFile) {
        showHelp();
        process.exitCode = 1;
        return;
    }

    if (!quiet) {
        console.log('════════════════════════════════════════════════');
        console.log(' Unified Comparison Chart Generator (Synthetic, uPlot)');
        console.log('════════════════════════════════════════════════\n');
    }

    try {
        generateUnifiedComparisonChartUplot({
            btsFile,
            xrpFile,
            outFile,
            logger: quiet ? { log() {} } : console,
        });
    } catch (e) {
        console.error('Error loading synthetic comparison data:', e.message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    run();
}

module.exports = {
    calculateMetrics,
    defaultUplotComparisonChartPath,
    generateSyntheticPair,
    generateUnifiedComparisonChartUplot,
    loadData,
    parseArgs,
    showHelp,
    run,
};
