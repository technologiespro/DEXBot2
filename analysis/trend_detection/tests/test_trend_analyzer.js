/**
 * Test Trend Analyzer — derivative-based (SMA only)
 */

'use strict';

const { TrendAnalyzer } = require('../trend_analyzer');

function printEvery(label, analysis, i, interval = 10) {
    if ((i + 1) % interval !== 0) return;
    console.log(
        `[${label} ${i + 1}] trend=${analysis.trend} conf=${analysis.confidence}%` +
        ` confirmed=${analysis.isConfirmed}` +
        ` sma=${analysis.smaRawTrend}(${analysis.smaBarsInTrend})`
    );
}

// Market drifts steadily up → SMA derivative positive → UP
async function testUptrend() {
    console.log('=== Uptrend: steadily rising price ===\n');
    const a = new TrendAnalyzer({ minBarsForConfirmation: 3 });

    // Short SMA to keep test fast
    const fast = new TrendAnalyzer({
        slowSmaPeriod: 20,
        minBarsForConfirmation: 3,
    });

    for (let i = 0; i < 55; i++) {
        const r = fast.update(1000 + i * 2, 1000);
        printEvery('Up', r, i);
    }
    console.log(`isUptrend: ${fast.isUptrend()}\n`);
}

// Market drifts steadily down → SMA derivative negative → DOWN
async function testDowntrend() {
    console.log('=== Downtrend: steadily falling price ===\n');
    const fast = new TrendAnalyzer({
        slowSmaPeriod: 20,
        minBarsForConfirmation: 3,
    });

    for (let i = 0; i < 55; i++) {
        const r = fast.update(2000 - i * 2, 2000);
        printEvery('Dn', r, i);
    }
    console.log(`isDowntrend: ${fast.isDowntrend()}\n`);
}

// Market oscillates → derivatives flip → stays NEUTRAL
async function testChoppy() {
    console.log('=== Choppy: oscillation ===\n');
    const fast = new TrendAnalyzer({
        slowSmaPeriod: 20,
        minBarsForConfirmation: 3,
    });

    for (let i = 0; i < 55; i++) {
        const noise = Math.sin(i * 0.5) * 5;
        const r = fast.update(1000 + noise, 1000);
        printEvery('Ch', r, i);
    }
    console.log(`isNeutral: ${fast.isNeutral()}\n`);
}

// feedPrice accepted but does not affect trend (backward compat)
async function testFeedPriceIgnored() {
    console.log('=== Feed price backward compat ===\n');
    const fast = new TrendAnalyzer({
        slowSmaPeriod: 20,
        minBarsForConfirmation: 3,
    });

    for (let i = 0; i < 55; i++) {
        const price = 1000 + i * 2;
        fast.update(price, 1000); // feedPrice provided but ignored for trend
    }
    const premium = fast.getFeedPremium();
    console.log(`Premium: ${premium ? JSON.stringify(premium) : 'null'}\n`);
}

// Full snapshot
async function testSnapshot() {
    console.log('=== Full Snapshot ===\n');
    const fast = new TrendAnalyzer({
        slowSmaPeriod: 20,
        minBarsForConfirmation: 3,
    });

    for (let i = 0; i < 55; i++) {
        fast.update(1000 + i * 3, 1000);
    }

    console.log(JSON.stringify(fast.getFullSnapshot(), null, 2));
    console.log('');
}

async function main() {
    await testUptrend();
    await testDowntrend();
    await testChoppy();
    await testFeedPriceIgnored();
    await testSnapshot();
    console.log('=== All tests complete ===');
}

main().catch(console.error);

module.exports = { testUptrend, testDowntrend, testChoppy, testFeedPriceIgnored, testSnapshot };
