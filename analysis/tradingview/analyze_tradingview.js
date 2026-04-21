#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { createSource } = require('../price_sources');
const { generateHTML } = require('./tradingview_uplot_chart_generator');
const { MARKET_ADAPTER } = require('../../modules/constants');
const { toIntervalLabel } = require('../../market_adapter/candle_utils');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'market_adapter', 'data', 'lp', '1_3_5537_1_3_0', 'lp_pool_133_1h.json');
const DEFAULT_CHART_DIR = path.join(__dirname, '..', 'charts');
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'tradingview_chart.html');
const DEFAULT_AMA = MARKET_ADAPTER.AMAS?.AMA3 || MARKET_ADAPTER.AMAS?.[MARKET_ADAPTER.DEFAULT_AMA_KEY || 'AMA3'] || {
    erPeriod: 781,
    fastPeriod: 5.2,
    slowPeriod: 112.7,
};

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        source: { type: 'json', config: { filePath: DEFAULT_FILE } },
        chartFile: DEFAULT_CHART_FILE,
        title: null,
        priceScale: 'log',
        smaPeriod: 500,
        amaErPeriod: DEFAULT_AMA.erPeriod,
        amaFastPeriod: DEFAULT_AMA.fastPeriod,
        amaSlowPeriod: DEFAULT_AMA.slowPeriod,
        smaEnabled: false,
        amaEnabled: false,
        vwapEnabled: false,
        vwapBars: 500,
        quiet: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = String(args[++i] || 'json');
        else if (arg === '--file') {
            config.source.type = 'json';
            config.source.config.filePath = args[++i];
        }
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--title') config.title = args[++i];
        else if (arg === '--price-scale' || arg === '--scale') config.priceScale = String(args[++i] || 'log');
        else if (arg === '--sma-period') config.smaPeriod = Math.max(1, parseInt(args[++i], 10) || 500);
        else if (arg === '--ama-er-period') config.amaErPeriod = Math.max(1, parseInt(args[++i], 10) || DEFAULT_AMA.erPeriod);
        else if (arg === '--ama-fast-period') config.amaFastPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.fastPeriod);
        else if (arg === '--ama-slow-period') config.amaSlowPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.slowPeriod);
        else if (arg === '--no-sma') config.smaEnabled = false;
        else if (arg === '--no-ama') config.amaEnabled = false;
        else if (arg === '--no-vwap') config.vwapEnabled = false;
        else if (arg === '--vwap-bars') config.vwapBars = Math.max(24, parseInt(args[++i], 10) || 500);
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function loadJsonMeta(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return { meta: null, candles: null };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw)) return { meta: null, candles: raw };
    if (raw && Array.isArray(raw.candles)) return { meta: raw.meta || null, candles: raw.candles };
    if (raw && Array.isArray(raw.data)) return { meta: raw.meta || raw || null, candles: raw.data };
    return { meta: null, candles: null };
}

function inferTitle(meta, fallback) {
    const pool = meta?.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : null;
    const a = meta?.assetA?.symbol || meta?.assetA?.id || null;
    const b = meta?.assetB?.symbol || meta?.assetB?.id || null;
    const pair = a && b ? `${a}/${b}` : fallback;
    const label = pool || pair;
    const interval = Number(meta?.intervalSeconds) > 0 ? toIntervalLabel(meta.intervalSeconds) : '1h';
    return `${label} · ${interval} · TradingView`;
}

async function main() {
    try {
        const config = parseArgs();
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = path.join(__dirname, '..', '..', 'market_adapter', 'state');
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[TradingView] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const jsonMeta = config.source.type === 'json' ? loadJsonMeta(srcConfig.filePath).meta : null;
        const title = config.title || inferTitle(jsonMeta, path.basename(srcConfig.filePath || 'tradingview'));

        const html = generateHTML({
            candles,
            meta: jsonMeta || {
                assetA: { symbol: 'Asset A' },
                assetB: { symbol: 'Asset B' },
            },
            smaPeriod: config.smaPeriod,
            amaErPeriod: config.amaErPeriod,
            amaFastPeriod: config.amaFastPeriod,
            amaSlowPeriod: config.amaSlowPeriod,
            smaEnabled: config.smaEnabled,
            amaEnabled: config.amaEnabled,
            vwapEnabled: config.vwapEnabled,
            vwapBars: config.vwapBars,
            priceScale: config.priceScale === 'linear' ? 'linear' : 'log',
            defaultTimeframe: '1h',
            marketAdapter: MARKET_ADAPTER,
        }, title);

        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[TradingView] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[TradingView] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    main,
    parseArgs,
    loadJsonMeta,
    inferTitle,
};
