#!/usr/bin/env node

/**
 * KALMAN TREND ANALYSIS RUNNER
 *
 * Runs KalmanTrendAnalyzer over candle data and generates an interactive HTML chart.
 *
 * Usage:
 *   node analysis/analyze_kalman_uplot.js \
 *     --source json \
 *     --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { KalmanTrendAnalyzer } = require('./trend_detection/kalman_trend_analyzer');
const { generateHTML } = require('./trend_detection/kalman_chart_generator');
const { createSource } = require('./price_sources');
const { calculateAMA } = require('./ama_fitting/ama');

// Mirror ama_slope_model.js defaults for a fair comparison
const AMA_ER_PERIOD   = 10;
const AMA_FAST        = 2;
const AMA_SLOW        = 30;
const LOOKBACK_BARS   = 72;
const NEUTRAL_ZONE    = 0.15;
const MAX_SLOPE_PCT   = 3.0;
const MAX_SLOPE_OFFSET = 0.5;
const ATR_PERIOD      = 14;

function computeATR(candles) {
    const atrs = [];
    let prevClose = Array.isArray(candles[0]) ? candles[0][4] : 0;
    let atrVal = 0;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const high  = Array.isArray(c) ? c[2] : 0;
        const low   = Array.isArray(c) ? c[3] : 0;
        const close = Array.isArray(c) ? c[4] : 0;
        if (i === 0) { atrs.push(0); prevClose = close; continue; }
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        if (i <= ATR_PERIOD) {
            atrVal = atrVal === 0 ? tr : (atrVal * (i - 1) + tr) / i;
        } else {
            atrVal = (atrVal * (ATR_PERIOD - 1) + tr) / ATR_PERIOD; // Wilder smoothing
        }
        atrs.push(atrVal);
        prevClose = close;
    }
    return atrs;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        source: { type: 'market_adapter', config: { botKey: 'XRP-BTS' } },
        rNoise: 0.05,
        qNoise: 0.005,
        chartFile: 'analysis/charts/kalman_chart.uplot.html',
        quiet: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = args[++i];
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--file') {
            config.source.config.filePath = args[++i];
            config.source.type = 'json';
        }
        else if (arg === '--r') config.rNoise = parseFloat(args[++i]);
        else if (arg === '--q') config.qNoise = parseFloat(args[++i]);
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

async function main() {
    const config = parseArgs();

    try {
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = path.join(__dirname, '..', 'market_adapter', 'state');
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[Kalman] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: config.rNoise,
            qNoise: config.qNoise
        });

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice);
            result.timestamp = timestamp;
            allResults.push(result);
        }

        // ── AMA weight offset (for comparison panel) ─────────────────────────
        const closes    = candles.map(c => Array.isArray(c) ? c[4] : 0);
        const amaValues = calculateAMA(closes, { erPeriod: AMA_ER_PERIOD, fastPeriod: AMA_FAST, slowPeriod: AMA_SLOW });
        const atrs      = computeATR(candles);
        const warmup    = AMA_ER_PERIOD + LOOKBACK_BARS + 1;

        for (let i = 0; i < allResults.length; i++) {
            if (i < warmup) { allResults[i].amaWeightOffset = null; continue; }
            const last = amaValues[i];
            const past = amaValues[i - LOOKBACK_BARS];
            if (!last || !past || past === 0) { allResults[i].amaWeightOffset = null; continue; }
            const slopePct = (last - past) / past * 100;
            if (Math.abs(slopePct) < NEUTRAL_ZONE) {
                allResults[i].amaWeightOffset = 0;
            } else {
                allResults[i].amaWeightOffset = Math.max(-MAX_SLOPE_OFFSET,
                    Math.min(MAX_SLOPE_OFFSET, (slopePct / MAX_SLOPE_PCT) * MAX_SLOPE_OFFSET));
            }
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateHTML({ allResults }, 'Kalman Trend Analysis');
        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[Kalman] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[Kalman] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
