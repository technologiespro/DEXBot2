const assert = require('assert');
const path = require('path');

console.log('Running market adapter service tests');

const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { detectMissingCandleTimestamps, fillCandleGaps, mergeCandles, pruneStaleTail } = require('../market_adapter/candle_utils');
const { calculateATR } = require('../market_adapter/core/strategies/atr/calculator');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');
const { normalizeAtrPeriod, normalizeMaxVolatilityOffset, normalizeVolatilityThreshold } = require('../market_adapter/core/config_normalizers');
const { computeRegimeMultiplier } = require('../market_adapter/core/strategies/regime_gate');
const { MARKET_ADAPTER } = require('../modules/constants');
const { calculateAMA, getAmaWarmupBars } = require('../analysis/ama_fitting/ama');
const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { buildKalmanVelocitySeries, computeAbsolutePercentileThreshold } = require('../analysis/trend_detection/kalman_velocity_smoothing');
const { sleepUntilAlignedBoundary } = require('../market_adapter/test_helpers');

function generateCandles(count, price) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateVolatileFlatCandles(count, close = 100, high = 110, low = 90) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, close, high, low, close, 1]);
    }
    return candles;
}

function generateTrendingCandles(count, start = 100, step = 0.2) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        const price = start + i * step;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateTrendShiftCandles(count, start = 100) {
    const candles = [];
    const baseTs = 1700000000000;
    let open = start;
    for (let i = 0; i < count; i++) {
        let drift = 0.28;
        if (i >= 110 && i < 190) drift = -0.42;
        else if (i >= 190 && i < 250) drift = 0.06;
        else if (i >= 250) drift = 0.36;

        const wave = ((i % 9) - 4) * 0.035;
        const close = Math.max(1, open + drift + wave);
        const high = Math.max(open, close) + 0.45 + ((i % 5) * 0.03);
        const low = Math.max(0.01, Math.min(open, close) - 0.38 - ((i % 4) * 0.02));
        candles.push([baseTs + i * 3600000, open, high, low, close, 1]);
        open = close;
    }
    return candles;
}

function generateUpThenFlatCandles(upCount, flatCount, start = 100, step = 1) {
    const candles = [];
    const baseTs = 1700000000000;
    let price = start;
    for (let i = 0; i < upCount; i++) {
        price = start + i * step;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    for (let i = 0; i < flatCount; i++) {
        const index = upCount + i;
        candles.push([baseTs + index * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function latchConfirmedSeries(appliedSeries, preGainSeries, confirmBars) {
    const echoedAppliedSeries = new Array(appliedSeries.length).fill(0);
    const echoedPreGainSeries = new Array(preGainSeries.length).fill(0);

    if (confirmBars === 0) {
        for (let i = 0; i < appliedSeries.length; i++) {
            echoedAppliedSeries[i] = appliedSeries[i];
            echoedPreGainSeries[i] = preGainSeries[i];
        }
        return { echoedAppliedSeries, echoedPreGainSeries };
    }

    let latchedSign = 0;
    let pendingSign = 0;
    let pendingCount = 0;
    let latchedApplied = 0;
    let latchedPreGain = 0;

    for (let i = 0; i < appliedSeries.length; i++) {
        const raw = appliedSeries[i];
        const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
        if (sign === latchedSign) {
            pendingSign = 0;
            pendingCount = 0;
            latchedApplied = raw;
            latchedPreGain = preGainSeries[i];
        } else {
            if (pendingSign !== sign) {
                pendingSign = sign;
                pendingCount = 1;
            } else {
                pendingCount++;
            }
            if (pendingCount >= confirmBars) {
                latchedSign = sign;
                pendingSign = 0;
                pendingCount = 0;
                latchedApplied = raw;
                latchedPreGain = preGainSeries[i];
            }
        }
        echoedAppliedSeries[i] = latchedApplied;
        echoedPreGainSeries[i] = latchedPreGain;
    }

    return { echoedAppliedSeries, echoedPreGainSeries };
}

function buildDynamicWeightParityInputs(candles, cfg, botAma) {
    const closes = candles.map((c) => Number(c[4])).filter((value) => Number.isFinite(value) && value > 0);
    const amaErPeriod = cfg.amaSlope?.erPeriod ?? botAma.erPeriod;
    const amaSlowPeriod = cfg.amaSlope?.slowPeriod ?? botAma.slowPeriod;
    const lookbackBars = cfg.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const amaValues = calculateAMA(closes, botAma);
    const amaPrice = amaValues[amaValues.length - 1] ?? null;
    const atrPeriod = normalizeAtrPeriod(cfg.atrPeriod);
    const atr = calculateATR(candles, atrPeriod);
    const weightVariance = Number.isFinite(atr) && amaPrice > 0 ? (atr / amaPrice) : 0;

    const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
    const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const amaSlopeMaxPct = cfg.amaSlope?.maxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const kalmanSlopeMaxPct = cfg.kalmanSlope?.maxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
    const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
    const amaFastPeriod = cfg.amaSlope?.fastPeriod ?? botAma.fastPeriod;
    const amaWarmupBars = getAmaWarmupBars(amaErPeriod, amaSlowPeriod, lookbackBars, amaFastPeriod);

    let amaClipThreshold = Infinity;
    if (clipPercentile > 0 && amaValues.length > amaWarmupBars) {
        const amaSlopes = [];
        for (let i = amaWarmupBars; i < amaValues.length; i++) {
            const last = amaValues[i];
            const past = amaValues[i - lookbackBars];
            if (past > 0) amaSlopes.push(Math.abs((last - past) / past * 100));
        }
        if (amaSlopes.length > 0) {
            amaSlopes.sort((a, b) => a - b);
            const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * amaSlopes.length), amaSlopes.length - 1);
            amaClipThreshold = amaSlopes[idx];
        }
    }

    const slopeCfg = {
        ...(cfg.amaSlope || {}),
        erPeriod: amaErPeriod,
        slowPeriod: amaSlowPeriod,
        fastPeriod: amaFastPeriod,
        maxSlopeOffset: cfg.maxSlopeOffset,
        maxVolatilityOffset: volatilityClamp,
        volatilityExponent: cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        volatilityScaleX: cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        volatilityThreshold: normalizeVolatilityThreshold(cfg.volatilityThreshold),
        neutralZonePct: nz,
        clipPercentile,
        clipThreshold: amaClipThreshold,
    };

    const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

    const kalman = new KalmanTrendAnalyzer({
        rNoise: cfg.kalman?.rNoise ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
        qTactical: cfg.kalman?.qTactical ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
        qModal: cfg.kalman?.qModal ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
        warmupBars: cfg.kalman?.warmupBars ?? 20,
    });
    const kalmanHistory = [];
    for (const close of closes) kalmanHistory.push(kalman.update(close));

    const kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanHistory, {
        kalmanSmoothPct: cfg.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
        kalmanDispScaleMult: cfg.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT,
        kalmanDispThresholdMult: cfg.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT,
        kalmanSmoothSpanPct: cfg.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT,
    });
    const kalmanWarmupBars = kalman.warmupBars ?? 20;
    const kalClipThreshold = computeAbsolutePercentileThreshold(
        kalmanSmoothedVelocityPct.slice(kalmanWarmupBars),
        clipPercentile,
        Infinity
    );

    const regimeSensitivity = cfg.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY;
    const absoluteThreshold = cfg.absoluteThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT;
    const regimeMultipliers = new Array(closes.length).fill(1.0);
    if (regimeSensitivity > 0) {
        const regimeResult = computeRegimeMultiplier(closes, {
            regimeSensitivity,
            regimeTable: cfg.regimeTable,
            hurstZoneBand: cfg.hurstZoneBand,
            peNodes: cfg.peNodes,
        });
        if (Array.isArray(regimeResult.series) && regimeResult.series.length === closes.length) {
            for (let i = 0; i < closes.length; i++) {
                const rawMult = regimeResult.series[i];
                regimeMultipliers[i] = Math.abs(rawMult - 1.0) >= absoluteThreshold ? rawMult : 1.0;
            }
        }
    }

    const alpha = cfg.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA;
    const dw = cfg.dw ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW;
    const gain = cfg.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN;
    const minOutputThreshold = cfg.minOutputThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD;
    const signalConfirmBars = Math.max(0, Math.min(5, Math.round(
        cfg.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT
    )));
    const dispScaleMinPct = cfg.dispScaleMinPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;

    const amaOffsets = [];
    for (let i = 0; i < closes.length; i++) {
        if (!slopeResult.isReady || i < amaWarmupBars) {
            amaOffsets.push(0);
            continue;
        }
        const last = amaValues[i];
        const past = amaValues[i - lookbackBars];
        if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) {
            amaOffsets.push(0);
            continue;
        }
        const slopePct = (last - past) / past * 100;
        const clippedSlopePct = clamp(slopePct, -amaClipThreshold, amaClipThreshold);
        amaOffsets.push(Math.abs(clippedSlopePct) < nz ? 0 : clamp((clippedSlopePct / amaSlopeMaxPct) * offsetClamp, -offsetClamp, offsetClamp));
    }

    const kalmanOffsets = [];
    for (let i = 0; i < kalmanHistory.length; i++) {
        const point = kalmanHistory[i];
        const velocityPct = kalmanSmoothedVelocityPct[i];
        if (!point.isReady || velocityPct == null || point.displacementPct == null) {
            kalmanOffsets.push(0);
            continue;
        }

        const clippedVelocityPct = clamp(velocityPct, -kalClipThreshold, kalClipThreshold);
        if (Math.abs(clippedVelocityPct) < nz) {
            kalmanOffsets.push(0);
            continue;
        }

        const dispScale = Math.max(1.0, dispScaleMinPct);
        const dispConf = Math.min(Math.abs(point.displacementPct) / dispScale, 1.0);
        const momAlign = Math.max(
            0,
            (clippedVelocityPct * point.displacementPct) /
            (Math.abs(clippedVelocityPct) * Math.abs(point.displacementPct) + 1e-10)
        );
        const composite = clippedVelocityPct * (1 - dw + dw * dispConf * momAlign);
        kalmanOffsets.push(clamp((composite / kalmanSlopeMaxPct) * offsetClamp, -offsetClamp, offsetClamp));
    }

    return {
        alpha,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        offsetClamp,
        amaOffsets,
        kalmanOffsets,
        regimeMultipliers,
        slopeResult,
    };
}

function computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput }) {
    const {
        alpha,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        offsetClamp,
        amaOffsets,
        kalmanOffsets,
        regimeMultipliers,
    } = parityInputs;

    const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
    const combinedOffSeries = new Array(amaOffsets.length).fill(0);
    const gatedOffSeries = new Array(amaOffsets.length).fill(0);

    for (let i = 0; i < amaOffsets.length; i++) {
        const blendedOff = (alpha * (amaOffsets[i] / channelNorm) + (1 - alpha) * (kalmanOffsets[i] / channelNorm));
        const gatedOff = Math.abs(blendedOff * regimeMultipliers[i]) < minOutputThreshold ? 0 : (blendedOff * regimeMultipliers[i]);
        const appliedOff = clampFinalOutput
            ? clamp(gatedOff * gain, -offsetClamp, offsetClamp)
            : (gatedOff * gain);
        gatedOffSeries[i] = gatedOff;
        combinedOffSeries[i] = roundTo(appliedOff, 3);
    }

    const { echoedAppliedSeries, echoedPreGainSeries } = latchConfirmedSeries(
        combinedOffSeries,
        gatedOffSeries,
        signalConfirmBars
    );

    return {
        gatedOffSeries,
        combinedOffSeries,
        echoedOffSeries: echoedAppliedSeries,
        echoedGatedOffSeries: echoedPreGainSeries,
        rawFinalOff: combinedOffSeries[combinedOffSeries.length - 1] ?? 0,
        rawFinalPreGainOff: gatedOffSeries[gatedOffSeries.length - 1] ?? 0,
        finalPreGainOff: echoedPreGainSeries[echoedPreGainSeries.length - 1] ?? 0,
        finalOff: echoedAppliedSeries[echoedAppliedSeries.length - 1] ?? 0,
    };
}

async function testTriggerHookCalledOnThreshold() {
    let triggerHookCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => generateCandles(110, 105),
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {
        onTrigger: async (payload) => {
            triggerHookCalls += 1;
            assert.strictEqual(payload.botKey, 'xrp-bts-0');
            assert.strictEqual(payload.triggerPath, '/tmp/recalculate.xrp-bts-0.trigger');
        },
    });

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire when delta exceeds threshold');
    assert.strictEqual(triggerHookCalls, 1, 'onTrigger hook should be called exactly once');
}

async function testNumericStartPriceSkipsAllMarketFetches() {
    let resolveCalls = 0;
    let poolCalls = 0;
    let bookCalls = 0;
    let saveCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => {
            resolveCalls += 1;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'AAA' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
                marketSource: 'pool',
            };
        },
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_fixed_1h.json`),
        loadJson: () => {
            throw new Error('loadJson should not run for fixed startPrice bots');
        },
        saveJson: () => {
            saveCalls += 1;
        },
        calculateBotThreshold: () => 0.75,
        kibanaSource: {
            getLpCandlesForPool: async () => {
                poolCalls += 1;
                throw new Error('pool fetch should not run for fixed startPrice bots');
            },
        },
        kibanaMarketSource: {
            getMarketCandles: async () => {
                bookCalls += 1;
                throw new Error('orderbook fetch should not run for fixed startPrice bots');
            },
        },
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'Fixed',
        botKey: 'fixed-start-price',
        assetA: 'AAA',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 1.25,
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should short-circuit successfully');
    assert.strictEqual(result.source, 'fixed-start-price', 'fixed startPrice should use the fixed-price source label');
    assert.strictEqual(resolveCalls, 0, 'resolveBotContext should not run for fixed startPrice bots');
    assert.strictEqual(poolCalls, 0, 'LP fetch should be skipped for fixed startPrice bots');
    assert.strictEqual(bookCalls, 0, 'orderbook fetch should be skipped for fixed startPrice bots');
    assert.strictEqual(saveCalls, 0, 'no candle file should be written for fixed startPrice bots');
    assert.strictEqual(state.bots['fixed-start-price'].priceMode, 'fixed', 'state should record fixed-price mode');
    assert.strictEqual(state.bots['fixed-start-price'].candleFile, null, 'fixed-price state should clear any previous candle file reference');
    assert.strictEqual(state.bots['fixed-start-price'].centerPrice, null, 'fixed-price state should clear any previous market center');
}

async function testOrderbookNativeFetchUsesBitsharesHistory() {
    let savedPayload = null;
    let nativeCalls = 0;
    let kibanaCalls = 0;

    const lastTs = 1700003600000;
    const nowMs = 1700007200000;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: Array.from({ length: 90 }, (_, idx) => {
                const ts = lastTs - ((89 - idx) * 3600000);
                const price = idx < 89 ? 0.19 : 0.2;
                return [ts, price, price, price, price, 8];
            }),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.75,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1 }),
        withRetries: async (fn) => fn(),
        fillCandleGaps,
        fetchNativeMarketHistorySince: async (assetA, assetB, sinceMs, untilMs, intervalSeconds, options) => {
            nativeCalls += 1;
            assert.strictEqual(assetA.symbol, 'IOB.XRP', 'native history should query the requested assetA');
            assert.strictEqual(assetB.symbol, 'BTS', 'native history should query the requested assetB');
            assert.strictEqual(intervalSeconds, 3600, 'native history should query the 1h bucket');
            assert.strictEqual(options.fillCandleGaps, fillCandleGaps, 'native history should use the shared gap filler');
            assert.strictEqual(sinceMs, lastTs - 3600000, 'incremental native fetch should overlap one bucket back');
            assert.strictEqual(untilMs, nowMs, 'native fetch should cap at the current cycle time');
            return [
                [lastTs, 0.2, 0.2, 0.2, 0.2, 18],
                [lastTs + 3600000, 0.22, 0.22, 0.22, 0.22, 19],
            ];
        },
        kibanaMarketSource: {
            getMarketCandles: async () => {
                kibanaCalls += 1;
                throw new Error('orderbook Kibana fetch should not run when native history is available');
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for orderbook bots');
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            for (const candle of existing) map.set(candle[0], candle);
            for (const candle of incoming) map.set(candle[0], candle);
            return [...map.values()].sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'IOB.XRP/BTS',
        botKey: 'iob-xrp-bts-book',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    };

    const state = {
        bots: {
            'iob-xrp-bts-book': {
                centerPrice: 0.2,
                amaCenterPrice: 0.2,
                lastClosedCandleTs: lastTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed for orderbook bots');
    assert.strictEqual(nativeCalls, 1, 'orderbook mode should use native BitShares history');
    assert.strictEqual(kibanaCalls, 0, 'orderbook mode should not hit Kibana when native history returns data');
    assert.strictEqual(result.source, 'native-book-history', 'orderbook mode should label native history updates');
    assert.ok(savedPayload?.candles?.length >= 3, 'native merge should retain the prior candle and add new history');
    assert.strictEqual(savedPayload.meta.marketSource, 'book', 'saved payload should mark the bot as orderbook sourced');
}

async function testAmaWarmupInsufficientSuppressesRawCloseRecenter() {
    let triggerWrites = 0;
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(30, 105) }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-warmup.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-warmup',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = { bots: { 'xrp-bts-warmup': { centerPrice: 100, amaCenterPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete during AMA warmup');
    assert.strictEqual(result.triggered, false, 'raw close price must not trigger recenter during warmup');
    assert.strictEqual(result.amaPrice, null, 'AMA price should be unavailable during insufficient warmup');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_warmup_insufficient', 'warmup suppression reason should be reported');
    assert.strictEqual(triggerWrites, 0, 'warmup suppression must not write a trigger');
    assert.strictEqual(dynamicGridWrites, 0, 'warmup suppression must not persist a raw-close center');
    assert.strictEqual(state.bots['xrp-bts-warmup'].centerPrice, 100, 'existing center should be preserved');
}

async function testKibanaBackfillFillsHistoricalShortfall() {
    let kibanaCalls = 0;
    const backfillCandles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < 54; i++) {
        backfillCandles.push([baseTs - (54 - i) * 3600000, 100, 100, 100, 100, 1]);
    }

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(60, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (poolId, assetA, assetB, options) => {
                kibanaCalls += 1;
                if (options.timeRange) {
                    return backfillCandles;
                }
                return [];
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach(c => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => {
            if (candles.length <= keepCount) return candles;
            return candles.slice(candles.length - keepCount);
        },
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-backfill.trigger',
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-backfill',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with backfill');
    assert.strictEqual(result.kibanaBackfillCount, 54, 'backfill should report all candles returned by Kibana');
    assert.strictEqual(result.candleCount, 114, 'total candles should equal merged set when rawKeepCount exceeds available candles');
    assert.ok(result.source.includes('kibana-backfill'), 'source label should include backfill marker');
    assert.strictEqual(kibanaCalls, 1, 'kibana should be called exactly once for backfill');
}

function buildRestartCandles(rawCount, nowMs, price = 100, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const currentBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;
    const firstTs = currentBucketStartMs - ((rawCount - 1) * bucketMs);
    const candles = [];
    for (let i = 0; i < rawCount; i++) {
        const ts = firstTs + (i * bucketMs);
        candles.push([ts, price, price, price, price, 1]);
    }
    return candles;
}

function buildOlderBackfillCandles(existingOldestTs, count, price = 100, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const candles = [];
    for (let i = count; i >= 1; i--) {
        const ts = existingOldestTs - (i * bucketMs);
        candles.push([ts, price, price, price, price, 1]);
    }
    return candles;
}

async function testRestartBackfillsOldAma3WindowBeforeWaitingForNextClosedCandle() {
    const ama3 = MARKET_ADAPTER.AMAS.AMA3;
    const intervalSeconds = 3600;
    const nowMs = Date.parse('2026-05-06T12:30:00Z');
    const analysisKeepCount = getAmaWarmupBars(
        ama3.erPeriod,
        ama3.slowPeriod,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama3.fastPeriod
    ) + 1;
    const rawKeepCount = analysisKeepCount + 1;
    const oldRawCount = 1836;
    const missingCount = rawKeepCount - oldRawCount;
    const oldCandles = buildRestartCandles(oldRawCount, nowMs, 100, intervalSeconds);
    const latestClosedTs = oldCandles[oldCandles.length - 2][0];
    const backfillCandles = buildOlderBackfillCandles(oldCandles[0][0], missingCount, 100, intervalSeconds);
    let kibanaCalls = 0;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;
    let savedPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, ...ama3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_restart_wait_1h.json`),
        loadJson: () => ({ candles: oldCandles }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                return options.timeRange ? backfillCandles : [];
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach((c) => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => candles.length <= keepCount ? candles : candles.slice(candles.length - keepCount),
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-restart-wait.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-restart-wait',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama3',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-restart-wait': {
                centerPrice: 100,
                lastClosedCandleTs: latestClosedTs,
            },
        },
    };

    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'restart should complete successfully');
    assert.strictEqual(result.pendingClosedCandle, true, 'without a new closed candle the adapter should wait after backfilling');
    assert.strictEqual(result.triggered, false, 'backfilling an old window alone must not trigger a grid update');
    assert.strictEqual(result.triggerSuppressedReason, 'waiting_for_new_closed_candle', 'restart should report the closed-candle gate when history was repaired but no new close exists');
    assert.strictEqual(result.kibanaBackfillCount, missingCount, 'restart should fetch exactly the missing historical candles');
    assert.strictEqual(result.candleCount, rawKeepCount, 'raw retained candle count should be expanded to the new AMA3 target');
    assert.strictEqual(result.analysisCandleCount, analysisKeepCount, 'effective analysis candles should exclude only the live partial bucket');
    assert.strictEqual(result.rawKeepCount, rawKeepCount, 'result should expose the updated raw retention target');
    assert.strictEqual(result.analysisKeepCount, analysisKeepCount, 'result should expose the updated analysis retention target');
    assert.ok(result.source.includes('kibana-backfill'), 'restart source should show that historical repair occurred');
    assert.strictEqual(kibanaCalls, 1, 'restart should perform a single targeted historical backfill request');
    assert.strictEqual(triggerWrites, 0, 'closed-candle gate should prevent a grid trigger after backfill');
    assert.strictEqual(dynamicGridWrites, 0, 'closed-candle gate should prevent AMA center persistence after backfill');
    assert.ok(savedPayload, 'repaired candle file should be persisted');
    assert.strictEqual(savedPayload.meta.candleCount, rawKeepCount, 'saved raw candle file should contain the expanded retention window');
    assert.strictEqual(savedPayload.meta.analysisCandleCount, analysisKeepCount, 'saved metadata should record the effective closed-candle window');
}

async function testRestartBackfillsOldAma3WindowAndTriggersWhenDeltaThresholdIsExceeded() {
    const ama3 = MARKET_ADAPTER.AMAS.AMA3;
    const intervalSeconds = 3600;
    const nowMs = Date.parse('2026-05-06T12:30:00Z');
    const analysisKeepCount = getAmaWarmupBars(
        ama3.erPeriod,
        ama3.slowPeriod,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama3.fastPeriod
    ) + 1;
    const rawKeepCount = analysisKeepCount + 1;
    const oldRawCount = 1836;
    const missingCount = rawKeepCount - oldRawCount;
    const oldCandles = buildRestartCandles(oldRawCount, nowMs, 100, intervalSeconds);
    const latestClosedTs = oldCandles[oldCandles.length - 2][0];
    const backfillCandles = buildOlderBackfillCandles(oldCandles[0][0], missingCount, 100, intervalSeconds);
    let kibanaCalls = 0;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, ...ama3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_restart_trigger_1h.json`),
        loadJson: () => ({ candles: oldCandles }),
        saveJson: () => {},
        calculateBotThreshold: () => MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                return options.timeRange ? backfillCandles : [];
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach((c) => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => candles.length <= keepCount ? candles : candles.slice(candles.length - keepCount),
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-restart-trigger.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-restart-trigger',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama3',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-restart-trigger': {
                centerPrice: 95,
                lastClosedCandleTs: latestClosedTs - (intervalSeconds * 1000),
            },
        },
    };

    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'restart should complete successfully');
    assert.strictEqual(result.kibanaBackfillCount, missingCount, 'restart should fetch the missing historical candles before analysis');
    assert.strictEqual(result.candleCount, rawKeepCount, 'raw retained candle count should be expanded to the new AMA3 target');
    assert.strictEqual(result.analysisCandleCount, analysisKeepCount, 'effective analysis candles should match the updated AMA3 window');
    assert.strictEqual(result.triggered, true, 'after a repaired restart window, a threshold breach should still trigger a grid update');
    assert.ok(result.deltaPercent > MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 'restart trigger should be driven by a real AMA delta above threshold');
    assert.strictEqual(result.amaPrice, 100, 'flat repaired history should yield the expected AMA center');
    assert.ok(result.source.includes('kibana-backfill'), 'restart source should show the historical repair path');
    assert.strictEqual(kibanaCalls, 1, 'restart should perform one targeted historical backfill request');
    assert.strictEqual(dynamicGridWrites, 1, 'threshold trigger should persist the refreshed AMA center once');
    assert.strictEqual(triggerWrites, 1, 'threshold trigger should write exactly one grid-reset marker');
    assert.strictEqual(state.bots['xrp-bts-restart-trigger'].lastClosedCandleTs, latestClosedTs, 'restart should advance the consumed closed-candle cursor after a successful trigger');
    assert.strictEqual(state.bots['xrp-bts-restart-trigger'].centerPrice, 100, 'restart should persist the new AMA center after the trigger');
}

async function testBootstrapFallsBackWhenKibanaIsEmpty() {
    let kibanaCalls = 0;
    let nativeCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                kibanaCalls += 1;
                return [];
            },
        },
        fetchNativeTradesSince: async () => {
            nativeCalls += 1;
            return [{
                tsMs: 1700000000000,
                sell: { asset_id: '1.3.1', amount: 10000 },
                received: { asset_id: '1.3.0', amount: 100000 },
            }];
        },
        tradesToCandles: () => [[1700000000000, 100, 100, 100, 100, 1]],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with native bootstrap source');
    assert.strictEqual(result.source, 'native-bootstrap', 'bootstrap should use native candles when Kibana is empty');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be attempted once');
    assert.strictEqual(nativeCalls, 1, 'native bootstrap should be called once');
}

async function testAmaGridPriceIsCaseInsensitive() {
    let writeAmaCenterCalls = 0;
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: () => {
            writeAmaCenterCalls += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'AMA',
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire on threshold breach');
    assert.strictEqual(writeAmaCenterCalls, 1, 'AMA center should be written for uppercase AMA mode');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
}

async function testAmaTriggerSuppressedWhenCenterPersistFails() {
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: () => false,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete');
    assert.strictEqual(result.triggered, false, 'trigger should be suppressed if AMA center cannot be persisted');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_center_persist_failed', 'suppression reason should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written when center persistence fails');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'center price should not advance when trigger is suppressed');
    assert.strictEqual(state.bots['xrp-bts-0'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the persisted snapshot');
}

async function testBootstrapCenterDoesNotAdvanceWhenPersistFails() {
    let triggerWrites = 0;
    let writeAttempts = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-bootstrap.trigger';
        },
        writeBotDynamicGrid: () => {
            writeAttempts += 1;
            return writeAttempts > 1;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-bootstrap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const contextCache = new Map();
    const firstResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(firstResult.ok, true, 'processBot should still complete on bootstrap persistence failure');
    assert.strictEqual(firstResult.triggered, false, 'bootstrap persistence failure should not produce a trigger');
    assert.strictEqual(firstResult.triggerSuppressedReason, 'ama_center_persist_failed', 'bootstrap failure should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written during bootstrap persistence failure');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].centerPrice, undefined, 'bootstrap baseline should remain unset so the next cycle retries');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].amaCenterPrice, undefined, 'bootstrap raw AMA center should remain unset when snapshot persistence fails');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].lastGridResetAt, undefined, 'bootstrap state should not pretend a reset happened');
    assert.strictEqual(state.bots['xrp-bts-bootstrap'].lastClosedCandleTs, null, 'failed bootstrap persistence should not consume the closed candle');

    const secondResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(secondResult.ok, true, 'bootstrap retry should still complete');
    assert.strictEqual(secondResult.triggered, true, 'bootstrap retry should create trigger to recalibrate after fresh bootstrap');
    assert.strictEqual(secondResult.triggerSuppressedReason, null, 'successful bootstrap retry should clear the suppression reason');
    assert.strictEqual(writeAttempts, 2, 'the same closed candle should be retried after bootstrap persistence failure');
    assert.strictEqual(secondResult.pendingClosedCandle, false, 'successful retry should process the closed candle rather than skip it');
    assert.ok(Number.isFinite(state.bots['xrp-bts-bootstrap'].centerPrice), 'bootstrap retry should establish the center baseline');
    assert.ok(Number.isFinite(state.bots['xrp-bts-bootstrap'].lastClosedCandleTs), 'successful bootstrap retry should finally consume the closed candle');
}

// Center remains AMA when there is no offset. Trigger fires from AMA delta.
async function testCenterEqualsAmaTriggeredByAmaDelta() {
    let triggerWrites = 0;
    let writeArgs = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 100),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            writeArgs = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    // Previous center 95 → AMA moved to 100 → delta = 5.26% > threshold 0.25% → triggered
    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 95,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'AMA movement should trigger recenter');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
    assert.ok(Array.isArray(writeArgs), 'writeBotDynamicGrid should be called');
    assert.strictEqual(writeArgs[0], 'xrp-bts-0');
    assert.strictEqual(writeArgs[1], 100, 'written center should be the AMA center');
    assert.strictEqual(writeArgs[2].amaCenterPrice, 100, 'raw AMA center should be persisted separately');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'center updates to new AMA');
    assert.strictEqual(state.bots['xrp-bts-0'].amaCenterPrice, 100, 'raw AMA center tracked separately');
}

// When AMA equals previous center, the center is unchanged → no trigger even with low threshold.
// The adapter still refreshes the dynamic snapshot so the bot side can consume the latest
// calculation output on the next grid reset.
async function testNoTriggerWhenCenterMatchesAma() {
    let triggerWrites = 0;
    let lastWrite = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 100),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-0.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    // Previous center = AMA → center unchanged → no trigger
    const state = {
        bots: {
            'xrp-bts-0': {
                centerPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.deltaPercent, 0, 'delta should be zero when center is unchanged');
    assert.strictEqual(result.triggered, false, 'no trigger when effective center equals previous center');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written');
    assert.ok(Array.isArray(lastWrite), 'unchanged center should still refresh the dynamic snapshot');
    assert.strictEqual(lastWrite[0], 'xrp-bts-0');
    assert.strictEqual(lastWrite[1], 100, 'snapshot refresh should preserve the current center');
    assert.strictEqual(lastWrite[2].amaCenterPrice, 100, 'snapshot refresh should persist the AMA center');
    assert.ok(lastWrite[2].dynamicWeights, 'snapshot refresh should persist dynamic weight metadata');
    assert.strictEqual(state.bots['xrp-bts-0'].centerPrice, 100, 'stored center should remain unchanged');
}

// Center is clamped to bot.minPrice/maxPrice bounds when AMA drifts outside them.
async function testCenterClampedByBotBounds() {
    let triggerWrites = 0;
    let lastWrite = null;

    // AMA = 110, bot bounds [99, 101] → center = 101 (clamped to maxPrice)
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 110),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-1.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    // AMA=110 is above maxPrice=101 → clamped to 101. Previous center=110 → delta = 8.2% > 0.5% → triggered.
    const clampedBot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        minPrice: 99,
        maxPrice: 101,
        incrementPercent: 0.4,
    };
    const clampedState = {
        bots: {
            'xrp-bts-1': {
                centerPrice: 110,
            },
        },
    };

    const clampedResult = await service.processBot(clampedBot, clampedState, cfg, new Map(), {});
    assert.strictEqual(clampedResult.ok, true);
    assert.strictEqual(clampedResult.triggered, true, 'clamped center change should trigger recenter');
    assert.strictEqual(clampedState.bots['xrp-bts-1'].centerPrice, 101, 'center should be clamped to maxPrice');
    assert.strictEqual(lastWrite[1], 101, 'written center should match clamped value');
    assert.strictEqual(lastWrite[2].amaCenterPrice, 110, 'raw AMA center should be persisted separately');

    // AMA=110, previous=101 (already at clamp boundary) → no center change → no trigger.
    const noOpBot = { ...clampedBot, botKey: 'xrp-bts-3' };
    const noOpState = {
        bots: {
            'xrp-bts-3': {
                centerPrice: 101,
            },
        },
    };
    const noOpResult = await service.processBot(noOpBot, noOpState, cfg, new Map(), {});
    assert.strictEqual(noOpResult.ok, true);
    assert.strictEqual(noOpResult.triggered, false, 'no trigger when clamping keeps center unchanged');
    assert.strictEqual(noOpState.bots['xrp-bts-3'].centerPrice, 101, 'center should remain at clamp boundary');
    assert.strictEqual(triggerWrites, 1, 'only the initial clamp move should have triggered');
}

async function testContextCacheInvalidatesOnPoolChange() {
    let resolveCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async (bot) => {
            resolveCalls += 1;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: bot.poolId,
            };
        },
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };
    const contextCache = new Map();

    const firstBot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        poolId: '1.19.133',
    };

    const secondBot = {
        ...firstBot,
        poolId: '1.19.999',
    };

    await service.processBot(firstBot, state, cfg, contextCache, {});
    await service.processBot(secondBot, state, cfg, contextCache, {});

    assert.strictEqual(resolveCalls, 2, 'context should be re-resolved after pool change');
    assert.strictEqual(state.bots['xrp-bts-0'].poolId, '1.19.999', 'state should store refreshed pool context');
}

async function testKibanaGapRepairPatchesMissingCandles() {
    let savedPayload = null;
    let kibanaCalls = 0;
    let kibanaTimeRange = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700007200000, 102, 102, 102, 102, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                kibanaTimeRange = cfg.timeRange;
                return [
                    [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
                ];
            },
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with Kibana gap repair');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be queried once to patch the gap');
    assert.deepStrictEqual(
        kibanaTimeRange,
        {
            gte: '2023-11-14T22:13:20.000Z',
            lte: '2023-11-15T01:13:19.999Z',
        },
        'Kibana repair should fetch slightly more than the missing bucket window'
    );
    assert.strictEqual(result.kibanaGapRepairCount, 1, 'patched gap count should be reported in result');
    assert.strictEqual(result.unresolvedGapCount, 0, 'no gaps should remain after Kibana repair');
    assert.strictEqual(state.bots['xrp-bts-0'].kibanaGapRepairCount, 1, 'state should track retained Kibana repairs');
    assert.strictEqual(state.bots['xrp-bts-0'].unresolvedGapCount, 0, 'state should track remaining gaps');
    assert.strictEqual(savedPayload.meta.kibanaGapRepairCount, 1, 'saved candle payload should include Kibana repair count');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 0, 'saved candle payload should include remaining gap count');
    assert.deepStrictEqual(
        savedPayload.candles,
        [
            [1700000000000, 100, 100, 100, 100, 1],
            [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
            [1700007200000, 102, 102, 102, 102, 1],
        ],
        'AMA should be computed from the Kibana-patched candle series'
    );
}

function testGapRepairRangeUsesSuspiciousGapThresholdInsteadOfNativeBackfillWindow() {
    const service = new MarketAdapterService({});
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const missingTimestamps = Array.from({ length: 12 }, (_, i) => baseTs + ((i + 1) * hour));

    const maxHours = service.getGapRepairMaxHours({
        intervalSeconds: 3600,
        nativeBackfillHours: 6,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    });
    const range = service.buildGapRepairTimeRange(missingTimestamps, 3600, maxHours);

    assert.strictEqual(maxHours, 38, 'gap repair should be capped by the suspicious-gap threshold plus context, not nativeBackfillHours');
    assert.deepStrictEqual(
        range,
        {
            gte: new Date(baseTs).toISOString(),
            lte: new Date(baseTs + (14 * hour) - 1).toISOString(),
        },
        'a 12-hour repair range should not be truncated to the 6h native backfill window'
    );
}

async function testRemainingGapsAreReportedWhenKibanaHasNoPatchData() {
    let savedPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700007200000, 102, 102, 102, 102, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete when Kibana cannot patch a gap');
    assert.strictEqual(result.kibanaGapRepairCount, 0, 'no Kibana repairs should be reported when nothing is returned');
    assert.strictEqual(result.unresolvedGapCount, 1, 'remaining gaps should be exposed in the result');
    assert.strictEqual(state.bots['xrp-bts-0'].unresolvedGapCount, 1, 'state should retain unresolved gap count');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 1, 'saved payload should retain unresolved gap count');
}

async function testNativeIncrementalFillsNoTradeGapsUpToStaleTailThreshold() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (14 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [{ tsMs: baseTs + (13 * hour) }],
        tradesToCandles: () => [
            [baseTs + (13 * hour), 113, 113, 113, 113, 2],
        ],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-native-gap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-native-gap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete after bounded native no-trade fill');
    assert.deepStrictEqual(
        savedPayload.candles.map((c) => c[0]),
        Array.from({ length: 14 }, (_, i) => baseTs + (i * hour)),
        'a 12-hour no-trade gap before the next trade should be kept as continuous hourly candles'
    );
    assert.strictEqual(savedPayload.candles[1][4], 100, 'filled no-trade candles should carry the previous close');
    assert.strictEqual(savedPayload.candles[12][4], 100, 'all no-trade candles before the new trade should stay flat');
    assert.strictEqual(savedPayload.candles[13][4], 113, 'the new trade candle should remain the real incoming candle');
    assert.strictEqual(result.unresolvedGapCount, 0, 'bounded no-trade gaps should not be reported as unresolved');
}

async function testNativeIncrementalDoesNotFillNoTradeGapsPastStaleTailThreshold() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (38 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 30.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-native-long-gap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-native-long-gap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete when long no-trade gaps are left unfilled');
    assert.deepStrictEqual(
        savedPayload.candles,
        [[baseTs, 100, 100, 100, 100, 1]],
        'no-trade gaps beyond the stale-tail threshold should not be synthesized by native incremental fill'
    );
    assert.strictEqual(result.staleData, true, 'long no-trade runs should surface as stale data');
}

async function testStaleTailThresholdCanBeOverriddenPerConfig() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (3 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-stale-tail.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-stale-tail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        staleTailThreshold: 2,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with a custom stale-tail threshold');
    assert.deepStrictEqual(
        savedPayload.candles,
        [[baseTs, 100, 100, 100, 100, 1]],
        'custom staleTailThreshold should prune the trailing zero-volume flat tail'
    );
}

async function testNativeIncrementalUsesTradeSequenceOverlap() {
    let savedPayload = null;
    let tradesToCandlesInput = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            meta: {
                nativeRecentTradeSequences: [100, 99],
                nativeLastTradeTs: baseTs + 1000,
            },
            candles: [
                [baseTs, 100, 110, 90, 100, 10],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => {
            throw new Error('time-based native fetch should not run when sequence overlap metadata exists');
        },
        fetchNativeTradesUntilOverlap: async (_poolId, overlapSequences, minOverlap) => {
            assert.deepStrictEqual(overlapSequences, [100, 99], 'stored native sequence watermark should drive overlap fetch');
            assert.strictEqual(minOverlap, 2, 'incremental fetch should require two overlapping trades');
            return {
                pages: 1,
                overlapCount: 2,
                trades: [
                    { tsMs: baseTs + 3000, sequence: 102 },
                    { tsMs: baseTs + 2000, sequence: 101 },
                    { tsMs: baseTs + 1000, sequence: 100 },
                    { tsMs: baseTs + 500, sequence: 99 },
                ],
            };
        },
        tradesToCandles: (trades) => {
            tradesToCandlesInput = trades;
            return [
                [baseTs, 108, 120, 105, 115, 2],
            ];
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-native-overlap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-native-overlap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const result = await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with sequence-overlap native fetch');
    assert.deepStrictEqual(
        tradesToCandlesInput.map((t) => t.sequence),
        [102, 101],
        'overlapping native trades must validate continuity but must not be re-aggregated'
    );
    assert.deepStrictEqual(
        savedPayload.candles[0],
        [baseTs, 100, 120, 90, 115, 12],
        'new trades in an existing bucket should merge into the saved candle instead of replacing it with a partial candle'
    );
    assert.deepStrictEqual(savedPayload.meta.nativeRecentTradeSequences, [102, 101, 100, 99], 'native sequence watermark should advance from fetched rows');
    assert.strictEqual(savedPayload.meta.nativeOverlapCount, 2, 'saved metadata should expose overlap count');
    assert.strictEqual(savedPayload.meta.nativePagesFetched, 1, 'saved metadata should expose native page count');
}

async function testTimeBasedNativeIncrementalDoesNotReaggregateExistingBuckets() {
    let savedPayload = null;
    let tradesToCandlesInput = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 110, 90, 105, 3],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [
            { tsMs: baseTs + 3000, sequence: null },
            { tsMs: baseTs + hour + 1000, sequence: null },
        ],
        tradesToCandles: (trades) => {
            tradesToCandlesInput = trades;
            return [
                [baseTs + hour, 120, 120, 120, 120, 2],
            ];
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-native-time-window.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-native-time-window',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const result = await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with time-based native fallback');
    assert.deepStrictEqual(
        tradesToCandlesInput.map((t) => t.tsMs),
        [baseTs + hour + 1000],
        'time-based native fallback should not re-aggregate trades from existing candle buckets'
    );
    assert.deepStrictEqual(
        savedPayload.candles,
        [
            [baseTs, 100, 110, 90, 105, 3],
            [baseTs + hour, 120, 120, 120, 120, 2],
        ],
        'existing candle OHLCV should remain unchanged when fallback fetch overlaps its bucket'
    );
}

async function testClosedCandleGateSkipsCurrentPartialHour() {
    let triggerWrites = 0;
    let weightWrites = 0;
    let savedPayload = null;
    const nowMs = Date.parse('2026-01-01T01:30:00Z');
    const closedTs = Date.parse('2026-01-01T00:00:00Z');
    const partialTs = Date.parse('2026-01-01T01:00:00Z');

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: (() => {
                const candles = [];
                // Prehistory: enough closed candles to satisfy AMA convergence warmup
                for (let i = 0; i < 23; i++) {
                    candles.push([closedTs - (23 - i) * 3600000, 100, 100, 100, 100, 1]);
                }
                candles.push([closedTs, 100, 100, 100, 100, 1],
                             [partialTs, 110, 110, 110, 110, 1]);
                return candles;
            })(),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => {
            throw new Error('calcAmaComparison should not run before a new closed candle exists');
        },
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.xrp-bts-closed-hour.trigger';
        },
        writeBotDynamicGrid: () => {
            weightWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-closed-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-closed-0': {
                centerPrice: 100,
                lastClosedCandleTs: closedTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    const expectedAnalysisKeepCount = getAmaWarmupBars(1, 3, MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS, 2) + 1;
    const expectedRawKeepCount = expectedAnalysisKeepCount + 1;

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.pendingClosedCandle, true, 'current partial hour should be ignored');
    assert.strictEqual(result.triggered, false, 'no trigger should fire before a new closed candle exists');
    assert.strictEqual(result.analysisCandleCount, 24, 'all closed prehistory candles + the new closed candle should be used for analysis');
    assert.strictEqual(result.rawKeepCount, expectedRawKeepCount, 'result should surface the retained raw candle target');
    assert.strictEqual(result.analysisKeepCount, expectedAnalysisKeepCount, 'result should surface the effective closed-candle target');
    assert.strictEqual(result.lastCandleTs, partialTs, 'raw latest candle timestamp should still be reported');
    assert.strictEqual(result.lastClosedCandleTs, closedTs, 'closed candle timestamp should drive the signal');
    assert.strictEqual(triggerWrites, 0, 'grid reset should not run for a partial candle');
    assert.strictEqual(weightWrites, 0, 'weight writes should not run for a partial candle');
    assert.ok(savedPayload, 'raw candle file should still be persisted');
    assert.strictEqual(savedPayload.meta.candleCount, 25, 'raw candle payload should keep prehistory + closed + partial candles');
    assert.strictEqual(savedPayload.meta.analysisCandleCount, 24, 'raw candle payload should record closed-candle count including prehistory');
    assert.strictEqual(savedPayload.meta.rawKeepCount, expectedRawKeepCount, 'raw candle payload should persist the retained raw target');
    assert.strictEqual(savedPayload.meta.analysisKeepCount, expectedAnalysisKeepCount, 'raw candle payload should persist the closed-candle target');
    assert.strictEqual(state.bots['xrp-bts-closed-0'].centerPrice, 100, 'state should remain unchanged when waiting for a close');
}

async function testClosedCandleGateSurfacesStaleData() {
    let savedPayload = null;
    let stalenessChecks = 0;
    const staleTs = Date.parse('2026-01-01T00:00:00Z');

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_stale_1h.json`),
        loadJson: () => ({
            candles: [
                [staleTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => {
            stalenessChecks += 1;
            return { staleData: true, staleAgeHours: 13.5 };
        },
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => {
            throw new Error('calcAmaComparison should not run while stale data blocks closed-candle processing');
        },
        getNowMs: () => Date.parse('2026-01-01T13:30:00Z'),
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-stale-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'xrp-bts-stale-0': {
                centerPrice: 100,
                lastClosedCandleTs: staleTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete when data is stale');
    assert.strictEqual(stalenessChecks, 1, 'staleness must be evaluated before returning from the closed-candle gate');
    assert.strictEqual(result.staleData, true, 'stale status should be surfaced to the caller');
    assert.strictEqual(result.staleAgeHours, 13.5, 'stale age should be preserved');
    assert.strictEqual(result.pendingClosedCandle, false, 'stale data should not masquerade as a normal pending close');
    assert.strictEqual(result.triggerSuppressedReason, 'stale_candle_data', 'suppression reason should distinguish stale data from a normal wait');
    assert.ok(savedPayload, 'raw candle payload should still be persisted');
    assert.strictEqual(state.bots['xrp-bts-stale-0'].pendingClosedCandle, false, 'state should not mark stale data as a pending close');
    assert.strictEqual(state.bots['xrp-bts-stale-0'].staleData, true, 'state should retain stale status');
    assert.strictEqual(state.bots['xrp-bts-stale-0'].lastTriggerSuppressedReason, 'stale_candle_data', 'state should persist the stale suppression reason');
}

async function testClosedCandlePruningRetainsFullDynamicWeightWarmup() {
    let writtenPayload = null;
    let pruneKeepCount = null;
    const intervalSeconds = 3600;
    const bucketMs = intervalSeconds * 1000;
    const baseTs = Date.parse('2026-01-01T00:00:00Z');
    const candles = [
        [baseTs + 0 * bucketMs, 100, 100, 100, 100, 1],
        [baseTs + 1 * bucketMs, 101, 101, 101, 101, 1],
        [baseTs + 2 * bucketMs, 102, 102, 102, 102, 1],
        [baseTs + 3 * bucketMs, 103, 103, 103, 103, 1],
        [baseTs + 4 * bucketMs, 104, 104, 104, 104, 1],
        [baseTs + 5 * bucketMs, 105, 105, 105, 105, 1],
        [baseTs + 6 * bucketMs, 106, 106, 106, 106, 1],
        [baseTs + 7 * bucketMs, 107, 107, 107, 107, 1],
        [baseTs + 8 * bucketMs, 108, 108, 108, 108, 1],
        [baseTs + 9 * bucketMs, 109, 109, 109, 109, 1],
        [baseTs + 10 * bucketMs, 110, 110, 110, 110, 1],
        [baseTs + 11 * bucketMs, 111, 111, 111, 111, 1],
        [baseTs + 12 * bucketMs, 112, 112, 112, 112, 1],
        [baseTs + 13 * bucketMs, 113, 113, 113, 113, 1],
    ];

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_prune_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (inputCandles, keepCount) => {
            pruneKeepCount = keepCount;
            if (inputCandles.length <= keepCount) return inputCandles;
            return inputCandles.slice(inputCandles.length - keepCount);
        },
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-prune.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => baseTs + (13 * bucketMs) + (30 * 60 * 1000),
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-prune',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-prune': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        amaSlope: {
            lookbackBars: 1,
            maxSlopePct: 0.5,
            neutralZonePct: 0,
        },
        kalmanSlope: {
            maxSlopePct: 0.5,
        },
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    const expectedAnalysisKeepCount = getAmaWarmupBars(1, 2, cfg.amaSlope.lookbackBars, 2) + 1;
    const expectedRawKeepCount = expectedAnalysisKeepCount + 1;

    assert.strictEqual(result.ok, true, 'processBot should succeed with a partial trailing candle');
    assert.strictEqual(result.analysisCandleCount, 11, 'analysis should retain the full closed-candle warmup window');
    assert.strictEqual(result.rawKeepCount, expectedRawKeepCount, 'raw keep target should remain one candle larger than the closed-candle window');
    assert.strictEqual(result.analysisKeepCount, expectedAnalysisKeepCount, 'analysis keep target should match the effective closed-candle window');
    assert.strictEqual(pruneKeepCount, expectedRawKeepCount, 'raw candle pruning should keep one extra bucket beyond the analysis window');
    assert.ok(writtenPayload, 'dynamic weights should still persist when the warmup window is fully retained');
    assert.strictEqual(writtenPayload.dynamicWeights.isReady, true, 'dynamic weights should stay ready after pruning away only the partial bucket');
}

function testSleepUntilAlignedBoundaryAnchorsToCycleStart() {
    const intervalSeconds = 3600;
    const startedAt = Date.parse('2026-01-01T12:59:59.900Z');
    const finishedAt = Date.parse('2026-01-01T13:00:01.500Z');
    const midCycleStartedAt = Date.parse('2026-01-01T12:15:00.000Z');
    const midCycleFinishedAt = Date.parse('2026-01-01T12:20:00.000Z');

    const crossedBoundaryDelay = sleepUntilAlignedBoundary(intervalSeconds, startedAt, finishedAt);
    const midCycleDelay = sleepUntilAlignedBoundary(intervalSeconds, midCycleStartedAt, midCycleFinishedAt);

    assert.strictEqual(crossedBoundaryDelay, 1000, 'crossing a boundary during the cycle should rerun immediately after the buffer');
    assert.strictEqual(midCycleDelay, 2401000, 'sleep should still target the next aligned boundary from the cycle start');
}

async function testIdOnlyBotIsNotRejected() {
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.id-bot.trigger',
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    // Bot with only assetAId/assetBId (no assetA/assetB symbols)
    const bot = {
        name: 'ID-Only-Bot',
        botKey: 'id-only-bot-0',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    assert.strictEqual(result.ok, true, 'ID-only bot should not be rejected by processBot');
    assert.notStrictEqual(result.reason, 'missing asset pair', 'should not fail with missing asset pair');
}

// Flat candles → finalOff = 0, which is below the configured 0.25 threshold.
// Bot side should receive isReady=false and effectiveWeights == baseWeights.
// Requires 1000 candles so slopeResult.isReady=true (AMA3 erPeriod=781, lookback=72 → needs 854+).
async function testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-0.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-0': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0.25,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called via weight-only update path');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles produce finalOff=0 < configured threshold 0.25');
    assert.strictEqual(dw.isReady, false, 'isReady should be false when below min output threshold');
    assert.strictEqual(dw.effectiveWeights.sell, 0.6, 'effectiveWeights.sell should equal static sell when below threshold');
    assert.strictEqual(dw.effectiveWeights.buy, 0.4, 'effectiveWeights.buy should equal static buy when below threshold');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effectiveWeights should equal baseWeights when below threshold');
    assert.strictEqual(dw.minOutputThreshold, 0.25, 'minOutputThreshold should reflect the configured 0.25 override');
}

// With minOutputThreshold=0 the gate is disabled: even finalOff=0 passes, isReady reflects
// slopeResult.isReady (true with enough flat candles), and belowMinOutputThreshold is false.
async function testDynamicWeightMinOutputThresholdZeroDisablesGate() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-1.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-1': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, false, 'minOutputThreshold=0 disables the gate');
    assert.strictEqual(dw.isReady, true, 'isReady should be true when gate is disabled and slopeResult is ready');
    assert.strictEqual(dw.minOutputThreshold, 0, 'cfg.minOutputThreshold=0 should be reflected in payload');
}

async function testDynamicWeightGainScalesOutputLinearly() {
    const runWithGain = async (gain) => {
        let writtenPayload = null;

        const service = new MarketAdapterService({
            resolveBotContext: async () => ({
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
            }),
            resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
            candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
            loadJson: () => ({ candles: generateTrendingCandles(300, 100, 1) }),
            saveJson: () => {},
            calculateBotThreshold: () => 100,
            computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
            withRetries: async (fn) => fn(),
            kibanaSource: { getLpCandlesForPool: async () => [] },
            fetchNativeTradesSince: async () => [],
            tradesToCandles: () => [],
            mergeCandles: (existing, incoming) => [...existing, ...incoming],
            pruneCandles: (candles) => candles,
            calcAmaComparison: () => [],
            writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-gain-neutral.trigger',
            writeBotDynamicGrid: (_botKey, _center, payload) => {
                writtenPayload = payload;
                return true;
            },
            isBotDynamicWeightWhitelisted: () => true,
            root: process.cwd(),
            path,
        });

        const bot = {
            name: 'XRP-BTS',
            botKey: 'xrp-bts-dw-gain-neutral',
            assetA: 'IOB.XRP',
            assetB: 'BTS',
            gridPrice: 'ama',
            incrementPercent: 0.4,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        };

        const state = { bots: { 'xrp-bts-dw-gain-neutral': { centerPrice: 100 } } };
        const cfg = {
            intervalSeconds: 3600,
            bootstrapLookbackHours: 1200,
            nativeBackfillHours: 6,
            pageLimit: 100,
            maxPages: 80,
            sourceRetries: 1,
            retryDelayMs: 0,
            maxStaleHours: 6,
            gain,
            minOutputThreshold: 0,
            signalConfirmBars: 0,
            regimeSensitivity: 0,
            maxSlopeOffset: 10,
        };

        const result = await service.processBot(bot, state, cfg, new Map(), {});
        assert.strictEqual(result.ok, true, 'processBot should succeed');
        assert.ok(writtenPayload, 'dynamic weights should be persisted');
        return writtenPayload.dynamicWeights;
    };

    const lowGain = await runWithGain(0.25);
    const highGain = await runWithGain(2.0);

    assert.ok(Number.isFinite(lowGain.rawFinalOffset), 'low-gain output should be finite');
    assert.ok(Number.isFinite(highGain.rawFinalOffset), 'high-gain output should be finite');
    const normalizedLow = lowGain.rawFinalOffset / 0.25;
    const normalizedHigh = highGain.rawFinalOffset / 2.0;
    assert.ok(Math.abs(normalizedLow - normalizedHigh) < 0.01,
        'gain should act as a linear end-stage scale factor once the blended shape is decided');
    assert.notDeepStrictEqual(lowGain.effectiveWeights, highGain.effectiveWeights,
        'different gain values should produce different effective weights when the signal survives gating');
}

async function testDynamicWeightSignalConfirmBarsCanLatchFlatState() {
    let writtenPayload = null;
    const candles = generateUpThenFlatCandles(90, 8, 100, 1);

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (series) => series,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-confirm-flat.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-confirm-flat',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        alpha: 1,
        gain: 1,
        minOutputThreshold: 0,
        signalConfirmBars: 2,
        regimeSensitivity: 0,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0,
        amaSlope: {
            lookbackBars: 1,
            maxSlopePct: 1,
            neutralZonePct: 0,
        },
    };

    const state = { bots: { 'xrp-bts-dw-confirm-flat': { centerPrice: 100 } } };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload?.dynamicWeights, 'dynamic weights should be persisted');
    assert.strictEqual(writtenPayload.dynamicWeights.rawFinalOffset, 0, 'raw final signal should be flat');
    assert.strictEqual(writtenPayload.dynamicWeights.finalOffset, 0, 'confirmed final signal should latch back to flat');
    assert.strictEqual(result.weights.meta.trendOffset, 0, 'stale positive trend offset should not survive confirmed flat bars');
    assert.deepStrictEqual(writtenPayload.dynamicWeights.effectiveWeights, { sell: 0.6, buy: 0.4 },
        'flat confirmed state should restore static weights');
}

async function testDynamicWeightChartParityMatchesLiveService() {
    let writtenPayload = null;

    const candles = generateTrendShiftCandles(360, 100);
    const botAma = { enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 };
    const staticWeights = { sell: 0.6, buy: 0.4 };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        alpha: 0.35,
        dw: 0.7,
        gain: 1.75,
        signalConfirmBars: 2,
        minOutputThreshold: 0.08,
        regimeSensitivity: 1.0,
        maxSlopeOffset: 0.5,
        clipPercentile: 10,
        kalmanSmoothPct: 60,
        kalmanDispScaleMult: 1.7,
        kalmanDispThresholdMult: 1.15,
        kalmanSmoothSpanPct: 120,
        amaSlope: {
            lookbackBars: 2,
            maxSlopePct: 0.9,
            neutralZonePct: 0.02,
        },
        kalmanSlope: {
            maxSlopePct: 1.8,
        },
    };

    const parityInputs = buildDynamicWeightParityInputs(candles, cfg, botAma);
    const chartSeries = computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput: false });
    const liveSeries = computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput: true });

    assert.ok(
        chartSeries.combinedOffSeries.some((value) => Math.abs(value) > parityInputs.offsetClamp),
        'fixture should exercise chart values above the runtime clamp'
    );
    assert.ok(
        liveSeries.echoedOffSeries.some((value, index) => index > 0 && value !== liveSeries.combinedOffSeries[index]),
        'fixture should exercise signalConfirmBars latching'
    );
    assert.deepStrictEqual(
        liveSeries.gatedOffSeries,
        chartSeries.gatedOffSeries,
        'chart and live runtime should share the same pre-gain gated series'
    );
    assert.deepStrictEqual(
        liveSeries.echoedGatedOffSeries,
        chartSeries.echoedGatedOffSeries,
        'chart and live runtime should share the same confirmed pre-gain state'
    );
    assert.deepStrictEqual(
        liveSeries.combinedOffSeries,
        chartSeries.gatedOffSeries.map((value) => roundTo(clamp(value * parityInputs.gain, -parityInputs.offsetClamp, parityInputs.offsetClamp), 3)),
        'live output should equal the chart shape after final gain and runtime clamping'
    );

    const expectedBelowThreshold = Math.abs(liveSeries.finalPreGainOff) < parityInputs.minOutputThreshold;
    const expectedVolatilityPenalty = parityInputs.slopeResult.isReady ? (parityInputs.slopeResult.symmetricDelta ?? 0) : 0;
    const expectedTrendOffset = expectedBelowThreshold ? 0 : liveSeries.finalOff;
    const expectedEffectiveWeights = {
        sell: roundTo(
            clamp(
                staticWeights.sell + expectedTrendOffset + expectedVolatilityPenalty,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT
            ),
            2
        ),
        buy: roundTo(
            clamp(
                staticWeights.buy - expectedTrendOffset + expectedVolatilityPenalty,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT
            ),
            2
        ),
    };

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => botAma,
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (series) => series,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-parity.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-parity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: staticWeights,
    };

    const state = { bots: { 'xrp-bts-dw-parity': { centerPrice: 100 } } };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.rawFinalOffset, liveSeries.rawFinalOff, 'persisted raw final offset should match the parity model');
    assert.strictEqual(dw.finalOffset, liveSeries.finalOff, 'persisted final offset should match the parity model');
    assert.strictEqual(dw.belowMinOutputThreshold, expectedBelowThreshold, 'persisted threshold gate should match the confirmed pre-gain state');
    assert.deepStrictEqual(dw.effectiveWeights, expectedEffectiveWeights, 'persisted effective weights should match the parity model');
    assert.strictEqual(result.weights.meta.rawFinalOffset, liveSeries.rawFinalOff, 'service metadata should expose the same raw final offset');
    assert.strictEqual(result.weights.meta.finalOffset, liveSeries.finalOff, 'service metadata should expose the same final offset');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, expectedBelowThreshold, 'service metadata should expose the same threshold decision');
    assert.strictEqual(result.weights.meta.trendOffset, expectedTrendOffset, 'applied trend offset should match the parity model');
    assert.deepStrictEqual(
        { sell: result.weights.sell, buy: result.weights.buy },
        expectedEffectiveWeights,
        'service weights should match the parity model'
    );

    const narrowKalCfg = {
        ...cfg,
        kalmanSlope: { maxSlopePct: 0.45 },
    };
    const wideKalCfg = {
        ...cfg,
        kalmanSlope: { maxSlopePct: 1.8 },
    };
    const narrowKalInputs = buildDynamicWeightParityInputs(candles, narrowKalCfg, botAma);
    const wideKalInputs = buildDynamicWeightParityInputs(candles, wideKalCfg, botAma);

    assert.deepStrictEqual(
        narrowKalInputs.amaOffsets,
        wideKalInputs.amaOffsets,
        'AMA offsets should not change when only the Kalman slope knob changes'
    );
    assert.notDeepStrictEqual(
        narrowKalInputs.kalmanOffsets,
        wideKalInputs.kalmanOffsets,
        'Kalman offsets should respond to the separate Kalman slope knob'
    );
}

async function testDynamicWeightVolatilityOnlyPathRemainsReady() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-vol.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-vol',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-vol': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0.08,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.profile, 'volatility', 'volatility-only path should identify its profile');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'volatility penalty should reduce weights');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend component should remain gated off');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles should still fail the trend threshold');
    assert.strictEqual(dw.isReady, true, 'volatility-only payload should remain ready');
    assert.ok(dw.volatilityPenalty < 0, 'payload should expose a negative volatility penalty');
    assert.ok(dw.effectiveWeights.sell < dw.baseWeights.sell, 'sell weight should be reduced by volatility');
    assert.ok(dw.effectiveWeights.buy < dw.baseWeights.buy, 'buy weight should be reduced by volatility');
    assert.notDeepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'volatility-only weights should differ from the static baseline');
}

async function testDynamicWeightVolatilityOverridesFlowIntoService() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-override.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-override',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-override': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        volatilityExponent: 1.0,
        volatilityScaleX: 0.2,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.volatilityPenalty, -0.2, 'service should clamp volatility scaleX to the live/research minimum');
    assert.strictEqual(dw.effectiveWeights.sell, 0.4, 'sell weight should reflect the clamped volatility penalty');
    assert.strictEqual(dw.effectiveWeights.buy, 0.2, 'buy weight should reflect the clamped volatility penalty');
    assert.strictEqual(result.weights.meta.volatilityPenalty, -0.2, 'service metadata should reflect the clamped volatility penalty');
}

async function testDynamicWeightSuppressedTrendUsesFlatProfile() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.2) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-flat-profile.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-flat-profile',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-flat-profile': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        gain: 2.0,
        minOutputThreshold: 2.0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.trend, 'UP', 'raw trend should remain available in metadata');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend output should be gated off by threshold');
    assert.strictEqual(result.weights.meta.trendOffset, 0, 'no trend offset should be applied when threshold suppresses it');
    assert.strictEqual(result.weights.profile, 'flat', 'profile should reflect the applied weighting mode');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.isReady, false, 'suppressed trend without volatility should not be ready');
    assert.strictEqual(dw.outputThreshold, 2, 'live output threshold should stay in pre-gain space');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effective weights should fall back to the static baseline');
}

async function testDynamicWeightWeightOnlyWritesPersistOnClosedCandle() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-persist.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-persist',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-persist': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const firstResult = await service.processBot(bot, state, cfg, new Map(), {});
    const firstWeights = { ...lastPayload.dynamicWeights.effectiveWeights };
    assert.strictEqual(state.bots['xrp-bts-dw-persist'].pendingClosedCandle, false, 'successful closed candle processing should clear the pending flag');
    const secondResult = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(firstResult.pendingClosedCandle, false, 'first closed candle cycle should process normally');
    assert.strictEqual(state.bots['xrp-bts-dw-persist'].pendingClosedCandle, true, 'state should mark the waiting poll after the second pass');
    assert.strictEqual(secondResult.pendingClosedCandle, true, 'second poll with no new closed candle should be skipped');
    assert.strictEqual(writeCount, 1, 'weight-only dynamic weights should only persist when a new closed candle is available');
    assert.deepStrictEqual(lastPayload.dynamicWeights.effectiveWeights, firstWeights, 'identical closed-candle data should yield identical effective weights');
}

async function testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-fail.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return writeCount > 1;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-fail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-dw-fail': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const contextCache = new Map();
    const firstResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(firstResult.ok, true, 'processBot should still complete when weight-only persistence fails');
    assert.strictEqual(firstResult.triggered, false, 'weight-only persistence failure should not create a trigger');
    assert.strictEqual(firstResult.triggerSuppressedReason, 'dynamic_weight_persist_failed', 'failed weight-only write should be surfaced');
    assert.strictEqual(writeCount, 1, 'weight-only persistence should still be attempted');
    assert.strictEqual(state.bots['xrp-bts-dw-fail'].effectiveWeights, null, 'effective weights should not advance when snapshot write fails');
    assert.strictEqual(state.bots['xrp-bts-dw-fail'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
    assert.strictEqual(state.bots['xrp-bts-dw-fail'].lastClosedCandleTs, null, 'failed weight-only persistence should not consume the closed candle');

    const secondResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(secondResult.ok, true, 'retry after weight-only persistence failure should complete');
    assert.strictEqual(secondResult.pendingClosedCandle, false, 'successful retry should process the same closed candle instead of skipping it');
    assert.strictEqual(secondResult.triggerSuppressedReason, null, 'successful retry should clear the persistence failure reason');
    assert.strictEqual(writeCount, 2, 'the same closed candle should be retried after weight-only persistence failure');
    assert.ok(lastPayload?.dynamicWeights, 'successful retry should write the dynamic weight payload');
    assert.ok(state.bots['xrp-bts-dw-fail'].effectiveWeights, 'effective weights should advance after a successful retry');
    assert.ok(Number.isFinite(state.bots['xrp-bts-dw-fail'].lastClosedCandleTs), 'successful retry should finally consume the closed candle');
}

async function testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData() {
    let writeCount = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 12.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-stale.trigger',
        writeBotDynamicGrid: () => {
            writeCount += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-stale',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'xrp-bts-dw-stale': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete with stale data');
    assert.strictEqual(result.staleData, true, 'stale flag should be surfaced');
    assert.strictEqual(result.triggered, false, 'stale data should not create a trigger');
    assert.strictEqual(writeCount, 0, 'stale data should suppress weight-only snapshot writes');
    assert.strictEqual(state.bots['xrp-bts-dw-stale'].effectiveWeights, null, 'stale cycles should not update effective weights');
    assert.strictEqual(state.bots['xrp-bts-dw-stale'].amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
}

async function testDynamicWeightInvalidAtrPeriodAndClampAreSanitized() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-sanitized.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-sanitized',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-sanitized': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        atrPeriod: 0,
        maxVolatilityOffset: -0.25,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.atrPeriod, 14, 'invalid ATR periods should fall back to the default window');
    assert.strictEqual(result.weights.meta.maxVolatilityOffset, 0.5, 'invalid volatility clamps should fall back to the default cap');
    assert.ok(Number.isFinite(result.weights.meta.volatilityPenalty), 'sanitized volatility penalty should stay finite');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'sanitized volatility penalty should remain downward-only');
}

async function testDynamicWeightDiagnosticsComputeWithoutWhitelistForAmaBots() {
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.5) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-diagnostic.trigger',
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-diagnostic',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-diagnostic': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        regimeSensitivity: 0,
        signalConfirmBars: 0,
        maxVolatilityOffset: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 0, 'non-whitelisted AMA bots should not persist dynamic grids');
    assert.strictEqual(result.dynamicWeightWhitelisted, false, 'whitelist flag should remain false');
    assert.strictEqual(result.dynamicWeightReady, true, 'diagnostic dynamic weights should still be computed');
    assert.strictEqual(result.dynamicWeightApplied, false, 'diagnostic weights should not be reported as applied');
    assert.ok(result.weights, 'diagnostic weights should be returned for logging');
    assert.ok(result.amaSlope, 'diagnostic amaSlope should be returned for logging');
    assert.strictEqual(result.weights.meta.source, 'dynamic_weight', 'diagnostic weights should come from the dynamic-weight path');
    assert.strictEqual(state.bots['xrp-bts-dw-diagnostic'].effectiveWeights, null, 'non-whitelisted diagnostics should not update live effective weights');
}

async function testDynamicWeightDiagnosticsDoNotLeakIntoBootstrapState() {
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.5) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.xrp-bts-dw-bootstrap-diagnostic.trigger',
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dw-bootstrap-diagnostic',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'xrp-bts-dw-bootstrap-diagnostic': {} } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        regimeSensitivity: 0,
        signalConfirmBars: 0,
        maxVolatilityOffset: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 1, 'bootstrap should still persist the AMA center snapshot');
    assert.strictEqual(result.dynamicWeightReady, true, 'diagnostic dynamic weights should still be computed');
    assert.strictEqual(result.dynamicWeightApplied, false, 'bootstrap diagnostics should not be reported as applied');
    assert.strictEqual(state.bots['xrp-bts-dw-bootstrap-diagnostic'].effectiveWeights, null, 'non-whitelisted bootstrap diagnostics should not update live effective weights');
}

async function testWeightOnlyUpdateInDryRunUpdatesState() {
    let dynamicGridWrites = 0;
    const closedTs = Date.parse('2026-01-01T12:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_dry_run.json`),
        loadJson: () => ({
            candles: [
                [closedTs - 3 * hour, 100, 100, 100, 100, 1],
                [closedTs - 2 * hour, 100, 100, 100, 100, 1],
                [closedTs - 1 * hour, 100, 100, 100, 100, 1],
                [closedTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 10,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => [],
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => existing,
        pruneCandles: (candles) => candles,
        calcAmaComparison: () => [],
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => closedTs + hour + 60 * 1000,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'XRP-BTS',
        botKey: 'xrp-bts-dry-run',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.5, buy: 0.5 },
    };

    const state = {
        bots: {
            'xrp-bts-dry-run': {
                centerPrice: 100,
                amaCenterPrice: 100,
                lastClosedCandleTs: closedTs - hour,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlope: {
            lookbackBars: 0,
            maxSlopePct: 1,
            neutralZonePct: 0
        }
    };

    const result = await service.processBot(bot, state, cfg, new Map(), { isDryRun: true });

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 0, 'writeBotDynamicGrid should not be called in dry run');
    assert.ok(state.bots['xrp-bts-dry-run'].effectiveWeights, 'state should be updated with effective weights even in dry run');
}

async function run() {
    await testTriggerHookCalledOnThreshold();
    await testNumericStartPriceSkipsAllMarketFetches();
    await testOrderbookNativeFetchUsesBitsharesHistory();
    await testAmaWarmupInsufficientSuppressesRawCloseRecenter();
    await testKibanaBackfillFillsHistoricalShortfall();
    await testRestartBackfillsOldAma3WindowBeforeWaitingForNextClosedCandle();
    await testRestartBackfillsOldAma3WindowAndTriggersWhenDeltaThresholdIsExceeded();
    await testIdOnlyBotIsNotRejected();
    await testBootstrapFallsBackWhenKibanaIsEmpty();
    await testAmaGridPriceIsCaseInsensitive();
    await testAmaTriggerSuppressedWhenCenterPersistFails();
    await testBootstrapCenterDoesNotAdvanceWhenPersistFails();
    await testCenterEqualsAmaTriggeredByAmaDelta();
    await testNoTriggerWhenCenterMatchesAma();
    await testCenterClampedByBotBounds();
    await testContextCacheInvalidatesOnPoolChange();
    await testKibanaGapRepairPatchesMissingCandles();
    testGapRepairRangeUsesSuspiciousGapThresholdInsteadOfNativeBackfillWindow();
    await testRemainingGapsAreReportedWhenKibanaHasNoPatchData();
    await testNativeIncrementalFillsNoTradeGapsUpToStaleTailThreshold();
    await testNativeIncrementalDoesNotFillNoTradeGapsPastStaleTailThreshold();
    await testStaleTailThresholdCanBeOverriddenPerConfig();
    await testNativeIncrementalUsesTradeSequenceOverlap();
    await testTimeBasedNativeIncrementalDoesNotReaggregateExistingBuckets();
    await testClosedCandleGateSkipsCurrentPartialHour();
    await testClosedCandleGateSurfacesStaleData();
    await testClosedCandlePruningRetainsFullDynamicWeightWarmup();
    testSleepUntilAlignedBoundaryAnchorsToCycleStart();
    await testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights();
    await testDynamicWeightMinOutputThresholdZeroDisablesGate();
    await testDynamicWeightGainScalesOutputLinearly();
    await testDynamicWeightSignalConfirmBarsCanLatchFlatState();
    await testDynamicWeightChartParityMatchesLiveService();
    await testDynamicWeightVolatilityOnlyPathRemainsReady();
    await testDynamicWeightVolatilityOverridesFlowIntoService();
    await testDynamicWeightSuppressedTrendUsesFlatProfile();
    await testDynamicWeightWeightOnlyWritesPersistOnClosedCandle();
    await testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState();
    await testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData();
    await testDynamicWeightInvalidAtrPeriodAndClampAreSanitized();
    await testDynamicWeightDiagnosticsComputeWithoutWhitelistForAmaBots();
    await testDynamicWeightDiagnosticsDoNotLeakIntoBootstrapState();
    await testWeightOnlyUpdateInDryRunUpdatesState();
}

run()
    .then(() => {
        console.log('market adapter service tests passed');
    })
    .catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
