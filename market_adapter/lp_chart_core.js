/**
 * LP CHART CORE — Shared chart generation
 *
 * Exports generateHTML(meta, candles, amaResults) used by:
 *   market_adapter/chart_lp_prices.js
 *   analysis/ama_fitting/generate_unified_comparison_chart.js
 *
 * meta:
 *   { pool, assetA: { symbol }, assetB: { symbol }, intervalSeconds, fetchedAt }
 *
 * candles:
 *   Array of [timestamp_ms, open, high, low, close, volume]
 *
 * amaResults:
 *   Array of { name, color, dash, lineWidth, erPeriod, values: number[] }
 *   First element = primary AMA (used for ±MaxDev band and stats maxDev).
 */

'use strict';

const { toIntervalLabel } = require('./candle_utils');

function generateHTML(meta, candles, amaResults) {
    const { assetA, assetB, intervalSeconds, fetchedAt, pool } = meta;
    const poolLabel = pool ? `Pool ${String(pool).replace('1.19.', '')}` : `${assetA.symbol}/${assetB.symbol}`;
    const intervalLabel = toIntervalLabel(intervalSeconds);

    const dates   = candles.map(c => c[0]);                                          // integer ms timestamps (shorter JSON than ISO strings)
    const closes  = candles.map(c => Math.round(c[4] * 1e6) / 1e6);               // 6 dp
    const volumes = candles.map(c => Math.round((c[5] ?? 0) * 1e4) / 1e4);        // 4 dp

    // Primary AMA (index 0) — used for band and maxDev stat
    const primary       = amaResults[0];
    const primaryValues = primary.values;

    // maxDev from primary AMA (skip warm-up period)
    const validCloses  = closes.slice(primary.erPeriod);
    const validPrimary = primaryValues.slice(primary.erPeriod);
    const maxDev = Math.max(...validCloses.map((p, i) =>
        Math.abs((p - validPrimary[i]) / validPrimary[i]) * 100
    ));

    const lastPrice = closes[closes.length - 1];

    // Per-AMA last deviation for stats box
    const amaStats = amaResults.map(a => {
        const lastVal = a.values[a.values.length - 1];
        const dev = ((lastPrice - lastVal) / lastVal) * 100;
        return { name: a.name, color: a.color, lastVal, dev };
    });

    // Per-AMA deviation arrays (for deviation chart) — rounded to 2 dp
    const amaDeviations = amaResults.map(a =>
        closes.map((p, i) => Math.round(((p - a.values[i]) / a.values[i]) * 10000) / 100)
    );

    // Serialise AMA config metadata for the browser (no values — passed separately)
    const amaMeta = amaResults.map(a => ({ name: a.name, color: a.color, dash: a.dash, lineWidth: a.lineWidth }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${poolLabel} LP Price · ${intervalLabel}</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0e1117; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }

        #header {
            position: fixed; top: 0; left: 0; right: 0; z-index: 100;
            background: rgba(14,17,23,0.92); backdrop-filter: blur(4px);
            border-bottom: 1px solid #2a2e3e;
            padding: 10px 20px;
            display: flex; align-items: baseline; gap: 20px;
        }
        #header h1 { font-size: 18px; font-weight: 600; color: #fff; }
        #header .sub { font-size: 12px; color: #888; }

        #stats {
            position: fixed; top: 90px; right: 12px; z-index: 100;
            background: rgba(20,24,32,0.88); backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e; border-radius: 6px;
            padding: 10px 14px; font-size: 12px; line-height: 1.8;
            min-width: 240px;
        }
        #stats .label { color: #888; }
        #stats .val   { color: #e0e0e0; font-weight: 600; }
        #stats .pos   { color: #26a69a; }
        #stats .neg   { color: #ef5350; }

        #charts { padding-top: 44px; display: flex; flex-direction: column; height: 100vh; }
        #price-chart  { flex: 3; }
        #vol-chart    { flex: 1; }
        #dev-chart    { flex: 1; }
    </style>
</head>
<body>

<div id="header">
    <h1><span style="color:#fb8c00">${poolLabel}</span> &nbsp; LP Swap Price</h1>
    <span class="sub">BitShares DEX · ${intervalLabel} buckets · 4 AMAs</span>
    <span class="sub" style="margin-left:auto">Fetched: ${new Date(fetchedAt).toLocaleString()}</span>
</div>

<div id="stats">
    <div><span class="label">Last Price  </span><span class="val">${lastPrice.toFixed(6)}</span></div>
    <div style="margin-top:4px; margin-bottom:2px"><span class="label" style="font-size:10px">── Deviations ──</span></div>
    ${amaStats.map(s => `<div><span style="color:${s.color}">● </span><span class="label" style="font-size:11px">${s.name.padEnd(22)}</span><span class="${s.dev >= 0 ? 'pos' : 'neg'}">${s.dev >= 0 ? '+' : ''}${s.dev.toFixed(2)}%</span></div>`).join('\n    ')}
    <div style="margin-top:6px"><span class="label">Max |dev|   </span><span class="val">${maxDev.toFixed(3)}% (primary)</span></div>
    <div><span class="label">Candles     </span><span class="val">${candles.length}</span></div>
    <div><span class="label">Source      </span><span class="label" style="font-size:10px">Kibana LP (op_type 63)</span></div>
</div>

<div id="charts">
    <div id="price-chart"></div>
    <div id="vol-chart"></div>
    <div id="dev-chart"></div>
</div>

<script>
const dates        = ${JSON.stringify(dates)};
const closes       = ${JSON.stringify(closes)};
const volumes      = ${JSON.stringify(volumes)};
const amaMeta      = ${JSON.stringify(amaMeta)};
const amaArrays    = ${JSON.stringify(amaResults.map(a => a.values.map(v => Math.round(v * 1e6) / 1e6)))};
const amaDevArrays = ${JSON.stringify(amaDeviations)};

const DARK = {
    plot_bgcolor:  '#0e1117',
    paper_bgcolor: '#0e1117',
    font:          { color: '#ccc', size: 11 },
};

const AXIS = {
    gridcolor:     '#1e2330',
    linecolor:     '#2a2e3e',
    zerolinecolor: '#2a2e3e',
    tickfont:      { size: 10 },
};

// ── Price + AMA chart ──────────────────────────────────────────────────────
const tracePrice = {
    x: dates, y: closes,
    type: 'scattergl', mode: 'lines',
    line: { color: '#5c9ee6', width: 1.5 },
    name: '${assetA.symbol}/${assetB.symbol} VWAP',
    hovertemplate: '<b>%{x|%Y-%m-%d %H:%M}</b><br>Price: %{y:.6f}<extra></extra>',
};

const amaTraces = amaMeta.map((cfg, i) => ({
    x: dates, y: amaArrays[i],
    type: 'scattergl', mode: 'lines',
    line: { color: cfg.color, width: cfg.lineWidth, dash: cfg.dash },
    name: cfg.name,
    hovertemplate: cfg.name + ': %{y:.6f}<extra></extra>',
}));

// Band: ±maxDev shaded region based on primary AMA (visual reference only)
// Downsampled to ~300 pts — band is a smooth curve so full resolution is unnecessary
const maxDev = ${maxDev.toFixed(6)};
const primaryAMA = amaArrays[0];
const BAND_STEP = Math.max(1, Math.floor(dates.length / 300));
const bandDates = dates.filter((_, i) => i % BAND_STEP === 0 || i === dates.length - 1);
const bandUpper = primaryAMA.filter((_, i) => i % BAND_STEP === 0 || i === primaryAMA.length - 1).map(v => v * (1 + maxDev / 100));
const bandLower = primaryAMA.filter((_, i) => i % BAND_STEP === 0 || i === primaryAMA.length - 1).map(v => v * (1 - maxDev / 100));

const traceUpper = {
    x: bandDates, y: bandUpper,
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(66,165,245,0.25)', width: 1, dash: 'dot' },
    name: '+MaxDev band', showlegend: false,
    hoverinfo: 'skip',
};

const traceLower = {
    x: bandDates, y: bandLower,
    fill: 'tonexty',
    fillcolor: 'rgba(66,165,245,0.04)',
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(66,165,245,0.25)', width: 1, dash: 'dot' },
    name: '±MaxDev band', showlegend: true,
    hoverinfo: 'skip',
};

Plotly.newPlot('price-chart',
    [traceUpper, traceLower, tracePrice, ...amaTraces],
    {
        ...DARK,
        margin: { l: 70, r: 260, t: 10, b: 10 },
        showlegend: false,
        xaxis: { ...AXIS, type: 'date', showticklabels: false, rangeslider: { visible: false } },
        yaxis: { ...AXIS, title: { text: '${assetA.symbol}/${assetB.symbol} (log scale)', standoff: 8 }, type: 'log' },
    },
    { responsive: true, displayModeBar: true }   // toolbar shown here only
);

// ── Volume chart ───────────────────────────────────────────────────────────
const traceVol = {
    x: dates, y: volumes,
    type: 'bar',
    marker: { color: 'rgba(92,158,230,0.5)', line: { width: 0 } },
    name: 'Volume (${assetA.symbol})',
    hovertemplate: 'Vol: %{y:.4f}<extra></extra>',
};

Plotly.newPlot('vol-chart',
    [traceVol],
    {
        ...DARK,
        margin: { l: 70, r: 260, t: 4, b: 10 },
        showlegend: false,
        xaxis: { ...AXIS, type: 'date', showticklabels: false },
        yaxis: { ...AXIS, title: { text: 'Volume', standoff: 8 } },
    },
    { responsive: true, displayModeBar: false }
);

// ── Deviation chart ────────────────────────────────────────────────────────
const devTraces = amaMeta.map((cfg, i) => ({
    x: dates, y: amaDevArrays[i],
    type: 'scattergl', mode: 'lines',
    line: { color: cfg.color, width: 1.2, dash: cfg.dash },
    name: cfg.name,
    hovertemplate: cfg.name + ' dev: %{y:.2f}%<extra></extra>',
    showlegend: false,
}));

const traceZero = {
    x: [dates[0], dates[dates.length - 1]], y: [0, 0],
    type: 'scatter', mode: 'lines',
    line: { color: '#444', width: 1, dash: 'dot' },
    name: 'Zero', showlegend: false, hoverinfo: 'skip',
};

Plotly.newPlot('dev-chart',
    [...devTraces, traceZero],
    {
        ...DARK,
        margin: { l: 70, r: 260, t: 4, b: 30 },
        showlegend: false,
        xaxis: { ...AXIS, type: 'date' },
        yaxis: { ...AXIS, title: { text: 'Dev %', standoff: 8 }, ticksuffix: '%',
                 zeroline: true, zerolinecolor: '#444', zerolinewidth: 1 },
    },
    { responsive: true, displayModeBar: false }
);

// ── Link x-axes for synchronized zoom/pan ──────────────────────────────────
// isSyncing guard prevents cascade: A→relayout(B,C)→relayout(A,C)→...
let isSyncing = false;
function syncAxes(sourceDiv, targetDivs) {
    let rafId = null;
    sourceDiv.on('plotly_relayout', (e) => {
        if (isSyncing) return;
        const update = e['xaxis.range[0]'] !== undefined
            ? { 'xaxis.range[0]': e['xaxis.range[0]'], 'xaxis.range[1]': e['xaxis.range[1]'] }
            : e['xaxis.autorange'] ? { 'xaxis.autorange': true } : null;
        if (!update) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            isSyncing = true;
            Promise.all(targetDivs.map(d => Plotly.relayout(d, update)))
                .finally(() => { isSyncing = false; rafId = null; });
        });
    });
}

const pc = document.getElementById('price-chart');
const vc = document.getElementById('vol-chart');
const dc = document.getElementById('dev-chart');
syncAxes(pc, [vc, dc]);
syncAxes(vc, [pc, dc]);
syncAxes(dc, [pc, vc]);
</script>
</body>
</html>`;
}

module.exports = { generateHTML };
