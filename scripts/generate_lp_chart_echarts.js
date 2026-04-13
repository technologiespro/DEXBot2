'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { calculateAMA } = require('../analysis/ama_fitting/ama');
const { loadStrategiesForLpChart } = require('../market_adapter/lp_chart_strategy_loader');
const { generateHTML } = require('../market_adapter/lp_chart_core_echarts');
const {
    loadLpDataFile,
    parseLpChartCliArgs,
} = require('../market_adapter/lp_chart_runner');

function showHelp() {
    console.log(`
LP Chart Generator (ECharts)

Usage:
  node scripts/generate_lp_chart_echarts.js [options]

Options:
  --data FILE   LP export JSON file
  --file FILE   Alias for --data
  --out FILE    Output HTML file
  --no-open     Suppress browser auto-open
  --help        Show this help
    `);
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = Array.isArray(argv) ? argv : [];
    const parsed = parseLpChartCliArgs(args, {
        dataFlags: ['--data', '--file'],
    });
    let outFile = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--out' && args[i + 1]) {
            outFile = path.resolve(args[++i]);
        } else if (arg === '--help' || arg === '-h') {
            return { ...parsed, outFile, help: true };
        }
    }
    return { ...parsed, outFile, help: false };
}

function defaultEchartsMarketChartPath(meta) {
    const suffix = meta?.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta?.assetA?.symbol || '?'}_${meta?.assetB?.symbol || '?'}`;
    return path.join(__dirname, '..', 'market_adapter', `lp_chart_${suffix}.echarts.html`)
        .replace(/\./g, '_')
        .replace('_html', '.html');
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

function generateMarketLpChartEcharts(options = {}) {
    const logger = options.logger ?? console;
    const { dataFile, meta, candleArrays } = loadLpDataFile(options.dataFile);

    logger.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);
    const poolLabel = meta?.pool ? `pool ${meta.pool}` : `${meta?.assetA?.symbol || '?'}\/${meta?.assetB?.symbol || '?'}`;
    logger.log(`  ${candleArrays.length} candles · ${poolLabel}`);

    const closes = candleArrays.map((c) => c[4]);
    const amaConfigs = loadStrategiesForLpChart({
        dataFile,
        meta,
        profilesFile: options.profilesFile ?? null,
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

    const outFile = options.outFile
        ? path.resolve(options.outFile)
        : defaultEchartsMarketChartPath(meta);
    const html = generateHTML(meta, candleArrays, amaResults);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html, 'utf8');

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    if (!options.noOpen) {
        logger.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        logger.log(`Open manually: file://${outFile}`);
    }

    return { dataFile, outFile, amaResults, meta, candleArrays };
}

function run() {
    const { dataFile, noOpen, outFile, help } = parseArgs(process.argv.slice(2));
    if (help) {
        showHelp();
        return;
    }

    return generateMarketLpChartEcharts({
        dataFile,
        noOpen,
        outFile,
        logger: console,
    });
}

if (require.main === module) {
    run();
}

module.exports = {
    defaultEchartsMarketChartPath,
    generateMarketLpChartEcharts,
    openInBrowser,
    parseArgs,
    run,
    showHelp,
};
