'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dynamic weight override wiring tests');

const marketAdapterPath = require.resolve('../market_adapter/market_adapter.js');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const originalMarketAdapter = require.cache[marketAdapterPath];
const originalBitsharesClient = require.cache[bitsharesClientPath];
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;

function installMarketAdapterStubs(settingsJson) {
    delete require.cache[marketAdapterPath];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_settings.json')) return true;
        return originalExistsSync(filePath);
    };

    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_settings.json')) {
            return JSON.stringify(settingsJson, null, 2);
        }
        return originalReadFileSync(filePath, encoding);
    };

    setCachedModule(bitsharesClientPath, {
        waitForConnected: async () => {},
    });
}

function restoreMarketAdapterStubs() {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    restoreCachedModule(marketAdapterPath, originalMarketAdapter);
    restoreCachedModule(bitsharesClientPath, originalBitsharesClient);
}

function testResolveBotCfgWiresMissingPairAndBotOverrides() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.33,
                    dispScaleAtrMult: 150,
                    dispScaleMinPct: 0.25,
                    hurstZoneBand: 0.08,
                    peNodes: [0.58, 0.70, 0.82],
                },
                botOverrides: {
                    'XRP-BTS': {
                        maxSlopeOffset: 0.44,
                        dispScaleAtrMult: 175,
                        dispScaleMinPct: 0.35,
                        hurstZoneBand: 0.09,
                        peNodes: [0.57, 0.69, 0.81],
                    },
                },
            },
        ],
    };

    installMarketAdapterStubs(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter.js');

    const bot = {
        name: 'XRP-BTS',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.maxSlopeOffset, 0.44, 'bot override should win for maxSlopeOffset');
    assert.strictEqual(merged.dispScaleAtrMult, 175, 'bot override should win for dispScaleAtrMult');
    assert.strictEqual(merged.dispScaleMinPct, 0.35, 'bot override should win for dispScaleMinPct');
    assert.strictEqual(merged.hurstZoneBand, 0.09, 'bot override should win for hurstZoneBand');
    assert.deepStrictEqual(merged.peNodes, [0.57, 0.69, 0.81], 'bot override should win for peNodes');
}

function testResolveBotCfgWiresMissingPairOverridesWithoutBotOverride() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.31,
                    dispScaleAtrMult: 140,
                    dispScaleMinPct: 0.2,
                    hurstZoneBand: 0.07,
                    peNodes: [0.59, 0.71, 0.83],
                },
            },
        ],
    };

    installMarketAdapterStubs(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter.js');

    const bot = {
        name: 'Different Bot',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.maxSlopeOffset, 0.31, 'pair override should apply for maxSlopeOffset');
    assert.strictEqual(merged.dispScaleAtrMult, 140, 'pair override should apply for dispScaleAtrMult');
    assert.strictEqual(merged.dispScaleMinPct, 0.2, 'pair override should apply for dispScaleMinPct');
    assert.strictEqual(merged.hurstZoneBand, 0.07, 'pair override should apply for hurstZoneBand');
    assert.deepStrictEqual(merged.peNodes, [0.59, 0.71, 0.83], 'pair override should apply for peNodes');
}

function testBilinearInterpolateUsesOverrideNodes() {
    const { bilinearInterpolate } = require('../market_adapter/core/strategies/regime_gate');

    const table = [
        [1.0, 0.7, 0.3],
        [0.6, 0.4, 0.15],
        [0.3, 0.2, 0.05],
    ];

    const defaultValue = bilinearInterpolate(0.56, 0.61, table);
    const overrideValue = bilinearInterpolate(0.56, 0.61, table, {
        hurstZoneBand: 0.08,
        peNodes: [0.58, 0.70, 0.82],
    });

    assert.notStrictEqual(overrideValue, defaultValue, 'override nodes should change interpolation');
}

function testResolveBotCfgSanitizesAtrPeriodAndVolatilityClampOverrides() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    atrPeriod: 0,
                    maxVolatilityOffset: -0.5,
                    volatilityThreshold: -1,
                },
                botOverrides: {
                    'XRP-BTS': {
                        atrPeriod: 14.5,
                        maxVolatilityOffset: 0,
                        volatilityThreshold: Number.NaN,
                    },
                },
            },
        ],
    };

    installMarketAdapterStubs(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter.js');
    const { MARKET_ADAPTER } = require('../modules/constants');

    const bot = {
        name: 'XRP-BTS',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.atrPeriod, 15, 'positive fractional ATR period should be normalized to an integer');
    assert.strictEqual(
        merged.maxVolatilityOffset,
        0,
        'zero volatility clamp overrides should remain valid and disable the symmetric shift'
    );
    assert.strictEqual(
        merged.volatilityThreshold,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
        'invalid volatility thresholds should fall back to the default threshold'
    );
}

async function main() {
    try {
        testResolveBotCfgWiresMissingPairAndBotOverrides();
        restoreMarketAdapterStubs();

        testResolveBotCfgWiresMissingPairOverridesWithoutBotOverride();
        restoreMarketAdapterStubs();

        testBilinearInterpolateUsesOverrideNodes();
        restoreMarketAdapterStubs();

        testResolveBotCfgSanitizesAtrPeriodAndVolatilityClampOverrides();
        console.log('dynamic weight override wiring tests passed');
    } finally {
        restoreMarketAdapterStubs();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
