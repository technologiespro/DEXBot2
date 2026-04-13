'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
    generateHTML,
} = require('../market_adapter/lp_chart_core_uplot');
const {
    calculateMetrics,
    generateSyntheticPair,
    generateUnifiedComparisonChartUplot,
    parseArgs,
} = require('../analysis/ama_fitting/generate_unified_comparison_chart_uplot');

function writeCandles(filePath, basePrice, step) {
    const candles = Array.from({ length: 120 }, (_, i) => {
        const price = basePrice + (i * step);
        return [
            1710000000000 + (i * 14400000),
            price,
            price * 1.01,
            price * 0.99,
            price * 1.005,
            100 + i,
        ];
    });
    fs.writeFileSync(filePath, JSON.stringify(candles), 'utf8');
}

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

function testGenerateUnifiedComparisonChartUplot() {
    const candles = Array.from({ length: 120 }, (_, i) => ({
        timestamp: 1710000000 + (i * 14400),
        open: 1.2 + (i * 0.002),
        high: 1.22 + (i * 0.002),
        low: 1.18 + (i * 0.002),
        close: 1.2 + (i * 0.0025),
        volume: 100 + i,
    }));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-ama-uplot-'));
    const outFile = path.join(tmpDir, 'synthetic.uplot.html');
    const result = generateUnifiedComparisonChartUplot({
        candles,
        outFile,
        logger: { log() {} },
    });

    assert.strictEqual(fs.existsSync(outFile), true);
    const html = fs.readFileSync(outFile, 'utf8');
    assert.ok(html.includes('uPlot.iife.min.js'));
    assert.ok(html.includes('price-chart'));
    const match = html.match(/<script>\s*(const payload =[\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(match, 'expected browser script block');
    new vm.Script(match[1]);
    assert.ok(result.amaResults.length >= 3);
}

function testGenerateHtml() {
    const html = generateHTML(
        {
            assetA: { symbol: 'XRP' },
            assetB: { symbol: 'BTS' },
            intervalSeconds: 3600,
            fetchedAt: '2026-04-13T00:00:00.000Z',
        },
        [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
            [1710010800000, 1.15, 1.24, 1.05, 1.2, 14],
        ],
        [
            {
                name: 'FAST',
                color: '#26a69a',
                dash: 'dot',
                lineWidth: 2,
                erPeriod: 1,
                fastPeriod: 2,
                slowPeriod: 3,
                values: [1.01, 1.06, 1.12, 1.16],
            },
            {
                name: 'SLOW',
                color: '#fb8c00',
                dash: 'solid',
                lineWidth: 1.5,
                erPeriod: 1,
                fastPeriod: 2,
                slowPeriod: 3,
                values: [1.0, 1.03, 1.08, 1.12],
            },
        ]
    );

    assert.ok(html.includes('uPlot.iife.min.js'));
    assert.ok(html.includes('LP Swap Price'));
    const match = html.match(/<script>\s*(const payload =[\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(match, 'expected browser script block');
    new vm.Script(match[1]);
}

function testParseArgs() {
    const parsed = parseArgs([
        '--bts-file', 'bts.json',
        '--xrp-file', 'xrp.json',
        '--output', 'out.html',
        '--quiet',
    ]);

    assert.strictEqual(parsed.btsFile.endsWith('bts.json'), true);
    assert.strictEqual(parsed.xrpFile.endsWith('xrp.json'), true);
    assert.strictEqual(parsed.outFile.endsWith('out.html'), true);
    assert.strictEqual(parsed.quiet, true);
    assert.strictEqual(parsed.help, false);
}

function testGenerateUnifiedComparisonChartUplotRequiresInput() {
    assert.throws(
        () => generateUnifiedComparisonChartUplot({ logger: { log() {} } }),
        /requires --bts-file and --xrp-file/
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-ama-input-'));
    const btsFile = path.join(tmpDir, 'bts.json');
    const xrpFile = path.join(tmpDir, 'xrp.json');
    const outFile = path.join(tmpDir, 'synthetic.uplot.html');
    writeCandles(btsFile, 10, 0.05);
    writeCandles(xrpFile, 2, 0.01);

    const result = generateUnifiedComparisonChartUplot({
        btsFile,
        xrpFile,
        outFile,
        logger: { log() {} },
    });

    assert.strictEqual(fs.existsSync(outFile), true);
    assert.ok(result.amaResults.length >= 3);
}

function main() {
    testGenerateSyntheticPair();
    testCalculateMetrics();
    testParseArgs();
    testGenerateUnifiedComparisonChartUplotRequiresInput();
    testGenerateHtml();
    testGenerateUnifiedComparisonChartUplot();
    console.log('ama chart uplot tests passed');
}

main();
