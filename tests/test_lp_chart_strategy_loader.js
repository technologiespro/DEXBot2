'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    findLatestLpData,
    parseLpChartCliArgs,
} = require('../market_adapter/lp_chart_runner');
const {
    loadStrategiesForLpChart,
    loadStrategiesFromProfiles,
} = require('../market_adapter/lp_chart_strategy_loader');

function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function removeFile(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (_) {}
}

function makeAmaConfig(name, erPeriod, fastPeriod, slowPeriod) {
    return { name, erPeriod, fastPeriod, slowPeriod };
}

function testLoaderFindsOptimizerResultsFromAnalysisDir() {
    const suffix = `${Date.now()}-${process.pid}`;
    const dataFile = path.join(
        __dirname,
        '..',
        'market_adapter',
        'inputs',
        'data',
        'lp',
        `test_pair_${suffix}`,
        `lp_pool_${suffix}_1h.json`
    );
    const resultsFile = path.join(
        __dirname,
        '..',
        'analysis',
        'ama_fitting',
        `optimization_results_lp_pool_${suffix}_1h.json`
    );

    writeJson(dataFile, {
        meta: {
            assetA: { symbol: 'TESTA' },
            assetB: { symbol: 'TESTB' },
            intervalSeconds: 3600,
        },
        candles: [],
    });
    writeJson(resultsFile, {
        meta: {
            amas: {
                AMA1: { label: 'AMA1 Fast', er: 10, fast: 2, slow: 30 },
                AMA2: { label: 'AMA2 Mid', er: 20, fast: 3, slow: 60 },
                AMA3: { label: 'AMA3 Slow', er: 30, fast: 4, slow: 90 },
                AMA4: { label: 'AMA4 Slowest', er: 40, fast: 5, slow: 120 },
            },
        },
    });

    try {
        const strategies = loadStrategiesForLpChart({
            dataFile,
            meta: {
                assetA: { symbol: 'TESTA' },
                assetB: { symbol: 'TESTB' },
                intervalSeconds: 3600,
            },
        });

        assert.ok(Array.isArray(strategies), 'strategies should be loaded from optimizer results');
        assert.strictEqual(strategies.length, 4);
        assert.strictEqual(strategies[0].erPeriod, 10);
        assert.strictEqual(strategies[3].slowPeriod, 120);
    } finally {
        removeFile(dataFile);
        removeFile(resultsFile);
    }
}

function testProfilesMatchByIntervalLabelFallback() {
    const suffix = `${Date.now()}-${process.pid}`;
    const profilesFile = path.join(__dirname, '..', 'tmp', `lp_chart_profiles_${suffix}.json`);

    writeJson(profilesFile, {
        profiles: [
            {
                assetA: 'TESTA',
                assetB: 'TESTB',
                intervalLabel: '1h',
                updatedAt: '2026-04-12T00:00:00.000Z',
                amas: {
                    AMA1: makeAmaConfig('AMA1', 11, 2, 31),
                    AMA2: makeAmaConfig('AMA2', 22, 3, 62),
                    AMA3: makeAmaConfig('AMA3', 33, 4, 93),
                    AMA4: makeAmaConfig('AMA4', 44, 5, 124),
                },
            },
        ],
    });

    try {
        const strategies = loadStrategiesFromProfiles(profilesFile, {
            assetA: { symbol: 'TESTA' },
            assetB: { symbol: 'TESTB' },
            intervalSeconds: 3600,
        });

        assert.ok(Array.isArray(strategies), 'strategies should load when profile only matches by intervalLabel');
        assert.strictEqual(strategies.length, 4);
        assert.strictEqual(strategies[2].erPeriod, 33);
        assert.strictEqual(strategies[3].slowPeriod, 124);
    } finally {
        removeFile(profilesFile);
    }
}

function testLatestLpDataIncludesInputsDirectory() {
    const suffix = `${Date.now()}-${process.pid}`;
    const analysisFile = path.join(
        __dirname,
        '..',
        'analysis',
        'ama_fitting',
        'data',
        `lp_pool_${suffix}_analysis.json`
    );
    const inputsFile = path.join(
        __dirname,
        '..',
        'market_adapter',
        'inputs',
        'data',
        `lp_pool_${suffix}_inputs.json`
    );

    writeJson(analysisFile, { meta: {}, candles: [] });
    writeJson(inputsFile, { meta: {}, candles: [] });

    const now = Date.now();
    fs.utimesSync(analysisFile, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(inputsFile, new Date(now + 10_000), new Date(now + 10_000));

    try {
        assert.strictEqual(findLatestLpData(), inputsFile, 'latest LP data should include market_adapter/inputs/data');
    } finally {
        removeFile(analysisFile);
        removeFile(inputsFile);
    }
}

function testParseLpChartCliArgsSupportsWrapperModes() {
    const scriptArgs = parseLpChartCliArgs(['--data', 'market_adapter/data/example.json', '--no-open'], {
        dataFlags: ['--data', '--file'],
    });
    assert.ok(scriptArgs.dataFile.endsWith(path.join('market_adapter', 'data', 'example.json')));
    assert.strictEqual(scriptArgs.noOpen, true);

    const marketArgs = parseLpChartCliArgs(['--file', 'analysis/ama_fitting/data/example.json'], {
        dataFlags: ['--file'],
    });
    assert.ok(marketArgs.dataFile.endsWith(path.join('analysis', 'ama_fitting', 'data', 'example.json')));
    assert.strictEqual(marketArgs.noOpen, false);

    const analysisArgs = parseLpChartCliArgs(['--data', 'analysis/ama_fitting/data/example.json', 'ignored.json'], {
        dataFlags: ['--data'],
        allowPositional: false,
    });
    assert.ok(analysisArgs.dataFile.endsWith(path.join('analysis', 'ama_fitting', 'data', 'example.json')));
    assert.strictEqual(analysisArgs.noOpen, false);
}

function main() {
    testLoaderFindsOptimizerResultsFromAnalysisDir();
    testProfilesMatchByIntervalLabelFallback();
    testLatestLpDataIncludesInputsDirectory();
    testParseLpChartCliArgsSupportsWrapperModes();
    console.log('lp chart strategy loader tests passed');
}

main();
