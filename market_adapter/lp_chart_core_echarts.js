'use strict';

const { toIntervalLabel } = require('./candle_utils');

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    }[m]));
}

function finite(values) {
    return values.filter((v) => Number.isFinite(v));
}

function padRange(min, max, pctLower = 0.04, pctUpper = 0.04) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
        const delta = Math.abs(min) * 0.03 || 1;
        return [min - delta, max + delta];
    }
    const span = max - min;
    return [min - span * pctLower, max + span * pctUpper];
}

function formatPct(v) {
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function serializeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function generateHTML(meta, candles, amaResults) {
    const { assetA = {}, assetB = {}, intervalSeconds, fetchedAt, pool } = meta || {};
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles supplied to LP ECharts renderer');
    }
    if (!Array.isArray(amaResults) || amaResults.length === 0) {
        throw new Error('No AMA results supplied to LP ECharts renderer');
    }

    const poolLabel = pool
        ? `Pool ${String(pool).replace('1.19.', '')}`
        : `${assetA.symbol || '?'} / ${assetB.symbol || '?'}`;
    const intervalLabel = toIntervalLabel(intervalSeconds);

    const dates = candles.map((c) => c[0]);
    const closes = candles.map((c) => Math.round(Number(c[4]) * 1e6) / 1e6);
    const volumes = candles.map((c) => Math.round(Number(c[5] ?? 0) * 1e4) / 1e4);

    const primary = amaResults[0];
    const primaryValues = Array.isArray(primary.values) ? primary.values : [];
    const primarySkip = Number.isFinite(primary.erPeriod) ? primary.erPeriod : 0;
    const validCloses = closes.slice(primarySkip);
    const validPrimary = primaryValues.slice(primarySkip);
    const maxDev = validCloses.length && validPrimary.length
        ? Math.max(...validCloses.map((p, i) => Math.abs((p - validPrimary[i]) / validPrimary[i]) * 100))
        : 0;

    const lastPrice = closes[closes.length - 1];
    const amaStats = amaResults.map((a) => {
        const values = Array.isArray(a.values) ? a.values : [];
        const lastVal = values[values.length - 1];
        const dev = Number.isFinite(lastVal) && lastVal !== 0
            ? ((lastPrice - lastVal) / lastVal) * 100
            : 0;
        return { name: a.name, color: a.color, lastVal, dev };
    });

    const amaMeta = amaResults.map((a) => ({
        name: a.name,
        color: a.color,
        dash: a.dash,
        lineWidth: a.lineWidth,
        erPeriod: a.erPeriod,
        fastPeriod: a.fastPeriod,
        slowPeriod: a.slowPeriod,
    }));

    const chartId = `lp-echarts-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(poolLabel)} LP Price · ${escapeHtml(intervalLabel)}</title>
    <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #0e1117;
            color: #e0e0e0;
            font-family: 'Segoe UI', sans-serif;
            overflow: hidden;
        }
        #header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            background: rgba(14,17,23,0.92);
            backdrop-filter: blur(4px);
            border-bottom: 1px solid #2a2e3e;
            padding: 10px 20px;
            display: flex;
            align-items: baseline;
            gap: 20px;
        }
        #header h1 {
            font-size: 18px;
            font-weight: 600;
            color: #fff;
        }
        #header .sub {
            font-size: 12px;
            color: #888;
        }
        #stats, #params {
            position: fixed;
            right: 12px;
            z-index: 100;
            background: rgba(20,24,32,0.88);
            backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e;
            border-radius: 6px;
            padding: 10px 14px;
            font-size: 12px;
            line-height: 1.8;
            min-width: 240px;
        }
        #stats { top: 90px; }
        #params { top: 310px; }
        #stats .label, #params .label { color: #888; }
        #stats .val, #params .val { color: #e0e0e0; font-weight: 600; }
        #stats .pos { color: #26a69a; }
        #stats .neg { color: #ef5350; }
        #params table { border-collapse: collapse; width: 100%; margin-top: 4px; }
        #params td { padding: 1px 6px 1px 0; font-size: 11px; color: #ccc; white-space: nowrap; }
        #params td:first-child { padding-left: 0; }
        #params th { font-size: 10px; color: #555; font-weight: 400; text-align: left; padding: 0 6px 3px 0; }
        #charts {
            padding-top: 44px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            gap: 0;
        }
        .chart {
            width: 100%;
        }
        #price-chart { flex: 3; }
        #dev-chart { flex: 1.15; }
        #vol-chart { flex: 0.75; }
    </style>
</head>
<body>

<div id="header">
    <h1><span style="color:#fb8c00">${escapeHtml(poolLabel)}</span> &nbsp; LP Swap Price</h1>
    <span class="sub">BitShares DEX · ${escapeHtml(intervalLabel)} buckets · ${amaResults.length} AMAs</span>
    <span class="sub" style="margin-left:auto">Fetched: ${fetchedAt ? escapeHtml(new Date(fetchedAt).toLocaleString()) : 'n/a'}</span>
</div>

<div id="stats">
    <div><span class="label">Last Price  </span><span class="val">${Number.isFinite(lastPrice) ? lastPrice.toFixed(6) : 'n/a'}</span></div>
    <div style="margin-top:4px; margin-bottom:2px"><span class="label" style="font-size:10px">── Deviations ──</span></div>
    ${amaStats.map((s) => `<div><span style="color:${s.color}">● </span><span class="label" style="font-size:11px">${escapeHtml(String(s.name || '').padEnd(22))}</span><span class="${s.dev >= 0 ? 'pos' : 'neg'}">${formatPct(s.dev)}</span></div>`).join('\n    ')}
    <div style="margin-top:6px"><span class="label">Max |dev|   </span><span class="val">${maxDev.toFixed(3)}% (primary)</span></div>
    <div><span class="label">Candles     </span><span class="val">${candles.length}</span></div>
    <div><span class="label">Source      </span><span class="label" style="font-size:10px">Kibana LP (op_type 63)</span></div>
</div>

<div id="params">
    <div style="margin-bottom:2px"><span class="label" style="font-size:10px">── AMA Parameters ──</span></div>
    <table id="params-table"></table>
</div>

<div id="charts">
    <div id="price-chart" class="chart"></div>
    <div id="dev-chart" class="chart"></div>
    <div id="vol-chart" class="chart"></div>
</div>

<script type="application/json" id="lp-payload">${serializeJsonForScript({
    dates,
    closes,
    volumes,
    amaMeta,
    amaArrays: amaResults.map((a) => (Array.isArray(a.values) ? a.values.map((v) => Math.round(Number(v) * 1e6) / 1e6) : [])),
})}</script>

<script>
const payload = JSON.parse(document.getElementById('lp-payload').textContent);
const dates = payload.dates;
const closes = payload.closes;
const volumes = payload.volumes;
const amaMeta = payload.amaMeta;
const amaArrays = payload.amaArrays;
const chartGroupId = ${JSON.stringify(chartId)};

(function renderParamsTable() {
    const tbl = document.getElementById('params-table');
    const hdr = tbl.insertRow();
    ['', 'ER', 'Fast', 'Slow'].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        hdr.appendChild(th);
    });
    amaMeta.forEach((a) => {
        const row = tbl.insertRow();
        const dot = document.createElement('td');
        dot.innerHTML = \`<span style="color:\${a.color}">●</span> \${a.name.split(' - ')[0]}\`;
        row.appendChild(dot);
        [a.erPeriod, a.fastPeriod, a.slowPeriod].forEach((v) => {
            const td = row.insertCell();
            td.textContent = v ?? '—';
        });
    });
})();

const THEME = {
    textColor: '#ccc',
    backgroundColor: '#0e1117',
    gridColor: '#1e2330',
    axisColor: '#2a2e3e',
    mutedColor: '#888',
};

const amaDevArrays = amaArrays.map((series) => series.map((v, idx) => {
    const p = closes[idx];
    return Number.isFinite(v) && v !== 0 ? Math.round(((p - v) / v) * 10000) / 100 : null;
}));

function commonXAxis() {
    return {
        type: 'time',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: { color: THEME.mutedColor, fontSize: 10 },
        splitLine: { show: false },
    };
}

function commonTooltip() {
    return {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        showContent: false,
        backgroundColor: 'rgba(20,24,32,0.96)',
        borderColor: THEME.axisColor,
        textStyle: { color: '#e0e0e0', fontSize: 11 },
        confine: true,
        valueFormatter: (v) => (v == null ? 'n/a' : String(v)),
    };
}

function commonDataZoom() {
    return [{
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        zoomOnMouseWheel: true,
        moveOnMouseWheel: true,
        moveOnMouseMove: true,
    }, {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'filter',
        height: 18,
        bottom: 0,
        start: 80,
        end: 100,
        handleSize: 10,
    }];
}

function initChart(domId, option) {
    const chart = echarts.init(document.getElementById(domId), null, { renderer: 'canvas', useDirtyRect: true });
    chart.group = chartGroupId;
    chart.setOption(option, { notMerge: true, lazyUpdate: true });
    return chart;
}

const priceChart = initChart('price-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    tooltip: commonTooltip(),
    legend: { show: false },
    grid: { left: 70, right: 260, top: 10, bottom: 10, containLabel: true },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: THEME.axisColor } },
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(),
    yAxis: {
        type: 'log',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: { color: THEME.mutedColor, fontSize: 10 },
        splitLine: { lineStyle: { color: THEME.gridColor } },
        min: 'dataMin',
        max: 'dataMax',
        name: '${escapeHtml(assetA.symbol || '?')}/${escapeHtml(assetB.symbol || '?')} (log scale)',
        nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] },
    },
    series: [
        {
            name: '${escapeHtml(assetA.symbol || '?')}/${escapeHtml(assetB.symbol || '?')} VWAP',
            type: 'line',
            data: dates.map((x, i) => [x, closes[i]]),
            showSymbol: false,
            sampling: 'lttb',
            progressive: 4000,
            progressiveThreshold: 8000,
            clip: true,
            lineStyle: { color: '#5c9ee6', width: 2.0, opacity: 0.92 },
            itemStyle: { color: '#5c9ee6' },
        },
        ...amaMeta.map((cfg, i) => ({
            name: cfg.name,
            type: 'line',
            data: dates.map((x, idx) => [x, amaArrays[i][idx]]),
            showSymbol: false,
            sampling: 'lttb',
            progressive: 4000,
            progressiveThreshold: 8000,
            clip: true,
            lineStyle: {
                color: cfg.color,
                width: 2.0,
                opacity: 0.92,
                type: 'solid',
            },
            itemStyle: { color: cfg.color },
            z: 10 + i,
        })),
    ],
    graphic: [{
        type: 'text',
        left: 12,
        top: 10,
        style: {
            text: 'Price + AMA',
            fill: THEME.mutedColor,
            fontSize: 11,
            fontFamily: 'Segoe UI, sans-serif',
        },
    }],
});

const devChart = initChart('dev-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    tooltip: commonTooltip(),
    legend: { show: false },
    grid: { left: 70, right: 260, top: 8, bottom: 24, containLabel: true },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: THEME.axisColor } },
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(),
    yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: { color: THEME.mutedColor, fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: THEME.gridColor } },
        min: 'dataMin',
        max: 'dataMax',
        name: 'Dev %',
        nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] },
        scale: true,
    },
    series: [
        ...amaMeta.map((cfg, i) => ({
            name: cfg.name,
            type: 'line',
            data: dates.map((x, idx) => [x, amaDevArrays[i][idx]]),
            showSymbol: false,
            sampling: 'lttb',
            progressive: 4000,
            progressiveThreshold: 8000,
            clip: true,
            lineStyle: {
                color: cfg.color,
                width: 1.6,
                opacity: 0.86,
                type: 'solid',
            },
            itemStyle: { color: cfg.color },
            z: 10 + i,
        })),
        {
            name: 'Zero',
            type: 'line',
            data: dates.length ? [[dates[0], 0], [dates[dates.length - 1], 0]] : [],
            showSymbol: false,
            sampling: 'lttb',
            progressive: 4000,
            progressiveThreshold: 8000,
            clip: true,
            lineStyle: { color: '#444', width: 1, type: 'dotted' },
            silent: true,
            emphasis: { disabled: true },
        },
    ],
    graphic: [{
        type: 'text',
        left: 12,
        top: 8,
        style: {
            text: 'Deviation %',
            fill: THEME.mutedColor,
            fontSize: 11,
            fontFamily: 'Segoe UI, sans-serif',
        },
    }],
});

const volChart = initChart('vol-chart', {
    backgroundColor: THEME.backgroundColor,
    animation: false,
    textStyle: { color: THEME.textColor },
    tooltip: commonTooltip(),
    legend: { show: false },
    grid: { left: 70, right: 260, top: 8, bottom: 10, containLabel: true },
    axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: THEME.axisColor } },
    dataZoom: commonDataZoom(),
    xAxis: commonXAxis(),
    yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: THEME.axisColor } },
        axisTick: { show: false },
        axisLabel: { color: THEME.mutedColor, fontSize: 10 },
        splitLine: { lineStyle: { color: THEME.gridColor } },
        min: 'dataMin',
        max: 'dataMax',
        name: 'Volume',
        nameTextStyle: { color: THEME.textColor, padding: [0, 0, 0, 8] },
        scale: true,
    },
    series: [{
        name: 'Volume (${escapeHtml(assetA.symbol || '?')})',
        type: 'bar',
        data: dates.map((x, i) => [x, volumes[i]]),
        barMaxWidth: 14,
        large: true,
        largeThreshold: 4000,
        progressive: 8000,
        progressiveThreshold: 8000,
        itemStyle: { color: 'rgba(92,158,230,1)' },
    }],
    graphic: [{
        type: 'text',
        left: 12,
        top: 8,
        style: {
            text: 'Volume',
            fill: THEME.mutedColor,
            fontSize: 11,
            fontFamily: 'Segoe UI, sans-serif',
        },
    }],
});

echarts.connect(chartGroupId);

function resizeAll() {
    priceChart.resize();
    devChart.resize();
    volChart.resize();
}

window.addEventListener('resize', resizeAll);
window.addEventListener('load', resizeAll);
</script>
</body>
</html>`;
}

module.exports = { generateHTML };
