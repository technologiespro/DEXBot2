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
 *   gridPrice: "ama"  or "ama3" => default (best backtest score, ER=372)
 *   gridPrice: "ama1"             => min move, cap 65%
 *   gridPrice: "ama2"             => min move, cap 55%
 *   gridPrice: "ama3"             => min move, cap 45%
 *
 * No wallet keys/password/auth required (read-only chain + Kibana bootstrap).
 */

const fs = require('fs');
const path = require('path');

const { parseJsonWithComments } = require('../modules/account_bots');
const { readGeneralSettings } = require('../modules/general_settings');
const { MARKET_ADAPTER } = require('../modules/constants');
const { createBotKey } = require('../modules/account_orders');
const { calculateAMA } = require('../analysis/ama_fitting/ama');
const kibanaSource = require('./inputs/kibana_source');
const { normalizePoolId } = kibanaSource;
const { tradesToCandles, detectMissingCandleTimestamps } = require('./candle_utils');

const ROOT = path.join(__dirname, '..');
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BOTS_FILE = path.join(PROFILES_DIR, 'bots.json');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'price_adapter_state.json');
const CENTER_FILE = path.join(STATE_DIR, 'price_adapter_centers.json');
const LOCK_FILE = path.join(STATE_DIR, 'price_adapter.lock');
const MARKET_PROFILES_FILE = path.join(PROFILES_DIR, 'market_profiles.json');

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
};

const WHITELIST_FILE = path.join(PROFILES_DIR, 'price_adapter_whitelist.json');

function isBotWhitelisted(botKey) {
    if (!fs.existsSync(WHITELIST_FILE)) return false;
    try {
        const json = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        return Array.isArray(json?.whitelist) && json.whitelist.includes(botKey);
    } catch (_) {
        return false;
    }
}

const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY || 'AMA3').toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS || {};
const DEFAULT_AMA = BUILTIN_AMAS[DEFAULT_AMA_KEY] || BUILTIN_AMAS.AMA3 || { erPeriod: 372, fastPeriod: 1.8, slowPeriod: 1286 };
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

function getAmaFromProfilesForBot(bot, ctx = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    if (!profile) return null;

    const rawGridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    const requestedKey = rawGridPrice === 'ama'
        ? normalizeAmaKey(profile?.defaultAma)
        : (isAmaKeyword(rawGridPrice)
            ? normalizeAmaKey(rawGridPrice)
            : normalizeAmaKey(profile?.defaultAma));
    const selected = normalizeAmaPreset(profile?.amas?.[requestedKey])
        || normalizeAmaPreset(profile?.amas?.[DEFAULT_AMA_KEY])
        || getAmaPresetForKey(requestedKey)
        || getAmaPresetForKey(DEFAULT_AMA_KEY);
    if (!selected) return null;

    return {
        enabled: true,
        erPeriod: selected.erPeriod,
        fastPeriod: selected.fastPeriod,
        slowPeriod: selected.slowPeriod,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        }
    }

    const merged = applyRuntimeDefaultsFromGeneralSettings(cfg, provided);
    return validateConfig(merged);
}

function printHelp() {
    console.log('Price adapter (standalone): Kibana bootstrap + native incremental updates');
    console.log('');
    console.log('Usage:');
    console.log('  node market_adapter/market_adapter.js [--once] [--pollSeconds 3600]');
    console.log('');
    console.log('Options:');
    console.log('  --once                 Run one cycle and exit');
    console.log('  --pollSeconds <n>      Loop interval seconds (default 3600)');
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

    const renamed = Number(settings?.MARKET_ADAPTER?.DELTA_THRESHOLD_PERCENT);
    if (Number.isFinite(renamed) && renamed > 0) return renamed;

    const legacy = Number(settings?.MARKET_ADAPTER?.GRID_RESET_FACTOR);
    if (Number.isFinite(legacy) && legacy > 0) return legacy;

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
const priceAdapterLogFile = path.join(__dirname, '..', 'logs', 'price_adapter.log');
const logger = new Logger('PriceAdapter', { quiet: DEFAULTS.quiet, logFile: priceAdapterLogFile });

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

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function saveJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadLockInfo(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function acquireFileLock(lockPath, opts = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : (6 * 3600 * 1000);
    const now = Date.now();

    for (let pass = 0; pass < 2; pass++) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            const payload = {
                pid: process.pid,
                createdAt: new Date(now).toISOString(),
            };
            fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            const heartbeatMs = Math.max(30000, Math.floor(staleMs / 2));
            const heartbeat = setInterval(() => {
                try {
                    const ts = new Date();
                    fs.utimesSync(lockPath, ts, ts);
                } catch (_) {}
            }, heartbeatMs);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
            return { fd, lockPath, heartbeat };
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;

            const info = loadLockInfo(lockPath);
            let stale = false;
            try {
                const stat = fs.statSync(lockPath);
                stale = (now - stat.mtimeMs) > staleMs;
            } catch (_) {
                stale = true;
            }

            const alive = isProcessAlive(Number(info.pid));
            if (stale || !alive) {
                try { fs.unlinkSync(lockPath); } catch (_) {}
                continue;
            }

            throw new Error(`price adapter already running (lock: ${lockPath}, pid: ${info.pid})`);
        }
    }

    throw new Error(`cannot acquire lock: ${lockPath}`);
}

function releaseFileLock(lock) {
    if (!lock) return;
    try { if (lock.heartbeat) clearInterval(lock.heartbeat); } catch (_) {}
    try { if (typeof lock.fd === 'number') fs.closeSync(lock.fd); } catch (_) {}
    try { if (lock.lockPath) fs.unlinkSync(lock.lockPath); } catch (_) {}
}

async function resolveAsset(symbol) {
    const { BitShares } = getBitsharesClient();
    const results = await BitShares.db.lookup_asset_symbols([symbol]);
    const asset = results?.[0];
    if (!asset?.id || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset "${symbol}"`);
    }
    return { id: asset.id, precision: asset.precision, symbol };
}

async function findPoolByAssets(assetAId, assetBId) {
    const { BitShares } = getBitsharesClient();
    if (typeof BitShares.db?.get_liquidity_pool_by_asset_ids === 'function') {
        try {
            const pool = await BitShares.db.get_liquidity_pool_by_asset_ids(assetAId, assetBId);
            if (pool?.id) return pool;
        } catch (_) {}
    }

    if (typeof BitShares.db?.get_liquidity_pools_by_assets === 'function') {
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_assets(assetAId, assetBId, 10, false);
            if (Array.isArray(pools) && pools.length > 0) return pools[0];
        } catch (_) {}
    }

    const listFn = BitShares.db?.list_liquidity_pools ?? BitShares.db?.get_liquidity_pools;
    if (typeof listFn === 'function') {
        let startId = '1.19.0';
        const page = 100;
        const a = String(assetAId);
        const b = String(assetBId);

        while (true) {
            const pools = await listFn(page, startId);
            if (!Array.isArray(pools) || pools.length === 0) break;

            const effective = startId === '1.19.0' ? pools : pools.slice(1);
            const matches = effective.filter((p) => {
                const ids = (p.asset_ids ?? [p.asset_a, p.asset_b]).map(String);
                return ids.includes(a) && ids.includes(b);
            });
            if (matches.length > 0) return matches[0];

            if (pools.length < page) break;
            startId = pools[pools.length - 1].id;
        }
    }

    throw new Error(`No liquidity pool found for ${assetAId}/${assetBId}`);
}

function parseChainTimeToMs(timeNoZ) {
    if (!timeNoZ) return Number.NaN;
    return Date.parse(`${timeNoZ}Z`);
}

function candleFileForBot(botKey) {
    return path.join(DATA_DIR, `price_adapter_${botKey}_1h.json`);
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

function resolveAmaForBot(bot, ctx = null) {
    const fromProfiles = getAmaFromProfilesForBot(bot, ctx);
    if (fromProfiles) return fromProfiles;

    const raw = (bot && typeof bot.ama === 'object' && bot.ama !== null) ? bot.ama : {};
    const cfg = {
        erPeriod: Number(raw.erPeriod),
        fastPeriod: Number(raw.fastPeriod),
        slowPeriod: Number(raw.slowPeriod),
        enabled: raw.enabled !== false,
    };

    if (!Number.isInteger(cfg.erPeriod) || cfg.erPeriod < 1) cfg.erPeriod = DEFAULT_AMA.erPeriod;
    if (!Number.isFinite(cfg.fastPeriod) || cfg.fastPeriod < 1) cfg.fastPeriod = DEFAULT_AMA.fastPeriod;
    if (!Number.isInteger(cfg.slowPeriod) || cfg.slowPeriod < 1) cfg.slowPeriod = DEFAULT_AMA.slowPeriod;
    if (cfg.fastPeriod > cfg.slowPeriod) {
        const t = cfg.fastPeriod;
        cfg.fastPeriod = cfg.slowPeriod;
        cfg.slowPeriod = t;
    }
    return cfg;
}

// Default price offset config — used when no pair-specific market profile is set.
const DEFAULT_PRICE_OFFSET = {
    devThreshold: 20, // % deviation from AMA before offset activates
    maxPct: 10,       // max offset applied at full confidence
};

function getOffsetFromProfilesForBot(bot, ctx = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    if (!profile) return null;
    const raw = profile?.priceOffset;
    if (!raw || typeof raw !== 'object') return null;
    const devThreshold = Number(raw.devThreshold);
    const maxPct = Number(raw.maxPct);
    if (!Number.isFinite(devThreshold) || devThreshold <= 0) return null;
    if (!Number.isFinite(maxPct) || maxPct <= 0) return null;
    return { devThreshold, maxPct };
}

function resolveOffsetForBot(bot, ctx = null) {
    const fromProfiles = getOffsetFromProfilesForBot(bot, ctx);
    if (fromProfiles) return fromProfiles;

    return { ...DEFAULT_PRICE_OFFSET };
}

function mergeCandles(existing, incoming) {
    const map = new Map();
    (existing || []).forEach((c) => { if (Array.isArray(c)) map.set(c[0], c); });
    (incoming || []).forEach((c) => { if (Array.isArray(c)) map.set(c[0], c); });
    return [...map.values()].sort((a, b) => a[0] - b[0]);
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
        if (!last || typeof last.sequence !== 'number' || last.sequence === 0) break;
        if (hitOld) break;
        startSeq = last.sequence - 1;
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

async function resolveBotContext(bot) {
    const assetA = bot.assetAId && Number.isFinite(bot.assetAPrecision)
        ? { id: bot.assetAId, precision: bot.assetAPrecision, symbol: bot.assetA }
        : await resolveAsset(bot.assetA);

    const assetB = bot.assetBId && Number.isFinite(bot.assetBPrecision)
        ? { id: bot.assetBId, precision: bot.assetBPrecision, symbol: bot.assetB }
        : await resolveAsset(bot.assetB);

    const poolId = bot.poolId
        ? normalizePoolId(bot.poolId)
        : normalizePoolId((await findPoolByAssets(assetA.id, assetB.id)).id);

    return { assetA, assetB, poolId };
}

const ORDERS_DIR = path.join(ROOT, 'profiles', 'orders');

/**
 * Atomically write the effective grid center for a bot to profiles/orders/<botKey>.gridprice.json.
 * Called by price_adapter when a grid reset trigger fires (or on first initialisation).
 * Uses write-then-rename to prevent partial reads by the dexbot process.
 * @param {string} botKey   - Bot key (e.g. "iob-xrp-bts-0")
 * @param {number} amaPrice - Current raw AMA center price (B/A format)
 * @param {Object} options
 * @param {number} options.gridPriceOffsetPct - Signed offset percentage applied to the center
 * @param {number} options.effectiveCenterPrice - Precomputed effective center price
 */
function writeBotGridPriceCenter(botKey, amaPrice, options = {}) {
    try {
        ensureDir(ORDERS_DIR);
        const filePath = path.join(ORDERS_DIR, `${botKey}.gridprice.json`);
        const tmpPath = `${filePath}.tmp`;
        const gridPriceOffsetPct = Number(options.gridPriceOffsetPct || 0);
        const effectiveCenterPrice = Number(options.effectiveCenterPrice);
        const centerPriceRaw = Number.isFinite(effectiveCenterPrice) && effectiveCenterPrice > 0
            ? effectiveCenterPrice
            : amaPrice * (1 + (Number.isFinite(gridPriceOffsetPct) ? gridPriceOffsetPct : 0) / 100);
        const centerPrice = Math.round(centerPriceRaw * 1e8) / 1e8;
        const payload = {
            amaCenterPrice: amaPrice,
            centerPrice,
            effectiveCenterPrice: centerPrice,
            gridPriceOffsetPct: Number.isFinite(gridPriceOffsetPct) ? gridPriceOffsetPct : 0,
            updatedAt: new Date().toISOString(),
            source: 'market_adapter/market_adapter.js',
        };
        // Atomic write: write to .tmp then rename — prevents dexbot reading a partial file
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (err) {
        console.warn(`[writeBotGridPriceCenter] Failed to write grid price center for ${botKey}: ${err.message}`);
        return false;
    }
}

const { MarketAdapterService } = require("./core/market_adapter_service");
const adapterService = new MarketAdapterService({
    resolveBotContext,
    resolveAmaForBot,
    resolveOffsetForBot,
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
    mergeCandles,
    pruneCandles,
    calcAmaPrice,
    calcAmaComparison,
    writeGridResetTrigger,
    writeBotGridPriceCenter,
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
            effectiveCenterPrice: v.effectiveCenterPrice,
            gridPriceOffsetPct: v.gridPriceOffsetPct,
            lastGridResetAt: v.lastGridResetAt,
            lastAmaPrice: v.lastAmaPrice,
            lastDeltaPercent: v.lastDeltaPercent,
            weights: v.weights,
            collateral: v.collateral,
            trend: v.trend,
            atr: v.atr
        };
    }
    saveJson(CENTER_FILE, centers);
}

async function runOnce(cfg, state, contextCache) {
    const startedAtMs = Date.now();
    const allBots = loadActiveBots();
    const bots = allBots.filter((bot) => usesAmaGridPrice(bot));
    log(cfg, `Active bots: ${allBots.length} | AMA-grid bots: ${bots.length}`);

    const results = [];

    for (const bot of bots) {
        const isDryRun = cfg.dryRun || (!cfg.whitelistAll && !isBotWhitelisted(bot.botKey));
        write(cfg, `- ${bot.name} (${bot.botKey})${isDryRun ? ' [DRY RUN]' : ''}: `);
        try {
            const r = await processBot(bot, state, cfg, contextCache, {
                onTrigger: cfg.onTrigger,
                isDryRun
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
            const deltaText = Number.isFinite(r.deltaPercent) ? `${r.deltaPercent.toFixed(3)}%` : 'n/a';
            const thresholdText = Number.isFinite(r.thresholdPercent) ? `${r.thresholdPercent.toFixed(3)}%` : 'n/a';
            const staleText = r.staleData ? ` STALE(${Number.isFinite(r.staleAgeHours) ? r.staleAgeHours.toFixed(2) : 'n/a'}h)` : '';
            const patchText = Number.isFinite(r.kibanaGapRepairCount) && r.kibanaGapRepairCount > 0 ? ` KIBANA_PATCH(${r.kibanaGapRepairCount})` : '';
            const gapText = Number.isFinite(r.unresolvedGapCount) && r.unresolvedGapCount > 0 ? ` GAPS(${r.unresolvedGapCount})` : '';
            const trigText = r.triggered ? ` TRIGGERED -> ${r.triggerPath ? path.relative(ROOT, r.triggerPath) : '[suppressed, dry-run]'}` : '';
            const weightText = r.weights ? ` weights[buy=${r.weights.buy}, sell=${r.weights.sell}]` : '';
            const trendText = r.trend ? ` trend=${r.trend}` : '';
            log(cfg, `${r.source}, candles=${r.candleCount}, ama=${amaText}, delta=${deltaText}, threshold=${thresholdText}${staleText}${patchText}${gapText}${trigText}${trendText}${weightText}`);
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

    const lock = acquireFileLock(LOCK_FILE, {
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
            results: run.results,
            metrics: run.metrics,
            state,
        };
    } finally {
        releaseFileLock(lock);
    }
}

async function main() {
    const cfg = parseArgs();
    logger.quiet = cfg.quiet;

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLock(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });

    try {
        log(cfg, '═══════════════════════════════════════');
        log(cfg, ' Market Adapter Hub Settings:');
        log(cfg, `  - Poll Interval: ${cfg.pollSeconds}s`);
        log(cfg, `  - Delta Threshold: ${cfg.deltaThresholdPercent}%`);
        log(cfg, `  - Dry Run: ${cfg.dryRun}`);
        log(cfg, `  - Whitelist All: ${cfg.whitelistAll}`);
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
            const elapsed = Date.now() - started;
            const sleepMs = Math.max(1000, cfg.pollSeconds * 1000 - elapsed);
            await sleep(sleepMs);
        }
    } finally {
        releaseFileLock(lock);
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
    resolveAmaForBot,
    resolveOffsetForBot,
    resolveDeltaThresholdPercentFromGeneralSettings,
    applyRuntimeDefaultsFromGeneralSettings,
    usesAmaGridPrice,
};
