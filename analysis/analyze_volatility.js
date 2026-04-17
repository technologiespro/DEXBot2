#!/usr/bin/env node

/**
 * VOLATILITY / SYMMETRIC SHIFT RESEARCH TOOL
 *
 * Computes normalized weight variance and the symmetric volatility shift used by
 * the market adapter. ATR is still computed internally to derive the variance.
 * Produces an interactive HTML chart with live knobs for threshold, exponent,
 * and scale.
 *
 * Usage:
 *   node analysis/analyze_volatility.js \
 *     --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { createSource } = require('./price_sources');
const { calculateAMA } = require('./ama_fitting/ama');
const { generateHTML } = require('./volatility_detection/volatility_chart_generator');
const { MARKET_ADAPTER } = require('../modules/constants');

const AMA_CONFIG = MARKET_ADAPTER.AMAS.AMA3;
const ATR_PERIOD = 14;
const DEFAULT_CHART_DIR = path.join(__dirname, 'charts');
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'volatility_chart.html');

function computeATRSeries(candles, period = ATR_PERIOD) {
    const atrs = [];
    let prevClose = Array.isArray(candles[0]) ? candles[0][4] : 0;
    let atrVal = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const high = Array.isArray(c) ? c[2] : 0;
        const low = Array.isArray(c) ? c[3] : 0;
        const close = Array.isArray(c) ? c[4] : 0;
        if (i === 0) {
            atrs.push(0);
            prevClose = close;
            continue;
        }
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
        chartFile: DEFAULT_CHART_FILE,
        threshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD,
        exponent: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        scalePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_PCT,
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
        else if (arg === '--threshold') config.threshold = parseFloat(args[++i]);
        else if (arg === '--exp') config.exponent = parseFloat(args[++i]);
        else if (arg === '--scale') config.scalePct = parseFloat(args[++i]);
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function computeShift(weightVariance, exponent, scalePct, threshold) {
    const safeVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeExponent = Number.isFinite(exponent) && exponent >= 0 ? exponent : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeScalePct = Number.isFinite(scalePct) && scalePct >= 0 ? scalePct : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_PCT;
    const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD;
    const effectiveExponent = Math.max(safeExponent, 0.2);
    const effectiveScalePct = Math.max(safeScalePct, 10.0);

    const rawDelta = -Math.pow(safeVariance, effectiveExponent) * (effectiveScalePct / 100);
    const clampedRawDelta = Math.max(-0.5, Math.min(0, rawDelta));
    const symmetricDelta = Math.abs(clampedRawDelta) < safeThreshold ? 0 : clampedRawDelta;
    const effectiveWeight = Math.max(-0.5, Math.min(1.5, 0.5 + symmetricDelta));

    return {
        rawSymmetricDelta: clampedRawDelta,
        symmetricDelta,
        effectiveWeight,
        sellW: effectiveWeight,
        buyW: effectiveWeight,
    };
}

async function main() {
    try {
        const config = parseArgs();
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = path.join(__dirname, '..', 'market_adapter', 'state');
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[Volatility] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const closes = candles.map(c => Array.isArray(c) ? c[4] : 0);
        const ama3Values = calculateAMA(closes, AMA_CONFIG);
        const atrs = computeATRSeries(candles, ATR_PERIOD);

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const amaPrice = ama3Values[i] ?? null;
            const atr = atrs[i] ?? 0;
            const weightVariance = amaPrice > 0 ? atr / amaPrice : 0;
            const shift = computeShift(weightVariance, config.exponent, config.scalePct, config.threshold);

            allResults.push({
                timestamp,
                price: marketPrice,
                ama3Price: amaPrice,
                atr,
                weightVariance,
                rawSymmetricDelta: shift.rawSymmetricDelta,
                symmetricDelta: shift.symmetricDelta,
                effectiveWeight: shift.effectiveWeight,
                sellW: shift.sellW,
                buyW: shift.buyW,
            });
        }

        const html = generateHTML({
            allResults,
            atrPeriod: ATR_PERIOD,
            volatilityThreshold: config.threshold,
            volatilityExponent: config.exponent,
            volatilityScalePct: config.scalePct,
        }, 'ATR Volatility Research');

        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[Volatility] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[Volatility] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
