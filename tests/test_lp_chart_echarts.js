'use strict';

const assert = require('assert');

const {
    generateHTML,
} = require('../market_adapter/lp_chart_core_echarts');
const {
    parseArgs,
} = require('../scripts/generate_lp_chart_echarts');

function testParseArgs() {
    const parsed = parseArgs(['--data', 'foo.json', '--out', 'out.html', '--no-open']);
    assert.strictEqual(parsed.dataFile.endsWith('foo.json'), true);
    assert.strictEqual(parsed.outFile.endsWith('out.html'), true);
    assert.strictEqual(parsed.noOpen, true);
    assert.strictEqual(parsed.help, false);
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
                values: [1.01, 1.06, 1.12],
            },
            {
                name: 'SLOW',
                color: '#fb8c00',
                dash: 'solid',
                lineWidth: 1.5,
                erPeriod: 1,
                fastPeriod: 2,
                slowPeriod: 3,
                values: [1.0, 1.03, 1.08],
            },
        ]
    );

    assert.ok(html.includes('echarts@5.5.1/dist/echarts.min.js'));
    assert.ok(html.includes('price-chart'));
    assert.ok(html.includes('dev-chart'));
    assert.ok(html.includes('vol-chart'));
    assert.ok(html.includes('AMA Parameters'));
    assert.ok(html.includes('LP Swap Price'));
}

function main() {
    testParseArgs();
    testGenerateHtml();
    console.log('lp chart echarts tests passed');
}

main();
