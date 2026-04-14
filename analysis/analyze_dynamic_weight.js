#!/usr/bin/env node

/**
 * DYNAMIC WEIGHT RESEARCH TOOL
 *
 * Compares AMA-based and Kalman-based dynamic weight calculations.
 * Shows input parameters, intermediate results, and final weight outputs.
 *
 * Usage:
 *   node analysis/analyze_dynamic_weight.js \
 *     --source json \
 *     --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { KalmanTrendAnalyzer } = require('./trend_detection/kalman_trend_analyzer');
const { generateHTML } = require('./trend_detection/dynamic_weight_chart_generator');
const { createSource } = require('./price_sources');
const { calculateAMA } = require('./ama_fitting/ama');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');

// AMA configuration (matching bot defaults)
const AMA_CONFIG = {
    erPeriod: 10,
    fastPeriod: 2,
    slowPeriod: 30,
};

// AMA Slope weight calculation config
const AMA_WEIGHT_CONFIG = {
    lookbackBars: 72,
    maxSlopePct: 3.0,
    neutralZonePct: 0.15,
    maxVolatilityThreshold: 0.03,
    maxSlopeOffset: 0.5,
    maxVolatilityOffset: 0.5,
};

// Kalman configuration
const KALMAN_CONFIG = {
    rNoise: 0.05,
    qTactical: 0.01,
    qModal: 0.0001,
};

function computeATR(candles, period = 14) {
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
        if (i <= period) {
            atrVal = atrVal === 0 ? tr : (atrVal * (i - 1) + tr) / i;
        } else {
            atrVal = (atrVal * (period - 1) + tr) / period;
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
        chartFile: 'analysis/charts/dynamic_weight_chart.html',
        alpha: 0.5,
        maxOff: 0.5,
        dispWeight: 0.4,
        clipPct: 10,
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
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--alpha') config.alpha = parseFloat(args[++i]);
        else if (arg === '--maxoff') config.maxOff = parseFloat(args[++i]);
        else if (arg === '--dw') config.dispWeight = parseFloat(args[++i]);
        else if (arg === '--clip') config.clipPct = parseFloat(args[++i]);
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
        if (!config.quiet) console.log(`[DynamicWeight] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: KALMAN_CONFIG.rNoise,
            qTactical: KALMAN_CONFIG.qTactical,
            qModal: KALMAN_CONFIG.qModal,
        });

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice);
            result.timestamp = timestamp;
            allResults.push(result);
        }

        // ── AMA weight calculation ───────────────────────────────────────────
        const closes = candles.map(c => Array.isArray(c) ? c[4] : 0);
        const amaValues = calculateAMA(closes, AMA_CONFIG);
        const atrs = computeATR(candles, 14);

        for (let i = 0; i < allResults.length; i++) {
            const amaPrice = amaValues[i];
            const atr = atrs[i];
            const weightVariance = amaPrice > 0 ? atr / amaPrice : 0;

            const weights = computeAmaSlopeWeights(amaValues.slice(0, i + 1), weightVariance, {
                erPeriod: AMA_CONFIG.erPeriod,
                lookbackBars: AMA_WEIGHT_CONFIG.lookbackBars,
                maxSlopePct: AMA_WEIGHT_CONFIG.maxSlopePct,
                neutralZonePct: AMA_WEIGHT_CONFIG.neutralZonePct,
                maxVolatilityThreshold: AMA_WEIGHT_CONFIG.maxVolatilityThreshold,
                maxSlopeOffset: AMA_WEIGHT_CONFIG.maxSlopeOffset,
                maxVolatilityOffset: AMA_WEIGHT_CONFIG.maxVolatilityOffset,
            });

            allResults[i].amaPrice = amaPrice;
            allResults[i].atr = atr;
            allResults[i].weightVariance = weightVariance;
            allResults[i].amaSlopePct = weights.slopePct;
            allResults[i].amaWeightReady = weights.isReady;
            allResults[i].amaSellW = weights.sellW;
            allResults[i].amaBuyW = weights.buyW;
            allResults[i].amaSlopeOffset = weights.slopeOffset;
            allResults[i].amaSymmetricDelta = weights.symmetricDelta;
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateHTML({
            allResults,
            amaConfig: AMA_CONFIG,
            amaWeightConfig: AMA_WEIGHT_CONFIG,
            kalmanConfig: KALMAN_CONFIG,
            alpha: config.alpha,
            maxOff: config.maxOff,
            dispWeight: config.dispWeight,
            clipPct: config.clipPct,
        }, 'Dynamic Weight Research Tool');

        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[DynamicWeight] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[DynamicWeight] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
