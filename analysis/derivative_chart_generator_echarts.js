#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        inputFile: null,
        outputFile: 'analysis/charts/derivative_chart.echarts.html',
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
Derivative Chart Generator (ECharts)

Usage:
  node analysis/derivative_chart_generator_echarts.js --input <file.json> [options]

Options:
  --output FILE   Output HTML (default: analysis/charts/derivative_chart.echarts.html)
  --title TEXT    Chart title
  --quiet         Suppress output
    `);
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[m]));
}

function serializeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function trendToNum(trend) {
    if (trend === 'UP') return 1;
    if (trend === 'DOWN') return -1;
    return 0;
}

function countTrend(arr) {
    return arr.reduce((acc, v) => {
        acc.total += 1;
        if (v > 0) acc.up += 1;
        else if (v < 0) acc.down += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, up: 0, down: 0, neutral: 0 });
}

function countStates(arr, positive, negative) {
    return arr.reduce((acc, v) => {
        acc.total += 1;
        if (v === positive) acc.positive += 1;
        else if (v === negative) acc.negative += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, positive: 0, negative: 0, neutral: 0 });
}

function generateHTML(data, title) {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const source = data.config?.source || 'Unknown';
    const smaPeriod = data.config?.slowSmaPeriod || 'N/A';
    const fastSmaPeriod = data.config?.fastSmaPeriod || null;
    const hasFastSma = fastSmaPeriod !== null && results.some((r) => r.fastSmaValue !== null && r.fastSmaValue !== undefined);
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

    const prices = results.map((r) => r.price);
    const smaValues = results.map((r) => r.slowSma);
    const fastSmaValues = results.map((r) => r.fastSmaValue);

    const smaNum = results.map((r) => trendToNum(r.smaRawTrend));
    const smaUp = smaNum.map((v) => (v > 0 ? 1 : 0));
    const smaDown = smaNum.map((v) => (v < 0 ? -1 : 0));
    const smaConf = results.map((r) => r.smaConfidence ?? 0);

    const fastSmaNum = results.map((r) => trendToNum(r.fastSmaRawTrend));
    const fastSmaUp = fastSmaNum.map((v) => (v > 0 ? 1 : 0));
    const fastSmaDown = fastSmaNum.map((v) => (v < 0 ? -1 : 0));
    const fastSmaConf = results.map((r) => r.fastSmaConfidence || 0);

    const macdHistogram = results.map((r) => r.macdHistogram ?? null);
    const macdLine = results.map((r) => r.macdLine ?? null);
    const macdSignal = results.map((r) => r.macdSignal ?? null);
    const macdHistUp = macdHistogram.map((v) => (v !== null && v > 0 ? v : 0));
    const macdHistDown = macdHistogram.map((v) => (v !== null && v < 0 ? v : 0));

    const rsiValues = results.map((r) => r.rsi ?? null);

    const interpState = results.map((r) => r.interpretation || 'NEUTRAL');
    const interpBars = results.map((r) => r.interpretationBars ?? 0);
    const interpBull = interpState.map((s) => (s === 'BULL' ? 1 : 0));
    const interpBullWeak = interpState.map((s) => (s === 'BULL_WEAK' ? 0.5 : 0));
    const interpOB = interpState.map((s) => (s === 'OVERBOUGHT' ? 0.75 : 0));
    const interpBear = interpState.map((s) => (s === 'BEAR' ? -1 : 0));
    const interpBearWeak = interpState.map((s) => (s === 'BEAR_WEAK' ? -0.5 : 0));
    const interpOS = interpState.map((s) => (s === 'OVERSOLD' ? -0.75 : 0));
    const entryBias = results.map((r) => r.entryBias || 'NONE');
    const entryLabelMap = {
        NONE: 'No fresh entry',
        EARLY_LONG: 'Early long entry',
        CONFIRM_LONG: 'Confirmed long entry',
        LATE_LONG: 'Late long entry',
        EARLY_SHORT: 'Early short entry',
        CONFIRM_SHORT: 'Confirmed short entry',
        LATE_SHORT: 'Late short entry',
    };
    const entryBiasLabel = entryBias.map((v) => entryLabelMap[v] || v);
    const signalPhase = results.map((r, i) => {
        if (entryBias[i] !== 'NONE') return entryLabelMap[entryBias[i]] || entryBias[i];
        switch (interpState[i]) {
        case 'BULL':
            return 'Bull trend active';
        case 'BULL_WEAK':
            return 'Bull setup active';
        case 'BEAR':
            return 'Bear trend active';
        case 'BEAR_WEAK':
            return 'Bear setup active';
        case 'OVERBOUGHT':
            return 'Overbought exit pressure';
        case 'OVERSOLD':
            return 'Oversold exit pressure';
        default:
            return 'No active setup';
        }
    });
    const bullWeakEntryMarkers = results.map((r) => (r.isBullWeakEntry ? 0.38 : null));
    const bullConfirmationMarkers = results.map((r) => (r.isBullConfirmation ? 0.88 : null));
    const lateBullMarkers = results.map((r) => (r.isLateBullWithoutWeak ? 0.88 : null));
    const bearWeakEntryMarkers = results.map((r) => (r.isBearWeakEntry ? -0.38 : null));
    const bearConfirmationMarkers = results.map((r) => (r.isBearConfirmation ? -0.88 : null));
    const lateBearMarkers = results.map((r) => (r.isLateBearWithoutWeak ? -0.88 : null));

    const priceSeries = prices.filter((v) => Number.isFinite(v));
    const priceStart = priceSeries.length ? priceSeries[0] : null;
    const priceEnd = priceSeries.length ? priceSeries[priceSeries.length - 1] : null;
    const priceHigh = priceSeries.length ? Math.max(...priceSeries) : null;
    const priceLow = priceSeries.length ? Math.min(...priceSeries) : null;
    const priceChange = priceStart !== null && priceEnd !== null ? priceEnd - priceStart : null;
    const priceChangePct = priceStart !== null && priceEnd !== null && priceStart !== 0
        ? ((priceEnd - priceStart) / priceStart) * 100
        : null;

    const macdTrendNum = results.map((r) => (r.macdTrend === 'BULL' ? 1 : r.macdTrend === 'BEAR' ? -1 : 0));
    const interpTrendNum = interpState.map((s) => (s === 'BULL' || s === 'BULL_WEAK' ? 1 : s === 'BEAR' || s === 'BEAR_WEAK' ? -1 : 0));

    const smaTotals = countTrend(smaNum);
    const fastSmaTotals = countTrend(fastSmaNum);
    const macdTotals = countTrend(macdTrendNum);
    const rsiTotals = countStates(results.map((r) => r.rsiZone || 'NEUTRAL'), 'OVERBOUGHT', 'OVERSOLD');
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
    const fmtPrice = (v) => (v === null ? 'n/a' : Number(v).toFixed(6));
    const fmtSignedPrice = (v) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}`);
    const fmtPct = (v) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}%`);
    const fmtShare = (count) => (candleCount > 0 ? `${Math.round((count / candleCount) * 100)}%` : 'n/a');

    const headerParts = [];
    if (smaPeriod !== 'N/A') headerParts.push(`SMA(${smaPeriod})`);
    if (hasFastSma) headerParts.push(`fastSMA(${fastSmaPeriod})`);
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

    const chartId = `deriv-echarts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0e1117; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; overflow: hidden; }
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
        #price-chart  { flex: 3; min-height: 0; }
        #deriv-chart  { flex: 1; min-height: 0; }
        #interp-chart { flex: 2; min-height: 0; }
        #macd-chart   { flex: 2; min-height: 0; }
        #rsi-chart    { flex: 1; min-height: 0; }
        #reset-zoom-btn {
            background: #1e2330; color: #ccc; border: 1px solid #2a2e3e;
            border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer;
            white-space: nowrap;
        }
        #reset-zoom-btn:hover { background: #2a3050; color: #fff; }
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
    <div id="price-chart"></div>
    <div id="deriv-chart"></div>
    <div id="interp-chart"></div>
    <div id="macd-chart"></div>
    <div id="rsi-chart"></div>
</div>

<script type="application/json" id="deriv-payload">${serializeJsonForScript({
    dates,
    prices,
    smaValues,
    fastSmaValues: hasFastSma ? fastSmaValues : null,
    macdHistogram,
    macdLine,
    macdSignal,
    macdHistUp,
    macdHistDown,
    rsiValues,
    interpBull,
    interpBullWeak,
    interpOB,
    interpBear,
    interpBearWeak,
    interpOS,
    interpState,
    interpBars,
    entryBias,
    entryBiasLabel,
    signalPhase,
    bullWeakEntryMarkers,
    bullConfirmationMarkers,
    lateBullMarkers,
    bearWeakEntryMarkers,
    bearConfirmationMarkers,
    lateBearMarkers,
    smaUp,
    smaDown,
    smaConf,
    fastSmaUp: hasFastSma ? fastSmaUp : null,
    fastSmaDown: hasFastSma ? fastSmaDown : null,
    fastSmaConf: hasFastSma ? fastSmaConf : null,
})}</script>

<script>
const payload = JSON.parse(document.getElementById('deriv-payload').textContent);
const dates = payload.dates;
const prices = payload.prices;
const smaValues = payload.smaValues;
const fastSmaValues = payload.fastSmaValues || [];
const macdHistogram = payload.macdHistogram;
const macdLine = payload.macdLine;
const macdSignal = payload.macdSignal;
const macdHistUp = payload.macdHistUp;
const macdHistDown = payload.macdHistDown;
const rsiValues = payload.rsiValues;
const interpBull = payload.interpBull;
const interpBullWeak = payload.interpBullWeak;
const interpOB = payload.interpOB;
const interpBear = payload.interpBear;
const interpBearWeak = payload.interpBearWeak;
const interpOS = payload.interpOS;
const interpState = payload.interpState;
const interpBars = payload.interpBars;
const entryBias = payload.entryBias;
const entryBiasLabel = payload.entryBiasLabel;
const signalPhase = payload.signalPhase;
const bullWeakEntryMarkers = payload.bullWeakEntryMarkers;
const bullConfirmationMarkers = payload.bullConfirmationMarkers;
const lateBullMarkers = payload.lateBullMarkers;
const bearWeakEntryMarkers = payload.bearWeakEntryMarkers;
const bearConfirmationMarkers = payload.bearConfirmationMarkers;
const lateBearMarkers = payload.lateBearMarkers;
const smaUp = payload.smaUp;
const smaDown = payload.smaDown;
const smaConf = payload.smaConf;
const fastSmaUp = payload.fastSmaUp || [];
const fastSmaDown = payload.fastSmaDown || [];
const fastSmaConf = payload.fastSmaConf || [];

const THEME = { textColor: '#ccc', backgroundColor: '#0e1117', gridColor: '#1e2330', axisColor: '#2a2e3e', mutedColor: '#888' };
const chartGroupId = ${JSON.stringify(chartId)};

function initChart(domId, option, deferRender = false) {
    const chart = echarts.init(document.getElementById(domId), null, { renderer: 'canvas', useDirtyRect: true });
    chart.group = chartGroupId;
    const applyOption = () => chart.setOption(option, { notMerge: true, lazyUpdate: true });
    if (deferRender) {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(applyOption, { timeout: 50 });
        } else {
            setTimeout(applyOption, 0);
        }
    } else {
        applyOption();
    }
    return chart;
}

function commonXAxis(showLabel) {
    return {
        type: 'time',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: { show: showLabel, color: THEME.mutedColor, fontSize: 10 },
        splitLine: { show: false },
    };
}

function commonTooltip() {
    return { show: false };
}

function commonAxisPointer() {
    return {
        show: true,
        type: 'line',
        link: [{ xAxisIndex: 'all' }],
        lineStyle: { color: THEME.axisColor, width: 1 },
        label: { show: false },
    };
}

function commonDataZoom() {
    return [{ type: 'inside', xAxisIndex: 0, filterMode: 'filter', zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true }];
}

function makeLineSeries(name, values, color, width, dash, extra = {}) {
    return {
        name,
        type: 'line',
        data: dates.map((x, idx) => [x, values[idx]]),
        showSymbol: false,
        lineStyle: {
            color,
            width,
            type: dash === 'dash' ? 'dashed' : dash === 'dot' ? 'dotted' : 'solid',
        },
        itemStyle: { color },
        ...extra,
    };
}

const priceChart = initChart('price-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    legend: { show: false },
    grid: { left: 88, right: 250, top: 8, bottom: 28, containLabel: true },
    axisPointer: commonAxisPointer(),
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(false),
    yAxis: { type: 'log', min: 'dataMin', max: 'dataMax', axisLine: { lineStyle: { color: THEME.axisColor } }, axisTick: { show: false }, axisLabel: { color: THEME.mutedColor, fontSize: 10 }, splitLine: { lineStyle: { color: THEME.gridColor } }, name: 'Price', nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] } },
    series: [
        { name: 'Price', type: 'line', data: dates.map((x, i) => [x, prices[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#5c9ee6', width: 2 }, itemStyle: { color: '#5c9ee6' }, emphasis: { disabled: true } },
        { name: 'SMA(${smaPeriod})', type: 'line', data: dates.map((x, i) => [x, smaValues[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#f59e0b', width: 2 }, itemStyle: { color: '#f59e0b' }, emphasis: { disabled: true } },
        ${hasFastSma ? `{ name: 'fastSMA(${fastSmaPeriod})', type: 'line', data: dates.map((x, i) => [x, fastSmaValues[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#fb923c', width: 2 }, itemStyle: { color: '#fb923c' }, emphasis: { disabled: true } },` : ''}
    ],
});

const derivChart = initChart('deriv-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    legend: { show: false },
    grid: { left: 88, right: 250, top: 4, bottom: 4, containLabel: true },
    axisPointer: commonAxisPointer(),
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(false),
    yAxis: {
        type: 'value',
        min: 'dataMin',
        max: 'dataMax',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: {
            color: THEME.mutedColor,
            fontSize: 10,
            formatter: (v) => (v === 1 ? 'UP' : v === -1 ? 'DOWN' : '—'),
        },
        splitLine: { lineStyle: { color: THEME.gridColor } },
        name: 'Direction',
        nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] },
    },
    series: [
        { name: 'd(SMA) UP', type: 'line', data: dates.map((x, i) => [x, smaUp[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(38,166,154,0.55)' }, silent: true, emphasis: { disabled: true } },
        { name: 'd(SMA) DOWN', type: 'line', data: dates.map((x, i) => [x, smaDown[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(239,83,80,0.55)' }, silent: true, emphasis: { disabled: true } },
        makeLineSeries('d(SMA)/dt', smaUp.map((u, i) => (u > 0 ? 1 : smaDown[i] < 0 ? -1 : 0)), 'rgba(255,255,255,0)', 0, 'solid', {
            lineStyle: { opacity: 0 },
            silent: true,
        }),
        ${hasFastSma ? `
        { name: 'd(fastSMA) UP', type: 'line', data: dates.map((x, i) => [x, fastSmaUp[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(251,146,60,0.35)' }, silent: true, emphasis: { disabled: true } },
        { name: 'd(fastSMA) DOWN', type: 'line', data: dates.map((x, i) => [x, fastSmaDown[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(251,146,60,0.35)' }, silent: true, emphasis: { disabled: true } },
        makeLineSeries('d(fastSMA)/dt', fastSmaUp.map((u, i) => (u > 0 ? 1 : fastSmaDown[i] < 0 ? -1 : 0)), 'rgba(255,255,255,0)', 0, 'solid', { lineStyle: { opacity: 0 }, silent: true }),
        ` : ''}
        { name: 'Zero', type: 'line', data: dates.length ? [[dates[0], 0], [dates[dates.length - 1], 0]] : [], showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#333', width: 2, type: 'dotted' }, silent: true, emphasis: { disabled: true } },
    ],
}, true);

const interpChart = initChart('interp-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    legend: { show: false },
    grid: { left: 88, right: 250, top: 4, bottom: 4, containLabel: true },
    axisPointer: commonAxisPointer(),
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(false),
    yAxis: {
        type: 'value',
        min: 'dataMin',
        max: 'dataMax',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: {
            color: THEME.mutedColor,
            fontSize: 10,
            formatter: (v) => {
                if (v === 1) return 'BULL';
                if (v === 0.75) return 'OB';
                if (v === 0.5) return 'WEAK';
                if (v === -0.5) return 'WEAK';
                if (v === -0.75) return 'OS';
                if (v === -1) return 'BEAR';
                return '—';
            },
        },
        splitLine: { lineStyle: { color: THEME.gridColor } },
        name: 'Signal',
        nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] },
    },
    series: [
        { name: 'Bull', type: 'line', data: dates.map((x, i) => [x, interpBull[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(38,166,154,0.45)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Bull Weak', type: 'line', data: dates.map((x, i) => [x, interpBullWeak[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(38,166,154,0.22)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Overbought', type: 'line', data: dates.map((x, i) => [x, interpOB[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(245,158,11,0.18)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Bear', type: 'line', data: dates.map((x, i) => [x, interpBear[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(239,83,80,0.45)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Bear Weak', type: 'line', data: dates.map((x, i) => [x, interpBearWeak[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(239,83,80,0.22)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Oversold', type: 'line', data: dates.map((x, i) => [x, interpOS[i]]), showSymbol: false, step: 'end', sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(56,189,248,0.18)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Early Long', type: 'scatter', data: dates.map((x, i) => [x, bullWeakEntryMarkers[i]]).filter((p) => p[1] !== null), symbol: 'triangle', symbolSize: 8, itemStyle: { color: '#67e8f9' }, silent: true, emphasis: { disabled: true } },
        { name: 'Confirm Long', type: 'scatter', data: dates.map((x, i) => [x, bullConfirmationMarkers[i]]).filter((p) => p[1] !== null), symbol: 'diamond', symbolSize: 8, itemStyle: { color: '#34d399' }, silent: true, emphasis: { disabled: true } },
        { name: 'Late Long', type: 'scatter', data: dates.map((x, i) => [x, lateBullMarkers[i]]).filter((p) => p[1] !== null), symbol: 'x', symbolSize: 9, itemStyle: { color: '#f59e0b' }, silent: true, emphasis: { disabled: true } },
        { name: 'Early Short', type: 'scatter', data: dates.map((x, i) => [x, bearWeakEntryMarkers[i]]).filter((p) => p[1] !== null), symbol: 'triangle', symbolRotate: 180, symbolSize: 8, itemStyle: { color: '#fca5a5' }, silent: true, emphasis: { disabled: true } },
        { name: 'Confirm Short', type: 'scatter', data: dates.map((x, i) => [x, bearConfirmationMarkers[i]]).filter((p) => p[1] !== null), symbol: 'diamond', symbolSize: 8, itemStyle: { color: '#ef4444' }, silent: true, emphasis: { disabled: true } },
        { name: 'Late Short', type: 'scatter', data: dates.map((x, i) => [x, lateBearMarkers[i]]).filter((p) => p[1] !== null), symbol: 'x', symbolSize: 9, itemStyle: { color: '#fb7185' }, silent: true, emphasis: { disabled: true } },
        { name: 'Interpretation', type: 'line', data: dates.map((x, i) => [x, interpState[i] === 'BULL' ? 0.75 : interpState[i] === 'BULL_WEAK' ? 0.35 : interpState[i] === 'OVERBOUGHT' ? 0.95 : interpState[i] === 'BEAR' ? -0.75 : interpState[i] === 'BEAR_WEAK' ? -0.35 : interpState[i] === 'OVERSOLD' ? -0.95 : 0]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { opacity: 0 }, silent: true, emphasis: { disabled: true } },
    ],
}, true);

const macdChart = initChart('macd-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    legend: { show: false },
    grid: { left: 88, right: 250, top: 4, bottom: 4, containLabel: true },
    axisPointer: commonAxisPointer(),
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(false),
    yAxis: { type: 'value', axisLine: { lineStyle: { color: THEME.axisColor } }, axisTick: { show: false }, axisLabel: { color: THEME.mutedColor, fontSize: 10 }, splitLine: { lineStyle: { color: THEME.gridColor } }, name: 'MACD %', nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] } },
    series: [
        { name: 'Hist+', type: 'bar', data: dates.map((x, i) => [x, macdHistUp[i]]), itemStyle: { color: 'rgba(38,166,154,0.6)' }, silent: true, emphasis: { disabled: true } },
        { name: 'Hist-', type: 'bar', data: dates.map((x, i) => [x, macdHistDown[i]]), itemStyle: { color: 'rgba(239,83,80,0.6)' }, silent: true, emphasis: { disabled: true } },
        makeLineSeries('MACD', macdLine, '#5c9ee6', 1, 'solid', { sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, silent: true, emphasis: { disabled: true } }),
        makeLineSeries('Signal', macdSignal, '#fb923c', 1, 'solid', { sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, silent: true, emphasis: { disabled: true } }),
        { name: 'Zero', type: 'line', data: dates.length ? [[dates[0], 0], [dates[dates.length - 1], 0]] : [], showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#333', width: 2, type: 'dotted' }, silent: true, emphasis: { disabled: true } },
    ],
}, true);

const rsiChart = initChart('rsi-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    legend: { show: false },
    grid: { left: 88, right: 250, top: 0, bottom: 20, containLabel: true },
    axisPointer: commonAxisPointer(),
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(true),
    yAxis: { type: 'value', min: 0, max: 100, axisLine: { lineStyle: { color: THEME.axisColor } }, axisTick: { show: false }, axisLabel: { color: THEME.mutedColor, fontSize: 10 }, splitLine: { lineStyle: { color: THEME.gridColor } }, name: 'RSI', nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] } },
    series: [
        { name: 'OB', type: 'line', data: dates.length ? [[dates[0], ${rsiOB}], [dates[dates.length - 1], ${rsiOB}]] : [], showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: 'rgba(239,83,80,0.5)', width: 2, type: 'dotted' }, silent: true, emphasis: { disabled: true } },
        { name: 'OS', type: 'line', data: dates.length ? [[dates[0], ${rsiOS}], [dates[dates.length - 1], ${rsiOS}]] : [], showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: 'rgba(38,166,154,0.5)', width: 2, type: 'dotted' }, silent: true, emphasis: { disabled: true } },
        { name: 'Mid', type: 'line', data: dates.length ? [[dates[0], 50], [dates[dates.length - 1], 50]] : [], showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#333', width: 2, type: 'dotted' }, silent: true, emphasis: { disabled: true } },
        { name: 'RSI(${rsiPeriod})', type: 'line', data: dates.map((x, i) => [x, rsiValues[i]]), showSymbol: false, sampling: 'lttb', progressive: 4000, progressiveThreshold: 8000, clip: true, lineStyle: { color: '#a78bfa', width: 1 }, itemStyle: { color: '#a78bfa' }, silent: true, emphasis: { disabled: true } },
    ],
}, true);

echarts.connect(chartGroupId);

function resetZoom() {
    [priceChart, derivChart, interpChart, macdChart, rsiChart].forEach((chart) => {
        chart.dispatchAction({ type: 'dataZoom', start: 80, end: 100 });
    });
}

window.addEventListener('resize', () => {
    priceChart.resize();
    derivChart.resize();
    interpChart.resize();
    macdChart.resize();
    rsiChart.resize();
});
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
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { generateHTML, parseArgs, showHelp, trendToNum };
