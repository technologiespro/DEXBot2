/**
 * TREND DETECTION BACKTEST (AMA + Feed)
 *
 * Backtests the best AMA+feed trend detection configuration on historical data.
 * Simulates trades based on trend signals and calculates performance metrics.
 *
 * A synthetic feed price is derived from a slow SMA to approximate the
 * feed-anchored behavior of HONEST.Assets during backtesting.
 *
 * Input: Best configuration from optimizer + 1-day candle data
 * Output: Backtest report with statistics and metrics
 */

const fs = require('fs');
const path = require('path');
const { TrendAnalyzer } = require('./trend_analyzer');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(__dirname, 'optimization_results_trend_1day.json');
const BACKTEST_OUTPUT = path.join(__dirname, 'backtest_results_trend_1day.json');
const REPORT_OUTPUT = path.join(__dirname, 'backtest_report_trend_1day.txt');

function loadJSON(filepath) {
    try {
        return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
        console.error(`Error loading ${filepath}:`, e.message);
        return null;
    }
}

function loadCandles() {
    const dataFile = path.join(DATA_DIR, 'XRP_BTS_SYNTHETIC_1day.json');
    if (!fs.existsSync(dataFile)) {
        console.error('Data file not found:', dataFile);
        return null;
    }
    const data = loadJSON(dataFile);
    return data.map(candle => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
    }));
}

function synthesizeFeedPrices(candles, smaPeriod = 50) {
    const closes = candles.map(c => c.close);
    const feed = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < smaPeriod - 1) {
            feed.push(closes[i]);
        } else {
            let sum = 0;
            for (let j = i - smaPeriod + 1; j <= i; j++) sum += closes[j];
            feed.push(sum / smaPeriod);
        }
    }
    return feed;
}

function getBestConfiguration() {
    if (!fs.existsSync(RESULTS_FILE)) {
        console.error('Results file not found:', RESULTS_FILE);
        return null;
    }
    const results = loadJSON(RESULTS_FILE);
    return results && results.length > 0 ? results[0] : null;
}

function runBacktest(candles, feedPrices, bestConfig) {
    const analyzer = new TrendAnalyzer({
        lookbackBars: 20,
        feedTrendConfig: bestConfig.config,
    });

    const stats = {
        totalCandles: candles.length,
        trades: [],
        wins: 0,
        losses: 0,
        breakeven: 0,
        totalProfit: 0,
        totalLoss: 0,
        maxWin: 0,
        maxLoss: 0,
        uptrends: 0,
        downtrends: 0,
        neutrals: 0,
        trendChanges: 0,
    };

    let currentPosition = null;
    let lastTrend = 'NEUTRAL';

    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        const analysis = analyzer.update(candle.close, feedPrices[i]);

        if (!analysis.isReady) continue;

        const trend = analysis.trend;

        if (trend === 'UP') stats.uptrends++;
        else if (trend === 'DOWN') stats.downtrends++;
        else stats.neutrals++;

        if (trend !== lastTrend && lastTrend !== 'NEUTRAL') {
            stats.trendChanges++;
        }

        if (trend !== lastTrend) {
            if (currentPosition) {
                const exit = {
                    entry_index: currentPosition.entry_index,
                    exit_index: i,
                    entry_price: currentPosition.entry_price,
                    exit_price: candle.close,
                    entry_date: new Date(candles[currentPosition.entry_index].timestamp).toISOString().split('T')[0],
                    exit_date: new Date(candle.timestamp).toISOString().split('T')[0],
                    days_held: i - currentPosition.entry_index,
                    pnl_percent: ((candle.close - currentPosition.entry_price) / currentPosition.entry_price) * 100,
                    pnl_absolute: candle.close - currentPosition.entry_price,
                    premium_at_entry: currentPosition.premium_at_entry,
                    deviation_at_entry: currentPosition.deviation_at_entry,
                };
                exit.pnl = exit.pnl_percent > 0 ? 'WIN' : exit.pnl_percent < 0 ? 'LOSS' : 'BREAKEVEN';

                if (exit.pnl === 'WIN') { stats.wins++; stats.totalProfit += exit.pnl_percent; stats.maxWin = Math.max(stats.maxWin, exit.pnl_percent); }
                else if (exit.pnl === 'LOSS') { stats.losses++; stats.totalLoss += exit.pnl_percent; stats.maxLoss = Math.min(stats.maxLoss, exit.pnl_percent); }
                else { stats.breakeven++; }

                stats.trades.push(exit);
                currentPosition = null;
            }

            if (trend === 'UP' || trend === 'DOWN') {
                currentPosition = {
                    entry_index: i,
                    entry_price: candle.close,
                    entry_trend: trend,
                    premium_at_entry: analysis.premium ? analysis.premium.percent : null,
                    deviation_at_entry: analysis.deviationPercent || null,
                };
            }

            lastTrend = trend;
        }
    }

    // Close final position
    if (currentPosition) {
        const lastCandle = candles[candles.length - 1];
        const exit = {
            entry_index: currentPosition.entry_index,
            exit_index: candles.length - 1,
            entry_price: currentPosition.entry_price,
            exit_price: lastCandle.close,
            entry_date: new Date(candles[currentPosition.entry_index].timestamp).toISOString().split('T')[0],
            exit_date: new Date(lastCandle.timestamp).toISOString().split('T')[0],
            days_held: candles.length - 1 - currentPosition.entry_index,
            pnl_percent: ((lastCandle.close - currentPosition.entry_price) / currentPosition.entry_price) * 100,
            pnl_absolute: lastCandle.close - currentPosition.entry_price,
            premium_at_entry: currentPosition.premium_at_entry,
            deviation_at_entry: currentPosition.deviation_at_entry,
        };
        exit.pnl = exit.pnl_percent > 0 ? 'WIN' : exit.pnl_percent < 0 ? 'LOSS' : 'BREAKEVEN';

        if (exit.pnl === 'WIN') { stats.wins++; stats.totalProfit += exit.pnl_percent; stats.maxWin = Math.max(stats.maxWin, exit.pnl_percent); }
        else if (exit.pnl === 'LOSS') { stats.losses++; stats.totalLoss += exit.pnl_percent; stats.maxLoss = Math.min(stats.maxLoss, exit.pnl_percent); }
        else { stats.breakeven++; }

        stats.trades.push(exit);
    }

    return {
        config: bestConfig.config,
        score: bestConfig.metrics.score,
        accuracy: bestConfig.metrics.accuracy,
        confirmed_accuracy: bestConfig.metrics.confirmedAccuracy,
        stats,
        trades: stats.trades
    };
}

function calculateMetrics(backtest) {
    const s = backtest.stats;
    const trades = s.trades;

    return {
        totalTrades: trades.length,
        winRate: trades.length > 0 ? (s.wins / trades.length * 100).toFixed(2) : 0,
        lossRate: trades.length > 0 ? (s.losses / trades.length * 100).toFixed(2) : 0,
        avgWinPercent: s.wins > 0 ? (s.totalProfit / s.wins).toFixed(3) : 0,
        avgLossPercent: s.losses > 0 ? (s.totalLoss / s.losses).toFixed(3) : 0,
        totalReturnPercent: (s.totalProfit + s.totalLoss).toFixed(2),
        maxWinPercent: s.maxWin.toFixed(3),
        maxLossPercent: s.maxLoss.toFixed(3),
        profitFactor: s.losses === 0 ? 'Inf' : (Math.abs(s.totalProfit) / Math.abs(s.totalLoss)).toFixed(2),
        avgTradeLength: trades.length > 0 ? (trades.reduce((sum, t) => sum + t.days_held, 0) / trades.length).toFixed(1) : 0,
    };
}

function generateReport(backtest, metrics) {
    const s = backtest.stats;
    const cfg = backtest.config;

    let r = '';
    r += '=================================================================\n';
    r += 'TREND DETECTION - BACKTEST REPORT (AMA + Feed)\n';
    r += '=================================================================\n\n';

    r += 'CONFIGURATION\n';
    r += '-------------------------------------------------------------\n';
    r += `Optimizer Score:           ${backtest.score}/100 (ranking only)\n`;
    r += `AMA: ER=${cfg.erPeriod}, Fast=${cfg.fastPeriod}, Slow=${cfg.slowPeriod}\n`;
    r += `Threshold: ${cfg.thresholdPercent}%\n`;
    r += `Feed: Synthesized 50-period SMA\n\n`;

    r += 'BACKTEST PERIOD\n';
    r += '-------------------------------------------------------------\n';
    r += `Total Candles:             ${s.totalCandles}\n`;
    r += `Uptrend Bars:              ${s.uptrends} (${(s.uptrends/s.totalCandles*100).toFixed(1)}%)\n`;
    r += `Downtrend Bars:            ${s.downtrends} (${(s.downtrends/s.totalCandles*100).toFixed(1)}%)\n`;
    r += `Neutral Bars:              ${s.neutrals} (${(s.neutrals/s.totalCandles*100).toFixed(1)}%)\n`;
    r += `Trend Changes:             ${s.trendChanges}\n\n`;

    r += 'TRADE STATISTICS\n';
    r += '-------------------------------------------------------------\n';
    r += `Total Trades:              ${metrics.totalTrades}\n`;
    r += `Wins: ${s.wins}  Losses: ${s.losses}  Breakeven: ${s.breakeven}\n`;
    r += `Win Rate:                  ${metrics.winRate}%\n\n`;

    r += 'PERFORMANCE METRICS\n';
    r += '-------------------------------------------------------------\n';
    r += `Total Return:              ${metrics.totalReturnPercent}%\n`;
    r += `Avg Win:                   ${metrics.avgWinPercent}%\n`;
    r += `Avg Loss:                  ${metrics.avgLossPercent}%\n`;
    r += `Max Win:                   ${metrics.maxWinPercent}%\n`;
    r += `Max Loss:                  ${metrics.maxLossPercent}%\n`;
    r += `Profit Factor:             ${metrics.profitFactor}\n`;
    r += `Avg Trade Duration:        ${metrics.avgTradeLength} days\n\n`;

    r += 'TOP TRADES\n';
    r += '-------------------------------------------------------------\n';
    const topWins = s.trades.filter(t => t.pnl === 'WIN').sort((a, b) => b.pnl_percent - a.pnl_percent).slice(0, 5);
    const topLosses = s.trades.filter(t => t.pnl === 'LOSS').sort((a, b) => a.pnl_percent - b.pnl_percent).slice(0, 5);

    if (topWins.length) {
        r += 'Winners:\n';
        topWins.forEach((t, i) => { r += `  ${i+1}. ${t.entry_date} -> ${t.exit_date}: +${t.pnl_percent.toFixed(2)}% (${t.days_held}d)\n`; });
    }
    if (topLosses.length) {
        r += 'Losers:\n';
        topLosses.forEach((t, i) => { r += `  ${i+1}. ${t.entry_date} -> ${t.exit_date}: ${t.pnl_percent.toFixed(2)}% (${t.days_held}d)\n`; });
    }
    r += '\n';

    r += '=================================================================\n';
    if (metrics.totalTrades > 0) {
        r += `${metrics.totalTrades} trades, ${metrics.winRate}% win rate, ${metrics.totalReturnPercent}% total return\n`;
    } else {
        r += 'No trades executed (no confirmed trends detected)\n';
    }
    r += '=================================================================\n';

    return r;
}

function backtest() {
    console.log('===============================================================');
    console.log('TREND DETECTION - BACKTEST (AMA + Feed)');
    console.log('===============================================================\n');

    console.log('Loading best configuration...');
    const bestConfig = getBestConfiguration();
    if (!bestConfig) { console.error('Could not load best configuration'); process.exit(1); }
    console.log(`Found best config (Score: ${bestConfig.metrics.score}/100)\n`);

    console.log('Loading candle data...');
    const candles = loadCandles();
    if (!candles) { console.error('Could not load candles'); process.exit(1); }
    console.log(`Loaded ${candles.length} candles\n`);

    console.log('Synthesizing feed prices...');
    const feedPrices = synthesizeFeedPrices(candles, 50);

    console.log('Running backtest...');
    const result = runBacktest(candles, feedPrices, bestConfig);

    console.log('Calculating metrics...');
    const metrics = calculateMetrics(result);

    console.log('Generating report...\n');
    const report = generateReport(result, metrics);

    fs.writeFileSync(BACKTEST_OUTPUT, JSON.stringify(result, null, 2));
    fs.writeFileSync(REPORT_OUTPUT, report);

    console.log(report);
    console.log(`Report: ${path.basename(REPORT_OUTPUT)}`);
    console.log(`Data:   ${path.basename(BACKTEST_OUTPUT)}`);
}

backtest();

module.exports = { backtest };
