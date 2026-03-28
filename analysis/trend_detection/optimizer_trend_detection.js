/**
 * TREND DETECTION OPTIMIZER (AMA + Feed)
 *
 * Tests different AMA parameter combinations for the feed-based trend
 * detection method.  The "true" trend is derived from the feed price:
 * when market price is consistently above feed, true trend is UP; below
 * feed is DOWN.
 *
 * For backtesting without a live feed, we synthesize a stable feed from
 * a slow moving average of the price data.
 *
 * Output: optimization_results_trend_1day.json (all results ranked)
 */

const fs = require('fs');
const path = require('path');
const { TrendAnalyzer } = require('./trend_analyzer');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');

function loadData() {
    const dataFile = path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC_1day.json');

    if (!fs.existsSync(dataFile)) {
        console.error('Data file not found:', dataFile);
        console.error('Run: node fetch_1day_candles.js');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    console.log(`Loaded ${data.length} 1-day candles`);

    return data.map(candle => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
    }));
}

/**
 * Synthesize a feed price series from a very slow SMA.
 * For HONEST.Assets the feed is externally published and relatively stable.
 * A 50-period SMA approximates that anchoring behavior for backtesting.
 */
function synthesizeFeedPrices(candles, smaPeriod = 50) {
    const closes = candles.map(c => c.close);
    const feed = [];

    for (let i = 0; i < closes.length; i++) {
        if (i < smaPeriod - 1) {
            // Not enough data yet — use close as feed proxy
            feed.push(closes[i]);
        } else {
            let sum = 0;
            for (let j = i - smaPeriod + 1; j <= i; j++) {
                sum += closes[j];
            }
            feed.push(sum / smaPeriod);
        }
    }

    return feed;
}

/**
 * Calculate "true" trend using market price vs synthesized feed.
 * UP = price > feed + tolerance, DOWN = price < feed - tolerance.
 */
function calculateTrueTrend(candles, feedPrices, tolerancePercent = 0.5) {
    return candles.map((c, i) => {
        const feed = feedPrices[i];
        const tolerance = feed * (tolerancePercent / 100);
        if (c.close > feed + tolerance) return 'UP';
        if (c.close < feed - tolerance) return 'DOWN';
        return 'NEUTRAL';
    });
}

/**
 * Test a single AMA parameter combination with feed-based trend detection.
 */
function testConfiguration(candles, feedPrices, feedTrendConfig) {
    try {
        const analyzer = new TrendAnalyzer({
            lookbackBars: 20,
            feedTrendConfig,
        });

        const detectedTrends = [];
        let confirmedTrendsCount = 0;
        let trendChangeCount = 0;
        let lastTrend = 'NEUTRAL';

        for (let i = 0; i < candles.length; i++) {
            analyzer.update(candles[i].close, feedPrices[i]);
            const analysis = analyzer.getAnalysis();

            if (analysis.isReady) {
                detectedTrends.push(analysis.trend);

                if (analysis.trend !== lastTrend) {
                    trendChangeCount++;
                }
                if (analysis.isConfirmed) {
                    confirmedTrendsCount++;
                }
                lastTrend = analysis.trend;
            }
        }

        return { detectedTrends, confirmedTrendsCount, trendChangeCount };
    } catch (_) {
        return null;
    }
}

/**
 * Score a configuration against the true trend series.
 */
function calculateScore(detectedTrends, trueTrends, warmup = 50) {
    const slice = detectedTrends.slice(warmup - 1);
    const truthSlice = trueTrends.slice(warmup - 1);
    if (slice.length === 0) return null;

    let correctCount = 0;
    for (let i = 0; i < slice.length; i++) {
        if (slice[i] === truthSlice[i]) correctCount++;
    }
    const accuracy = (correctCount / slice.length) * 100;

    let confirmedMatches = 0;
    let confirmedCount = 0;
    for (let i = 0; i < slice.length; i++) {
        if (slice[i] !== 'NEUTRAL') {
            confirmedCount++;
            if (slice[i] === truthSlice[i]) confirmedMatches++;
        }
    }
    const confirmedAccuracy = confirmedCount > 0 ? (confirmedMatches / confirmedCount) * 100 : 0;

    const combinedScore = accuracy * 0.6 + confirmedAccuracy * 0.4;

    return {
        accuracy: Math.round(accuracy * 100) / 100,
        confirmedAccuracy: Math.round(confirmedAccuracy * 100) / 100,
        score: Math.round(combinedScore * 100) / 100,
        confirmedSignals: confirmedCount,
    };
}

/**
 * Generate parameter combinations for feed-based AMA.
 */
function generateConfigurations() {
    const configs = [];

    const erPeriods = [10, 20, 30, 40, 50, 60, 80, 100];
    const fastPeriods = [2, 3, 4, 5];
    const slowPeriods = [10, 15, 20, 25, 30];
    const thresholds = [0.5, 1.0, 1.5, 2.0];

    for (const erPeriod of erPeriods) {
        for (const fastPeriod of fastPeriods) {
            for (const slowPeriod of slowPeriods) {
                if (fastPeriod >= slowPeriod) continue;
                for (const thresholdPercent of thresholds) {
                    configs.push({ erPeriod, fastPeriod, slowPeriod, thresholdPercent });
                }
            }
        }
    }

    return configs;
}

async function optimize() {
    console.log('=== TREND DETECTION OPTIMIZER (AMA + Feed) ===\n');

    console.log('Loading data...');
    const candles = loadData();

    console.log('Synthesizing feed prices (50-period SMA)...');
    const feedPrices = synthesizeFeedPrices(candles, 50);

    console.log('Calculating reference trends...');
    const trueTrends = calculateTrueTrend(candles, feedPrices, 0.5);

    console.log('\nGenerating parameter combinations...');
    const configs = generateConfigurations();
    console.log(`Testing ${configs.length} configurations...\n`);

    const results = [];
    let tested = 0;

    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        const testResult = testConfiguration(candles, feedPrices, cfg);

        if (testResult) {
            const score = calculateScore(testResult.detectedTrends, trueTrends);
            if (score) {
                results.push({
                    rank: 0,
                    config: cfg,
                    metrics: score,
                    detection: {
                        trendChanges: testResult.trendChangeCount,
                        confirmedTrends: testResult.confirmedTrendsCount,
                    }
                });
            }
            tested++;

            if ((i + 1) % 100 === 0) {
                console.log(`  Tested ${i + 1}/${configs.length}...`);
            }
        }
    }

    results.sort((a, b) => b.metrics.score - a.metrics.score);
    results.forEach((r, i) => { r.rank = i + 1; });

    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    console.log(`\nTested ${tested} configurations`);
    console.log(`Results saved to: ${path.basename(RESULTS_FILE)}`);

    console.log('\n=== TOP 10 CONFIGURATIONS ===\n');
    console.log('For REAL performance metrics, run: node backtest_trend_detection.js\n');
    for (let i = 0; i < Math.min(10, results.length); i++) {
        const r = results[i];
        const c = r.config;
        console.log(`#${r.rank} - Score: ${r.metrics.score}/100`);
        console.log(`    AMA: ER=${c.erPeriod}, Fast=${c.fastPeriod}, Slow=${c.slowPeriod}, Threshold=${c.thresholdPercent}%`);
        console.log(`    Accuracy: ${r.metrics.accuracy}% (Confirmed: ${r.metrics.confirmedAccuracy}%)`);
        console.log('');
    }

    const scores = results.map(r => r.metrics.score);
    console.log('=== STATISTICS ===');
    console.log(`  Tested: ${tested} configurations`);
    console.log(`  Best Score: ${Math.max(...scores).toFixed(2)}/100`);
    console.log(`  Avg Score: ${(scores.reduce((a, b) => a + b) / scores.length).toFixed(2)}/100`);
    console.log(`  Worst Score: ${Math.min(...scores).toFixed(2)}/100`);

    return results;
}

optimize().catch(console.error);

module.exports = { optimize };
