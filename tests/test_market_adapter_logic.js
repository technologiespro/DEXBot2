const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running market_adapter logic tests');

const {
    DEFAULT_AMA,
    calculateBotThreshold,
    calcAmaComparison,
    computeCandleStaleness,
    resolveAmaForBot,
    resolveOffsetForBot,
    resolveDeltaThresholdPercentFromGeneralSettings,
    usesAmaGridPrice,
    applyRuntimeDefaultsFromGeneralSettings,
} = require('../market_adapter/market_adapter');
const { detectMissingCandleTimestamps } = require('../market_adapter/candle_utils');

const MARKET_PROFILES_FILE = path.join(__dirname, '..', 'profiles', 'market_profiles.json');

// Threshold behavior
assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: 1 }),
    1,
    'threshold should be fixed deltaThresholdPercent'
);

assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: 2.5 }),
    2.5,
    'custom delta threshold should be used directly'
);

assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: Number.NaN }),
    null,
    'invalid threshold should return null'
);

// Stale detection behavior
{
    const now = Date.now();
    const freshTs = now - (1 * 3600 * 1000);
    const staleTs = now - (7 * 3600 * 1000);

    const fresh = computeCandleStaleness(freshTs, 6);
    assert.strictEqual(fresh.staleData, false, '1h old candle should not be stale with 6h max');
    assert.ok(Number.isFinite(fresh.staleAgeHours), 'fresh staleAgeHours should be finite');

    const stale = computeCandleStaleness(staleTs, 6);
    assert.strictEqual(stale.staleData, true, '7h old candle should be stale with 6h max');
    assert.ok(Number.isFinite(stale.staleAgeHours), 'stale staleAgeHours should be finite');

    const missing = computeCandleStaleness(null, 6);
    assert.strictEqual(missing.staleData, true, 'missing candle timestamp should be treated as stale');
    assert.strictEqual(missing.staleAgeHours, null, 'missing candle timestamp should expose null staleAgeHours');
}

// Candle continuity behavior
{
    const candles = [
        [1700000000000, 100, 100, 100, 100, 1],
        [1700007200000, 102, 103, 101, 102, 2],
    ];
    const result = detectMissingCandleTimestamps(candles, 3600);
    assert.strictEqual(result.gapCount, 1, 'missing hourly bucket should be detected');
    assert.deepStrictEqual(
        result.missingTimestamps,
        [1700003600000],
        'gap detector should return the missing hourly bucket timestamp'
    );
}

{
    const candles = [
        [1700000000000, 100, 100, 100, 100, 1],
        [1700003600000, 101, 101, 101, 101, 1],
    ];
    const result = detectMissingCandleTimestamps(candles, 3600);
    assert.strictEqual(result.gapCount, 0, 'continuous candles should not report gaps');
    assert.deepStrictEqual(result.missingTimestamps, [], 'continuous series should not return missing timestamps');
}

// General settings → runtime defaults behavior
assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 3.25 } }),
    3.25,
    'should read MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT when valid'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 0 } }),
    null,
    'non-positive settings value should be ignored'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 3.0 } }),
    3.0,
    'renamed DELTA_THRESHOLD_PERCENT should be accepted as fallback'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { GRID_RESET_FACTOR: 2.2 } }),
    2.2,
    'legacy GRID_RESET_FACTOR should be accepted as fallback threshold percent'
);

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { deltaThresholdPercent: 1 },
        { deltaThresholdPercent: false },
        { MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 4, 'settings should override default when CLI flag absent');
}

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { deltaThresholdPercent: 2.5 },
        { deltaThresholdPercent: true },
        { MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 2.5, 'CLI-provided deltaPercent should win over settings');
}

// Bot AMA config behavior
assert.strictEqual(DEFAULT_AMA.erPeriod, 395, 'built-in default AMA should point to AMA3 erPeriod');
assert.strictEqual(DEFAULT_AMA.fastPeriod, 1.51, 'built-in default AMA should point to AMA3 fastPeriod');
assert.strictEqual(DEFAULT_AMA.slowPeriod, 1944, 'built-in default AMA should point to AMA3 slowPeriod');

{
    const ama = resolveAmaForBot({
        ama: {
            enabled: true,
            erPeriod: 136,
            fastPeriod: 2.73,
            slowPeriod: 672,
        },
    });
    assert.strictEqual(ama.fastPeriod, 2.73, 'fractional fastPeriod from bot config should be preserved');
}

assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should enable price adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama3' }), true, 'ama3 should enable price adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: '  AMA4  ' }), true, 'ama4 matching should be case-insensitive');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 1.2345 }), false, 'numeric gridPrice should not enable price adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: null }), false, 'missing gridPrice should not enable price adapter processing');

// AMA profile override behavior
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        fs.mkdirSync(path.dirname(MARKET_PROFILES_FILE), { recursive: true });
        fs.writeFileSync(MARKET_PROFILES_FILE, JSON.stringify({
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA4',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 351, fastPeriod: 3.26, slowPeriod: 802 },
                        AMA4: { erPeriod: 136, fastPeriod: 2.73, slowPeriod: 672 },
                    },
                },
            ],
        }, null, 2));

        const ama1 = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama1' });
        assert.strictEqual(ama1.fastPeriod, 3.26, 'market_profiles AMA1 override should preserve fractional fastPeriod');

        const amaDefault = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama' });
        assert.strictEqual(amaDefault.fastPeriod, 2.73, 'market_profiles default AMA should preserve fractional fastPeriod');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// AMA comparison behavior should follow pair-specific profiles
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        fs.mkdirSync(path.dirname(MARKET_PROFILES_FILE), { recursive: true });
        fs.writeFileSync(MARKET_PROFILES_FILE, JSON.stringify({
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA4',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 2.1, slowPeriod: 6 },
                        AMA2: { erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA3: { erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                        AMA4: { erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
                    },
                },
            ],
        }, null, 2));

        const candles = Array.from({ length: 20 }, (_, i) => [1700000000000 + (i * 3600000), 100 + i, 101 + i, 99 + i, 100 + i, 1]);
        const comparison = calcAmaComparison(candles, { assetA: 'TESTA', assetB: 'TESTB' });
        assert.deepStrictEqual(
            comparison.map((entry) => ({ name: entry.name, erPeriod: entry.erPeriod, fastPeriod: entry.fastPeriod, slowPeriod: entry.slowPeriod })),
            [
                { name: 'AMA1', erPeriod: 2, fastPeriod: 2.1, slowPeriod: 6 },
                { name: 'AMA2', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                { name: 'AMA3', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                { name: 'AMA4', erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
            ],
            'market_profiles comparison should use pair-specific profile presets when present'
        );
        assert.ok(comparison.every((entry) => entry.ok), 'profile-based comparison presets should produce valid AMA values with enough candles');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// resolveOffsetForBot: defaults when no profile exists
{
    const offset = resolveOffsetForBot({ assetA: 'UNKNOWN', assetB: 'UNKNOWN' });
    assert.strictEqual(offset.devThreshold, 20, 'default devThreshold should be 20');
    assert.strictEqual(offset.maxPct, 10, 'default maxPct should be 10');
}

// resolveOffsetForBot: market_profiles.json overrides defaults
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        fs.mkdirSync(path.dirname(MARKET_PROFILES_FILE), { recursive: true });
        fs.writeFileSync(MARKET_PROFILES_FILE, JSON.stringify({
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    updatedAt: '2026-04-10T00:00:00.000Z',
                    amas: { AMA3: { erPeriod: 372, fastPeriod: 1.8, slowPeriod: 1286 } },
                    priceOffset: { devThreshold: 12, maxPct: 1.0 },
                },
            ],
        }, null, 2));

        const offset = resolveOffsetForBot({ assetA: 'TESTA', assetB: 'TESTB' });
        assert.strictEqual(offset.devThreshold, 12, 'market_profiles priceOffset.devThreshold should override defaults');
        assert.strictEqual(offset.maxPct, 1.0, 'market_profiles priceOffset.maxPct should override defaults');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

console.log('market_adapter logic tests passed');
process.exit(0);
