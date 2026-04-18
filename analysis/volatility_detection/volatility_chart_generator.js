'use strict';

const { MARKET_ADAPTER } = require('../../modules/constants');

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[m]));
}

function serializeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function toEpochSeconds(ts, fallbackIdx) {
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    return fallbackIdx * 3600;
}

function generateHTML(data, title = 'ATR Volatility Research') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const volatilityCfg = data.volatilityConfig || {};
    const defaultThreshold = data.volatilityThreshold ?? volatilityCfg.volatilityThreshold
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_THRESHOLD;
    const defaultExponent = data.volatilityExponent ?? volatilityCfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const defaultScalePct = data.volatilityScalePct ?? volatilityCfg.volatilityScalePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_PCT;
    const defaultClamp = data.volatilityClamp ?? volatilityCfg.volatilityClamp ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;
    const defaultMinWeight = data.minWeight ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
    const defaultMaxWeight = data.maxWeight ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
    const interval = results.length > 1
        ? (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000
        : 3600;

    const dates = results.map((r, i) => toEpochSeconds(r.timestamp || Date.now(), i));
    const prices = results.map((r) => r.price);
    const ama3Prices = results.map((r) => r.ama3Price ?? null);
    const varianceSeries = results.map((r) => r.weightVariance ?? null);

    const realBarCount = results.length;
    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 120; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        ama3Prices.push(null);
        varianceSeries.push(null);
    }

    const payload = {
        dates,
        prices,
        ama3Prices,
        varianceSeries,
        realBarCount,
        volatilityThreshold: defaultThreshold,
        volatilityExponent: defaultExponent,
        volatilityScalePct: defaultScalePct,
        volatilityClamp: defaultClamp,
        minWeight: defaultMinWeight,
        maxWeight: defaultMaxWeight,
        marketAdapter: MARKET_ADAPTER,
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="https://unpkg.com/uplot@1.6.32/dist/uPlot.min.css">
    <script src="https://unpkg.com/uplot@1.6.32/dist/uPlot.iife.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        body { background: #0b0e14; color: #d1d5db; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow: hidden; }
        #header { padding: 10px 18px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 48px; }
        #header-left { font-weight: bold; color: #fff; }
        #hint { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap; }
        #panels { display: flex; flex-direction: column; height: calc(100vh - 48px); width: 100vw; }
        #price-panel { flex: 0 0 35%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #variance-panel { flex: 0 0 27%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #variance-panel .legend { top: 10px; }
        #variance-chart { margin-top: 0; height: 100%; }
        #shift-panel { flex: 0 0 38%; min-height: 0; position: relative; }
        #shift-panel .legend { top: 18px; }
        #shift-chart { margin-top: 0; height: calc(100% - 30px); }
        .uplot { background: #0b0e14; }
        .legend { position: absolute; top: 8px; left: 12px; right: 12px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 12px; color: #adbac7; white-space: nowrap; align-items: center; flex-wrap: wrap; }
        .legend-item { display: flex; align-items: center; gap: 5px; }
        .legend-val { font-family: monospace; font-weight: bold; }
        .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top: 1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }
        .section-label { position: absolute; top: 8px; right: 12px; font-size: 9px; color: #30363d; text-transform: uppercase; letter-spacing: 1px; z-index: 10; pointer-events: none; }
        .ctrl { pointer-events: auto; display: inline-flex; align-items: center; gap: 3px; margin-left: 4px; }
        .ctrl label { color: #8b949e; font-size: 10px; min-width: 34px; text-align: right; }
        .ctrl input[type="range"] { width: 161px; height: 3px; }
        .ctrl .val { font-weight: bold; font-size: 10px; min-width: 44px; display: inline-block; text-align: right; }
        .ctrl.thr label { min-width: 26px; }
        .ctrl.exp label { min-width: 24px; }
        .ctrl.scale label { min-width: 38px; }
        .ctrl.clamp label { min-width: 36px; }
        .ctrl.thr input[type="range"] { accent-color: #8b949e; }
        .ctrl.thr .val { color: #8b949e; }
        .ctrl.exp input[type="range"] { accent-color: #58a6ff; }
        .ctrl.exp .val { color: #58a6ff; }
        .ctrl.scale input[type="range"] { accent-color: #f0883e; }
        .ctrl.scale .val { color: #f0883e; }
        .ctrl.clamp input[type="range"] { accent-color: #a371f7; }
        .ctrl.clamp .val { color: #a371f7; }
        .group-sep { border-left: 1px solid #30363d; margin-left: 4px; padding-left: 4px; display: inline-flex; align-items: center; height: 18px; }
    </style>
</head>
<body>
    <div id="header">
        <div id="header-left">${escapeHtml(title)}</div>
        <div id="hint">Log price only · weight variance · symmetric shift · wheel zoom · drag pan · Ctrl+0 reset</div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" class="legend-val" style="color:#58a6ff;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>AMA3: <span id="l-ama3" class="legend-val" style="color:#e3b341;">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="variance-panel">
            <div class="section-label">WEIGHT VARIANCE</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Weight variance: <span id="l-var" class="legend-val" style="color:#d2a8ff;">-</span></div>
            </div>
            <div id="variance-chart"></div>
        </div>
        <div id="shift-panel">
            <div class="section-label">SYMMETRIC SHIFT</div>
            <div class="legend" style="gap: 10px;">
                <div class="legend-item"><div class="dot" style="background:#8b949e;"></div>Raw Δ: <span id="l-raw-delta" class="legend-val" style="color:#8b949e;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#f85149;"></div>Δ: <span id="l-delta" class="legend-val" style="color:#f85149;">-</span></div>
                <div class="legend-item">Weff: <span id="l-weff" class="legend-val" style="color:#3fb950;">-</span></div>
                <div class="legend-item">S: <span id="l-sell" class="legend-val" style="color:#58a6ff;">-</span></div>
                <div class="legend-item">B: <span id="l-buy" class="legend-val" style="color:#58a6ff;">-</span></div>
                <div class="group-sep"></div>
                <div class="ctrl thr"><label for="threshold-slider">thr</label><input type="range" id="threshold-slider" min="0" max="500" step="1" value="${Math.round(defaultThreshold * 1000)}"><span class="val" id="threshold-value">${defaultThreshold.toFixed(3)}</span></div>
                <div class="ctrl clamp"><label for="clamp-slider">clamp</label><input type="range" id="clamp-slider" min="0" max="500" step="1" value="${Math.round(defaultClamp * 1000)}"><span class="val" id="clamp-value">${defaultClamp.toFixed(3)}</span></div>
                <div class="ctrl exp"><label for="exponent-slider">exp</label><input type="range" id="exponent-slider" min="0" max="1000" step="1" value="0"><span class="val" id="exponent-value">${defaultExponent.toFixed(2)}</span></div>
                <div class="ctrl scale"><label for="scale-slider">scale%</label><input type="range" id="scale-slider" min="0" max="1000" step="1" value="0"><span class="val" id="scale-value">${defaultScalePct.toFixed(1)}%</span></div>
            </div>
            <div id="shift-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>
    <script>
    (function () {
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = 'volatility-det-v1';
        const Y_AXIS_SIZE = 58;
        const MARKET_ADAPTER = data.marketAdapter || {};
        const MIN_WEIGHT = data.minWeight ?? ${JSON.stringify(defaultMinWeight)};
        const MAX_WEIGHT = data.maxWeight ?? ${JSON.stringify(defaultMaxWeight)};
        const BASELINE_WEIGHT = 0.5;
        const EXP_LOG_MIN = Math.log(0.2);
        const EXP_LOG_MAX = Math.log(5.0);
        const SCALE_LOG_MIN = Math.log(10.0);
        const SCALE_LOG_MAX = Math.log(10000.0);

        let currentThreshold = data.volatilityThreshold;
        let currentExponent = data.volatilityExponent;
        let currentScalePct = data.volatilityScalePct;
        let currentClamp = data.volatilityClamp ?? ${JSON.stringify(defaultClamp)};

        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let priceChart, varianceChart, shiftChart;

        function clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        }

        function fmtNum(v, digits = 4) {
            if (v == null || !Number.isFinite(v)) return '-';
            const abs = Math.abs(v);
            if (abs >= 1000) return v.toFixed(2);
            if (abs >= 1) return v.toFixed(Math.min(4, digits));
            return v.toPrecision(Math.min(6, digits + 2));
        }

        function fmtSigned(v, digits = 3) {
            if (v == null || !Number.isFinite(v)) return '-';
            const s = v >= 0 ? '+' : '';
            return s + v.toFixed(digits);
        }

        function fmtDate(ts) {
            if (ts == null) return '-';
            const d = new Date(ts * 1000);
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                 + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        }

        function expSliderToVal(pos) {
            return Math.exp(EXP_LOG_MIN + (pos / 1000) * (EXP_LOG_MAX - EXP_LOG_MIN));
        }

        function expValToSlider(val) {
            const clamped = Math.max(Math.exp(EXP_LOG_MIN), Math.min(Math.exp(EXP_LOG_MAX), val));
            return Math.round((Math.log(clamped) - EXP_LOG_MIN) / (EXP_LOG_MAX - EXP_LOG_MIN) * 1000);
        }

        function scaleSliderToVal(pos) {
            return Math.exp(SCALE_LOG_MIN + (pos / 1000) * (SCALE_LOG_MAX - SCALE_LOG_MIN));
        }

        function scaleValToSlider(val) {
            const clamped = Math.max(Math.exp(SCALE_LOG_MIN), Math.min(Math.exp(SCALE_LOG_MAX), val));
            return Math.round((Math.log(clamped) - SCALE_LOG_MIN) / (SCALE_LOG_MAX - SCALE_LOG_MIN) * 1000);
        }

        function clampValToSlider(val) {
            const clamped = Math.max(0, Math.min(0.5, val));
            return Math.round(clamped * 1000);
        }

        function clampSliderToVal(pos) {
            return Math.max(0, Math.min(0.5, pos / 1000));
        }

        function toPlotLog(values) {
            return values.map((v) => (v != null && v > 0 ? v : null));
        }

        const variancePlot = toPlotLog(data.varianceSeries);

        let rawDeltaArr = new Array(data.dates.length).fill(null);
        let deltaArr = new Array(data.dates.length).fill(null);
        let weffArr = new Array(data.dates.length).fill(null);
        let sellArr = new Array(data.dates.length).fill(null);
        let buyArr = new Array(data.dates.length).fill(null);

        function calcShift(weightVariance) {
            const safeVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
            const effectiveExponent = Math.max(currentExponent, Math.exp(EXP_LOG_MIN));
            const effectiveScalePct = Math.max(currentScalePct, Math.exp(SCALE_LOG_MIN));
            const effectiveClamp = Number.isFinite(currentClamp) && currentClamp >= 0 ? currentClamp : ${JSON.stringify(defaultClamp)};
            const raw = -Math.pow(safeVariance, effectiveExponent) * (effectiveScalePct / 100);
            const clampedRaw = clamp(raw, -effectiveClamp, 0);
            const delta = Math.abs(clampedRaw) < currentThreshold ? 0 : clampedRaw;
            const weff = clamp(BASELINE_WEIGHT + delta, MIN_WEIGHT, MAX_WEIGHT);
            return { raw: clampedRaw, delta, weff, sellW: weff, buyW: weff };
        }

        function recalcShift() {
            for (let i = 0; i < data.dates.length; i++) {
                if (i >= data.realBarCount) {
                    rawDeltaArr[i] = null;
                    deltaArr[i] = null;
                    weffArr[i] = null;
                    sellArr[i] = null;
                    buyArr[i] = null;
                    continue;
                }
                const r = calcShift(data.varianceSeries[i]);
                rawDeltaArr[i] = r.raw;
                deltaArr[i] = r.delta;
                weffArr[i] = r.weff;
                sellArr[i] = r.sellW;
                buyArr[i] = r.buyW;
            }
        }

        function clampXRange(min, max) {
            let lo = min, hi = max;
            const span = hi - lo;
            if (!Number.isFinite(span) || span <= 0) return { min: xMin, max: xMax };
            if (lo < xMin) { hi += xMin - lo; lo = xMin; }
            if (hi > xMax) { lo -= hi - xMax; hi = xMax; }
            if (lo < xMin) lo = xMin;
            if (hi > xMax) hi = xMax;
            if (hi <= lo) return { min: xMin, max: xMax };
            return { min: lo, max: hi };
        }

        function rangeFrom(values, fallbackMin, fallbackMax, padFrac = 0.12) {
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (v == null || !Number.isFinite(v)) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max)) return [fallbackMin, fallbackMax];
            if (min === max) {
                const pad = Math.max(Math.abs(min) * padFrac, 0.02);
                return [min - pad, max + pad];
            }
            const span = max - min;
            const pad = span * padFrac;
            return [min - pad, max + pad];
        }

        function buildRawDeltaSplits(u) {
            const scale = u.scales.d || {};
            const r = rangeFrom(rawDeltaArr, -0.5, 0.04);
            const min = Number.isFinite(scale.min) ? scale.min : r[0];
            const max = Number.isFinite(scale.max) ? scale.max : r[1];
            const lo = Math.min(min, max);
            const hi = Math.max(min, max);
            const step = 0.05;
            const start = Math.floor(lo / step) * step;
            const end = Math.ceil(hi / step) * step;
            const splits = [];
            for (let v = start; v <= end + 1e-9; v += step) {
                const rounded = Math.round(v * 100) / 100;
                if (!splits.includes(rounded)) splits.push(rounded);
            }
            if (!splits.includes(0)) splits.push(0);
            if (!splits.includes(-currentThreshold)) splits.push(-currentThreshold);
            return splits.sort((a, b) => a - b);
        }

        function syncXRange(min, max) {
            pendingRange = clampXRange(min, max);
            if (pendingRangeRaf) return;
            pendingRangeRaf = requestAnimationFrame(() => {
                const next = pendingRange;
                pendingRange = null;
                pendingRangeRaf = 0;
                if (!next) return;
                [priceChart, varianceChart, shiftChart].forEach(c => c && c.batch(() => c.setScale('x', next)));
            });
        }

        function bindWheelZoom(chart) {
            chart.root.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                e.stopPropagation();
                const rect = chart.root.getBoundingClientRect();
                const center = chart.posToVal(e.clientX - rect.left, 'x');
                const s = chart.scales.x || {};
                const currMin = Number.isFinite(s.min) ? s.min : xMin;
                const currMax = Number.isFinite(s.max) ? s.max : xMax;
                const span = currMax - currMin;
                if (!Number.isFinite(span) || span <= 0) return;
                const factor = e.deltaY < 0 ? 0.85 : 1.15;
                const nextSpan = Math.max(1, Math.min(xMax - xMin, span * factor));
                const ratio = (center - currMin) / span;
                syncXRange(center - nextSpan * ratio, center - nextSpan * ratio + nextSpan);
            }, { passive: false });
        }

        function bindPan(chart) {
            let dragging = false;
            let startClientX = 0;
            let startMin = xMin;
            let startMax = xMax;

            const onMove = (e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                const delta = chart.posToVal(e.clientX - rect.left, 'x') - chart.posToVal(startClientX - rect.left, 'x');
                syncXRange(startMin - delta, startMax - delta);
            };

            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };

            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientX = e.clientX;
                const s = chart.scales.x || {};
                startMin = Number.isFinite(s.min) ? s.min : xMin;
                startMax = Number.isFinite(s.max) ? s.max : xMax;
                document.body.style.cursor = 'grabbing';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });

            chart.root.addEventListener('mouseleave', () => {
                if (dragging) document.body.style.cursor = 'grabbing';
            });
        }

        function makeDeltaHook(values, scaleKey, thresholdGetter) {
            return (u) => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath();
                ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
                ctx.clip();

                const zeroY = u.valToPos(0, scaleKey, true);
                const thresholdY = u.valToPos(-thresholdGetter(), scaleKey, true);

                ctx.strokeStyle = '#ffd24a';
                ctx.shadowColor = 'rgba(255,210,74,0.85)';
                ctx.shadowBlur = 6;
                ctx.lineWidth = 2.5;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, thresholdY);
                ctx.lineTo(bbox.left + bbox.width, thresholdY);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
                ctx.font = 'bold 10px Segoe UI, sans-serif';
                ctx.textBaseline = 'middle';
                const label = 'threshold';
                const labelX = Math.max(bbox.left + 4, bbox.left + bbox.width - 60);
                const labelY = thresholdY - 8;
                const labelW = ctx.measureText(label).width + 8;
                ctx.fillStyle = 'rgba(11,14,20,0.82)';
                ctx.fillRect(labelX - 4, labelY - 7, labelW, 14);
                ctx.fillStyle = '#ffd24a';
                ctx.fillText(label, labelX, labelY);

                const clampY = u.valToPos(-currentClamp, scaleKey, true);
                ctx.strokeStyle = '#a371f7';
                ctx.shadowColor = 'rgba(163,113,247,0.85)';
                ctx.shadowBlur = 6;
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, clampY);
                ctx.lineTo(bbox.left + bbox.width, clampY);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
                ctx.font = 'bold 10px Segoe UI, sans-serif';
                ctx.textBaseline = 'middle';
                const clampLabel = 'clamp';
                const clampLabelX = Math.max(bbox.left + 4, bbox.left + bbox.width - 52);
                const clampLabelY = clampY - 8;
                const clampLabelW = ctx.measureText(clampLabel).width + 8;
                ctx.fillStyle = 'rgba(11,14,20,0.82)';
                ctx.fillRect(clampLabelX - 4, clampLabelY - 7, clampLabelW, 14);
                ctx.fillStyle = '#a371f7';
                ctx.fillText(clampLabel, clampLabelX, clampLabelY);

                ctx.strokeStyle = 'rgba(139,148,158,0.4)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, zeroY);
                ctx.lineTo(bbox.left + bbox.width, zeroY);
                ctx.stroke();
                ctx.setLineDash([]);

                const path = new Path2D();
                let started = false;
                let lastX = 0;
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (v == null) { if (started) { path.lineTo(lastX, zeroY); started = false; } continue; }
                    const x = u.valToPos(data.dates[i], 'x', true);
                    const y = u.valToPos(v, scaleKey, true);
                    if (!started) {
                        path.moveTo(x, zeroY);
                        path.lineTo(x, y);
                        started = true;
                    } else {
                        path.lineTo(x, y);
                    }
                    lastX = x;
                }
                if (started) path.lineTo(lastX, zeroY);

                ctx.save();
                ctx.beginPath();
                ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY);
                ctx.clip();
                ctx.fillStyle = 'rgba(248,81,73,0.16)';
                ctx.fill(path);
                ctx.restore();

                ctx.strokeStyle = 'rgba(248,81,73,0.9)';
                ctx.lineWidth = 1.7;
                ctx.stroke(path);
                ctx.restore();
            };
        }

        const cursorCfg = {
            show: true,
            x: true,
            y: true,
            points: { show: false },
            drag: { x: false, y: false, setScale: false },
            sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] },
            focus: { prox: -1 },
        };

        function updateLegend(idx) {
            if (idx == null || idx >= data.realBarCount) return;
            document.getElementById('l-price').textContent = fmtNum(data.prices[idx], 6);
            document.getElementById('l-ama3').textContent = fmtNum(data.ama3Prices[idx], 6);
            const variance = data.varianceSeries[idx];
            document.getElementById('l-var').textContent = variance == null ? '-' : fmtNum(variance, 6) + ' (' + fmtNum(variance * 100, 4) + '%)';
            document.getElementById('l-raw-delta').textContent = fmtSigned(rawDeltaArr[idx], 3);
            document.getElementById('l-delta').textContent = fmtSigned(deltaArr[idx], 3);
            document.getElementById('l-weff').textContent = fmtNum(weffArr[idx], 3);
            document.getElementById('l-sell').textContent = fmtNum(sellArr[idx], 3);
            document.getElementById('l-buy').textContent = fmtNum(buyArr[idx], 3);
        }

        function init() {
            currentExponent = Math.max(currentExponent, Math.exp(EXP_LOG_MIN));
            currentScalePct = Math.max(currentScalePct, Math.exp(SCALE_LOG_MIN));
            document.getElementById('threshold-slider').value = Math.round(currentThreshold * 1000);
            document.getElementById('exponent-slider').value = expValToSlider(currentExponent);
            document.getElementById('scale-slider').value = scaleValToSlider(currentScalePct);
            document.getElementById('clamp-slider').value = clampValToSlider(currentClamp);
            document.getElementById('exponent-value').textContent = currentExponent.toFixed(3);
            document.getElementById('scale-value').textContent = currentScalePct.toFixed(2) + '%';
            document.getElementById('clamp-value').textContent = currentClamp.toFixed(3);

            const priceEl = document.getElementById('price-panel');
            const varianceEl = document.getElementById('variance-panel');
            const shiftEl = document.getElementById('shift-panel');

            recalcShift();

            priceChart = new uPlot({
                width: priceEl.offsetWidth,
                height: priceEl.offsetHeight,
                padding: [4, 8, 2, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.95, max * 1.05] },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'AMA3', stroke: '#e3b341', width: 1.5, scale: 'y', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'y', stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtNum(x, 6) : '') },
                ],
                cursor: cursorCfg,
            }, [data.dates, data.prices, data.ama3Prices], document.getElementById('price-chart'));

            varianceChart = new uPlot({
                width: varianceEl.offsetWidth,
                height: varianceEl.offsetHeight,
                padding: [14, 8, 2, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    v: { auto: true, range: (u, min, max) => [min * 0.95, max * 1.05] },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Weight variance', stroke: '#d2a8ff', width: 1.5, scale: 'v', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'v', stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtNum(x, 6) : '') },
                ],
                cursor: cursorCfg,
            }, [data.dates, variancePlot], document.getElementById('variance-chart'));

            shiftChart = new uPlot({
                width: shiftEl.offsetWidth,
                height: shiftEl.offsetHeight,
                padding: [26, 8, 4, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    d: { auto: true, range: () => rangeFrom(rawDeltaArr, -0.5, 0.04) },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Raw Δ', stroke: '#8b949e', width: 1.2, dash: [5, 4], scale: 'd', points: { show: false } },
                    { label: 'Δ', stroke: '#f85149', width: 1.7, scale: 'd', points: { show: false } },
                ],
                axes: [
                    { show: true, stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'd', stroke: '#545d68', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtSigned(x, 3) : ''),
                      splits: buildRawDeltaSplits },
                ],
                cursor: cursorCfg,
                hooks: {
                    draw: [makeDeltaHook(deltaArr, 'd', () => currentThreshold)],
                },
            }, [data.dates, rawDeltaArr, deltaArr], document.getElementById('shift-chart'));

            let leavePending = null;
            [priceChart, varianceChart, shiftChart].forEach(chart => {
                chart.over.addEventListener('mousemove', () => {
                    if (leavePending !== null) {
                        clearTimeout(leavePending);
                        leavePending = null;
                    }
                    updateLegend(chart.cursor.idx);
                });
                chart.over.addEventListener('mouseleave', () => {
                    leavePending = setTimeout(() => {
                        leavePending = null;
                        updateLegend(shiftChart.cursor.idx ?? data.realBarCount - 1);
                    }, 60);
                });
                chart.root.addEventListener('mouseenter', () => chart.root.classList.add('is-hovered'));
                chart.root.addEventListener('mouseleave', () => chart.root.classList.remove('is-hovered'));
                bindWheelZoom(chart);
                bindPan(chart);
            });

            function applyShiftFromSliders() {
                recalcShift();
                const xs = shiftChart.scales.x;
                const savedX = xs ? { min: Number.isFinite(xs.min) ? xs.min : xMin, max: Number.isFinite(xs.max) ? xs.max : xMax } : null;
                shiftChart.setData([data.dates, rawDeltaArr, deltaArr]);
                if (savedX) shiftChart.setScale('x', savedX);
                updateLegend(shiftChart.cursor.idx ?? data.realBarCount - 1);
            }

            document.getElementById('threshold-slider').addEventListener('input', (e) => {
                currentThreshold = parseInt(e.target.value, 10) / 1000;
                document.getElementById('threshold-value').textContent = currentThreshold.toFixed(3);
                applyShiftFromSliders();
            });

            document.getElementById('exponent-slider').addEventListener('input', (e) => {
                currentExponent = expSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('exponent-value').textContent = currentExponent.toFixed(3);
                applyShiftFromSliders();
            });

            document.getElementById('scale-slider').addEventListener('input', (e) => {
                currentScalePct = scaleSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('scale-value').textContent = currentScalePct.toFixed(2) + '%';
                applyShiftFromSliders();
            });

            document.getElementById('clamp-slider').addEventListener('input', (e) => {
                currentClamp = clampSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('clamp-value').textContent = currentClamp.toFixed(3);
                applyShiftFromSliders();
            });
        }

        function sizeCharts() {
            if (!priceChart || !varianceChart || !shiftChart) return;
            [
                [priceChart, 'price-panel'],
                [varianceChart, 'variance-panel'],
                [shiftChart, 'shift-panel'],
            ].forEach(([chart, id]) => {
                const el = document.getElementById(id);
                chart.setSize({ width: el.offsetWidth, height: el.offsetHeight });
            });
        }

        window.addEventListener('resize', sizeCharts);
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '0') syncXRange(xMin, xMax);
        });

        init();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            sizeCharts();
            updateLegend(data.realBarCount - 1);
        }));
    })();
    </script>
</body>
</html>`;
}

module.exports = { generateHTML };
