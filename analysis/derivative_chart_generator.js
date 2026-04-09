#!/usr/bin/env node

/**
 * DERIVATIVE CHART GENERATOR
 *
 * Generates interactive HTML charts for derivative-based trend analysis.
 *
 * Chart panels:
 *   Top:    Price with SMA overlay (+ ALMA when present)
 *   Middle: Derivative direction — green fill above zero (UP), red fill below (DOWN)
 *   Bottom: Confidence %
 *
 * Usage:
 *   node analysis/derivative_chart_generator.js \
 *     --input derivative_data.json \
 *     --output analysis/charts/derivative_chart.html \
 *     [--sma-only]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        inputFile:  null,
        outputFile: 'analysis/charts/derivative_chart.html',
        title:      'Derivative Trend Analysis',
        smaOnly:    true,
        quiet:      false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if      (a === '--input')    cfg.inputFile  = args[++i];
        else if (a === '--output')   cfg.outputFile = args[++i];
        else if (a === '--title')    cfg.title      = args[++i];
        else if (a === '--sma-only') cfg.smaOnly    = true;
        else if (a === '--all')      cfg.smaOnly    = false;
        else if (a === '--quiet')    cfg.quiet      = true;
        else if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
    }
    if (!cfg.inputFile) { console.error('Error: --input required'); showHelp(); process.exit(1); }
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
  --sma-only      Show only SMA derivative signals (default true)
  --all           Show all indicators (ALMA, MACD, etc.)
  --quiet         Suppress output
    `);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])
    );
}

function trendToNum(trend) {
    if (trend === 'UP')   return  1;
    if (trend === 'DOWN') return -1;
    return 0;
}

// ─── HTML Generator ──────────────────────────────────────────────────────────

/**
 * @param {Object}  data       – report object from analyze_derivatives.js
 * @param {string}  title
 * @param {boolean} [smaOnly]  – hide ALMA, show only SMA derivative
 */
function generateHTML(data, title, smaOnly = false) {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const last      = results[results.length - 1];
    const source    = data.config?.source           || 'Unknown';
    const smaPeriod     = data.config?.slowSmaPeriod || 'N/A';
    const fastSmaPeriod = data.config?.fastSmaPeriod || null;
    const hasFastSma    = fastSmaPeriod !== null && results.some(r => r.fastSmaValue !== null && r.fastSmaValue !== undefined);
    const almaPeriod    = data.config?.almaPeriod    || null;
    const almaOffset = data.config?.almaOffset      ?? 0.85;
    const almaSigma  = data.config?.almaSigma       ?? 6;
    const hasAlma    = !smaOnly && almaPeriod !== null && data.config?.almaPeriod !== null && results.some(r => r.almaValue !== null && r.almaValue !== undefined);
    const macdFast   = data.config?.macdFastPeriod   ?? 12;
    const macdSlow   = data.config?.macdSlowPeriod   ?? 26;
    const macdSig    = data.config?.macdSignalPeriod ?? 9;
    const rsiPeriod  = data.config?.rsiPeriod        ?? 14;
    const rsiOB     = data.config?.rsiExtreme        ?? 70;
    const rsiOS     = 100 - rsiOB;
    const hasMacd    = data.config?.macdEnabled && results.some(r => r.macdHistogram !== null && r.macdHistogram !== undefined);
    const hasRsi     = data.config?.rsiEnabled  && results.some(r => r.rsi !== null && r.rsi !== undefined);
    const hasInterp  = hasMacd || hasRsi;

    // ── Timestamps ────────────────────────────────────────────
    const dates = results.map((r, idx) => {
        if (r.timestamp) return new Date(r.timestamp).toISOString();
        return new Date(Date.now() - (results.length - idx) * 3600000).toISOString();
    });

    // ── Price & MA series ──────────────────────────────────────
    const prices        = results.map(r => r.price);
    const smaValues     = results.map(r => r.slowSma);
    const fastSmaValues = results.map(r => r.fastSmaValue);
    const almaValues    = results.map(r => r.almaValue);
    const kamaValues    = results.map(r => r.fastKama);
    const hasKama       = !smaOnly && results.some(r => r.fastKama !== null && r.fastKama !== undefined);
    const lrsValues     = results.map(r => r.lrsValue);
    const hasLrs        = !smaOnly && results.some(r => r.lrsValue !== null && r.lrsValue !== undefined);
    const lrsPeriod     = data.config?.lrsPeriod || 'N/A';
    const kamaEr        = data.config?.fastKamaErPeriod || 'N/A';

    // ── Signal series (UP=+1, NEUTRAL=0, DOWN=-1) ─────────────
    const smaNum  = results.map(r => trendToNum(r.smaRawTrend));
    const smaUp   = smaNum.map(v => v > 0 ?  1 : 0);
    const smaDown = smaNum.map(v => v < 0 ? -1 : 0);
    const smaConf = results.map(r => r.smaConfidence);

    const fastSmaNum  = results.map(r => trendToNum(r.fastSmaRawTrend));
    const fastSmaUp   = fastSmaNum.map(v => v > 0 ?  1 : 0);
    const fastSmaDown = fastSmaNum.map(v => v < 0 ? -1 : 0);
    const fastSmaConf = results.map(r => r.fastSmaConfidence || 0);

    const almaNum  = results.map(r => trendToNum(r.almaRawTrend));
    const almaUp   = almaNum.map(v => v > 0 ?  1 : 0);
    const almaDown = almaNum.map(v => v < 0 ? -1 : 0);
    const almaConf = results.map(r => r.almaConfidence || 0);

    const lrsNum  = results.map(r => trendToNum(r.lrsRawTrend));
    const lrsUp   = lrsNum.map(v => v > 0 ?  1 : 0);
    const lrsDown = lrsNum.map(v => v < 0 ? -1 : 0);
    const lrsConf = results.map(r => r.lrsConfidence || 0);

    // ── MACD series ────────────────────────────────────────────
    const macdHistogram = results.map(r => r.macdHistogram ?? null);
    const macdLine      = results.map(r => r.macdLine      ?? null);
    const macdSignal    = results.map(r => r.macdSignal    ?? null);
    const macdHistUp    = macdHistogram.map(v => v !== null && v > 0 ? v : 0);
    const macdHistDown  = macdHistogram.map(v => v !== null && v < 0 ? v : 0);

    // ── RSI series ─────────────────────────────────────────────
    const rsiValues = results.map(r => r.rsi ?? null);

    // ── Interpretation series — 6 states ──────────────────────
    const interpState = results.map(r => r.interpretation || 'NEUTRAL');
    const interpBull     = interpState.map(s => s === 'BULL'       ?  1    : 0);
    const interpBullWeak = interpState.map(s => s === 'BULL_WEAK'  ?  0.5  : 0);
    const interpOB       = interpState.map(s => s === 'OVERBOUGHT' ?  0.75 : 0);
    const interpBear     = interpState.map(s => s === 'BEAR'       ? -1    : 0);
    const interpBearWeak = interpState.map(s => s === 'BEAR_WEAK'  ? -0.5  : 0);
    const interpOS       = interpState.map(s => s === 'OVERSOLD'   ? -0.75 : 0);

    // ── Stats values ───────────────────────────────────────────
    const smaTrendClass     = (last.smaRawTrend     || 'neutral').toLowerCase();
    const fastSmaTrendClass = (last.fastSmaRawTrend || 'neutral').toLowerCase();
    const almaTrendClass    = (last.almaRawTrend    || 'neutral').toLowerCase();
    const lrsTrendClass     = (last.lrsRawTrend     || 'neutral').toLowerCase();

    const headerParts = [];
    if (smaPeriod !== 'N/A')  headerParts.push(`SMA(${smaPeriod})`);
    if (hasFastSma)           headerParts.push(`fastSMA(${fastSmaPeriod})`);
    if (hasAlma)              headerParts.push(`ALMA(${almaPeriod},${almaOffset},σ${almaSigma})`);
    if (hasKama)              headerParts.push(`KAMA(${kamaEr})`);
    if (hasLrs)               headerParts.push(`LRS(${lrsPeriod})`);
    if (hasMacd)              headerParts.push(`MACD(${macdFast},${macdSlow},${macdSig})`);
    if (hasRsi)               headerParts.push(`RSI(${rsiPeriod})`);
    const headerSub = headerParts.join(' &middot; ');

    const lrsStatsBlock = hasLrs ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; LRS(${lrsPeriod}) slope &#x2500;&#x2500;</span></div>
    <div><span class="label">Direction</span><span class="trend-badge ${lrsTrendClass}">${last.lrsRawTrend}</span></div>
    <div><span class="label">Confirmed</span> <span class="val">${last.lrsTrend}</span></div>
    <div><span class="label">Bars in direction</span> <span class="val">${last.lrsBarsInTrend}</span></div>
    <div><span class="label">Confidence</span> <span class="val">${last.lrsConfidence}%</span></div>
    <div><span class="label">Slope %/bar</span> <span class="val">${last.lrsSlope !== null ? Number(last.lrsSlope).toFixed(6) : 'n/a'}</span></div>` : '';

    const fastSmaStatsBlock = hasFastSma ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; fastSMA(${fastSmaPeriod}) d/dt &#x2500;&#x2500;</span></div>
    <div><span class="label">Direction</span><span class="trend-badge ${fastSmaTrendClass}">${last.fastSmaRawTrend}</span></div>
    <div><span class="label">Confirmed</span> <span class="val">${last.fastSmaTrend}</span></div>
    <div><span class="label">Bars in direction</span> <span class="val">${last.fastSmaBarsInTrend}</span></div>
    <div><span class="label">Confidence</span> <span class="val">${last.fastSmaConfidence}%</span></div>
    <div><span class="label">fastSMA value</span> <span class="val">${last.fastSmaValue !== null ? Number(last.fastSmaValue).toFixed(6) : 'n/a'}</span></div>` : '';

    const almaStatsBlock = hasAlma ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; ALMA(${almaPeriod}) d/dt &#x2500;&#x2500;</span></div>
    <div><span class="label">Direction</span><span class="trend-badge ${almaTrendClass}">${last.almaRawTrend}</span></div>
    <div><span class="label">Confirmed</span> <span class="val">${last.almaTrend}</span></div>
    <div><span class="label">Bars in direction</span> <span class="val">${last.almaBarsInTrend}</span></div>
    <div><span class="label">Confidence</span> <span class="val">${last.almaConfidence}%</span></div>
    <div><span class="label">ALMA value</span> <span class="val">${last.almaValue !== null ? Number(last.almaValue).toFixed(6) : 'n/a'}</span></div>` : '';

    const statsPanel = `
    <div><span class="label">Candles</span> <span class="val">${results.length}</span></div>
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; SMA(${smaPeriod}) d/dt &#x2500;&#x2500;</span></div>
    <div><span class="label">Direction</span><span class="trend-badge ${smaTrendClass}">${last.smaRawTrend}</span></div>
    <div><span class="label">Confirmed</span> <span class="val">${last.smaTrend}</span></div>
    <div><span class="label">Bars in direction</span> <span class="val">${last.smaBarsInTrend}</span></div>
    <div><span class="label">Confidence</span> <span class="val">${last.smaConfidence}%</span></div>
    <div><span class="label">SMA value</span> <span class="val">${last.slowSma !== null ? Number(last.slowSma).toFixed(6) : 'n/a'}</span></div>
    ${fastSmaStatsBlock}
    ${almaStatsBlock}
    ${lrsStatsBlock}
    ${hasMacd ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; MACD(${macdFast},${macdSlow},${macdSig}) &#x2500;&#x2500;</span></div>
    <div><span class="label">Signal</span><span class="trend-badge ${(last.macdTrend || 'neutral').toLowerCase()}">${last.macdTrend || 'n/a'}</span></div>
    <div><span class="label">Histogram</span> <span class="val">${last.macdHistogram !== null ? Number(last.macdHistogram).toFixed(4) + '%' : 'n/a'}</span></div>
    <div><span class="label">MACD line</span> <span class="val">${last.macdLine !== null ? Number(last.macdLine).toFixed(4) + '%' : 'n/a'}</span></div>` : ''}
    ${hasRsi ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; RSI(${rsiPeriod}) &#x2500;&#x2500;</span></div>
    <div><span class="label">Value</span> <span class="val">${last.rsi !== null ? Number(last.rsi).toFixed(1) : 'n/a'}</span></div>
    <div><span class="label">Zone</span> <span class="val">${last.rsiZone || 'n/a'}</span></div>` : ''}
    ${hasInterp ? `
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Interpretation &#x2500;&#x2500;</span></div>
    <div><span class="trend-badge ${last.interpretation === 'BULL' ? 'up' : last.interpretation === 'BEAR' ? 'down' : 'neutral'}">${last.interpretation}</span></div>` : ''}
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Price &#x2500;&#x2500;</span></div>
    <div><span class="label">Last</span> <span class="val">${last.price !== null ? Number(last.price).toFixed(6) : 'n/a'}</span></div>
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
        #stats .val   { color: #e0e0e0; font-weight: 600; }

        #charts { padding-top: 36px; display: flex; flex-direction: column; height: 100vh; }
        #price-chart  { flex: 3; min-height: 0; }
        #deriv-chart  { flex: 1; min-height: 0; }
        #macd-chart   { flex: 2; min-height: 0; }
        #rsi-chart    { flex: 1; min-height: 0; }
        #interp-chart { flex: 2; min-height: 0; }

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
    <span class="sub" style="margin-left:auto">Generated: ${new Date().toLocaleString()}</span>
</div>

<div id="stats">${statsPanel}</div>

<div id="charts">
    <div id="price-chart"></div>
    <div id="deriv-chart"></div>
    ${hasInterp ? '<div id="interp-chart"></div>' : ''}
    ${hasRsi   ? '<div id="rsi-chart"></div>'  : ''}
    ${hasMacd ? '<div id="macd-chart"></div>' : ''}
</div>

<script>
const dates     = ${JSON.stringify(dates)};
const prices    = ${JSON.stringify(prices)};
const smaValues = ${JSON.stringify(smaValues)};
${hasFastSma ? `const fastSmaValues = ${JSON.stringify(fastSmaValues)};` : ''}
${hasAlma  ? `const almaValues  = ${JSON.stringify(almaValues)};`  : ''}
${hasKama  ? `const kamaValues  = ${JSON.stringify(kamaValues)};`  : ''}
${hasLrs ? `const lrsValues = ${JSON.stringify(lrsValues)};` : ''}
${hasMacd ? `const macdHistogram = ${JSON.stringify(macdHistogram)};
const macdLine      = ${JSON.stringify(macdLine)};
const macdSignal    = ${JSON.stringify(macdSignal)};
const macdHistUp    = ${JSON.stringify(macdHistUp)};
const macdHistDown  = ${JSON.stringify(macdHistDown)};` : ''}
${hasRsi ? `const rsiValues = ${JSON.stringify(rsiValues)};` : ''}
${hasInterp ? `const interpBull     = ${JSON.stringify(interpBull)};
const interpBullWeak = ${JSON.stringify(interpBullWeak)};
const interpOB       = ${JSON.stringify(interpOB)};
const interpBear     = ${JSON.stringify(interpBear)};
const interpBearWeak = ${JSON.stringify(interpBearWeak)};
const interpOS       = ${JSON.stringify(interpOS)};
const interpState    = ${JSON.stringify(interpState)};` : ''}
const smaUp     = ${JSON.stringify(smaUp)};
const smaDown   = ${JSON.stringify(smaDown)};
const smaConf   = ${JSON.stringify(smaConf)};
${hasFastSma ? `const fastSmaUp   = ${JSON.stringify(fastSmaUp)};
const fastSmaDown = ${JSON.stringify(fastSmaDown)};
const fastSmaConf = ${JSON.stringify(fastSmaConf)};` : ''}
${hasAlma ? `const almaUp   = ${JSON.stringify(almaUp)};
const almaDown = ${JSON.stringify(almaDown)};
const almaConf = ${JSON.stringify(almaConf)};` : ''}
${hasLrs ? `const lrsUp   = ${JSON.stringify(lrsUp)};
const lrsDown = ${JSON.stringify(lrsDown)};
const lrsConf = ${JSON.stringify(lrsConf)};` : ''}

const DARK = { plot_bgcolor: '#0e1117', paper_bgcolor: '#0e1117', font: { color: '#ccc', size: 11 } };
const AXIS = { gridcolor: '#1e2330', linecolor: '#2a2e3e', zerolinecolor: '#333', tickfont: { size: 10 } };
const MARGIN_R = 250;

// ── Price chart ────────────────────────────────────────────────────────────
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
${hasAlma ? `    {
        x: dates, y: almaValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#f472b6', width: 1 },
        name: 'ALMA(${almaPeriod})',
        hovertemplate: 'ALMA: %{y:.6f}<extra></extra>',
    },` : ''}
${hasKama ? `    {
        x: dates, y: kamaValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#a78bfa', width: 1 },
        name: 'KAMA(${kamaEr})',
        hovertemplate: 'KAMA: %{y:.6f}<extra></extra>',
    },` : ''}
${hasLrs ? `    {
        x: dates, y: lrsValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#22d3ee', width: 1 },
        name: 'LRS(${lrsPeriod})',
        hovertemplate: 'LRS: %{y:.6f}<extra></extra>',
    },` : ''}
];

Plotly.newPlot('price-chart', priceTraces, {
    ...DARK,
    margin: { l: 60, r: MARGIN_R, t: 8, b: 4 },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
    xaxis: { ...AXIS, type: 'date', showticklabels: false, rangeslider: { visible: false } },
    yaxis: { ...AXIS, title: { text: 'Price', standoff: 6 }, type: 'log', autorange: true },
}, { responsive: true, displayModeBar: true });

// ── Derivative signal chart ────────────────────────────────────────────────
// Rendered as two filled scatter traces per indicator (UP half / DOWN half).
// Much faster than bar charts for large datasets.
const zeroLine = {
    x: [dates[0], dates[dates.length - 1]], y: [0, 0],
    type: 'scatter', mode: 'lines',
    line: { color: '#333', width: 1, dash: 'dot' },
    showlegend: false, hoverinfo: 'skip',
};

const derivTraces = [
    // SMA UP fill (green)
    {
        x: dates, y: smaUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.55)',
        name: 'd(SMA) UP', showlegend: false, hoverinfo: 'skip',
    },
    // SMA DOWN fill (red)
    {
        x: dates, y: smaDown,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.55)',
        name: 'd(SMA) DOWN', showlegend: false, hoverinfo: 'skip',
    },
    // Hover line for SMA
    {
        x: dates, y: smaUp.map((u, i) => u || smaDown[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'd(SMA)/dt',
        customdata: smaUp.map((u, i) => u > 0 ? 'UP' : smaDown[i] < 0 ? 'DOWN' : 'NEUTRAL'),
        hovertemplate: 'd(SMA)/dt: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
${hasFastSma ? `    // fastSMA UP fill (orange)
    {
        x: dates, y: fastSmaUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(251,146,60,0.35)',
        name: 'd(fastSMA) UP', showlegend: false, hoverinfo: 'skip',
    },
    // fastSMA DOWN fill (orange)
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
${hasAlma ? `    // ALMA UP fill (pink, lighter)
    {
        x: dates, y: almaUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(244,114,182,0.25)',
        name: 'd(ALMA) UP', showlegend: false, hoverinfo: 'skip',
    },
    // ALMA DOWN fill (pink, lighter)
    {
        x: dates, y: almaDown,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(244,114,182,0.25)',
        name: 'd(ALMA) DOWN', showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: almaUp.map((u, i) => u || almaDown[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'd(ALMA)/dt',
        customdata: almaUp.map((u, i) => u > 0 ? 'UP' : almaDown[i] < 0 ? 'DOWN' : 'NEUTRAL'),
        hovertemplate: 'd(ALMA)/dt: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },` : ''}
${hasLrs ? `    // LRS UP fill (cyan)
    {
        x: dates, y: lrsUp,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(34,211,238,0.35)',
        showlegend: false, hoverinfo: 'skip',
    },
    // LRS DOWN fill (cyan)
    {
        x: dates, y: lrsDown,
        type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' },
        fill: 'tozeroy', fillcolor: 'rgba(34,211,238,0.35)',
        showlegend: false, hoverinfo: 'skip',
    },
    {
        x: dates, y: lrsUp.map((u, i) => u || lrsDown[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'LRS(${lrsPeriod})',
        customdata: lrsUp.map((u, i) => u > 0 ? 'UP' : lrsDown[i] < 0 ? 'DOWN' : 'NEUTRAL'),
        hovertemplate: 'LRS slope: <b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },` : ''}
    zeroLine,
];

Plotly.newPlot('deriv-chart', derivTraces, {
    ...DARK,
    hovermode: 'x',
    margin: { l: 60, r: MARGIN_R, t: 4, b: 4 },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
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

// ── MACD chart ─────────────────────────────────────────────────────────────
${hasMacd ? `
const macdZero = {
    x: [dates[0], dates[dates.length - 1]], y: [0, 0],
    type: 'scatter', mode: 'lines',
    line: { color: '#333', width: 1, dash: 'dot' },
    showlegend: false, hoverinfo: 'skip',
};
Plotly.newPlot('macd-chart', [
    // Histogram UP (green)
    {
        x: dates, y: macdHistUp,
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.6)',
        name: 'Hist+', showlegend: false, hoverinfo: 'skip',
    },
    // Histogram DOWN (red)
    {
        x: dates, y: macdHistDown,
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.6)',
        name: 'Hist-', showlegend: false, hoverinfo: 'skip',
    },
    // MACD line (blue)
    {
        x: dates, y: macdLine,
        type: 'scattergl', mode: 'lines',
        line: { color: '#5c9ee6', width: 1 },
        name: 'MACD',
        hovertemplate: 'MACD: %{y:.4f}%<extra></extra>',
    },
    // Signal line (orange)
    {
        x: dates, y: macdSignal,
        type: 'scattergl', mode: 'lines',
        line: { color: '#fb923c', width: 1 },
        name: 'Signal',
        hovertemplate: 'Signal: %{y:.4f}%<extra></extra>',
    },
    macdZero,
], {
    ...DARK,
    margin: { l: 60, r: MARGIN_R, t: 4, b: 4 },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
    xaxis: { ...AXIS, type: 'date', showticklabels: false },
    yaxis: { ...AXIS, title: { text: 'MACD %', standoff: 6 }, zeroline: true, zerolinecolor: '#333' },
}, { responsive: true, displayModeBar: false });` : ''}

// ── RSI chart ──────────────────────────────────────────────────────────────
${hasRsi ? `
Plotly.newPlot('rsi-chart', [
    // Overbought zone fill
    {
        x: dates, y: rsiValues.map(() => ${rsiOB}),
        type: 'scattergl', mode: 'none',
        fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.07)',
        showlegend: false, hoverinfo: 'skip',
    },
    // RSI line
    {
        x: dates, y: rsiValues,
        type: 'scattergl', mode: 'lines',
        line: { color: '#a78bfa', width: 1 },
        name: 'RSI(${rsiPeriod})',
        hovertemplate: 'RSI: %{y:.1f}<extra></extra>',
    },
    // Overbought line
    {
        x: [dates[0], dates[dates.length-1]], y: [${rsiOB}, ${rsiOB}],
        type: 'scatter', mode: 'lines',
        line: { color: 'rgba(239,83,80,0.5)', width: 1, dash: 'dot' },
        name: 'OB ${rsiOB}', showlegend: false, hoverinfo: 'skip',
    },
    // Oversold line
    {
        x: [dates[0], dates[dates.length-1]], y: [${rsiOS}, ${rsiOS}],
        type: 'scatter', mode: 'lines',
        line: { color: 'rgba(38,166,154,0.5)', width: 1, dash: 'dot' },
        name: 'OS ${rsiOS}', showlegend: false, hoverinfo: 'skip',
    },
    // Midline
    {
        x: [dates[0], dates[dates.length-1]], y: [50, 50],
        type: 'scatter', mode: 'lines',
        line: { color: '#333', width: 1, dash: 'dot' },
        showlegend: false, hoverinfo: 'skip',
    },
], {
    ...DARK,
    margin: { l: 60, r: MARGIN_R, t: 4, b: 4 },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
    xaxis: { ...AXIS, type: 'date', showticklabels: false },
    yaxis: { ...AXIS, title: { text: 'RSI', standoff: 6 }, range: [0, 100], fixedrange: true },
}, { responsive: true, displayModeBar: false });` : ''}

// ── Interpretation chart ───────────────────────────────────────────────────
${hasInterp ? `
Plotly.newPlot('interp-chart', [
    // BULL — strong green
    { x: dates, y: interpBull,     type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.70)',  showlegend: false, hoverinfo: 'skip' },
    // BULL_WEAK — dim green
    { x: dates, y: interpBullWeak, type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(38,166,154,0.30)',  showlegend: false, hoverinfo: 'skip' },
    // OVERBOUGHT — amber warning
    { x: dates, y: interpOB,       type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(245,158,11,0.60)',  showlegend: false, hoverinfo: 'skip' },
    // BEAR — strong red
    { x: dates, y: interpBear,     type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.70)',   showlegend: false, hoverinfo: 'skip' },
    // BEAR_WEAK — dim red
    { x: dates, y: interpBearWeak, type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(239,83,80,0.30)',   showlegend: false, hoverinfo: 'skip' },
    // OVERSOLD — teal warning
    { x: dates, y: interpOS,       type: 'scattergl', mode: 'lines', line: { shape: 'hv', width: 0, color: 'transparent' }, fill: 'tozeroy', fillcolor: 'rgba(34,211,238,0.50)',  showlegend: false, hoverinfo: 'skip' },
    // Hover trace
    {
        x: dates, y: interpBull.map((v, i) => v || interpBullWeak[i] || interpOB[i] || interpBear[i] || interpBearWeak[i] || interpOS[i]),
        type: 'scattergl', mode: 'lines',
        line: { color: 'rgba(255,255,255,0)', width: 0 },
        name: 'Signal',
        customdata: interpState,
        hovertemplate: '<b>%{customdata}</b><extra></extra>',
        showlegend: true,
    },
    { x: [dates[0], dates[dates.length-1]], y: [0, 0], type: 'scatter', mode: 'lines', line: { color: '#333', width: 1, dash: 'dot' }, showlegend: false, hoverinfo: 'skip' },
], {
    ...DARK,
    hovermode: 'x',
    margin: { l: 60, r: MARGIN_R, t: 4, b: 28 },
    showlegend: true,
    legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(0,0,0,0.4)', font: { size: 11 } },
    xaxis: { ...AXIS, type: 'date' },
    yaxis: {
        ...AXIS,
        title: { text: 'Signal', standoff: 6 },
        tickvals: [-1, -0.75, -0.5, 0, 0.5, 0.75, 1],
        ticktext: ['BEAR', 'OVERSOLD', 'WEAK', '—', 'WEAK', 'OVERBOUGHT', 'BULL'],
        range: [-1.15, 1.15], fixedrange: true,
    },
}, { responsive: true, displayModeBar: false });` : ''}

// ── Synchronized x-axis zoom ───────────────────────────────────────────────
let isSyncing = false;
function syncAxes(srcDiv, targets) {
    let rafId = null;
    srcDiv.on('plotly_relayout', e => {
        if (isSyncing) return;
        const upd = e['xaxis.range[0]'] !== undefined
            ? { 'xaxis.range[0]': e['xaxis.range[0]'], 'xaxis.range[1]': e['xaxis.range[1]'] }
            : e['xaxis.autorange'] ? { 'xaxis.autorange': true } : null;
        if (!upd) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            isSyncing = true;
            Promise.all(targets.map(d => Plotly.relayout(d, upd)))
                .finally(() => { isSyncing = false; rafId = null; });
        });
    });
}
const allCharts = [
    document.getElementById('price-chart'),
    document.getElementById('deriv-chart'),
    ${hasMacd ? "document.getElementById('macd-chart')," : ''}
    ${hasRsi   ? "document.getElementById('rsi-chart'),"  : ''}
    ${hasInterp ? "document.getElementById('interp-chart')," : ''}
].filter(Boolean);
allCharts.forEach(src => syncAxes(src, allCharts.filter(c => c !== src)));

// ── Vertical crosshair across all panels ──────────────────────────────────
let lastCrosshairX = null;
function setCrosshair(xVal) {
    if (lastCrosshairX === xVal) return;
    lastCrosshairX = xVal;
    const shape = xVal !== null ? [{
        type: 'line',
        x0: xVal, x1: xVal,
        y0: 0, y1: 1,
        yref: 'paper',
        line: { color: 'rgba(255,255,255,0.35)', width: 1, dash: 'dot' },
    }] : [];
    allCharts.forEach(chart => Plotly.relayout(chart, { shapes: shape }));
}
allCharts.forEach(chart => {
    chart.on('plotly_hover',   data => { const x = data.points[0]?.x; if (x != null) setCrosshair(x); });
    chart.on('plotly_unhover', ()   => setCrosshair(null));
});
</script>
</body>
</html>`;
}

// ─── Main (standalone) ───────────────────────────────────────────────────────

async function main() {
    const cfg = parseArgs();
    try {
        if (!cfg.quiet) console.log(`[Chart] Reading ${cfg.inputFile}...`);
        if (!fs.existsSync(cfg.inputFile)) throw new Error(`File not found: ${cfg.inputFile}`);
        const data = JSON.parse(fs.readFileSync(cfg.inputFile, 'utf8'));
        const html = generateHTML(data, cfg.title, cfg.smaOnly);
        const dir = path.dirname(cfg.outputFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cfg.outputFile, html, 'utf8');
        if (!cfg.quiet) console.log(`[Chart] ✓ Saved to ${cfg.outputFile}`);
    } catch (err) {
        console.error(`[Chart] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { generateHTML };
