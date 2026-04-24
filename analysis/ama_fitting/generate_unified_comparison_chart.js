'use strict';

const fs = require('fs');
const path = require('path');
const { calculateAMA } = require('./ama');
const { MARKET_ADAPTER } = require('../../modules/constants');

const { generateHTML } = require('../../market_adapter/lp_chart_core');
const {
    LP_DATA_DIR,
    findLatestLpData,
    loadLpDataFile,
} = require('../../market_adapter/lp_chart_runner');

/**
 * UNIFIED COMPARISON CHART GENERATOR — Local LP analysis mode
 *
 * Shows fallback AMA strategies on a local LP candle export. The preferred
 * end-to-end LP workflow is still:
 *   npm run lp:chart -- --data <lp-export.json>
 *
 * This script remains available for analysis-only comparison review and now
 * uses the explicit `ama:chart:lp-local` / `chart:lp-local` naming.
 */

const DEFAULT_COLORS = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
const DEFAULT_DASHES = ['dot', 'solid', 'dash', 'dashdot'];

function buildDefaultStrategies() {
    const presets = MARKET_ADAPTER.AMAS;
    return Object.keys(presets).map((key, i) => ({
        name: presets[key].name || key,
        erPeriod: presets[key].erPeriod,
        fastPeriod: presets[key].fastPeriod,
        slowPeriod: presets[key].slowPeriod,
        color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        dash: DEFAULT_DASHES[i % DEFAULT_DASHES.length],
    }));
}

const FALLBACK_STRATEGIES = buildDefaultStrategies();

function showHelp() {
    console.log(`
Unified Comparison Chart Generator (Local LP)

Usage:
  node analysis/ama_fitting/generate_unified_comparison_chart.js [options]

Options:
  --data FILE     LP candle export JSON file
  --file FILE     Alias for --data
  --output FILE   Output HTML file
  --quiet         Suppress console output
  --help          Show this help

Notes:
  - If --data is omitted, the newest lp_pool_*.json under market_adapter/data/lp is used.
    `);
}

function parseArgs(argv = process.argv.slice(2)) {
    const cfg = {
        dataFile: null,
        outFile: null,
        quiet: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--data' || arg === '--file') && argv[i + 1]) {
            cfg.dataFile = path.resolve(argv[++i]);
        } else if ((arg === '--output' || arg === '--out') && argv[i + 1]) {
            cfg.outFile = path.resolve(argv[++i]);
        } else if (arg === '--quiet') {
            cfg.quiet = true;
        } else if (arg === '--help' || arg === '-h') {
            cfg.help = true;
        }
    }

    return cfg;
}

function intervalLabelFromSeconds(sec) {
    if (!sec || sec <= 0) return 'unknown';
    if (sec % 86400 === 0) return `${sec / 86400}d`;
    if (sec % 3600 === 0) return `${sec / 3600}h`;
    if (sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
}

function defaultLocalComparisonChartPath(intervalLabel) {
    return path.join(__dirname, '..', 'charts', `lp_chart_${intervalLabel}_UNIFIED_COMPARISON.html`);
}

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0;
    let maxDriftDown = 0;
    let areaAbove = 0;
    let areaBelow = 0;
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

function generateLocalLpComparisonChart(options = {}) {
    const logger = options.logger ?? console;
    const dataFile = options.dataFile ? path.resolve(options.dataFile) : findLatestLpData();
    if (!dataFile) {
        throw new Error(`No LP candle exports found under ${LP_DATA_DIR}`);
    }

    const loaded = loadLpDataFile(dataFile);
    const candles = loaded.candleObjects;
    const meta = loaded.meta || {
        pool: null,
        assetA: { symbol: path.basename(dataFile, '.json') },
        assetB: { symbol: '' },
        intervalSeconds: 14400,
        fetchedAt: new Date().toISOString(),
    };
    if (!meta.assetA) meta.assetA = { symbol: path.basename(dataFile, '.json') };
    if (!meta.assetB) meta.assetB = { symbol: '' };
    if (!meta.intervalSeconds) meta.intervalSeconds = 3600;
    if (!meta.fetchedAt) meta.fetchedAt = new Date().toISOString();

    const intervalLabel = intervalLabelFromSeconds(meta.intervalSeconds);
    const outFile = options.outFile ? path.resolve(options.outFile) : defaultLocalComparisonChartPath(intervalLabel);
    const strategies = Array.isArray(options.strategies) && options.strategies.length
        ? options.strategies
        : [...FALLBACK_STRATEGIES];

    logger.log(`Data:        ${path.relative(process.cwd(), dataFile)} (${candles.length} candles)`);
    const closes = candles.map((c) => c.close);
    const amaResults = [];

    logger.log('');
    for (const [index, strategy] of strategies.entries()) {
        const values = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candles);
        amaResults.push({ ...strategy, lineWidth: index === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Area:     ${metrics.totalArea.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const candleArrays = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0]);
    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    const html = generateHTML(meta, candleArrays, amaResults);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    logger.log(`Open:        file://${outFile}`);

    return { dataFile, outFile, candles, amaResults, meta, candleArrays };
}

function run(argv = process.argv.slice(2)) {
    const { dataFile, outFile, quiet, help } = parseArgs(argv);
    if (help) {
        showHelp();
        return;
    }

    if (!quiet) {
        console.log('════════════════════════════════════════════════');
        console.log(' Unified Comparison Chart Generator (Local LP)');
        console.log('════════════════════════════════════════════════');
        console.log('');
    }

    try {
        generateLocalLpComparisonChart({
            dataFile,
            outFile,
            logger: quiet ? { log() {} } : console,
        });
    } catch (e) {
        console.error('Error loading local LP comparison data:', e.message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    run();
}

module.exports = {
    calculateMetrics,
    defaultLocalComparisonChartPath,
    FALLBACK_STRATEGIES,
    generateLocalLpComparisonChart,
    parseArgs,
    run,
    showHelp,
};
