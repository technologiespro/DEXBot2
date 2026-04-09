#!/usr/bin/env node

/**
 * DERIVATIVE TREND ANALYSIS
 *
 * Runs DerivativeAnalyzer over candle data and generates an interactive HTML chart.
 * Trend is detected purely from the sign of d(SMA)/dt and d(KAMA)/dt.
 *
 * Usage:
 *   node analysis/analyze_derivatives.js \
 *     --source json \
 *     --file market_adapter/inputs/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
 *
 *   node analysis/analyze_derivatives.js \
 *     --source market_adapter \
 *     --pair XRP-BTS
 *
 * Output:
 *   analysis/charts/derivative_chart.html
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { DerivativeAnalyzer } = require('./derivative_analyzer');
const { generateHTML }        = require('./derivative_chart_generator');
const { createSource }        = require('./price_sources');

// ─── CLI Parser ─────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        source: { type: 'market_adapter', config: { pair: 'XRP-BTS' } },
        slowSmaPeriod:        500,
        fastSmaPeriod:        100,
        fastKamaErPeriod:     null,
        fastKamaFastPeriod:   2,
        fastKamaSlowPeriod:   300,
        minBarsForConfirmation: 3,
        lrsPeriod: null,
        almaPeriod: null,
        almaOffset: 0.85,
        almaSigma: 6,
        macdEnabled: false,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdMinHist: 0.02,
        trendFilter: false,
        trendFilterMinBars: 3,
        momentumGateEnabled: false,
        momentumGateMinBars: 3,
        momentumGateRsiZone: 35,
        opt10CommitmentBars: 2,
        rsiEnabled: false,
        rsiPeriod: 14,
        interpConfirmBars: 3,
        interpHoldBars: 3,
        rsiZone: 10,
        rsiExtreme: 90,
        chartFile: 'analysis/charts/derivative_chart.html',
        smaOnly: true,
        quiet: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if      (arg === '--source')    config.source.type                  = args[++i];
        else if (arg === '--pair')      config.source.config.pair           = args[++i];
        else if (arg === '--file')      config.source.config.filePath       = args[++i];
        else if (arg === '--pool')      config.source.config.poolId         = args[++i];
        else if (arg === '--precA')     config.source.config.precA          = parseInt(args[++i]);
        else if (arg === '--precB')     config.source.config.precB          = parseInt(args[++i]);
        else if (arg === '--sma')       config.slowSmaPeriod                = parseInt(args[++i]);
        else if (arg === '--fast-sma')  config.fastSmaPeriod                = parseInt(args[++i]);
        else if (arg === '--kama-er')   { config.fastKamaErPeriod           = parseInt(args[++i]); }
        else if (arg === '--kama-fast') config.fastKamaFastPeriod           = parseInt(args[++i]);
        else if (arg === '--kama-slow') config.fastKamaSlowPeriod           = parseInt(args[++i]);
        else if (arg === '--confirm')   config.minBarsForConfirmation       = parseInt(args[++i]);
        else if (arg === '--lrs')       { config.lrsPeriod                  = parseInt(args[++i]); }
        else if (arg === '--alma')      { config.almaPeriod                 = parseInt(args[++i]); }
        else if (arg === '--alma-offset')  config.almaOffset                = parseFloat(args[++i]);
        else if (arg === '--alma-sigma')   config.almaSigma                 = parseFloat(args[++i]);
        else if (arg === '--macd')         { config.macdEnabled             = true; }
        else if (arg === '--macd-fast')  { config.macdFastPeriod            = parseInt(args[++i]); config.macdEnabled = true; }
        else if (arg === '--macd-slow')  { config.macdSlowPeriod            = parseInt(args[++i]); config.macdEnabled = true; }
        else if (arg === '--macd-signal'){ config.macdSignalPeriod          = parseInt(args[++i]); config.macdEnabled = true; }
        else if (arg === '--macd-min-hist') { config.macdMinHist            = parseFloat(args[++i]); }
        else if (arg === '--rsi')          { config.rsiEnabled = true; const v = parseInt(args[i + 1]); if (!isNaN(v)) { config.rsiPeriod = v; i++; } }
        else if (arg === '--interp-confirm') config.interpConfirmBars        = parseInt(args[++i]);
        else if (arg === '--interp-hold')    config.interpHoldBars           = parseInt(args[++i]);
        else if (arg === '--rsi-zone')       config.rsiZone                  = parseFloat(args[++i]);
        else if (arg === '--rsi-extreme')    config.rsiExtreme               = parseFloat(args[++i]);
        else if (arg === '--trend-filter')          config.trendFilter          = true;
        else if (arg === '--trend-filter-min-bars') config.trendFilterMinBars  = parseInt(args[++i]);
        else if (arg === '--momentum-gate')         config.momentumGateEnabled  = true;
        else if (arg === '--momentum-gate-bars')    config.momentumGateMinBars  = parseInt(args[++i]);
        else if (arg === '--momentum-gate-rsi-zone') config.momentumGateRsiZone = parseFloat(args[++i]);
        else if (arg === '--opt10-commitment')      config.opt10CommitmentBars  = parseInt(args[++i]);
        else if (arg === '--chart')       config.chartFile                  = args[++i];
        else if (arg === '--sma-only')  config.smaOnly                      = true;
        else if (arg === '--all')       config.smaOnly                      = false;
        else if (arg === '--quiet')     config.quiet                        = true;
        else if (arg === '--help' || arg === '-h') { showHelp(); process.exit(0); }
    }

    return config;
}

function showHelp() {
    console.log(`
Derivative Trend Analysis

Analyzes candle data using d(SMA)/dt and d(KAMA)/dt as trend signals.
Generates an interactive HTML chart.

Usage:
  node analysis/analyze_derivatives.js \\
    --source <type> \\
    [--pair PAIR] [--file PATH] [--pool ID] [--precA N] [--precB N]

Sources:
  market_adapter   Use market_adapter state (default)   --pair XRP-BTS
  json             JSON candles file                    --file path/to/file.json
  kibana           Kibana LP pool                       --pool ID --precA N --precB N

Analyzer options:
  --sma N        SMA period (default 500)
  --fast-sma N   Fast SMA period (default 100)
  --kama-er N    KAMA ER period (default disabled)
  --kama-fast N  KAMA fast period (default 2)
  --kama-slow N  KAMA slow period (default 300)
  --confirm N    Bars required for confirmation (default 3)
  --sma-only     Show only SMA signals (default true)
  --all          Show all calculated indicators

Output:
  --chart FILE   Chart output path (default: analysis/charts/derivative_chart.html)
  --quiet        Suppress log output
    `);
}

// ─── Analysis ──────────────────────────────────────────────────────────────

async function analyze(source, config) {
    if (!config.quiet) console.log(`[Analyzer] Loading candles from ${source.name}...`);

    const candles = await source.fetchCandles();
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles returned from source');
    }
    if (!config.quiet) console.log(`[Analyzer] Loaded ${candles.length} candles`);

    const analyzer = new DerivativeAnalyzer({
        slowSmaPeriod:          config.slowSmaPeriod,
        fastSmaPeriod:          config.fastSmaPeriod,
        fastKamaErPeriod:       config.fastKamaErPeriod,
        fastKamaFastPeriod:     config.fastKamaFastPeriod,
        fastKamaSlowPeriod:     config.fastKamaSlowPeriod,
        lrsPeriod:              config.lrsPeriod,
        almaPeriod:             config.almaPeriod,
        almaOffset:             config.almaOffset,
        almaSigma:              config.almaSigma,
        macdEnabled:            config.macdEnabled,
        macdFastPeriod:         config.macdFastPeriod,
        macdSlowPeriod:         config.macdSlowPeriod,
        macdSignalPeriod:       config.macdSignalPeriod,
        macdMinHist:            config.macdMinHist,
        trendFilterEnabled:     config.trendFilter,
        trendFilterMinBars:     config.trendFilterMinBars,
        momentumGateEnabled:    config.momentumGateEnabled,
        momentumGateMinBars:    config.momentumGateMinBars,
        momentumGateRsiZone:    config.momentumGateRsiZone,
        opt10CommitmentBars:    config.opt10CommitmentBars,
        rsiEnabled:             config.rsiEnabled,
        rsiPeriod:              config.rsiPeriod,
        interpConfirmBars:      config.interpConfirmBars,
        interpHoldBars:         config.interpHoldBars,
        rsiBullThreshold:       50 + config.rsiZone,
        rsiBearThreshold:       50 - config.rsiZone,
        rsiOverboughtLevel:     config.rsiExtreme,
        rsiOversoldLevel:       100 - config.rsiExtreme,
        minBarsForConfirmation: config.minBarsForConfirmation,
    });

    const allResults = [];
    for (let i = 0; i < candles.length; i++) {
        const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
        try {
            allResults.push(analyzer.update(marketPrice, timestamp));
        } catch (err) {
            throw new Error(`Failed at candle ${i}: ${err.message}`);
        }
    }

    const last = allResults[allResults.length - 1];
    if (!config.quiet) {
        const parts = [];
        if (config.fastKamaErPeriod) parts.push(`KAMA: ${last.kamaRawTrend} (${last.kamaBarsInTrend} bars)`);
        if (config.almaPeriod)       parts.push(`ALMA: ${last.almaRawTrend} (${last.almaBarsInTrend} bars)`);
        if (config.slowSmaPeriod)    parts.push(`SMA(${config.slowSmaPeriod}): ${last.smaRawTrend} (${last.smaBarsInTrend} bars)`);
        if (config.fastSmaPeriod)    parts.push(`fastSMA(${config.fastSmaPeriod}): ${last.fastSmaRawTrend} (${last.fastSmaBarsInTrend} bars)`);
        if (config.lrsPeriod)        parts.push(`LRS: ${last.lrsRawTrend} (${last.lrsBarsInTrend} bars)`);
        if (config.macdEnabled)      parts.push(`MACD: ${last.macdTrend} hist=${last.macdHistogram}`);
        if (config.rsiEnabled)       parts.push(`RSI(${config.rsiPeriod}): ${last.rsi !== null ? last.rsi.toFixed(1) : 'n/a'} [${last.rsiZone}]`);
        console.log(`[Analyzer] Done — ${last.isReady ? '' : '(warming up) '}${parts.join('  ')}`);
    }

    return {
        config: {
            source:              source.name,
            slowSmaPeriod:       config.slowSmaPeriod,
            fastSmaPeriod:       config.fastSmaPeriod,
            fastKamaErPeriod:    config.fastKamaErPeriod,
            fastKamaFastPeriod:  config.fastKamaFastPeriod,
            fastKamaSlowPeriod:  config.fastKamaSlowPeriod,
            lrsPeriod:           config.lrsPeriod,
            almaPeriod:          config.almaPeriod,
            almaOffset:          config.almaOffset,
            almaSigma:           config.almaSigma,
            macdEnabled:         config.macdEnabled,
            macdFastPeriod:      config.macdFastPeriod,
            macdSlowPeriod:      config.macdSlowPeriod,
            macdSignalPeriod:    config.macdSignalPeriod,
            macdMinHist:         config.macdMinHist,
            trendFilter:         config.trendFilter,
            trendFilterMinBars:  config.trendFilterMinBars,
            rsiEnabled:          config.rsiEnabled,
            rsiPeriod:           config.rsiPeriod,
            interpConfirmBars:   config.interpConfirmBars,
            interpHoldBars:      config.interpHoldBars,
            rsiZone:             config.rsiZone,
            rsiExtreme:          config.rsiExtreme,
            minBarsForConfirmation: config.minBarsForConfirmation,
        },
        allResults,
        lastAnalysis: last,
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const config = parseArgs();

    try {
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = path.join(__dirname, '..', 'market_adapter', 'state');
            srcConfig.botKey   = srcConfig.pair;
        }

        const source = createSource(config.source.type, srcConfig);
        const report = await analyze(source, config);

        // Generate chart
        const html    = generateHTML(report, 'Derivative Trend Analysis', config.smaOnly);
        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[Analyzer] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[Analyzer] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { analyze };
