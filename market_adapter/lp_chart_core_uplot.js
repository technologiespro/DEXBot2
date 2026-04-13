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

function serializeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function formatPct(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return 'n/a';
    return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function padRange(min, max, lower = 0.04, upper = 0.04) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
        const delta = Math.abs(min) * 0.03 || 1;
        return [min - delta, max + delta];
    }
    const span = max - min;
    return [min - span * lower, max + span * upper];
}

function dashToArray(dash) {
    if (Array.isArray(dash)) return dash;
    if (dash === 'dot') return [2, 4];
    if (dash === 'dash') return [10, 5];
    if (dash === 'longdash') return [14, 6];
    if (dash === 'longdashdot') return [16, 5, 4, 5];
    return null;
}

function generateHTML(meta, candles, amaResults) {
    const { assetA = {}, assetB = {}, intervalSeconds, fetchedAt, pool } = meta || {};
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles supplied to LP uPlot renderer');
    }
    if (!Array.isArray(amaResults) || amaResults.length === 0) {
        throw new Error('No AMA results supplied to LP uPlot renderer');
    }

    const poolLabel = pool
        ? `Pool ${String(pool).replace('1.19.', '')}`
        : `${assetA.symbol || '?'} / ${assetB.symbol || '?'}`;
    const intervalLabel = toIntervalLabel(intervalSeconds);

    const ts = candles.map((c) => Math.round(Number(c[0]) / 1000));
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

    const chartId = `lp-uplot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const amaMeta = amaResults.map((a) => ({
        name: a.name,
        color: a.color,
        dash: a.dash,
        lineWidth: a.lineWidth,
        erPeriod: a.erPeriod,
        fastPeriod: a.fastPeriod,
        slowPeriod: a.slowPeriod,
    }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(poolLabel)} LP Price · ${escapeHtml(intervalLabel)}</title>
    <link rel="stylesheet" href="https://unpkg.com/uplot@1.6.32/dist/uPlot.min.css">
    <script src="https://unpkg.com/uplot@1.6.32/dist/uPlot.iife.min.js"></script>
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
            position: fixed;
            top: 44px;
            left: 0;
            right: 276px;
            bottom: 0;
            padding-top: 0;
            display: flex;
            flex-direction: column;
            gap: 0;
            border-right: 1px solid #2a2e3e;
        }
        .chart {
            width: 100%;
            min-height: 120px;
            position: relative;
        }
        #price-chart { flex: 3.1; }
        #dev-chart { flex: 1.1; }
        #vol-chart { flex: 0.9; }
        .uplot {
            background: #0e1117;
        }
        .u-cursor-y {
            display: none !important;
        }
        .uplot.is-hovered .u-cursor-y {
            display: block !important;
        }
        .u-cursor-y {
            border-top: 1px dashed rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
        }
        .u-cursor-x {
            border-left: 1px dashed rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
        }
        .u-legend {
            display: none !important;
        }
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
    ts,
    closes,
    volumes,
    amaMeta,
    amaArrays: amaResults.map((a) => (Array.isArray(a.values) ? a.values.map((v) => Math.round(Number(v) * 1e6) / 1e6) : [])),
})}</script>

<script>
const payload = JSON.parse(document.getElementById('lp-payload').textContent);
const ts = payload.ts;
const closes = payload.closes;
const volumes = payload.volumes;
const amaMeta = payload.amaMeta;
const amaArrays = payload.amaArrays;
const chartGroupId = ${JSON.stringify(chartId)};

const THEME = {
    text: '#ccc',
    muted: '#888',
    background: '#0e1117',
    grid: '#1e2330',
    axis: '#2a2e3e',
};

function initChart(domId, opts, data) {
    if (typeof uPlot === 'undefined') {
        throw new Error('uPlot library did not load');
    }
    const el = document.getElementById(domId);
    const rect = el.getBoundingClientRect();
    const chart = new uPlot({
        ...opts,
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(120, Math.floor(rect.height)),
    }, data, el);
    chart.root.style.background = THEME.background;
    return chart;
}

function fmtDateTime(sec) {
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function fmtShortDate(sec) {
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
    });
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

function makeAxis(show, type) {
    return {
        show,
        scale: type,
        stroke: THEME.axis,
        grid: { show: false },
        ticks: { show: true, stroke: THEME.axis, width: 1 },
        size: show ? 34 : 0,
        space: 50,
        font: '10px Segoe UI, sans-serif',
        label: '',
        values: show ? (u, splits) => splits.map((v) => fmtShortDate(v)) : () => [],
    };
}

function makeYAxis(show, formatter, size = 58) {
    return {
        show,
        scale: 'y',
        stroke: THEME.axis,
        grid: { show: true, stroke: THEME.grid },
        ticks: { show: true, stroke: THEME.axis, width: 1 },
        size,
        space: 60,
        font: '10px Segoe UI, sans-serif',
        values: formatter,
    };
}

function makeCursor() {
    return {
        show: true,
        x: true,
        y: true,
        points: { show: false },
        drag: { x: false, y: false, setScale: false },
        sync: { key: chartGroupId, setSeries: false, scales: ['x', null] },
        focus: { prox: -1 },
    };
}

function makePlotBase(showX, yFormatter, yScale, yRange) {
    return {
        width: 0,
        height: 0,
        title: null,
        legend: { show: false },
        cursor: makeCursor(),
        select: { show: false },
        scales: {
            x: {
                time: true,
            },
            y: yScale,
        },
        axes: [
            makeAxis(showX, 'x'),
            makeYAxis(true, yFormatter),
        ],
        series: [
            { label: 'Time' },
        ],
        padding: [10, 16, 0, 0],
        hooks: {
            ready: [
                (u) => {
                    u.root.style.background = THEME.background;
                },
            ],
        },
    };
}

function lineSeries(name, color, width, dash, extra = {}) {
    return {
        label: name,
        stroke: color,
        width,
        dash: dashToArray(dash),
        points: { show: false },
        fill: null,
        ...extra,
    };
}

function applyChartHeights() {
    const available = Math.max(window.innerHeight - 44, 600);
    const priceH = Math.max(320, Math.floor(available * 0.60));
    const devH = Math.max(150, Math.floor(available * 0.22));
    const volH = Math.max(120, Math.max(available - priceH - devH, Math.floor(available * 0.18)));
    document.getElementById('price-chart').style.height = priceH + 'px';
    document.getElementById('dev-chart').style.height = devH + 'px';
    document.getElementById('vol-chart').style.height = volH + 'px';
}

function showFatal(message) {
    const charts = document.getElementById('charts');
    charts.innerHTML = '<div style="padding:20px;color:#ef5350;font-size:14px;white-space:pre-wrap;">' + String(message) + '</div>';
}

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

applyChartHeights();

const amaDevArrays = amaArrays.map((values, i) =>
    closes.map((p, idx) => {
        const v = values[idx];
        if (!Number.isFinite(v) || v === 0) return null;
        return Math.round(((p - v) / v) * 10000) / 100;
    })
);

const priceData = [ts, closes, ...amaArrays];
const devData = [ts, ...amaDevArrays];
const volData = [ts, volumes];

let priceChart;
let devChart;
let volChart;
let charts = [];

try {
priceChart = initChart('price-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => Number(v).toFixed(6)), {
        auto: true,
        log: 10,
        range: (u, min, max) => padRange(min, max, 0.02, 0.03) || [min, max],
    }),
    axes: [
        makeAxis(false, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => Number(v).toFixed(6)), 62),
    ],
    series: [
        { label: 'Time' },
        lineSeries('${escapeHtml(assetA.symbol || '?')}/${escapeHtml(assetB.symbol || '?')} VWAP', '#5c9ee6', 1.5),
        ...amaMeta.map((cfg) => lineSeries(cfg.name, cfg.color, cfg.lineWidth || 1.5, cfg.dash)),
    ],
}, priceData);

devChart = initChart('dev-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => Number(v).toFixed(2) + '%'), {
        auto: true,
        range: (u, min, max) => padRange(min, max, 0.08, 0.08) || [min, max],
    }),
    axes: [
        makeAxis(false, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => Number(v).toFixed(2) + '%'), 62),
    ],
    series: [
        { label: 'Time' },
        ...amaMeta.map((cfg) => lineSeries(cfg.name, cfg.color, 1.25, cfg.dash)),
    ],
}, devData);

volChart = initChart('vol-chart', {
    ...makePlotBase(true, (u, vals) => vals.map((v) => Number(v).toLocaleString()), {
        auto: true,
        range: (u, min, max) => padRange(min, max, 0.04, 0.04) || [min, max],
    }),
    axes: [
        makeAxis(true, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => Number(v).toLocaleString()), 62),
    ],
    series: [
        { label: 'Time' },
        {
            label: 'Volume (' + ${JSON.stringify(escapeHtml(assetA.symbol || '?'))} + ')',
            stroke: 'rgba(92,158,230,1)',
            fill: 'rgba(92,158,230,1)',
            width: 1,
            points: { show: false },
            paths: uPlot.paths.bars({ align: 0, gap: 1, size: [0.72, 14, 1] }),
        },
    ],
}, volData);
} catch (err) {
    console.error(err);
    showFatal(err && err.message ? err.message : String(err));
    throw err;
}

charts = [priceChart, devChart, volChart];
const [xMin, xMax] = [ts[0], ts[ts.length - 1]];
let pendingRange = null;
let pendingRangeRaf = 0;

function clampXRange(min, max) {
    let nextMin = min;
    let nextMax = max;
    const span = nextMax - nextMin;
    if (!Number.isFinite(span) || span <= 0) {
        return { min: xMin, max: xMax };
    }

    if (nextMin < xMin) {
        nextMax += xMin - nextMin;
        nextMin = xMin;
    }
    if (nextMax > xMax) {
        nextMin -= nextMax - xMax;
        nextMax = xMax;
    }
    if (nextMin < xMin) nextMin = xMin;
    if (nextMax > xMax) nextMax = xMax;
    if (nextMax <= nextMin) {
        return { min: xMin, max: xMax };
    }
    return { min: nextMin, max: nextMax };
}

function syncXRange(min, max) {
    pendingRange = clampXRange(min, max);
    if (pendingRangeRaf) return;

    const rafSync = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 0);

    pendingRangeRaf = rafSync(() => {
        const next = pendingRange;
        pendingRange = null;
        pendingRangeRaf = 0;
        if (!next) return;
        charts.forEach((chart) => {
            chart.batch(() => {
                chart.setScale('x', next);
            });
        });
    });
}

function bindWheelZoom(chart) {
    const onWheel = (e) => {
        if (!e) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = chart.root.getBoundingClientRect();
        const left = e.clientX - rect.left;
        const center = chart.posToVal(left, 'x');
        const xScale = chart.scales.x || {};
        const currMin = Number.isFinite(xScale.min) ? xScale.min : xMin;
        const currMax = Number.isFinite(xScale.max) ? xScale.max : xMax;
        const span = currMax - currMin;
        if (!Number.isFinite(span) || span <= 0) return;

        const factor = e.deltaY < 0 ? 0.85 : 1.15;
        const nextSpan = Math.max(1, Math.min(xMax - xMin, span * factor));
        const ratio = (center - currMin) / span;
        const nextMin = center - nextSpan * ratio;
        const nextMax = nextMin + nextSpan;

        syncXRange(nextMin, nextMax);
    };

    chart.root.addEventListener('wheel', onWheel, { passive: false });
}

function bindPan(chart) {
    let dragging = false;
    let startClientX = 0;
    let startMin = xMin;
    let startMax = xMax;

    const getCurrentScale = () => {
        const xScale = chart.scales.x || {};
        const currMin = Number.isFinite(xScale.min) ? xScale.min : xMin;
        const currMax = Number.isFinite(xScale.max) ? xScale.max : xMax;
        return { currMin, currMax };
    };

    const onMouseMove = (e) => {
        if (!dragging) return;
        e.preventDefault();

        const rect = chart.root.getBoundingClientRect();
        const currentLeft = e.clientX - rect.left;
        const startLeft = startClientX - rect.left;
        const startVal = chart.posToVal(startLeft, 'x');
        const currentVal = chart.posToVal(currentLeft, 'x');
        const delta = currentVal - startVal;

        syncXRange(startMin - delta, startMax - delta);
    };

    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', endDrag);
    };

    const onMouseDown = (e) => {
        if (!e || e.button !== 0) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const rect = chart.root.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (!inside) return;

        e.preventDefault();
        e.stopPropagation();

        dragging = true;
        startClientX = e.clientX;
        const current = getCurrentScale();
        startMin = current.currMin;
        startMax = current.currMax;
        document.body.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', endDrag, { once: true });
    };

    chart.root.addEventListener('mousedown', onMouseDown);
    chart.root.addEventListener('mouseleave', () => {
        if (!dragging) return;
        document.body.style.cursor = 'grabbing';
    });
}

function bindHoverState(chart) {
    const root = chart.root;
    root.addEventListener('mouseenter', () => {
        root.classList.add('is-hovered');
    });
    root.addEventListener('mouseleave', () => {
        root.classList.remove('is-hovered');
    });
}

function resetZoom() {
    pendingRange = null;
    syncXRange(xMin, xMax);
}

function sizeCharts() {
    applyChartHeights();
    for (const chart of charts) {
        const rect = chart.root.parentElement.getBoundingClientRect();
        const width = Math.max(320, Math.floor(rect.width));
        const height = Math.max(120, Math.floor(rect.height));
        chart.setSize({ width, height });
    }
}

window.addEventListener('resize', sizeCharts);
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === '0') {
        resetZoom();
    }
});

charts.forEach((chart) => {
    bindWheelZoom(chart);
    bindPan(chart);
});
bindHoverState(priceChart);
bindHoverState(devChart);
bindHoverState(volChart);

const raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);

raf(() => {
    sizeCharts();
});
</script>
</body>
</html>`;
}

module.exports = { generateHTML };
