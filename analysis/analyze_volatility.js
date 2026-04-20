#!/usr/bin/env node

/**
 * VOLATILITY / SYMMETRIC SHIFT RESEARCH TOOL
 *
 * Computes the symmetric volatility shift used by the market adapter.
 *
 * Signal path:
 *   ATR(period, default 14) -> weightVariance = atr / amaPrice
 *   rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
 *   clampedRawDelta = clamp(rawSymmetricDelta, -DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 0)
 *   symmetricDelta = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
 *
 * The live adapter adds this penalty to both sides after the trend term is built.
 * This runner intentionally omits the directional trend branch so the volatility
 * effect can be researched in isolation.
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
const DEFAULT_ATR_PERIOD = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT;
const MIN_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
const MAX_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
const DEFAULT_THRESHOLD = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD;
const DEFAULT_CLAMP = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;
const MIN_ATR_PERIOD = 3;
const MAX_ATR_PERIOD = 30;
const DEFAULT_CHART_DIR = path.join(__dirname, 'charts');
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'volatility_chart.html');

function normalizeAtrPeriod(period) {
    const n = Math.round(Number(period));
    if (!Number.isFinite(n)) return DEFAULT_ATR_PERIOD;
    return Math.max(MIN_ATR_PERIOD, Math.min(MAX_ATR_PERIOD, n));
}

function computeATRSeries(candles, period = DEFAULT_ATR_PERIOD) {
    const atrs = [];
    let prevClose = Array.isArray(candles[0]) ? candles[0][4] : 0;
    let atrVal = 0;
    const safePeriod = normalizeAtrPeriod(period);

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
        if (i <= safePeriod) {
            atrVal = atrVal === 0 ? tr : (atrVal * (i - 1) + tr) / i;
        } else {
            atrVal = (atrVal * (safePeriod - 1) + tr) / safePeriod;
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
        threshold: DEFAULT_THRESHOLD,
        atrPeriod: DEFAULT_ATR_PERIOD,
        exponent: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        scaleX: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        clamp: DEFAULT_CLAMP,
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
        else if (arg === '--atr-period') {
            const next = parseInt(args[++i], 10);
            if (Number.isFinite(next)) config.atrPeriod = normalizeAtrPeriod(next);
        }
        else if (arg === '--exp') config.exponent = parseFloat(args[++i]);
        else if (arg === '--scale-x') config.scaleX = parseFloat(args[++i]);
        else if (arg === '--clamp') config.clamp = parseFloat(args[++i]);
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function computeShift(weightVariance, exponent, scaleX, threshold, clampValue) {
    const safeVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeExponent = Number.isFinite(exponent) && exponent >= 0 ? exponent : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeScaleX = Number.isFinite(scaleX) && scaleX >= 0 ? scaleX : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_THRESHOLD;
    const safeClamp = Number.isFinite(clampValue) && clampValue >= 0 ? clampValue : DEFAULT_CLAMP;
    const effectiveExponent = Math.max(0.5, Math.min(1.0, safeExponent));
    const effectiveScaleX = Math.max(1.0, Math.min(100.0, safeScaleX));

    const rawDelta = -Math.pow(safeVariance, effectiveExponent) * effectiveScaleX;
    const clampedRawDelta = Math.max(safeClamp * -1, Math.min(0, rawDelta));
    const symmetricDelta = Math.abs(clampedRawDelta) < safeThreshold ? 0 : clampedRawDelta;
    const effectiveWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, 0.5 + symmetricDelta));

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
        const atrPeriod = normalizeAtrPeriod(config.atrPeriod);
        const atrs = computeATRSeries(candles, atrPeriod);

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const amaPrice = ama3Values[i] ?? null;
            const atr = atrs[i] ?? 0;
            const weightVariance = amaPrice > 0 ? atr / amaPrice : 0;
            const shift = computeShift(weightVariance, config.exponent, config.scaleX, config.threshold, config.clamp);

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
            candles,
            atrPeriod: config.atrPeriod,
            volatilityThreshold: config.threshold,
            volatilityExponent: config.exponent,
            volatilityScaleX: config.scaleX,
            volatilityClamp: config.clamp,
            atrPeriod,
            minWeight: MIN_WEIGHT,
            maxWeight: MAX_WEIGHT,
            marketAdapter: MARKET_ADAPTER,
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
