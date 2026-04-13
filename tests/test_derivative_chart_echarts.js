'use strict';

const assert = require('assert');

const {
    generateHTML,
} = require('../analysis/derivative_chart_generator_echarts');

function makeResult(i) {
    const price = 100 + i;
    return {
        timestamp: `2026-04-13T0${i}:00:00.000Z`,
        price,
        slowSma: price - 0.5,
        fastSmaValue: price - 0.25,
        smaRawTrend: i % 2 === 0 ? 'UP' : 'DOWN',
        smaConfidence: 75 + i,
        fastSmaRawTrend: i % 2 === 0 ? 'UP' : 'DOWN',
        fastSmaConfidence: 70 + i,
        macdHistogram: i % 2 === 0 ? 0.4 : -0.2,
        macdLine: 0.5 + i * 0.1,
        macdSignal: 0.3 + i * 0.1,
        rsi: 45 + i,
        interpretation: i % 2 === 0 ? 'BULL' : 'BEAR',
        interpretationBars: i + 1,
        entryBias: i === 2 ? 'CONFIRM_LONG' : 'NONE',
        rsiZone: i === 0 ? 'OVERSOLD' : 'NEUTRAL',
        macdTrend: i % 2 === 0 ? 'BULL' : 'BEAR',
        isBullWeakEntry: i === 0,
        isBullConfirmation: i === 1,
        isLateBullWithoutWeak: i === 2,
        isBearWeakEntry: i === 3,
        isBearConfirmation: i === 4,
        isLateBearWithoutWeak: i === 4,
        fastSmaValue: price - 0.25,
        fastSmaBarsInTrend: i + 2,
        isReady: true,
    };
}

function testGenerateHtml() {
    const html = generateHTML(
        {
            config: {
                source: 'market_adapter',
                slowSmaPeriod: 500,
                fastSmaPeriod: 50,
                macdFastPeriod: 12,
                macdSlowPeriod: 26,
                macdSignalPeriod: 9,
                rsiPeriod: 14,
                rsiExtreme: 90,
            },
            allResults: [0, 1, 2, 3, 4, 5].map(makeResult),
        },
        'Derivative Trend Analysis'
    );

    assert.ok(html.includes('echarts@5.5.1/dist/echarts.min.js'));
    assert.ok(html.includes('price-chart'));
    assert.ok(html.includes('deriv-chart'));
    assert.ok(html.includes('interp-chart'));
    assert.ok(html.includes('macd-chart'));
    assert.ok(html.includes('rsi-chart'));
    assert.ok(html.includes('Reset Zoom'));
}

function main() {
    testGenerateHtml();
    console.log('derivative chart echarts tests passed');
}

main();
