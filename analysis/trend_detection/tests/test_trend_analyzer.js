/**
 * Test Trend Analyzer (AMA + Feed)
 */

const { TrendAnalyzer } = require('../trend_analyzer');

function printEvery(label, analysis, i, interval = 10) {
    if ((i + 1) % interval !== 0) return;
    console.log(`[${label} ${i + 1}] trend=${analysis.trend} conf=${analysis.confidence}% confirmed=${analysis.isConfirmed}`);
    if (analysis.premium) {
        console.log(`  premium: ${analysis.premium.signal} (${analysis.premium.percent}%)  dev=${analysis.deviationPercent}%`);
    }
    console.log('');
}

// Market drifts above feed → UP trend + PREMIUM
async function testUptrend() {
    console.log('=== Uptrend: market above feed ===\n');
    const a = new TrendAnalyzer({
        feedTrendConfig: { thresholdPercent: 1.0 },
        feedPremiumConfig: { deadZonePercent: 0.25 },
    });

    for (let i = 0; i < 55; i++) {
        const r = a.update(1000 + i * 2, 1000);
        printEvery('Up', r, i);
    }
    console.log(`isUptrend: ${a.isUptrend()}\n`);
}

// Market drifts below feed → DOWN trend + DISCOUNT
async function testDowntrend() {
    console.log('=== Downtrend: market below feed ===\n');
    const a = new TrendAnalyzer({
        feedTrendConfig: { thresholdPercent: 1.0 },
        feedPremiumConfig: { deadZonePercent: 0.25 },
    });

    for (let i = 0; i < 55; i++) {
        const r = a.update(1000 - i * 2, 1000);
        printEvery('Dn', r, i);
    }
    console.log(`isDowntrend: ${a.isDowntrend()}\n`);
}

// Market oscillates around feed → NEUTRAL + FAIR
async function testChoppy() {
    console.log('=== Choppy: oscillation around feed ===\n');
    const a = new TrendAnalyzer({
        feedTrendConfig: { thresholdPercent: 1.0 },
        feedPremiumConfig: { deadZonePercent: 0.25 },
    });

    for (let i = 0; i < 55; i++) {
        const noise = Math.sin(i * 0.5) * 5;
        const r = a.update(1000 + noise, 1000);
        printEvery('Ch', r, i);
    }
    console.log(`isNeutral: ${a.isNeutral()}\n`);
}

// Both market and feed move together → NEUTRAL (no deviation)
async function testParallelMove() {
    console.log('=== Parallel: market and feed move together ===\n');
    const a = new TrendAnalyzer({
        feedTrendConfig: { thresholdPercent: 1.0 },
        feedPremiumConfig: { deadZonePercent: 0.25 },
    });

    for (let i = 0; i < 55; i++) {
        const price = 1000 + i * 2;
        const r = a.update(price + 1, price);  // market always +1 above feed
        printEvery('Par', r, i);
    }
    console.log(`isNeutral: ${a.isNeutral()}\n`);
}

// Full snapshot output
async function testSnapshot() {
    console.log('=== Full Snapshot ===\n');
    const a = new TrendAnalyzer({
        feedTrendConfig: { erPeriod: 40, fastPeriod: 5, slowPeriod: 15, thresholdPercent: 1.0 },
        feedPremiumConfig: { deadZonePercent: 0.25 },
    });

    for (let i = 0; i < 55; i++) {
        a.update(1000 + i * 3, 1000);
    }

    console.log(JSON.stringify(a.getFullSnapshot(), null, 2));
    console.log('');
}

async function main() {
    await testUptrend();
    await testDowntrend();
    await testChoppy();
    await testParallelMove();
    await testSnapshot();
    console.log('=== All tests complete ===');
}

main().catch(console.error);

module.exports = { testUptrend, testDowntrend, testChoppy, testParallelMove, testSnapshot };
