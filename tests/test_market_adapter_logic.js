const assert = require('assert');

console.log('Running market_adapter logic tests');

const {
    calculateBotThreshold,
    computeCandleStaleness,
    resolveDeltaThresholdPercentFromGeneralSettings,
    applyRuntimeDefaultsFromGeneralSettings,
} = require('../market_adapter/price_adapter');

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

// General settings → runtime defaults behavior
assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 3.25 } }),
    3.25,
    'should read MARKET_ADAPTER.DELTA_THRESHOLD_PERCENT when valid'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 0 } }),
    null,
    'non-positive settings value should be ignored'
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
        { MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 4, 'settings should override default when CLI flag absent');
}

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { deltaThresholdPercent: 2.5 },
        { deltaThresholdPercent: true },
        { MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 2.5, 'CLI-provided deltaPercent should win over settings');
}

console.log('market_adapter logic tests passed');
process.exit(0);
