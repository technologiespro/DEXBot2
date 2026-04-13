'use strict';

const assert = require('assert');

const {
    calculateMetrics,
    generateSyntheticPair,
} = require('../analysis/ama_fitting/generate_unified_comparison_chart_echarts');

function testGenerateSyntheticPair() {
    const bts = [
        { timestamp: 1, open: 10, high: 11, low: 9, close: 10.5 },
        { timestamp: 2, open: 11, high: 12, low: 10, close: 11.5 },
        { timestamp: 3, open: 12, high: 13, low: 11, close: 12.5 },
    ];
    const xrp = [
        { timestamp: 1, open: 2, high: 2.5, low: 1.5, close: 2.1 },
        { timestamp: 2, open: 2, high: 2.4, low: 1.6, close: 2.2 },
        { timestamp: 3, open: 2, high: 2.3, low: 1.7, close: 2.4 },
    ];

    const synthetic = generateSyntheticPair(bts, xrp);
    assert.strictEqual(synthetic.length, 3);
    assert.ok(synthetic[0].close < bts[0].close);
}

function testCalculateMetrics() {
    const candles = [
        { high: 10, low: 8 },
        { high: 11, low: 9 },
        { high: 12, low: 10 },
        { high: 13, low: 11 },
    ];
    const values = [9, 9.5, 10, 10.5];
    const metrics = calculateMetrics(values, candles);
    assert.ok(metrics.totalArea >= 0);
    assert.ok(metrics.maxDistance >= 0);
}

function main() {
    testGenerateSyntheticPair();
    testCalculateMetrics();
    console.log('ama chart echarts tests passed');
}

main();
