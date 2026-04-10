#!/usr/bin/env node

'use strict';

/**
 * DERIVATIVE CHART GENERATOR
 *
 * Generates interactive HTML charts for the fixed SMA / MACD / RSI analysis stack.
 * The layout intentionally matches the earlier full-screen derivative chart style.
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        inputFile: null,
        outputFile: 'analysis/charts/derivative_chart.html',
        title: 'Derivative Trend Analysis',
        quiet: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--input') cfg.inputFile = args[++i];
        else if (a === '--output') cfg.outputFile = args[++i];
        else if (a === '--title') cfg.title = args[++i];
        else if (a === '--quiet') cfg.quiet = true;
        else if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
    }
    if (!cfg.inputFile) {
        console.error('Error: --input required');
        showHelp();
        process.exit(1);
    }
    return cfg;
}

function showHelp() {
    console.log(`
Derivative Chart Generator

Usage:
  node analysis/derivative_chart_generator.js --input <file.json> [options]

Options:
  --output FILE   Output HTML (default: analysis/charts/derivative_chart.html)
  --title TEXT    Chart title
  --quiet         Suppress output
    `);
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])
    );
}

function trendToNum(trend) {
    if (trend === 'UP') return 1;
    if (trend === 'DOWN') return -1;
    return 0;
}

function generateHTML(data, title) {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const last = results[results.length - 1];
    const source = data.config?.source || 'Unknown';
    const smaPeriod     = data.config?.slowSmaPeriod || 'N/A';
    const fastSmaPeriod = data.config?.fastSmaPeriod || null;
    const hasFastSma    = fastSmaPeriod !== null && results.some(r => r.fastSmaValue !== null && r.fastSmaValue !== undefined);
    const macdFast = data.config?.macdFastPeriod ?? 12;
    const macdSlow = data.config?.macdSlowPeriod ?? 26;
    const macdSig = data.config?.macdSignalPeriod ?? 9;
    const rsiPeriod = data.config?.rsiPeriod ?? 14;
    const rsiOB = data.config?.rsiExtreme ?? 90;
    const rsiOS = 100 - rsiOB;

    const dates = results.map((r, idx) => {
        if (r.timestamp) return new Date(r.timestamp).toISOString();
        return new Date(Date.now() - (results.length - idx) * 3600000).toISOString();
    });

    const prices        = results.map(r => r.price);
    const smaValues     = results.map(r => r.slowSma);
    const fastSmaValues = results.map(r => r.fastSmaValue);

    const smaNum  = results.map(r => trendToNum(r.smaRawTrend));
    const smaUp   = smaNum.map(v => v > 0 ?  1 : 0);
    const smaDown = smaNum.map(v => v < 0 ? -1 : 0);
    const smaConf = results.map(r => r.smaConfidence ?? 0);

    const fastSmaNum  = results.map(r => trendToNum(r.fastSmaRawTrend));
    const fastSmaUp   = fastSmaNum.map(v => v > 0 ?  1 : 0);
    const fastSmaDown = fastSmaNum.map(v => v < 0 ? -1 : 0);
    const fastSmaConf = results.map(r => r.fastSmaConfidence || 0);

    const macdHistogram = results.map(r => r.macdHistogram ?? null);
    const macdLine = results.map(r => r.macdLine ?? null);
    const macdSignal = results.map(r => r.macdSignal ?? null);
    const macdHistUp = macdHistogram.map(v => v !== null && v > 0 ? v : 0);
    const macdHistDown = macdHistogram.map(v => v !== null && v < 0 ? v : 0);

    const rsiValues = results.map(r => r.rsi ?? null);

    const interpState = results.map(r => r.interpretation || 'NEUTRAL');
    const interpBull     = interpState.map(s => s === 'BULL'       ?  1    : 0);
    const interpBullWeak = interpState.map(s => s === 'BULL_WEAK'  ?  0.5  : 0);
    const interpOB       = interpState.map(s => s === 'OVERBOUGHT' ?  0.75 : 0);
    const interpBear     = interpState.map(s => s === 'BEAR'       ? -1    : 0);
    const interpBearWeak = interpState.map(s => s === 'BEAR_WEAK'  ? -0.5  : 0);
    const interpOS       = interpState.map(s => s === 'OVERSOLD'   ? -0.75 : 0);
    const entryBias      = results.map(r => r.entryBias || 'NONE');
    const bullWeakEntryMarkers = results.map(r => r.isBullWeakEntry ? 0.38 : null);
    const bullConfirmationMarkers = results.map(r => r.isBullConfirmation ? 0.88 : null);
    const lateBullMarkers = results.map(r => r.isLateBullWithoutWeak ? 0.88 : null);
    const bearWeakEntryMarkers = results.map(r => r.isBearWeakEntry ? -0.38 : null);
    const bearConfirmationMarkers = results.map(r => r.isBearConfirmation ? -0.88 : null);
    const lateBearMarkers = results.map(r => r.isLateBearWithoutWeak ? -0.88 : null);

    const priceSeries = prices.filter(v => Number.isFinite(v));
    const priceStart = priceSeries.length ? priceSeries[0] : null;
    const priceEnd = priceSeries.length ? priceSeries[priceSeries.length - 1] : null;
    const priceHigh = priceSeries.length ? Math.max(...priceSeries) : null;
    const priceLow = priceSeries.length ? Math.min(...priceSeries) : null;
    const priceChange = priceStart !== null && priceEnd !== null ? priceEnd - priceStart : null;
    const priceChangePct = priceStart !== null && priceEnd !== null && priceStart !== 0
        ? ((priceEnd - priceStart) / priceStart) * 100
        : null;

    const countTrend = arr => arr.reduce((acc, v) => {
        acc.total += 1;
        if (v > 0) acc.up += 1;
        else if (v < 0) acc.down += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, up: 0, down: 0, neutral: 0 });

    const countStates = (arr, positive, negative) => arr.reduce((acc, v) => {
        acc.total += 1;
        if (v === positive) acc.positive += 1;
        else if (v === negative) acc.negative += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, positive: 0, negative: 0, neutral: 0 });

    const macdTrendNum = results.map(r => r.macdTrend === 'BULL' ? 1 : r.macdTrend === 'BEAR' ? -1 : 0);
    const interpTrendNum = interpState.map(s =>
        s === 'BULL' || s === 'BULL_WEAK' ? 1 :
        s === 'BEAR' || s === 'BEAR_WEAK' ? -1 : 0
    );

    const smaTotals = countTrend(smaNum);
    const fastSmaTotals = countTrend(fastSmaNum);
    const macdTotals = countTrend(macdTrendNum);
    const rsiTotals = countStates(results.map(r => r.rsiZone || 'NEUTRAL'), 'OVERBOUGHT', 'OVERSOLD');
    const signalTotals = (() => {
        let up = 0, down = 0, prev = null;
        for (const state of interpState) {
            const isBull = state === 'BULL' || state === 'BULL_WEAK';
            const isBear = state === 'BEAR' || state === 'BEAR_WEAK';
            if (isBull) {
                if (state !== prev) up += 1;
            } else if (isBear) {
                if (state !== prev) down += 1;
            }
            prev = state;
        }
        return { up, down };
    })();
    const candleCount = results.length;

    const fmtPrice = v => v === null ? 'n/a' : Number(v).toFixed(6);
    const fmtSignedPrice = v => v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}`;
    const fmtPct = v => v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}%`;
    const fmtShare = count => candleCount > 0 ? `${Math.round((count / candleCount) * 100)}%` : 'n/a';

    const headerParts = [];
    if (smaPeriod !== 'N/A') headerParts.push(`SMA(${smaPeriod})`);
    if (hasFastSma)          headerParts.push(`fastSMA(${fastSmaPeriod})`);
    headerParts.push(`MACD(${macdFast},${macdSlow},${macdSig})`);
    headerParts.push(`RSI(${rsiPeriod})`);
    const headerSub = headerParts.join(' &middot; ');

    const statsPanel = `
    <div><span class="label">Candles</span> <span class="val">${results.length}</span></div>
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Price summary &#x2500;&#x2500;</span></div>
    <div><span class="label">Start</span> <span class="val">${fmtPrice(priceStart)}</span></div>
    <div><span class="label">End</span> <span class="val">${fmtPrice(priceEnd)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">High</span> <span class="val">${fmtPrice(priceHigh)}</span></div>
    <div><span class="label">Low</span> <span class="val">${fmtPrice(priceLow)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">Abs change</span> <span class="val">${fmtSignedPrice(priceChange)}</span></div>
    <div><span class="label">Rel change</span> <span class="val">${fmtPct(priceChangePct)}</span></div>
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Totals &#x2500;&#x2500;</span></div>
    <div><span class="label">SMA(${smaPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(smaTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(smaTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(smaTotals.neutral)}</span></div>
    ${hasFastSma ? `<div><span class="label">fastSMA(${fastSmaPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(fastSmaTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(fastSmaTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(fastSmaTotals.neutral)}</span></div>` : ''}
    <div style="margin-top:4px"></div>
    <div><span class="label">MACD(${macdFast},${macdSlow},${macdSig})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(macdTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(macdTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(macdTotals.neutral)}</span></div>
    <div><span class="label">RSI(${rsiPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(rsiTotals.positive)} <span class="neg">&#x25BC;</span>${fmtShare(rsiTotals.negative)} <span class="muted">&#x25CF;</span>${fmtShare(rsiTotals.neutral)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">Signals</span> <span class="val"><span class="pos">&#x25B2;</span>${signalTotals.up} <span class="neg">&#x25BC;</span>${signalTotals.down}</span></div>
`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0e1117; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }

        #header {
            position: fixed; top: 0; left: 0; right: 0; z-index: 100;
            background: rgba(14,17,23,0.92); backdrop-filter: blur(4px);
            border-bottom: 1px solid #2a2e3e;
            padding: 8px 20px;
            display: flex; align-items: center; gap: 18px;
        }
        #header h1  { font-size: 16px; font-weight: 600; color: #fff; white-space: nowrap; }
        #header .sub { font-size: 11px; color: #888; white-space: nowrap; }

        #stats {
            position: fixed; top: 160px; right: 10px; z-index: 100;
            background: rgba(20,24,32,0.92); backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e; border-radius: 6px;
            padding: 10px 14px; font-size: 12px; line-height: 1.85;
            min-width: 230px;
        }
        #stats .label { color: #888; }
        #stats .val   { color: #e0e0e0; font-weight: 600; font-variant-numeric: tabular-nums; }
        #stats .pos   { color: #26a69a; }
        #stats .neg   { color: #ef5350; }
        #stats .muted { color: #9ca3b8; }

        #charts {
            padding-top: 36px;
            padding-bottom: 8px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            position: relative;
        }
        #global-crosshair {
            position: absolute;
            top: 36px;
            bottom: 8px;
            width: 0;
            border-left: 1px dashed rgba(255,255,255,0.35);
            pointer-events: none;
            z-index: 90;
            display: none;
        }
        #reset-zoom-btn {
            background: #1e2330; color: #ccc; border: 1px solid #2a2e3e;
            border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer;
            white-space: nowrap;
        }
        #reset-zoom-btn:hover { background: #2a3050; color: #fff; }
        #price-chart  { flex: 3; min-height: 0; }
        #deriv-chart  { flex: 1; min-height: 0; }
        #interp-chart { flex: 2; min-height: 0; }
        #macd-chart   { flex: 2; min-height: 0; }
        #rsi-chart    { flex: 1; min-height: 0; }

        .trend-badge {
            display: inline-block; padding: 2px 7px; border-radius: 3px;
            font-size: 11px; font-weight: 700; margin-left: 4px;
        }
        .trend-badge.up      { background: rgba(38,166,154,0.2); color: #26a69a; }
        .trend-badge.down    { background: rgba(239,83,80,0.2);  color: #ef5350; }
        .trend-badge.neutral { background: rgba(156,163,175,0.12); color: #9ca3b8; }
    </style>
</head>
<body>

<div id="header">
    <h1>&#x1F4CA; ${escapeHtml(title)}</h1>
    <span class="sub">Source: ${escapeHtml(source)}</span>
    <span class="sub">${headerSub}</span>
    <button id="reset-zoom-btn" onclick="resetZoom()" title="Reset x-axis zoom on all panels">&#x21BA; Reset Zoom</button>
    <span class="sub" style="margin-left:auto">Generated: ${new Date().toLocaleString()}</span>
</div>

<div id="stats">${statsPanel}</div>

<div id="charts">
    <div id="global-crosshair"></div>
    <div id="price-chart"></div>
    <div id="deriv-chart"></div>
    <div id="interp-chart"></div>
    <div id="macd-chart"></div>
    <div id="rsi-chart"></div>
</div>

<script>
const dates     = ${JSON.stringify(dates)};
const prices    = ${JSON.stringify(prices)};
const smaValues = ${JSON.stringify(smaValues)};
${hasFastSma ? `const fastSmaValues = ${JSON.stringify(fastSmaValues)};` : ''}
const macdHistogram = ${JSON.stringify(macdHistogram)};
const macdLine      = ${JSON.stringify(macdLine)};
const macdSignal    = ${JSON.stringify(macdSignal)};
const macdHistUp    = ${JSON.stringify(macdHistUp)};
const macdHistDown  = ${JSON.stringify(macdHistDown)};
const rsiValues = ${JSON.stringify(rsiValues)};
const interpBull     = ${JSON.stringify(interpBull)};
const interpBullWeak = ${JSON.stringify(interpBullWeak)};
const interpOB       = ${JSON.stringify(interpOB)};
const interpBear     = ${JSON.stringify(interpBear)};
const interpBearWeak = ${JSON.stringify(interpBearWeak)};
const interpOS       = ${JSON.stringify(interpOS)};
const interpState    = ${JSON.stringify(interpState)};
const entryBias      = ${JSON.stringify(entryBias)};
const bullWeakEntryMarkers = ${JSON.stringify(bullWeakEntryMarkers)};
const bullConfirmationMarkers = ${JSON.stringify(bullConfirmationMarkers)};
const lateBullMarkers = ${JSON.stringify(lateBullMarkers)};
const bearWeakEntryMarkers = ${JSON.stringify(bearWeakEntryMarkers)};
const bearConfirmationMarkers = ${JSON.stringify(bearConfirmationMarkers)};
const lateBearMarkers = ${JSON.stringify(lateBearMarkers)};
const smaUp     = ${JSON.stringify(smaUp)};
const smaDown   = ${JSON.stringify(smaDown)};
const smaConf   = ${JSON.stringify(smaConf)};
${hasFastSma ? `const fastSmaUp   = ${JSON.stringify(fastSmaUp)};
const fastSmaDown = ${JSON.stringify(fastSmaDown)};
const fastSmaConf = ${JSON.stringify(fastSmaConf)};` : ''}

const DARK = { plot_bgcolor: '#0e1117', paper_bgcolor: '#0e1117', font: { color: '#ccc', size: 11 } };
const AXIS = {
    gridcolor: '#1e2330',
    linecolor: '#2a2e3e',
    zerolinecolor: '#333',
    tickfont: { size: 10 },
    automargin: false,
};
const MARGIN_L = 88;
const MARGIN_R = 250;

const priceTraces = [
    {
        x: dates, y: prices,
        type: 'scattergl', mode: 'lines',
        line: { color: '#5c9ee6', width: 1 },
        name: 'Price',
        hovertemplate: '<b>%{x|%Y-%m-%d %H:%M}</b><br>Price: %{y:.6f}<extra></extra>',
    },
    {
        x: dates, y: smaValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#f59e0b', width: 1 },
        name: 'SMA(${smaPeriod})',
        hovertemplate: 'SMA: %{y:.6f}<extra></extra>',
    },
${hasFastSma ? `    {
        x: dates, y: fastSmaValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#fb923c', width: 1 },
        name: 'fastSMA(${fastSmaPeriod})',
        hovertemplate: 'fastSMA: %{y:.6f}<extra></extra>',
    },` : ''}
];

Plotly.newPlot('price-chart', priceTraces, {
    ...DARK,
    margin: { l: MARGIN_L, r: MARGIN_R, t: 8, b: 28, autoexpand: false },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
    xaxis: { ...AXIS, type: 'date', rangeslider: { visible: false } },
    yaxis: { ...AXIS, title: { text: 'Price', standoff: 6 }, type: 'log', autorange: true },
}, { responsive: true, displayModeBar: true });

const zeroLine = {
    x: [dates[0], dates[dates.length - 1]], y: [0, 0],
    type: 'scatter', mode: 'lines',
    line: { color: '#333', width: 1, dash: 'dot' },
    showlegend: false, hoverinfo: 'skip',
};

const derivTraces = [
    {
        x: dates, y: smaUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.55)',
        name: 'd(SMA) UP', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: smaDown,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.55)',
        name: 'd(SMA) DOWN', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: smaUp.map((u, i) => u || smaDown[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'd(SMA)/dt',
        customdata: smaUp.map((u, i) => u > 0 ? 'UP' : smaDown[i] < 0 ? 'DOWN' : 'NEUTRAL'),
        hovertemplate: 'd(SMA)/dt: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
${hasFastSma ? `    {
        x: dates, y: fastSmaUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(251,146,60,0.35)',
        name: 'd(fastSMA) UP', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: fastSmaDown,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(251,146,60,0.35)',
        name: 'd(fastSMA) DOWN', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: fastSmaUp.map((u, i) => u || fastSmaDown[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'd(fastSMA)/dt',
        customdata: fastSmaUp.map((u, i) => u > 0 ? 'UP' : fastSmaDown[i] < 0 ? 'DOWN' : 'NEUTRAL'),
        hovertemplate: 'd(fastSMA)/dt: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },` : ''}
    zeroLine,
];

Plotly.newPlot('deriv-chart', derivTraces, {
    ...DARK,
    hovermode: 'x',
    margin: { l: MARGIN_L, r: MARGIN_R, t: 4, b: 4, autoexpand: false },
    showlegend: false,
    xaxis: { ...AXIS, type: 'date', showticklabels: false },
    yaxis: {
        ...AXIS,
        title: { text: 'Direction', standoff: 6 },
        tickvals: [-1, 0, 1], ticktext: ['DOWN', '—', 'UP'],
        range: [-1.15, 1.15],
        zeroline: true, zerolinecolor: '#333', zerolinewidth: 1,
        fixedrange: true,
    },
}, { responsive: true, displayModeBar: false });

const interpTraces = [
    {
        x: dates, y: interpBull,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.45)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: interpBullWeak,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.22)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: interpOB,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(245,158,11,0.18)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: interpBear,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.45)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: interpBearWeak,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.22)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: interpOS,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(56,189,248,0.18)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: bullWeakEntryMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#67e8f9', size: 7, symbol: 'triangle-right' },
        name: 'Early Long',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: bullConfirmationMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#34d399', size: 8, symbol: 'diamond' },
        name: 'Confirm Long',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: lateBullMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#f59e0b', size: 8, symbol: 'x' },
        name: 'Late Long',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: bearWeakEntryMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#fca5a5', size: 7, symbol: 'triangle-left' },
        name: 'Early Short',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: bearConfirmationMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#ef4444', size: 8, symbol: 'diamond' },
        name: 'Confirm Short',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: lateBearMarkers,
        type: 'scattergl', mode: 'markers',
        marker: { color: '#fb7185', size: 8, symbol: 'x' },
        name: 'Late Short',
        customdata: entryBias,
        hovertemplate: 'Entry: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    {
        x: dates, y: interpState.map(s => s === 'BULL' ? 0.75 : s === 'BULL_WEAK' ? 0.35 : s === 'OVERBOUGHT' ? 0.95 : s === 'BEAR' ? -0.75 : s === 'BEAR_WEAK' ? -0.35 : s === 'OVERSOLD' ? -0.95 : 0),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'Interpretation',
        customdata: interpState.map((state, i) => [state, entryBias[i]]),
        hovertemplate: 'Signal: <b>%{customdata[0]}</b><br>Entry: <b>%{customdata[1]}</b><extra></extra>',
        showlegend: true,
    },
];

Plotly.newPlot('interp-chart', interpTraces, {
    ...DARK,
    hovermode: 'x',
    margin: { l: MARGIN_L, r: MARGIN_R, t: 4, b: 4, autoexpand: false },
    showlegend: false,
    xaxis: { ...AXIS, type: 'date', showticklabels: false },
    yaxis: {
        ...AXIS,
        title: { text: 'Signal', standoff: 6 },
        tickvals: [-1, -0.75, -0.5, 0, 0.5, 0.75, 1],
        ticktext: ['BEAR', 'OVERSOLD', 'WEAK', '—', 'WEAK', 'OVERBOUGHT', 'BULL'],
        range: [-1.15, 1.15], fixedrange: true,
    },
}, { responsive: true, displayModeBar: false });

Plotly.newPlot('macd-chart', [
    {
        x: dates, y: macdHistUp,
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.6)',
        name: 'Hist+', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: macdHistDown,
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.6)',
        name: 'Hist-', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: macdLine,
        type: 'scattergl', mode: 'lines',
        line: { color: '#5c9ee6', width: 1 },
        name: 'MACD',
        hovertemplate: 'MACD: %{y:.4f}%<extra></extra>',
    },
    {
        x: dates, y: macdSignal,
        type: 'scattergl', mode: 'lines',
        line: { color: '#fb923c', width: 1 },
        name: 'Signal',
        hovertemplate: 'Signal: %{y:.4f}%<extra></extra>',
    },
    zeroLine,
], {
    ...DARK,
    margin: { l: MARGIN_L, r: MARGIN_R, t: 4, b: 4, autoexpand: false },
    showlegend: false,
    xaxis: { ...AXIS, type: 'date', showticklabels: false },
    yaxis: { ...AXIS, title: { text: 'MACD %', standoff: 6 }, zeroline: true, zerolinecolor: '#333' },
}, { responsive: true, displayModeBar: false });

Plotly.newPlot('rsi-chart', [
    {
        x: dates, y: rsiValues.map(() => ${rsiOB}),
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.07)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: rsiValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#a78bfa', width: 1 },
        name: 'RSI(${rsiPeriod})',
        hovertemplate: 'RSI: %{y:.1f}<extra></extra>',
    },
    {
        x: [dates[0], dates[dates.length-1]], y: [${rsiOB}, ${rsiOB}],
        type: 'scatter', mode: 'lines',
        line: { color: 'rgba(239,83,80,0.5)', width: 1, dash: 'dot' },
        name: 'OB ${rsiOB}', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: [dates[0], dates[dates.length-1]], y: [${rsiOS}, ${rsiOS}],
        type: 'scatter', mode: 'lines',
        line: { color: 'rgba(38,166,154,0.5)', width: 1, dash: 'dot' },
        name: 'OS ${rsiOS}', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: [dates[0], dates[dates.length-1]], y: [50, 50],
        type: 'scatter', mode: 'lines',
        line: { color: '#333', width: 1, dash: 'dot' },
        showlegend: false, hoverinfo: 'skip',
    },
], {
    ...DARK,
    margin: { l: MARGIN_L, r: MARGIN_R, t: 0, b: 20, autoexpand: false },
    showlegend: false,
    xaxis: { ...AXIS, type: 'date' },
    yaxis: { ...AXIS, title: { text: 'RSI', standoff: 6 }, range: [0, 100], fixedrange: true },
}, { responsive: true, displayModeBar: false });

// ── Synchronized x-axis zoom ───────────────────────────────────────────────
let isSyncing = false;

const allCharts = [
    document.getElementById('price-chart'),
    document.getElementById('deriv-chart'),
    document.getElementById('interp-chart'),
    document.getElementById('macd-chart'),
    document.getElementById('rsi-chart'),
].filter(Boolean);

function wireAutoscaleToResetZoom(chartDiv) {
    if (!chartDiv || chartDiv.__resetZoomAutoscaleWired) return;
    chartDiv.__resetZoomAutoscaleWired = true;

    const bind = () => {
        const autoscaleBtn = chartDiv.querySelector(
            '.modebar-btn[data-title*="Autoscale"], ' +
            '.modebar-btn[data-title*="autoscale"], ' +
            '.modebar-btn[aria-label*="Autoscale"]'
        );

        if (!autoscaleBtn || autoscaleBtn.__resetZoomBound) return;
        autoscaleBtn.__resetZoomBound = true;
        autoscaleBtn.addEventListener('click', e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            setTimeout(resetZoom, 0);
        }, true);
    };

    bind();
    const observer = new MutationObserver(bind);
    observer.observe(chartDiv, { childList: true, subtree: true });
    chartDiv.__resetZoomObserver = observer;
}

function syncAxes(srcDiv, targets) {
    srcDiv.on('plotly_relayout', e => {
        if (isSyncing) return;
        let upd;
        if (e['xaxis.range[0]'] !== undefined) {
            upd = { 'xaxis.range[0]': e['xaxis.range[0]'], 'xaxis.range[1]': e['xaxis.range[1]'] };
        } else if (e['xaxis.autorange']) {
            const range = srcDiv.layout?.xaxis?.range;
            if (!range || range.length < 2) return;
            upd = { 'xaxis.range[0]': range[0], 'xaxis.range[1]': range[1] };
        } else if (e['autosize']) {
            setTimeout(resetZoom, 0);
            return;
        } else {
            return;
        }

        isSyncing = true;
        Promise.all(targets.map(d => Plotly.relayout(d, upd)))
            .finally(() => { setTimeout(() => { isSyncing = false; }, 50); });
    });
}

allCharts.forEach(src => syncAxes(src, allCharts.filter(c => c !== src)));
wireAutoscaleToResetZoom(allCharts[0]);

// ── Reset Zoom button ──────────────────────────────────────────────────────
function resetZoom() {
    const ref = allCharts.find(c => c.data && c.data.length > 0);
    if (!ref) return;
    let xMin = null, xMax = null;
    for (const trace of ref.data) {
        if (trace.x && trace.x.length > 0) {
            const f = trace.x[0], l = trace.x[trace.x.length - 1];
            if (!xMin || f < xMin) xMin = f;
            if (!xMax || l > xMax) xMax = l;
        }
    }
    if (!xMin || !xMax) return;
    isSyncing = true;
    Promise.all(allCharts.map(d => Plotly.relayout(d, {
        'xaxis.range[0]': xMin, 'xaxis.range[1]': xMax, 'yaxis.autorange': true
    })))
    .finally(() => { setTimeout(() => { isSyncing = false; }, 50); });
}

// ── Vertical crosshair across all panels ──────────────────────────────────
const chartsContainer = document.getElementById('charts');
const globalCrosshair = document.getElementById('global-crosshair');
let lastCrosshairLeft = null;

function hideCrosshair() {
    lastCrosshairLeft = null;
    if (globalCrosshair) globalCrosshair.style.display = 'none';
}

function setCrosshairFromClientX(clientX) {
    if (!globalCrosshair || !chartsContainer || !Number.isFinite(clientX)) return;
    const rect = chartsContainer.getBoundingClientRect();
    const left = clientX - rect.left;
    if (lastCrosshairLeft !== null && Math.abs(lastCrosshairLeft - left) < 0.5) return;
    lastCrosshairLeft = left;
    globalCrosshair.style.left = left + 'px';
    globalCrosshair.style.display = 'block';
}

function fallbackClientX(chart, point) {
    const axis = point?.xaxis;
    const value = point?.x;
    const offsetLeft = chart?._fullLayout?._size?.l;
    if (!axis || value == null || !Number.isFinite(offsetLeft)) return null;
    const pixel = typeof axis.d2p === 'function' ? axis.d2p(value) : typeof axis.l2p === 'function' ? axis.l2p(value) : null;
    if (!Number.isFinite(pixel)) return null;
    const rect = chart.getBoundingClientRect();
    return rect.left + offsetLeft + pixel;
}

allCharts.forEach(chart => {
    chart.on('plotly_hover', data => {
        const clientX = data.event?.clientX ?? fallbackClientX(chart, data.points?.[0]);
        if (clientX != null) setCrosshairFromClientX(clientX);
    });
    chart.on('plotly_unhover', hideCrosshair);
});
window.addEventListener('resize', hideCrosshair);
</script>
</body>
</html>`;
}

async function main() {
    const cfg = parseArgs();
    const data = JSON.parse(fs.readFileSync(cfg.inputFile, 'utf8'));
    const html = generateHTML(data, cfg.title);
    fs.mkdirSync(path.dirname(cfg.outputFile), { recursive: true });
    fs.writeFileSync(cfg.outputFile, html, 'utf8');
    if (!cfg.quiet) console.log(`Chart written to ${cfg.outputFile}`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { generateHTML };
