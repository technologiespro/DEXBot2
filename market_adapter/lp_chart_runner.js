'use strict';

/**
 * LP CHART RUNNER — Shared LP chart orchestration
 *
 * Owns the reusable chart workflow used by:
 * - scripts/generate_lp_chart.js
 * - package.json `lp:chart`
 *
 * Responsibilities:
 * - resolve the input LP data file
 * - load candles and metadata
 * - resolve AMA strategies from optimizer results and/or market profiles
 * - calculate AMA series and comparison metrics
 * - choose output paths
 * - render and write HTML via `lp_chart_core`
 *
 * Non-responsibilities:
 * - rendering HTML internals (`lp_chart_core.js`)
 * - synthetic comparison mode (kept in analysis/ama_fitting)
 * - fetch/export of LP data (`market_adapter/inputs/fetch_lp_data.js`)
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { calculateAMA } = require('./core/strategies/ama');
const { MARKET_ADAPTER } = require('../modules/constants');
const { generateHTML } = require('./lp_chart_core');
const { loadStrategiesForLpChart } = require('./lp_chart_strategy_loader');
const { findLatestLpData } = require('./utils/data_discovery');

const ROOT = path.resolve(__dirname, '..');
const LP_DATA_DIR = path.join(ROOT, 'market_adapter', 'data', 'lp');
const ANALYSIS_CHARTS_DIR = path.join(ROOT, 'analysis', 'charts');
const AMA_PROFILES_FILE = path.join(ROOT, 'profiles', 'market_profiles.json');
const DEFAULT_COMPARISON_COLORS = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
const DEFAULT_COMPARISON_DASHES = ['dot', 'solid', 'dash', 'dashdot'];
const DEFAULT_COMPARISON_STRATEGIES = Object.keys(MARKET_ADAPTER.AMAS).map((key, index) => {
    const ama = MARKET_ADAPTER.AMAS[key];
    return {
        name: ama.name || key,
        erPeriod: ama.erPeriod,
        fastPeriod: ama.fastPeriod,
        slowPeriod: ama.slowPeriod,
        color: DEFAULT_COMPARISON_COLORS[index % DEFAULT_COMPARISON_COLORS.length],
        dash: DEFAULT_COMPARISON_DASHES[index % DEFAULT_COMPARISON_DASHES.length],
    };
});

function parseLpChartCliArgs(argv, options = {}) {
    const args = Array.isArray(argv) ? argv : [];
    const dataFlags = new Set(options.dataFlags ?? ['--data', '--file']);
    const allowPositional = options.allowPositional !== false;
    const includeNoOpen = options.includeNoOpen !== false;
    let dataFile = null;
    let noOpen = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (dataFlags.has(arg) && args[i + 1]) {
            dataFile = path.resolve(args[i + 1]);
            i++;
            continue;
        }
        if (includeNoOpen && arg === '--no-open') {
            noOpen = true;
            continue;
        }
        if (allowPositional && !arg.startsWith('--') && !dataFile) {
            dataFile = path.resolve(arg);
        }
    }

    return { dataFile, noOpen };
}

function normalizeLpCandle(candle, index) {
    if (Array.isArray(candle)) {
        if (candle.length < 5) {
            throw new Error(`Invalid candle row at index ${index}: expected at least 5 entries`);
        }
        return [
            candle[0],
            candle[1],
            candle[2],
            candle[3],
            candle[4],
            candle[5] ?? 0,
        ];
    }

    if (candle && typeof candle === 'object') {
        const { timestamp, open, high, low, close, volume = 0 } = candle;
        if ([timestamp, open, high, low, close].some((value) => value == null)) {
            throw new Error(`Invalid candle object at index ${index}: missing OHLC fields`);
        }
        return [timestamp, open, high, low, close, volume];
    }

    throw new Error(`Invalid candle row at index ${index}: unsupported format`);
}

function resolveLpDataFile(dataFile) {
    const resolved = dataFile ? path.resolve(dataFile) : findLatestLpData();
    if (!resolved) {
        throw new Error('No LP data file found. Use --data <path> or run the fetch step first.');
    }
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    return resolved;
}

function loadLpDataFile(dataFile) {
    const resolved = resolveLpDataFile(dataFile);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const meta = raw.meta ?? null;
    const candles = Array.isArray(raw?.candles) ? raw.candles : raw;
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles in data file.');
    }

    return {
        dataFile: resolved,
        meta,
        candleArrays: candles.map((c, index) => normalizeLpCandle(c, index)),
        candleObjects: candles.map((c, index) => {
            const normalized = normalizeLpCandle(c, index);
            return {
                timestamp: normalized[0],
                open: normalized[1],
                high: normalized[2],
                low: normalized[3],
                close: normalized[4],
                volume: normalized[5] ?? 0,
            };
        }),
    };
}

function openInBrowser(filePath) {
    const url = `file://${filePath}`;
    const cmd = process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.warn(`  Could not auto-open browser: ${err.message}`);
    });
}

function defaultMarketChartPath(meta) {
    const suffix = meta?.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta?.assetA?.symbol || '?'}_${meta?.assetB?.symbol || '?'}`;
    return path.join(ANALYSIS_CHARTS_DIR, `lp_AMA_chart_${suffix}.html`).replace(/\./g, '_').replace('_html', '.html');
}

function defaultComparisonChartPath(meta, dataFile) {
    if (meta?.pool) {
        const suffix = String(meta.pool).replace('1.19.', '');
        return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_pool_${suffix}.comparison.html`);
    }

    const fromMetaA = String(meta?.assetA?.symbol || '').trim();
    const fromMetaB = String(meta?.assetB?.symbol || '').trim();
    if (fromMetaA && fromMetaB) {
        return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_${fromMetaA}_${fromMetaB}.comparison.html`)
            .replace(/\./g, '_')
            .replace('_html', '.html');
    }

    return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_${path.basename(dataFile || 'comparison', '.json')}.comparison.html`)
        .replace(/\./g, '_')
        .replace('_html', '.html');
}

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0;
    let maxDriftDown = 0;
    let cumDevAbove = 0;
    let cumDevBelow = 0;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const driftUp = (candles[i].high - ama) / ama;
        const driftDown = (ama - candles[i].low) / ama;
        if (driftUp > maxDriftUp) maxDriftUp = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;
        if (candles[i].high > ama) cumDevAbove += driftUp;
        if (candles[i].low < ama) cumDevBelow += driftDown;
    }

    return {
        maxDriftUp,
        maxDriftDown,
        cumDevAbove,
        cumDevBelow,
        totalDeviation: cumDevAbove + cumDevBelow,
        maxDistance: Math.max(maxDriftUp, maxDriftDown),
    };
}

function writeChartHtml({ meta, candleArrays, amaResults, outFile }) {
    const html = generateHTML(meta, candleArrays, amaResults);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);
}

function generateMarketLpChart(options = {}) {
    const logger = options.logger ?? console;
    const { dataFile, meta, candleArrays } = loadLpDataFile(options.dataFile);

    logger.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);
    const poolLabel = meta?.pool ? `pool ${meta.pool}` : `${meta?.assetA?.symbol || '?'}\/${meta?.assetB?.symbol || '?'}`;
    logger.log(`  ${candleArrays.length} candles · ${poolLabel}`);

    const closes = candleArrays.map((c) => c[4]);
    const amaConfigs = loadStrategiesForLpChart({
        dataFile,
        meta,
        profilesFile: options.profilesFile ?? AMA_PROFILES_FILE,
    });
    if (!amaConfigs) {
        const pair = `${meta?.assetA?.symbol || '?'} / ${meta?.assetB?.symbol || '?'}`;
        throw new Error(`AMA profile not found for pair ${pair}`);
    }

    const amaResults = amaConfigs.map((cfg) => ({
        ...cfg,
        values: calculateAMA(closes, cfg),
    }));

    const lastClose = closes[closes.length - 1];
    for (const ama of amaResults) {
        const lastAma = ama.values[ama.values.length - 1];
        const deviation = ((lastClose - lastAma) / lastAma) * 100;
        logger.log(`  ${ama.name.padEnd(24)} AMA: ${lastAma.toFixed(6)}  dev: ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);
    }

    const outFile = options.outFile ? path.resolve(options.outFile) : defaultMarketChartPath(meta);
    writeChartHtml({ meta, candleArrays, amaResults, outFile });

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    if (!options.noOpen) {
        logger.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        logger.log(`Open manually: file://${outFile}`);
    }

    return { dataFile, outFile, amaResults, meta, candleArrays };
}

function generateComparisonLpChart(options = {}) {
    const logger = options.logger ?? console;
    const { dataFile, meta, candleArrays, candleObjects } = loadLpDataFile(options.dataFile);
    const defaultStrategies = options.defaultStrategies ?? DEFAULT_COMPARISON_STRATEGIES;
    const strategies = loadStrategiesForLpChart({
        dataFile,
        meta,
        profilesFile: options.profilesFile ?? null,
    }) ?? defaultStrategies;

    logger.log(`Data:        ${path.basename(dataFile)}  (${candleObjects.length} candles)`);
    if (strategies.length && strategies !== defaultStrategies) {
        logger.log('Strategies:  loaded from shared strategy loader');
        strategies.forEach((s) => logger.log(`  ${s.name.padEnd(28)} ER=${s.erPeriod}  Fast=${s.fastPeriod}  Slow=${s.slowPeriod}`));
    } else {
        logger.log('Strategies:  results file not found — using defaults');
    }

    const closes = candleObjects.map((c) => c.close);
    const amaResults = [];
    logger.log('');
    for (const [index, strategy] of strategies.entries()) {
        const values = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candleObjects);
        amaResults.push({ ...strategy, lineWidth: index === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Deviation: ${metrics.totalDeviation.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const outFile = options.outFile ? path.resolve(options.outFile) : defaultComparisonChartPath(meta, dataFile);
    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    writeChartHtml({ meta, candleArrays, amaResults, outFile });
    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    if (!options.noOpen) {
        logger.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        logger.log(`Open:        file://${outFile}`);
    }

    return { dataFile, outFile, amaResults, meta, candleArrays };
}

function generateLpChartBundle(options = {}) {
    const logger = options.logger ?? console;
    const dataFile = resolveLpDataFile(options.dataFile);
    logger.log(`Generating LP charts from ${path.relative(process.cwd(), dataFile)}`);

    const marketChart = generateMarketLpChart({
        dataFile,
        noOpen: options.noOpen,
        logger,
        profilesFile: options.profilesFile,
    });
    const comparisonChart = generateComparisonLpChart({
        dataFile,
        noOpen: options.openComparison === true ? !!options.noOpen : true,
        logger,
        defaultStrategies: options.defaultStrategies ?? DEFAULT_COMPARISON_STRATEGIES,
        profilesFile: options.comparisonProfilesFile ?? null,
    });

    return {
        dataFile,
        marketChart,
        comparisonChart,
    };
}

function runLpChartCli(argv = process.argv.slice(2), options = {}) {
    const { dataFile, noOpen } = parseLpChartCliArgs(argv, {
        dataFlags: options.dataFlags ?? ['--data', '--file'],
    });
    return generateLpChartBundle({
        dataFile,
        noOpen,
        logger: options.logger ?? console,
        profilesFile: options.profilesFile,
        comparisonProfilesFile: options.comparisonProfilesFile,
        defaultStrategies: options.defaultStrategies,
    });
}

module.exports = {
    AMA_PROFILES_FILE,
    DEFAULT_COMPARISON_STRATEGIES,
    defaultComparisonChartPath,
    defaultMarketChartPath,
    findLatestLpData,
    generateComparisonLpChart,
    generateLpChartBundle,
    generateMarketLpChart,
    ANALYSIS_CHARTS_DIR,
    LP_DATA_DIR,
    loadLpDataFile,
    parseLpChartCliArgs,
    resolveLpDataFile,
    runLpChartCli,
};
