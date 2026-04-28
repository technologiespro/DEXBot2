#!/usr/bin/env node
'use strict';

/**
 * PRICE ADAPTER (standalone)
 *
 * Purpose:
 * - Runs independently from dexbot runtime
 * - Loads active bots with AMA grid pricing from profiles/bots.json
 * - Uses built-in AMA defaults from constants, optionally overridden by pair-specific
 *   profiles in profiles/market_profiles.json
 * - Bootstraps 1h candles from Kibana once (if local file missing)
 * - Then updates candles from native BitShares API only
 * - Persists candles incrementally, prunes to AMA-required window
 * - Tracks a separate market center price per bot in market_adapter/state
 * - Creates recalculate.<botKey>.trigger when AMA center delta threshold is reached
 *
 * GRID RECALCULATION TRIGGERS (Three Independent Mechanisms):
 * ──────────────────────────────────────────────────────────
 *
 * 1. AMA DELTA THRESHOLD (this file / market adapter)
 *    Triggers when market price moves significantly from last recorded AMA center
 *    ├─ Controlled by: MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT
 *    ├─ Location: profiles/general.settings.json
 *    ├─ Default: 2.5% (grid resets when AMA moves ±2.5%)
 *    ├─ CLI override: --deltaPercent <percent>
 *    └─ Use case: Catch big market moves that require grid repositioning
 *
 * 2. RMS DIVERGENCE CHECK (order/grid.js / grid engine)
 *    Triggers when calculated grid diverges from blockchain state
 *    ├─ Controlled by: GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE
 *    ├─ Location: profiles/general.settings.json
 *    ├─ Default: 14.3% (balanced tolerance)
 *    ├─ Set to 0 to disable (Issue #5: RMS Divergence Check Disabling)
 *    └─ Use case: Detect order fill/rotation accumulation drift
 *
 * 3. GRID REGENERATION (internal threshold)
 *    Triggers when available funds exceed allocation threshold
 *    ├─ Controlled by: GRID_LIMITS.GRID_REGENERATION_PERCENTAGE
 *    ├─ Default: 3% (regen when free balance ≥ 3% of allocated capital)
 *    └─ Use case: Rebalance and utilize accumulated fill proceeds
 *
 * AMA PROFILE SELECTION (per bot via gridPrice keyword):
 * ───────────────────────────────────────────────────────
 *   gridPrice: "ama"  or "ama3" => default (best backtest score)
 *   gridPrice: "ama1"             => min move, cap 25%
 *   gridPrice: "ama2"             => min move, cap 30%
 *   gridPrice: "ama3"             => min move, cap 35%
 *   gridPrice: "ama4"             => min move, cap 40%
 *
 * No wallet keys/password/auth required (read-only chain + Kibana bootstrap).
 */

const fs = require('fs');
const path = require('path');

const { parseJsonWithComments, sleep, ensureDir } = require('../modules/order/utils/system');
const { readGeneralSettings } = require('../modules/general_settings');
const { MARKET_ADAPTER } = require('../modules/constants');
const { createBotKey } = require('../modules/account_orders');
const { calculateAMA } = require('../analysis/ama_fitting/ama');
const {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} = require('./core/config_normalizers');
const {
    resetMarketAdapterWhitelistCache,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
} = require('../modules/market_adapter_whitelist');
const kibanaSource = require('./inputs/kibana_source');
const { normalizePoolId } = kibanaSource;
const { tradesToCandles, detectMissingCandleTimestamps, fillCandleGaps, pruneStaleTail, mergeCandles } = require('./candle_utils');
const { toIntervalLabel } = require('./interval_utils');
const { resolveAsset, findPoolByAssets, resolveBotContext } = require('./utils/chain');
const { acquireFileLockSync, releaseFileLockSync } = require('./utils/file_lock');

const ROOT = path.join(__dirname, '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'market_adapter_state.json');
const CENTER_FILE = path.join(STATE_DIR, 'market_adapter_centers.json');
const LOCK_FILE = path.join(STATE_DIR, 'market_adapter.lock');
const MARKET_PROFILES_FILE = path.join(PROFILES_DIR, 'market_profiles.json');
const MARKET_ADAPTER_SETTINGS_FILE = path.join(PROFILES_DIR, 'market_adapter_settings.json');
let bitsharesClient = null;

function getBitsharesClient() {
    if (!bitsharesClient) {
        bitsharesClient = require('../modules/bitshares_client');
    }
    return bitsharesClient;
}

const LP_OP_TYPE = 63;
const API_MAX_PAGE = 101;

const DEFAULTS = {
    pollSeconds: 3600,
    deltaThresholdPercent: MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
    absoluteThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT,
    intervalSeconds: 3600,
    bootstrapLookbackHours: 720,
    nativeBackfillHours: 6,
    maxStaleHours: 6,
    sourceRetries: 3,
    retryDelayMs: 800,
    metricsJson: false,
    quiet: false,
    dryRun: false,
    whitelistAll: false,
    maxPages: 80,
    pageLimit: 100,
    once: false,
    maxNativeGapFillCandles: 3,
    amaSlope: {
        lookbackBars:  MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        maxSlopePct:   MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
    },
    kalmanSlope: {
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
    },
    atrPeriod: MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT,
};

// Cycle-scoped caches — reset once per runOnce() so each cycle reads files fresh
// but all bots within that cycle share the same loaded data (N bots → 1 file read).
let _marketAdapterSettingsCache = null;

function _resetCycleCache() {
    _marketAdapterSettingsCache = null;
    resetMarketAdapterWhitelistCache();
}

function loadMarketAdapterSettings() {
    if (_marketAdapterSettingsCache !== null) return _marketAdapterSettingsCache;
    if (!fs.existsSync(MARKET_ADAPTER_SETTINGS_FILE)) return null;
    try {
        _marketAdapterSettingsCache = JSON.parse(fs.readFileSync(MARKET_ADAPTER_SETTINGS_FILE, 'utf8'));
        return _marketAdapterSettingsCache;
    } catch (_) {
        return null;
    }
}

function findPairForBot(bot, pairs) {
    if (!Array.isArray(pairs)) return null;
    const botAId = String(bot.assetAId || '');
    const botBId = String(bot.assetBId || '');
    const botA = normalizeAssetSymbol(bot.assetA);
    const botB = normalizeAssetSymbol(bot.assetB);
    return pairs.find((p) => {
        const parts = String(p.key || '').split('|');
        if (botAId && botBId && parts[0] === botAId && parts[1] === botBId) return true;
        if (botA && botB &&
            normalizeAssetSymbol(p.assetASymbol) === botA &&
            normalizeAssetSymbol(p.assetBSymbol) === botB) return true;
        return false;
    }) || null;
}

function applyAmaSlopeOverrides(target, overrides) {
    if (!overrides || typeof overrides !== 'object') return target;
    if (overrides.neutralZonePct != null) {
        target.amaSlope = { ...target.amaSlope, neutralZonePct: overrides.neutralZonePct };
    }
    if (overrides.amaMaxSlopePct != null) {
        target.amaSlope = { ...target.amaSlope, maxSlopePct: overrides.amaMaxSlopePct };
    }
    if (overrides.lookbackBars != null) {
        target.amaSlope = { ...target.amaSlope, lookbackBars: overrides.lookbackBars };
    }
    return target;
}

function applyKalmanSlopeOverrides(target, overrides) {
    if (!overrides || typeof overrides !== 'object') return target;
    if (overrides.maxSlopePct != null) {
        target.kalmanSlope = { ...target.kalmanSlope, maxSlopePct: overrides.maxSlopePct };
    }
    return target;
}

function applyMarketAdapterOverrides(target, overrides, opts = {}) {
    if (!overrides || typeof overrides !== 'object') return target;
    if (overrides.deltaThresholdPercent != null) target.deltaThresholdPercent = overrides.deltaThresholdPercent;
    if (opts.includeDefaultAmaKey && overrides.defaultAmaKey) target.defaultAmaKey = overrides.defaultAmaKey;
    if (overrides.pollSeconds != null) target.pollSeconds = overrides.pollSeconds;
    if (overrides.bootstrapLookbackHours != null) target.bootstrapLookbackHours = overrides.bootstrapLookbackHours;
    if (overrides.nativeBackfillHours != null) target.nativeBackfillHours = overrides.nativeBackfillHours;
    if (overrides.maxStaleHours != null) target.maxStaleHours = overrides.maxStaleHours;
    if (overrides.sourceRetries != null) target.sourceRetries = overrides.sourceRetries;
    if (overrides.retryDelayMs != null) target.retryDelayMs = overrides.retryDelayMs;
    if (overrides.maxSlopeOffset != null) target.maxSlopeOffset = overrides.maxSlopeOffset;
    if (overrides.maxVolatilityOffset != null) {
        target.maxVolatilityOffset = normalizeMaxVolatilityOffset(overrides.maxVolatilityOffset);
    }
    if (overrides.atrPeriod != null) target.atrPeriod = normalizeAtrPeriod(overrides.atrPeriod);
    if (overrides.absoluteThreshold != null) target.absoluteThreshold = overrides.absoluteThreshold;
    if (overrides.minOutputThreshold != null) target.minOutputThreshold = overrides.minOutputThreshold;
    if (overrides.volatilityExponent != null) target.volatilityExponent = overrides.volatilityExponent;
    if (overrides.volatilityScaleX != null) target.volatilityScaleX = overrides.volatilityScaleX;
    if (overrides.volatilityThreshold != null) {
        target.volatilityThreshold = normalizeVolatilityThreshold(overrides.volatilityThreshold);
    }
    if (overrides.clipPercentile != null) target.clipPercentile = overrides.clipPercentile;
    if (overrides.regimeSensitivity != null) target.regimeSensitivity = overrides.regimeSensitivity;
    if (overrides.hurstZoneBand != null) target.hurstZoneBand = overrides.hurstZoneBand;
    if (overrides.peNodes) target.peNodes = overrides.peNodes;
    if (overrides.regimeTable) target.regimeTable = overrides.regimeTable;
    if (overrides.alpha != null) target.alpha = overrides.alpha;
    if (overrides.dw != null) target.dw = overrides.dw;
    if (overrides.gain != null) target.gain = overrides.gain;
    if (overrides.kalmanSmoothPct != null) target.kalmanSmoothPct = overrides.kalmanSmoothPct;
    if (overrides.kalmanDispScaleMult != null) target.kalmanDispScaleMult = overrides.kalmanDispScaleMult;
    if (overrides.kalmanDispThresholdMult != null) target.kalmanDispThresholdMult = overrides.kalmanDispThresholdMult;
    if (overrides.kalmanSmoothSpanPct != null) target.kalmanSmoothSpanPct = overrides.kalmanSmoothSpanPct;
    if (overrides.signalConfirmBars != null) target.signalConfirmBars = overrides.signalConfirmBars;
    if (overrides.dispScaleMinPct != null) target.dispScaleMinPct = overrides.dispScaleMinPct;
    if (overrides.kalman) target.kalman = overrides.kalman;
    if (overrides.kalmanMaxSlopePct != null) target.kalmanSlope = { ...target.kalmanSlope, maxSlopePct: overrides.kalmanMaxSlopePct };
    applyKalmanSlopeOverrides(target, overrides.kalmanSlope);
    applyAmaSlopeOverrides(target, overrides);
    return target;
}

function resolveBotCfg(bot, globalCfg) {
    const settings = loadMarketAdapterSettings();
    if (!settings) return globalCfg;

    let merged = { ...globalCfg };

    // Apply global amaSlope overrides from settings file
    const globals = settings.globals || {};
    if (globals.amaSlope && typeof globals.amaSlope === 'object') {
        merged.amaSlope = { ...merged.amaSlope, ...globals.amaSlope };
    }
    if (globals.kalmanSlope && typeof globals.kalmanSlope === 'object') {
        merged.kalmanSlope = { ...merged.kalmanSlope, ...globals.kalmanSlope };
    }

    // Pair-level overrides
    const pair = findPairForBot(bot, settings.pairs);
    if (pair?.marketAdapterSettings) {
        applyMarketAdapterOverrides(merged, pair.marketAdapterSettings);
    }

    // Bot-level overrides
    const botOverride = pair?.botOverrides?.[bot.name];
    if (botOverride) {
        applyMarketAdapterOverrides(merged, botOverride, { includeDefaultAmaKey: true });
    }

    return merged;
}

const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY || 'AMA3').toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS || {};
const DEFAULT_AMA = BUILTIN_AMAS[DEFAULT_AMA_KEY] || BUILTIN_AMAS.AMA3 || { erPeriod: 781, fastPeriod: 5.2, slowPeriod: 112.7 };
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);
const AMA_PRESET_KEYS = ['AMA1', 'AMA2', 'AMA3', 'AMA4'];

function normalizeAmaPreset(raw) {
    const erPeriod = Number(raw?.erPeriod);
    const fastPeriod = Number(raw?.fastPeriod);
    const slowPeriod = Number(raw?.slowPeriod);
    if (!Number.isFinite(erPeriod) || !Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod)) return null;
    return { erPeriod, fastPeriod, slowPeriod };
}

function normalizeAssetSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeAmaKey(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!AMA_KEYWORDS.has(s)) return DEFAULT_AMA_KEY;
    if (s === 'ama') return DEFAULT_AMA_KEY;
    return s.toUpperCase();
}

function isAmaKeyword(raw) {
    const s = String(raw || '').trim().toLowerCase();
    return AMA_KEYWORDS.has(s);
}

function usesAmaGridPrice(bot) {
    return isAmaKeyword(bot?.gridPrice);
}

function findAmaProfileForBot(bot, ctx = null) {
    const profiles = loadMarketProfiles();
    if (profiles.length === 0) return null;

    const botAssetA = normalizeAssetSymbol(bot?.assetA);
    const botAssetB = normalizeAssetSymbol(bot?.assetB);
    const ctxAssetAId = normalizeAssetSymbol(ctx?.assetA?.id);
    const ctxAssetBId = normalizeAssetSymbol(ctx?.assetB?.id);
    if (!botAssetA && !ctxAssetAId) return null;
    if (!botAssetB && !ctxAssetBId) return null;

    const matches = profiles.filter((p) => {
        const pA = normalizeAssetSymbol(p?.assetA);
        const pB = normalizeAssetSymbol(p?.assetB);
        const pAId = normalizeAssetSymbol(p?.assetAId);
        const pBId = normalizeAssetSymbol(p?.assetBId);

        const bySymbol = botAssetA && botAssetB && pA === botAssetA && pB === botAssetB;
        const byId = ctxAssetAId && ctxAssetBId && pAId === ctxAssetAId && pBId === ctxAssetBId;
        return bySymbol || byId;
    });
    if (matches.length === 0) return null;

    const oneHour = matches.filter((p) => Number(p?.intervalSeconds) === 3600);
    const candidates = oneHour.length > 0 ? oneHour : matches;
    return [...candidates].sort((a, b) => {
        const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
        const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
        return bTs - aTs;
    })[0] || null;
}

function getAmaPresetForKey(key, profile = null) {
    return normalizeAmaPreset(profile?.amas?.[key]) || normalizeAmaPreset(BUILTIN_AMAS[key]) || null;
}

function buildAmaComparisonPresets(bot, ctx = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    return AMA_PRESET_KEYS
        .map((key) => {
            const preset = getAmaPresetForKey(key, profile);
            if (!preset) return null;
            return {
                name: key,
                erPeriod: preset.erPeriod,
                fastPeriod: preset.fastPeriod,
                slowPeriod: preset.slowPeriod,
            };
        })
        .filter(Boolean);
}

function loadMarketProfiles() {
    if (!fs.existsSync(MARKET_PROFILES_FILE)) return [];
    try {
        const json = JSON.parse(fs.readFileSync(MARKET_PROFILES_FILE, 'utf8'));
        return Array.isArray(json?.profiles) ? json.profiles : [];
    } catch (_) {
        return [];
    }
}

function getAmaFromProfilesForBot(bot, ctx = null, cfg = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    if (!profile) return null;

    const rawGridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    const overrideDefaultAmaKey = cfg?.defaultAmaKey ? normalizeAmaKey(cfg.defaultAmaKey) : null;
    const requestedKey = rawGridPrice === 'ama'
        ? (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma))
        : (isAmaKeyword(rawGridPrice)
            ? normalizeAmaKey(rawGridPrice)
            : (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma)));
    const selected = normalizeAmaPreset(profile?.amas?.[requestedKey])
        || normalizeAmaPreset(profile?.amas?.[overrideDefaultAmaKey || DEFAULT_AMA_KEY])
        || getAmaPresetForKey(requestedKey)
        || getAmaPresetForKey(overrideDefaultAmaKey || DEFAULT_AMA_KEY);
    if (!selected) return null;

    return {
        enabled: true,
        erPeriod: selected.erPeriod,
        fastPeriod: selected.fastPeriod,
        slowPeriod: selected.slowPeriod,
    };
}

function sleepUntilAlignedBoundary(pollSeconds, referenceNowMs = Date.now(), nowMs = Date.now()) {
    const intervalMs = Math.max(1, Math.floor(Number(pollSeconds) || 0)) * 1000;
    const bufferMs = 1000;
    const targetBoundaryMs = Math.floor(Number(referenceNowMs) / intervalMs) * intervalMs + intervalMs;
    const delayMs = targetBoundaryMs - Number(nowMs) + bufferMs;
    return Math.max(bufferMs, delayMs);
}

function withRetries(fn, attempts, baseDelayMs, label) {
    return (async () => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (i + 1 >= attempts) break;
                const waitMs = Math.max(0, baseDelayMs) * (i + 1);
                if (waitMs > 0) await sleep(waitMs);
            }
        }
        const msg = label ? `${label}: ${lastErr?.message || 'unknown error'}` : (lastErr?.message || 'unknown error');
        throw new Error(msg);
    })();
}

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = { ...DEFAULTS };
    const provided = {
        deltaThresholdPercent: false,
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--once':
                cfg.once = true;
                break;
            case '--pollSeconds':
                cfg.pollSeconds = Number(v);
                i++;
                break;
            case '--deltaPercent':
                cfg.deltaThresholdPercent = Number(v);
                provided.deltaThresholdPercent = true;
                i++;
                break;
            case '--gridResetFactor':
                throw new Error('--gridResetFactor is no longer supported; use --deltaPercent <percent>');
            case '--bootstrapHours':
                cfg.bootstrapLookbackHours = Number(v);
                i++;
                break;
            case '--nativeBackfillHours':
                cfg.nativeBackfillHours = Number(v);
                i++;
                break;
            case '--maxStaleHours':
                cfg.maxStaleHours = Number(v);
                i++;
                break;
            case '--sourceRetries':
                cfg.sourceRetries = Number(v);
                i++;
                break;
            case '--retryDelayMs':
                cfg.retryDelayMs = Number(v);
                i++;
                break;
            case '--metricsJson':
                cfg.metricsJson = true;
                break;
            case '--quiet':
                cfg.quiet = true;
                break;
            case '--dryRun':
                cfg.dryRun = true;
                break;
            case '--whitelist-all':
                cfg.whitelistAll = true;
                break;
            case '--maxPages':
                cfg.maxPages = Number(v);
                i++;
                break;
            case '--pageLimit':
                cfg.pageLimit = Number(v);
                i++;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }

    const merged = applyRuntimeDefaultsFromGeneralSettings(cfg, provided);
    return validateConfig(merged);
}

function printHelp() {
    console.log('Market adapter (standalone): Kibana bootstrap + native incremental updates');
    console.log('');
    console.log('Usage:');
    console.log('  node market_adapter/market_adapter.js [--once] [--pollSeconds 3600]');
    console.log('');
    console.log('Options:');
    console.log('  --once                 Run one cycle and exit');
    console.log('  --pollSeconds <n>      Loop interval seconds (default 3600, wall-clock aligned)');
    console.log('  --deltaPercent <n>     Trigger threshold percent (default: general.settings MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT or 2.5)');
    console.log('  --bootstrapHours <n>   Kibana bootstrap lookback hours (default 720)');
    console.log('  --nativeBackfillHours  Native incremental lookback hours (default 6)');
    console.log('  --maxStaleHours <n>    Max accepted candle staleness before trigger suppression (default 6)');
    console.log('  --sourceRetries <n>    Retries for source fetch calls (default 3)');
    console.log('  --retryDelayMs <n>     Base retry delay in milliseconds (default 800)');
    console.log('  --metricsJson          Emit per-cycle metrics as one JSON line');
    console.log('  --quiet                Suppress per-bot logs (state still written)');
    console.log('  --dryRun               Enable dry run mode for non-whitelisted bots');
    console.log('  --whitelist-all        Disable dry run mode for all bots');
    console.log('  --maxPages <n>         Max native history pages per cycle (default 80)');
    console.log('  --pageLimit <n>        Native page size (max 101, default 100)');
}

function validateConfig(input) {
    const cfg = { ...DEFAULTS, ...input };

    if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds <= 0) throw new Error('--pollSeconds must be > 0');
    if (!Number.isFinite(cfg.deltaThresholdPercent) || cfg.deltaThresholdPercent <= 0) {
        throw new Error('--deltaPercent must be > 0');
    }
    if (!Number.isFinite(cfg.bootstrapLookbackHours) || cfg.bootstrapLookbackHours <= 0) throw new Error('--bootstrapHours must be > 0');
    if (!Number.isFinite(cfg.nativeBackfillHours) || cfg.nativeBackfillHours <= 0) throw new Error('--nativeBackfillHours must be > 0');
    if (!Number.isFinite(cfg.maxStaleHours) || cfg.maxStaleHours <= 0) throw new Error('--maxStaleHours must be > 0');
    if (!Number.isFinite(cfg.sourceRetries) || cfg.sourceRetries < 1) throw new Error('--sourceRetries must be >= 1');
    if (!Number.isFinite(cfg.retryDelayMs) || cfg.retryDelayMs < 0) throw new Error('--retryDelayMs must be >= 0');
    if (!Number.isFinite(cfg.maxPages) || cfg.maxPages <= 0) throw new Error('--maxPages must be > 0');
    if (!Number.isFinite(cfg.pageLimit) || cfg.pageLimit <= 0) throw new Error('--pageLimit must be > 0');

    cfg.pageLimit = Math.min(API_MAX_PAGE, Math.floor(cfg.pageLimit));
    cfg.maxPages = Math.floor(cfg.maxPages);
    cfg.sourceRetries = Math.floor(cfg.sourceRetries);
    cfg.deltaThresholdPercent = Number(cfg.deltaThresholdPercent);
    cfg.metricsJson = !!cfg.metricsJson;
    cfg.quiet = !!cfg.quiet;
    cfg.dryRun = !!cfg.dryRun;
    return cfg;
}

function resolveDeltaThresholdPercentFromGeneralSettings(settings) {
    const explicit = Number(settings?.MARKET_ADAPTER?.AMA_DELTA_THRESHOLD_PERCENT);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;
}

function applyRuntimeDefaultsFromGeneralSettings(cfg, provided = {}, settingsOverride = undefined) {
    const out = { ...cfg };
    if (!provided?.deltaThresholdPercent) {
        const settings = settingsOverride === undefined
            ? readGeneralSettings({ fallback: null })
            : settingsOverride;
        const fromSettings = resolveDeltaThresholdPercentFromGeneralSettings(settings);
        if (fromSettings != null) {
            out.deltaThresholdPercent = fromSettings;
        }
    }
    return out;
}

const Logger = require('../modules/logger');
const marketAdapterLogFile = path.join(PROFILES_DIR, 'logs', 'market_adapter.log');
const logger = new Logger('MarketAdapter', { quiet: DEFAULTS.quiet, logFile: marketAdapterLogFile });

function log(cfg, ...args) {
    logger.quiet = !!cfg?.quiet;
    logger.info(...args);
}

function write(cfg, text) {
    logger.quiet = !!cfg?.quiet;
    logger.raw(text);
}

function loadActiveBots() {
    if (!fs.existsSync(BOTS_FILE)) {
        throw new Error(`bots.json not found: ${BOTS_FILE}`);
    }
    const raw = parseJsonWithComments(fs.readFileSync(BOTS_FILE, 'utf8'));
    const bots = Array.isArray(raw?.bots) ? raw.bots : (Array.isArray(raw) ? raw : []);
    return bots
        .map((b, i) => ({ ...b, botIndex: i, botKey: createBotKey(b, i), active: b.active === undefined ? true : !!b.active }))
        .filter((b) => b.active);
}

function loadJson(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return defaultValue;
    }
}

function saveJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}
        throw err;
    }
}

function parseChainTimeToMs(timeStr) {
    if (!timeStr) return Number.NaN;
    const s = String(timeStr);
    return Date.parse(s.endsWith('Z') ? s : `${s}Z`);
}

function candleFileForBot(botKey, intervalSeconds = 3600) {
    const label = intervalSeconds === 3600 ? '1h' : toIntervalLabel(intervalSeconds);
    return path.join(DATA_DIR, `market_adapter_${botKey}_${label}.json`);
}

function requiredCandlesForAma(ama = DEFAULT_AMA) {
    return Math.max(ama.erPeriod + ama.slowPeriod + 20, 80);
}

function calculateBotThreshold(cfg) {
    const value = Number(cfg?.deltaThresholdPercent);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function computeCandleStaleness(lastCandleTs, maxStaleHours) {
    const staleAgeMs = Number.isFinite(lastCandleTs) ? (Date.now() - lastCandleTs) : Number.POSITIVE_INFINITY;
    const staleData = staleAgeMs > (maxStaleHours * 3600 * 1000);
    const staleAgeHours = Number.isFinite(staleAgeMs) ? (staleAgeMs / 3600000) : null;
    return { staleData, staleAgeHours };
}

function resolveAmaForBot(bot, ctx = null, cfg = null) {
    const fromProfiles = getAmaFromProfilesForBot(bot, ctx, cfg);
    if (fromProfiles) return fromProfiles;

    const raw = (bot && typeof bot.ama === 'object' && bot.ama !== null) ? bot.ama : {};
    const amaCfg = {
        erPeriod: Number(raw.erPeriod),
        fastPeriod: Number(raw.fastPeriod),
        slowPeriod: Number(raw.slowPeriod),
        enabled: raw.enabled !== false,
    };

    if (!Number.isInteger(amaCfg.erPeriod) || amaCfg.erPeriod < 1) amaCfg.erPeriod = DEFAULT_AMA.erPeriod;
    if (!Number.isFinite(amaCfg.fastPeriod) || amaCfg.fastPeriod < 1) amaCfg.fastPeriod = DEFAULT_AMA.fastPeriod;
    if (!Number.isInteger(amaCfg.slowPeriod) || amaCfg.slowPeriod < 1) amaCfg.slowPeriod = DEFAULT_AMA.slowPeriod;
    if (amaCfg.fastPeriod > amaCfg.slowPeriod) {
        const t = amaCfg.fastPeriod;
        amaCfg.fastPeriod = amaCfg.slowPeriod;
        amaCfg.slowPeriod = t;
    }
    return amaCfg;
}

function pruneCandles(candles, keepCount) {
    if (!Array.isArray(candles)) return [];
    if (candles.length <= keepCount) return candles;
    return candles.slice(candles.length - keepCount);
}

function calcAmaPrice(candles, ama = DEFAULT_AMA) {
    const closes = (candles || []).map((c) => Number(c?.[4])).filter((v) => Number.isFinite(v) && v > 0);
    if (closes.length < ama.erPeriod + 1) return null;
    const values = calculateAMA(closes, ama);
    const last = values[values.length - 1];
    return Number.isFinite(last) ? last : null;
}

function calcAmaComparison(candles, bot = null, ctx = null) {
    const closes = (candles || []).map((c) => Number(c?.[4])).filter((v) => Number.isFinite(v) && v > 0);
    const out = [];
    const presets = buildAmaComparisonPresets(bot, ctx);

    for (const p of presets) {
        const minNeeded = p.erPeriod + 1;
        if (closes.length < minNeeded) {
            out.push({ ...p, value: null, ok: false });
            continue;
        }
        const values = calculateAMA(closes, {
            erPeriod: p.erPeriod,
            fastPeriod: p.fastPeriod,
            slowPeriod: p.slowPeriod,
        });
        const value = values[values.length - 1];
        out.push({ ...p, value: Number.isFinite(value) ? value : null, ok: Number.isFinite(value) });
    }

    return out;
}

async function fetchNativeTradesSince(poolId, sinceMs, pageLimit, maxPages) {
    const { BitShares } = getBitsharesClient();
    const trades = [];
    const seenSequences = new Set();
    let pages = 0;
    let startSeq = null;

    while (pages < maxPages) {
        let page;
        if (startSeq == null) {
            page = await BitShares.history.get_liquidity_pool_history(poolId, null, null, pageLimit, LP_OP_TYPE);
        } else {
            page = await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, pageLimit, LP_OP_TYPE);
        }

        if (!Array.isArray(page) || page.length === 0) break;

        pages++;
        let hitOld = false;

        for (const row of page) {
            const seq = Number(row?.sequence);
            if (Number.isFinite(seq)) {
                if (seenSequences.has(seq)) continue;
                seenSequences.add(seq);
            }

            const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
            if (!Number.isFinite(tsMs)) continue;
            if (tsMs < sinceMs) {
                hitOld = true;
                break;
            }

            const opPayload = Array.isArray(row?.op?.op) ? row.op.op[1] : null;
            const resultPayload = Array.isArray(row?.op?.result) ? row.op.result[1] : null;
            const received = Array.isArray(resultPayload?.received)
                ? resultPayload.received[0]
                : (resultPayload?.received || null);

            if (!opPayload?.amount_to_sell || !received) continue;

            trades.push({
                tsMs,
                sell: opPayload.amount_to_sell,
                received,
            });
        }

        const last = page[page.length - 1];
        const lastSeq = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1) break;
        if (hitOld) break;
        startSeq = lastSeq - 1;
    }

    if (pages >= maxPages && !hitOld) {
        console.warn(`[market_adapter] fetchNativeTradesSince exhausted maxPages (${maxPages}) before reaching sinceMs; data may be incomplete`);
    }

    return trades;
}

function writeGridResetTrigger(bot, payload) {
    const triggerPath = path.join(PROFILES_DIR, `recalculate.${bot.botKey}.trigger`);
    const content = {
        createdAt: new Date().toISOString(),
        source: 'market_adapter/market_adapter.js',
        botName: bot.name,
        botKey: bot.botKey,
        ...payload,
    };
    fs.writeFileSync(triggerPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
    return triggerPath;
}

const ORDERS_DIR = path.join(ROOT, 'profiles', 'orders');

/**
 * Atomically write the dynamic grid snapshot for a bot to profiles/orders/<botKey>.dynamicgrid.json.
 * Contains AMA-derived center price and any computed effective weight offsets.
 * The bot reads this snapshot before every rebalance (fills, spread checks, divergence
 * corrections, etc.) — not only on grid reset — so fresh weights are applied to new orders.
 * Uses write-then-rename to prevent partial reads by the dexbot process.
 * @param {string} botKey      - Bot key (e.g. "iob-xrp-bts-0")
 * @param {number} centerPrice - Current AMA-derived center price (B/A format)
 * @param {Object} options
 * @param {number} [options.amaCenterPrice]   - Raw AMA center price before any downstream handling
 * @param {Object} [options.dynamicWeights]   - Computed weight offsets for live order sizing
 */
function writeBotDynamicGrid(botKey, centerPrice, options = {}) {
    try {
        ensureDir(ORDERS_DIR);
        const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        const tmpPath = `${filePath}.tmp`;
        const amaCenterPrice = Number(options.amaCenterPrice);
        const resolvedCenterPrice = Math.round(Number(centerPrice) * 1e8) / 1e8;
        const payload = {
            centerPrice: resolvedCenterPrice,
            amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : resolvedCenterPrice,
            updatedAt: new Date().toISOString(),
            source: 'market_adapter/market_adapter.js',
        };
        if (options.dynamicWeights && typeof options.dynamicWeights === 'object') {
            payload.dynamicWeights = options.dynamicWeights;
        }
        // Atomic write: write to .tmp then rename — prevents dexbot reading a partial file
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (err) {
        console.warn(`[writeBotDynamicGrid] Failed to write dynamic grid for ${botKey}: ${err.message}`);
        return false;
    }
}

const { MarketAdapterService } = require("./core/market_adapter_service");
const adapterService = new MarketAdapterService({
    resolveBotContext,
    resolveAmaForBot,
    candleFileForBot,
    loadJson,
    saveJson,
    requiredCandlesForAma,
    calculateBotThreshold,
    computeCandleStaleness,
    withRetries,
    kibanaSource,
    fetchNativeTradesSince,
    tradesToCandles,
    detectMissingCandleTimestamps,
    fillCandleGaps,
    pruneStaleTail,
    mergeCandles,
    pruneCandles,
    calcAmaPrice,
    calcAmaComparison,
    writeGridResetTrigger,
    writeBotDynamicGrid,
    isBotDynamicWeightWhitelisted,
    logger,
    root: ROOT,
    path,
});

async function processBot(bot, state, cfg, contextCache, hooks = {}) {
    return adapterService.processBot(bot, state, cfg, contextCache, hooks);
}

function writeCenterSnapshot(state) {
    const centers = {
        updatedAt: new Date().toISOString(),
        bots: {},
    };
    for (const [botKey, v] of Object.entries(state.bots || {})) {
        centers.bots[botKey] = {
            botName: v.botName,
            centerPrice: v.centerPrice,
            amaCenterPrice: v.amaCenterPrice,
            lastGridResetAt: v.lastGridResetAt,
            lastAmaPrice: v.lastAmaPrice,
            lastDeltaPercent: v.lastDeltaPercent,
            weights: v.weights,
            effectiveWeights: v.effectiveWeights,
            collateralRecommendation: v.collateralRecommendation ?? null,
            amaSlope: v.amaSlope,
            atr: v.atr
        };
    }
    saveJson(CENTER_FILE, centers);
}

async function runOnce(cfg, state, contextCache) {
    _resetCycleCache(); // reload settings and cached file-backed config once per cycle
    const startedAtMs = Date.now();
    const allBots = loadActiveBots();
    const bots = allBots.filter((bot) => usesAmaGridPrice(bot));
    log(cfg, `Active bots: ${allBots.length} | AMA-grid bots: ${bots.length}`);

    const results = [];

    for (const bot of bots) {
        const isDryRun = cfg.dryRun || (!cfg.whitelistAll && !isBotWhitelisted(bot.botKey));
        write(cfg, `- ${bot.name} (${bot.botKey})${isDryRun ? ' [DRY RUN]' : ''}: `);
        try {
            const botCfg = resolveBotCfg(bot, cfg);
            const r = await processBot(bot, state, botCfg, contextCache, {
                onTrigger: cfg.onTrigger,
                isDryRun,
                forceWhitelistAll: cfg.whitelistAll,
            });
            if (!r.ok) {
                log(cfg, `skip (${r.reason})`);
                results.push({
                    botName: bot.name,
                    botKey: bot.botKey,
                    ok: false,
                    reason: r.reason,
                });
                continue;
            }

            const amaText = Number.isFinite(r.amaPrice) ? r.amaPrice.toFixed(8) : 'n/a';
            const prevCenterText = Number.isFinite(r.previousCenterPrice) ? r.previousCenterPrice.toFixed(8) : 'n/a';
            const deltaText = Number.isFinite(r.deltaPercent) ? `${r.deltaPercent.toFixed(3)}%` : 'n/a';
            const thresholdText = Number.isFinite(r.thresholdPercent) ? `${r.thresholdPercent.toFixed(3)}%` : 'n/a';
            const offText = r.weights?.meta?.finalOffset != null ? ` off=${r.weights.meta.finalOffset.toFixed(3)}` : '';
            const amaOffText = r.amaSlope?.amaSlopeGated != null ? ` (amaOff=${r.amaSlope.amaSlopeGated.toFixed(3)})` : '';
            const regimeText = r.amaSlope?.regimeMultiplier != null ? ` regime=${r.amaSlope.regimeMultiplier.toFixed(2)}` : '';

            const staleText = r.staleData ? ` STALE(${Number.isFinite(r.staleAgeHours) ? r.staleAgeHours.toFixed(2) : 'n/a'}h)` : '';
            const patchText = Number.isFinite(r.kibanaGapRepairCount) && r.kibanaGapRepairCount > 0 ? ` KIBANA_PATCH(${r.kibanaGapRepairCount})` : '';
            const backfillText = Number.isFinite(r.kibanaBackfillCount) && r.kibanaBackfillCount > 0 ? ` BACKFILL(${r.kibanaBackfillCount})` : '';
            const gapText = Number.isFinite(r.unresolvedGapCount) && r.unresolvedGapCount > 0 ? ` GAPS(${r.unresolvedGapCount})` : '';
            const trigText = r.triggered ? ` TRIGGERED -> ${r.triggerPath ? path.relative(ROOT, r.triggerPath) : '[suppressed, dry-run]'}` : '';
            const pendingText = r.pendingClosedCandle ? ' WAITING_FOR_CLOSED_CANDLE' : '';
            const weightText = r.weights ? ` weights[buy=${r.weights.buy}, sell=${r.weights.sell}]` : '';
            const trendText = r.amaSlope?.trend ? ` trend=${r.amaSlope.trend}` : '';
            const warmupText = r.triggerSuppressedReason === 'ama_warmup_insufficient' ? ` WARMUP_INSUFFICIENT(${r.candleCount})` : '';

            log(cfg, `${r.source}, candles=${r.candleCount}, ama=${amaText} (prevCenter=${prevCenterText}, delta=${deltaText}), threshold=${thresholdText}${offText}${amaOffText}${regimeText}${staleText}${patchText}${backfillText}${gapText}${trigText}${pendingText}${warmupText}${trendText}${weightText}`);
            if (Array.isArray(r.dryRunMessages)) {
                r.dryRunMessages.forEach(msg => log(cfg, `  ${msg}`));
            }
            if (Array.isArray(r.amaComparison) && r.amaComparison.length > 0) {
                const parts = r.amaComparison.map((a) => {
                    const val = Number.isFinite(a.value) ? a.value.toFixed(8) : 'n/a';
                    return `${a.name}[${a.erPeriod}/${a.fastPeriod}/${a.slowPeriod}]=${val}`;
                });
                log(cfg, `  AMA compare: ${parts.join(' | ')}`);
            }
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ...r,
            });
        } catch (err) {
            log(cfg, `error (${err.message})`);
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ok: false,
                reason: err.message,
            });
        }
    }

    state.meta = {
        updatedAt: new Date().toISOString(),
        source: 'market_adapter/market_adapter.js',
        defaults: {
            ama: DEFAULT_AMA,
            intervalSeconds: cfg.intervalSeconds,
            deltaThresholdPercent: cfg.deltaThresholdPercent,
            deltaThresholdMode: 'fixed_percent',
        },
    };

    const metrics = {
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        totalActiveBots: allBots.length,
        processedBots: bots.length,
        successBots: results.filter((r) => r.ok).length,
        failedBots: results.filter((r) => !r.ok).length,
        triggeredBots: results.filter((r) => r.ok && r.triggered).length,
        staleBots: results.filter((r) => r.ok && r.staleData).length,
        kibanaPatchedBots: results.filter((r) => r.ok && Number(r.kibanaGapRepairCount) > 0).length,
        kibanaPatchedCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaGapRepairCount) ? r.kibanaGapRepairCount : 0), 0),
        kibanaBackfilledBots: results.filter((r) => r.ok && Number(r.kibanaBackfillCount) > 0).length,
        kibanaBackfilledCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaBackfillCount) ? r.kibanaBackfillCount : 0), 0),
        unresolvedGapBots: results.filter((r) => r.ok && Number(r.unresolvedGapCount) > 0).length,
        unresolvedGapCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.unresolvedGapCount) ? r.unresolvedGapCount : 0), 0),
    };
    state.meta.metrics = metrics;

    saveJson(STATE_FILE, state);
    writeCenterSnapshot(state);
    if (cfg.metricsJson) {
        log(cfg, `METRICS ${JSON.stringify(metrics)}`);
    }
    return { results, metrics };
}

async function runOnceForAma(overrides = {}) {
    const provided = {
        deltaThresholdPercent: Object.prototype.hasOwnProperty.call(overrides, 'deltaThresholdPercent'),
    };
    const cfg = validateConfig({
        ...applyRuntimeDefaultsFromGeneralSettings({
            ...DEFAULTS,
            quiet: true,
        }, provided),
        ...overrides,
        once: true,
    });

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });
    try {
        const { waitForConnected } = getBitsharesClient();
        await waitForConnected(30000);
        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map();
        const run = await runOnce(cfg, state, contextCache);

        return {
            updatedAt: state?.meta?.updatedAt || new Date().toISOString(),
            ...run,
            state,
        };
    } finally {
        releaseFileLockSync(lock);
    }
}

async function main() {
    const cfg = parseArgs();
    logger.quiet = cfg.quiet;

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });

    try {
        log(cfg, '═══════════════════════════════════════');
        log(cfg, ' Market Adapter Hub Settings:');
        log(cfg, `  - Poll Interval: ${cfg.pollSeconds}s`);
        log(cfg, `  - Delta Threshold: ${cfg.deltaThresholdPercent}%`);
        log(cfg, `  - Dry Run: ${cfg.dryRun}`);
        log(cfg, `  - Max Pages: ${cfg.maxPages} (Limit: ${cfg.pageLimit})`);
        log(cfg, `  - Native Backfill: ${cfg.nativeBackfillHours}h (Max Stale: ${cfg.maxStaleHours}h)`);
        log(cfg, `  - Bootstrap Lookback: ${cfg.bootstrapLookbackHours}h`);
        log(cfg, `  - Source Retries: ${cfg.sourceRetries} (Delay: ${cfg.retryDelayMs}ms)`);
        log(cfg, `  - Metrics JSON: ${cfg.metricsJson}`);
        log(cfg, `  - Quiet Mode: ${cfg.quiet}`);
        log(cfg, '═══════════════════════════════════════');

        if (cfg.once && cfg.dryRun) {
            log(cfg, 'Dry run: config validation + lock acquisition OK (no network, no writes).');
            return 0;
        }

        const { waitForConnected } = getBitsharesClient();
        await waitForConnected(30000);
        log(cfg, 'Connected to BitShares');

        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map();

        if (cfg.once) {
            const run = await runOnce(cfg, state, contextCache);
            const allProcessedFailed = run.metrics.processedBots > 0 && run.metrics.successBots === 0;
            return allProcessedFailed ? 1 : 0;
        }

        while (true) {
            const started = Date.now();
            log(cfg, `\n[cycle ${new Date(started).toISOString()}]`);
            await runOnce(cfg, state, contextCache);
            const sleepMs = sleepUntilAlignedBoundary(cfg.pollSeconds, started, Date.now());
            await sleep(sleepMs);
        }
    } finally {
        releaseFileLockSync(lock);
    }
}

if (require.main === module) {
    main()
        .then((exitCode) => process.exit(Number.isInteger(exitCode) ? exitCode : 0))
        .catch((err) => {
            console.error(`Fatal: ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
    main,
    runOnceForAma,
    DEFAULT_AMA,
    DEFAULTS,
    calculateBotThreshold,
    calcAmaComparison,
    computeCandleStaleness,
    sleepUntilAlignedBoundary,
    resolveAmaForBot,
    resolveDeltaThresholdPercentFromGeneralSettings,
    applyRuntimeDefaultsFromGeneralSettings,
    resolveBotCfg,
    usesAmaGridPrice,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    _resetCycleCache,
    writeCenterSnapshot,
};
