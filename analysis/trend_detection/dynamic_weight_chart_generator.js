'use strict';

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

function generateHTML(data, title = 'Dynamic Weight Research') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const amaWeightConfig = data.amaWeightConfig || {};
    const defaultAlpha        = data.alpha ?? 0.5;
    const defaultMaxOff       = data.maxOff ?? 0.5;
    const defaultNeutralZone  = amaWeightConfig.neutralZonePct ?? 0.15;
    const defaultDispWeight   = data.dispWeight ?? 0.4;
    const maxSlopePct         = amaWeightConfig.maxSlopePct ?? 3.0;
    const defaultClipPct      = data.clipPct ?? 10;

    const interval = results.length > 1 ?
        (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000 : 3600;

    const dates              = results.map((r, idx) => toEpochSeconds(r.timestamp || Date.now(), idx));
    const prices             = results.map((r) => r.price);
    const amaSlopePct       = results.map((r) => r.amaSlopePct ?? null);
    const kalmanVelocityPct  = results.map((r) => r.velocityPct ?? null);
    const kalmanDisplacementPct = results.map((r) => r.displacementPct ?? null);
    const kalmanIsReady      = results.map((r) => r.isReady ?? false);
    const signals            = results.map((r) => r.signal);

    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 150; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        amaSlopePct.push(null);
        kalmanVelocityPct.push(null);
        kalmanDisplacementPct.push(null);
        kalmanIsReady.push(null);
        signals.push(null);
    }

    const realBarCount = results.length;

    function maxAbsPct(arr) {
        let m = 0;
        for (let i = 0; i < realBarCount; i++) {
            if (arr[i] != null && Math.abs(arr[i]) > m) m = Math.abs(arr[i]);
        }
        return m || 4;
    }
    const amaPctMax = Math.ceil(maxAbsPct(amaSlopePct) * 1.15) || 5;
    const kalPctMax = Math.ceil(Math.max(maxAbsPct(kalmanVelocityPct), maxAbsPct(kalmanDisplacementPct)) * 1.15) || 5;

    function buildPercentiles(arr) {
        const sorted = [];
        for (let i = 0; i < realBarCount; i++) { if (arr[i] != null) sorted.push(Math.abs(arr[i])); }
        sorted.sort((a, b) => a - b);
        const pcts = [];
        for (let p = 0; p <= 100; p++) {
            const idx = Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1);
            pcts.push(sorted[idx] || 0);
        }
        return pcts;
    }
    const amaPercentiles = buildPercentiles(amaSlopePct);
    const kalPercentiles = buildPercentiles(kalmanVelocityPct);

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
        #header { padding: 10px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; height: 45px; z-index: 100; }
        #panels { display: flex; flex-direction: column; height: calc(100vh - 45px); width: 100vw; }
        #ama-panel    { flex: 0 0 28%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #kalman-panel { flex: 0 0 28%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #output-panel { flex: 1 1 0;   min-height: 0; position: relative; }
        .uplot { background: #0b0e14; }
        .legend { position: absolute; top: 8px; left: 70px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 12px; color: #8b949e; white-space: nowrap; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 5px; }
        .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top:  1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }
        .ctrl { pointer-events: auto; display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; }
        .ctrl label { color: #8b949e; font-size: 10px; }
        .ctrl input[type="range"] { width: 90px; height: 3px; }
        .ctrl .val { font-weight: bold; font-size: 10px; min-width: 26px; }
        .ctrl.alpha input[type="range"] { accent-color: #58a6ff; }
        .ctrl.alpha .val { color: #58a6ff; }
        .ctrl.off input[type="range"] { accent-color: #3fb950; }
        .ctrl.off .val { color: #3fb950; }
        .ctrl.nz input[type="range"] { accent-color: #8b949e; }
        .ctrl.nz .val { color: #8b949e; }
        .ctrl.dw input[type="range"] { accent-color: #79c0ff; }
        .ctrl.dw .val { color: #79c0ff; }
        .ctrl.ms input[type="range"] { accent-color: #f0883e; }
        .ctrl.ms .val { color: #f0883e; }
        .ctrl.clip input[type="range"] { accent-color: #da3633; }
        .ctrl.clip .val { color: #da3633; }
        .formula { position: absolute; bottom: 8px; left: 70px; font-size: 9.5px; color: #484f58; pointer-events: none; z-index: 10; line-height: 1.4; }
        .section-label { position: absolute; top: 8px; right: 12px; font-size: 9px; color: #30363d; text-transform: uppercase; letter-spacing: 1px; z-index: 10; pointer-events: none; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">AMA Slope &nbsp;\u2192&nbsp; Kalman Composite &nbsp;\u2192&nbsp; Dynamic Weight &nbsp;&nbsp;|&nbsp;&nbsp; Scroll \u00b7 Drag \u00b7 Ctrl+0</div>
    </div>

    <div id="panels">
        <div id="ama-panel">
            <div class="section-label">AMA SLOPE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#f0a000;"></div>Slope%: <span id="l-ama-slope" style="font-weight:bold;">-</span></div>
            </div>
            <div id="ama-chart"></div>
        </div>
        <div id="kalman-panel">
            <div class="section-label">KALMAN COMPOSITE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Vel%: <span id="l-kal-vel" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#79c0ff;"></div>Disp%: <span id="l-kal-disp">-</span></div>
                <div class="legend-item">Signal: <span id="l-signal" style="font-weight:bold;">-</span></div>
            </div>
            <div id="kalman-chart"></div>
        </div>
        <div id="output-panel">
            <div class="section-label">COMBINED WEIGHT OUTPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#2ea043,#f85149);"></div>Off: <span id="l-combined" style="font-weight:bold;">-</span></div>
                <div class="legend-item">&nbsp;S:<span id="l-sell" style="color:#ff7b72;">-</span></div>
                <div class="legend-item">&nbsp;B:<span id="l-buy" style="color:#58a6ff;">-</span></div>
                <div class="ctrl alpha"><label for="alpha-slider">\u03b1</label><input type="range" id="alpha-slider" min="0" max="100" value="${Math.round(defaultAlpha * 100)}"><span class="val" id="alpha-value">${defaultAlpha.toFixed(2)}</span></div>
                <div class="ctrl ms"><label for="ms-slider">maxS%</label><input type="range" id="ms-slider" min="5" max="1000" value="${Math.round(maxSlopePct * 100)}"><span class="val" id="ms-value">${maxSlopePct.toFixed(1)}</span></div>
                <div class="ctrl off"><label for="off-slider">maxOff</label><input type="range" id="off-slider" min="0" max="100" value="${Math.round(defaultMaxOff * 100)}"><span class="val" id="off-value">${defaultMaxOff.toFixed(2)}</span></div>
                <div class="ctrl clip"><label for="clip-slider">clip%</label><input type="range" id="clip-slider" min="0" max="80" value="${defaultClipPct}"><span class="val" id="clip-value">${defaultClipPct}%</span></div>
                <div class="ctrl dw"><label for="dw-slider">dw</label><input type="range" id="dw-slider" min="0" max="100" value="${Math.round(defaultDispWeight * 100)}"><span class="val" id="dw-value">${defaultDispWeight.toFixed(2)}</span></div>
                <div class="ctrl nz"><label for="nz-slider">nz%</label><input type="range" id="nz-slider" min="0" max="100" value="${Math.round(defaultNeutralZone * 100)}"><span class="val" id="nz-value">${defaultNeutralZone.toFixed(2)}</span></div>
            </div>
            <div id="output-chart"></div>
            <div class="formula">amaOff = clamp(amaClip / <span id="formula-ms">${maxSlopePct.toFixed(1)}%</span> \u00d7 <span id="formula-off">${defaultMaxOff.toFixed(2)}</span>, \u00b1<span id="formula-off2">${defaultMaxOff.toFixed(2)}</span>) &nbsp;\u2502&nbsp; kalOff = clamp(kalComp / <span id="formula-ms2">${maxSlopePct.toFixed(1)}%</span> \u00d7 <span id="formula-off3">${defaultMaxOff.toFixed(2)}</span>, \u00b1<span id="formula-off4">${defaultMaxOff.toFixed(2)}</span>) &nbsp;\u2502&nbsp; off = \u03b1\u00b7amaOff + (1\u2212\u03b1)\u00b7kalOff &nbsp;\u2502&nbsp; clip P<span id="formula-clip">${defaultClipPct}</span>%: \u00b1<span id="formula-ama-clip">-</span> / \u00b1<span id="formula-kal-clip">-</span></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript({ dates, prices, amaSlopePct, kalmanVelocityPct, kalmanDisplacementPct, kalmanIsReady, signals, alpha: defaultAlpha, maxOff: defaultMaxOff, neutralZonePct: defaultNeutralZone, dispWeight: defaultDispWeight, maxSlopePct, clipPct: defaultClipPct, realBarCount, amaPctMax, kalPctMax, amaPercentiles, kalPercentiles })}</script>

    <script>
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = "dyn-wt-res-v3";
        const Y_AXIS_SIZE = 58;

        let currentAlpha   = data.alpha;
        let currentMaxOff  = data.maxOff;
        let currentNz      = data.neutralZonePct;
        let currentDw      = data.dispWeight;
        let currentMaxSlopePct = data.maxSlopePct;
        let currentClipPct = data.clipPct;
        const maxAmaSlope = data.amaPercentiles[data.amaPercentiles.length - 1];
        const maxKalVel = data.kalPercentiles[data.kalPercentiles.length - 1];
        let currentAmaClipThreshold = currentClipPct === 0 ? maxAmaSlope : data.amaPercentiles[100 - currentClipPct];
        let currentKalClipThreshold = currentClipPct === 0 ? maxKalVel : data.kalPercentiles[100 - currentClipPct];

        const dynamicAmaOff  = new Array(data.dates.length).fill(null);
        const dynamicKalOff  = new Array(data.dates.length).fill(null);
        const combinedOff     = new Array(data.dates.length).fill(null);
        const combinedSell    = new Array(data.dates.length).fill(null);
        const combinedBuy     = new Array(data.dates.length).fill(null);

        function recalcInputs() {
            const nz = currentNz;
            const ms = currentMaxSlopePct;
            const mo = currentMaxOff;
            const dw = currentDw;
            const acl = currentAmaClipThreshold;
            const kcl = currentKalClipThreshold;
            for (let i = 0; i < data.realBarCount; i++) {
                const sp = data.amaSlopePct[i];
                const vp = data.kalmanVelocityPct[i];
                const dp = data.kalmanDisplacementPct[i];
                const kr = data.kalmanIsReady[i];

                // AMA: percentile-clip then convert to offset
                if (sp === null) { dynamicAmaOff[i] = null; }
                else {
                    const clippedA = Math.max(-acl, Math.min(acl, sp));
                    if (Math.abs(clippedA) < nz) { dynamicAmaOff[i] = 0; }
                    else { dynamicAmaOff[i] = Math.max(-mo, Math.min(mo, (clippedA / ms) * mo)); }
                }

                // Kalman: percentile-clip velocity, composite with displacement, then offset
                if (!kr || vp === null || dp === null) { dynamicKalOff[i] = null; }
                else {
                    const clippedV = Math.max(-kcl, Math.min(kcl, vp));
                    if (Math.abs(clippedV) < nz) { dynamicKalOff[i] = 0; }
                    else {
                        const dispConf = Math.min(Math.abs(dp) / 1.0, 1.0);
                        const momAlign = (clippedV > 0 && dp > 0) || (clippedV < 0 && dp < 0) ? 1 : -0.5;
                        const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                        dynamicKalOff[i] = Math.max(-mo, Math.min(mo, (composite / ms) * mo));
                    }
                }
            }
            for (let i = data.realBarCount; i < data.dates.length; i++) {
                dynamicAmaOff[i] = null;
                dynamicKalOff[i] = null;
            }
        }

        function recalcWeights() {
            for (let i = 0; i < data.dates.length; i++) {
                const aOff = dynamicAmaOff[i];
                const kOff = dynamicKalOff[i];
                if (aOff === null || kOff === null) {
                    combinedOff[i] = null; combinedSell[i] = null; combinedBuy[i] = null;
                } else {
                    const off = currentAlpha * aOff + (1 - currentAlpha) * kOff;
                    combinedOff[i] = Math.round(off * 1000) / 1000;
                    combinedSell[i] = Math.max(-0.5, Math.min(1.5, Math.round((0.5 + off) * 100) / 100));
                    combinedBuy[i]  = Math.max(-0.5, Math.min(1.5, Math.round((0.5 - off) * 100) / 100));
                }
            }
        }
        recalcInputs();
        recalcWeights();

        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let amaChart, kalmanChart, outputChart;

        function clampXRange(min, max) {
            let nextMin = min, nextMax = max;
            const span = nextMax - nextMin;
            if (!Number.isFinite(span) || span <= 0) return { min: xMin, max: xMax };
            if (nextMin < xMin) { nextMax += xMin - nextMin; nextMin = xMin; }
            if (nextMax > xMax) { nextMin -= nextMax - xMax; nextMax = xMax; }
            if (nextMin < xMin) nextMin = xMin;
            if (nextMax > xMax) nextMax = xMax;
            if (nextMax <= nextMin) return { min: xMin, max: xMax };
            return { min: nextMin, max: nextMax };
        }

        function syncXRange(min, max) {
            pendingRange = clampXRange(min, max);
            if (pendingRangeRaf) return;
            pendingRangeRaf = requestAnimationFrame(() => {
                const next = pendingRange;
                pendingRange = null;
                pendingRangeRaf = 0;
                if (!next) return;
                [amaChart, kalmanChart, outputChart].forEach(c => c.batch(() => c.setScale('x', next)));
            });
        }

        function bindWheelZoom(chart) {
            chart.root.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault(); e.stopPropagation();
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
            let dragging = false, startClientX = 0, startMin = xMin, startMax = xMax;
            const getScale = () => {
                const s = chart.scales.x || {};
                return { currMin: Number.isFinite(s.min) ? s.min : xMin, currMax: Number.isFinite(s.max) ? s.max : xMax };
            };
            const onMouseMove = (e) => {
                if (!dragging) return; e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                const delta = chart.posToVal(e.clientX - rect.left, 'x') - chart.posToVal(startClientX - rect.left, 'x');
                syncXRange(startMin - delta, startMax - delta);
            };
            const endDrag = () => { if (!dragging) return; dragging = false; document.body.style.cursor = ''; window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', endDrag); };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                e.preventDefault(); e.stopPropagation();
                dragging = true; startClientX = e.clientX;
                const cur = getScale(); startMin = cur.currMin; startMax = cur.currMax;
                document.body.style.cursor = 'grabbing';
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });
            chart.root.addEventListener('mouseleave', () => { if (dragging) document.body.style.cursor = 'grabbing'; });
        }

        let lastLiveIdx = data.realBarCount - 1;

        function updateLegend(idx) {
            if (idx == null) return;
            lastLiveIdx = idx;

            const sp = data.amaSlopePct[idx];
            const spEl = document.getElementById('l-ama-slope');
            if (sp == null) { spEl.textContent = '-'; spEl.style.color = '#8b949e'; }
            else { spEl.textContent = (sp >= 0 ? '+' : '') + sp.toFixed(3) + '%'; spEl.style.color = sp > 0.01 ? '#2ea043' : sp < -0.01 ? '#f85149' : '#8b949e'; }

            const vp = data.kalmanVelocityPct[idx];
            const vpEl = document.getElementById('l-kal-vel');
            if (vp == null) { vpEl.textContent = '-'; vpEl.style.color = '#8b949e'; }
            else { vpEl.textContent = (vp >= 0 ? '+' : '') + vp.toFixed(3) + '%'; vpEl.style.color = vp > 0.01 ? '#2ea043' : vp < -0.01 ? '#f85149' : '#8b949e'; }

            const dp = data.kalmanDisplacementPct[idx];
            const dpEl = document.getElementById('l-kal-disp');
            if (dp == null) { dpEl.textContent = '-'; dpEl.style.color = '#8b949e'; }
            else { dpEl.textContent = (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%'; dpEl.style.color = dp > 0.3 ? '#2ea043' : dp < -0.3 ? '#f85149' : '#8b949e'; }

            const sig = data.signals[idx];
            const sigEl = document.getElementById('l-signal');
            if (!sig) { sigEl.textContent = '-'; sigEl.style.color = '#8b949e'; }
            else if (sig.includes('BULL')) { sigEl.textContent = '\u25b2 BULL'; sigEl.style.color = '#2ea043'; }
            else if (sig.includes('BEAR')) { sigEl.textContent = '\u25bc BEAR'; sigEl.style.color = '#f85149'; }
            else if (sig === 'EQUILIBRIUM') { sigEl.textContent = '\u2248 EQ'; sigEl.style.color = '#58a6ff'; }
            else { sigEl.textContent = '\u25cb NEU'; sigEl.style.color = '#8b949e'; }

            const cOff = combinedOff[idx];
            const cEl = document.getElementById('l-combined');
            if (cOff == null) { cEl.textContent = '-'; cEl.style.color = '#8b949e'; }
            else { cEl.textContent = (cOff >= 0 ? '+' : '') + cOff.toFixed(3); cEl.style.color = cOff > 0.01 ? '#2ea043' : cOff < -0.01 ? '#f85149' : '#8b949e'; }
            document.getElementById('l-sell').textContent = combinedSell[idx] != null ? combinedSell[idx].toFixed(2) : '-';
            document.getElementById('l-buy').textContent  = combinedBuy[idx]  != null ? combinedBuy[idx].toFixed(2) : '-';
        }

        function makeSignalBgHook(scaleKey) {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
                ctx.globalCompositeOperation = 'destination-over';
                let i = 0;
                while (i < data.signals.length) {
                    const s = data.signals[i];
                    if (!s || i >= data.realBarCount) { i++; continue; }
                    const isBull = s.includes('BULL');
                    const isBear = s.includes('BEAR');
                    let j = i + 1;
                    while (j < data.realBarCount && data.signals[j] === s) j++;
                    const x0 = u.valToPos(data.dates[i], 'x', true);
                    const x1 = j < data.realBarCount ? u.valToPos(data.dates[j], 'x', true) : bbox.left + bbox.width;
                    if (isBull) { ctx.fillStyle = 'rgba(46,160,67,0.06)'; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); }
                    else if (isBear) { ctx.fillStyle = 'rgba(248,81,73,0.06)'; ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height); }
                    i = j;
                }
                // Neutral zone band
                if (scaleKey) {
                    const nzY = u.valToPos(currentNz, scaleKey, true);
                    const nzYNeg = u.valToPos(-currentNz, scaleKey, true);
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.fillStyle = 'rgba(139,148,158,0.06)';
                    ctx.fillRect(bbox.left, Math.min(nzY, nzYNeg), bbox.width, Math.abs(nzYNeg - nzY));
                }
                ctx.restore();
            };
        }

        function makePctFillHook(values, scaleKey, posColor, negColor) {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
                const zeroY = u.valToPos(0, scaleKey, true);
                const path = new Path2D();
                let inSeg = false, lastX = 0;
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (v === null) { if (inSeg) { path.lineTo(lastX, zeroY); inSeg = false; } continue; }
                    const x = u.valToPos(data.dates[i], 'x', true);
                    const y = u.valToPos(v, scaleKey, true);
                    if (!inSeg) { path.moveTo(x, zeroY); path.lineTo(x, y); inSeg = true; }
                    else path.lineTo(x, y);
                    lastX = x;
                }
                if (inSeg) path.lineTo(lastX, zeroY);
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, zeroY - bbox.top); ctx.clip();
                ctx.fillStyle = posColor; ctx.fill(path);
                ctx.restore();
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY); ctx.clip();
                ctx.fillStyle = negColor; ctx.fill(path);
                ctx.restore();
                ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.stroke(path);
                ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(bbox.left, zeroY); ctx.lineTo(bbox.left + bbox.width, zeroY); ctx.stroke();
                ctx.restore();
            };
        }

        const cursorCfg = {
            show: true, x: true, y: true, points: { show: false },
            drag: { x: false, y: false, setScale: false },
            sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] },
            focus: { prox: -1 },
        };

        function init() {
            const amaEl    = document.getElementById('ama-panel');
            const kalmanEl = document.getElementById('kalman-panel');
            const outputEl = document.getElementById('output-panel');

            const pctRangeAma = () => [-data.amaPctMax, data.amaPctMax];
            const pctRangeKal = () => [-data.kalPctMax, data.kalPctMax];

            amaChart = new uPlot({
                width: amaEl.offsetWidth, height: amaEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, p: { range: pctRangeAma } },
                series: [
                    { label: 'Time' },
                    { label: 'Slope%', stroke: '#f0a000', width: 2, scale: 'p', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'p', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : ''),
                      splits: () => { const m = data.amaPctMax; return [-m, -m/2, 0, m/2, m]; } }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makePctFillHook(data.amaSlopePct, 'p', 'rgba(46,160,67,0.20)', 'rgba(248,81,73,0.20)'), makeSignalBgHook('p')] }
            }, [data.dates, data.amaSlopePct], document.getElementById('ama-chart'));

            kalmanChart = new uPlot({
                width: kalmanEl.offsetWidth, height: kalmanEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, v: { range: pctRangeKal } },
                series: [
                    { label: 'Time' },
                    { label: 'Vel%', stroke: '#d2a8ff', width: 2, scale: 'v', points: { show: false } },
                    { label: 'Disp%', stroke: '#79c0ff', width: 1.5, dash: [6, 3], scale: 'v', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30303d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'v', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : ''),
                      splits: () => { const m = data.kalPctMax; return [-m, -m/2, 0, m/2, m]; } }
                ],
                cursor: cursorCfg,
                hooks: { draw: [
                    makePctFillHook(data.kalmanVelocityPct, 'v', 'rgba(210,168,255,0.18)', 'rgba(210,168,255,0.18)'),
                    makeSignalBgHook('v')
                ] }
            }, [data.dates, data.kalmanVelocityPct, data.kalmanDisplacementPct], document.getElementById('kalman-chart'));

const outRange = () => {
                const m = Math.max(0.1, currentMaxOff);
                return [-m * 1.1, m * 1.1];
            };

            outputChart = new uPlot({
                width: outputEl.offsetWidth, height: outputEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, ow: { range: outRange } },
                series: [
                    { label: 'Time' },
                    { label: 'Off', stroke: 'transparent', scale: 'ow', points: { show: false } }
                ],
                axes: [
                    { show: true, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'ow', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(2) : ''),
                      splits: () => { const m = Math.max(0.1, currentMaxOff); return [-m, -m/2, 0, m/2, m]; } }
                ],
                axes: [
                    { show: true, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'ow', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(2) : ''),
                      splits: () => { const m = Math.max(0.1, currentMaxOff); return [-m, -m/2, 0, m/2, m]; } }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makePctFillHook(combinedOff, 'ow', 'rgba(46,160,67,0.30)', 'rgba(248,81,73,0.30)')] }
            }, [data.dates, combinedOff], document.getElementById('output-chart'));

            let leavePending = null;
            [amaChart, kalmanChart, outputChart].forEach(chart => {
                chart.over.addEventListener('mousemove', () => {
                    if (leavePending !== null) { clearTimeout(leavePending); leavePending = null; }
                    const idx = chart.cursor.idx;
                    if (idx != null) updateLegend(idx);
                });
                chart.over.addEventListener('mouseleave', () => {
                    leavePending = setTimeout(() => { leavePending = null; updateLegend(lastLiveIdx); }, 60);
                });
                chart.root.addEventListener('mouseenter', () => chart.root.classList.add('is-hovered'));
                chart.root.addEventListener('mouseleave', () => chart.root.classList.remove('is-hovered'));
                bindWheelZoom(chart);
                bindPan(chart);
            });

            function onSliderChange() {
                recalcInputs();
                recalcWeights();
                const xs = outputChart.scales.x;
                const savedX = xs ? { min: Number.isFinite(xs.min) ? xs.min : xMin, max: Number.isFinite(xs.max) ? xs.max : xMax } : null;
                outputChart.setData([data.dates, combinedOff]);
                if (savedX) outputChart.setScale('x', savedX);
            }

            document.getElementById('alpha-slider').addEventListener('input', (e) => {
                currentAlpha = parseInt(e.target.value, 10) / 100;
                document.getElementById('alpha-value').textContent = currentAlpha.toFixed(2);
                recalcWeights();
                const xs = outputChart.scales.x;
                const savedX = xs ? { min: Number.isFinite(xs.min) ? xs.min : xMin, max: Number.isFinite(xs.max) ? xs.max : xMax } : null;
                outputChart.setData([data.dates, combinedOff]);
                if (savedX) outputChart.setScale('x', savedX);
            });

            document.getElementById('ms-slider').addEventListener('input', (e) => {
                currentMaxSlopePct = parseInt(e.target.value, 10) / 100;
                document.getElementById('ms-value').textContent = currentMaxSlopePct.toFixed(1);
                document.getElementById('formula-ms').textContent = currentMaxSlopePct.toFixed(1) + '%';
                document.getElementById('formula-ms2').textContent = currentMaxSlopePct.toFixed(1) + '%';
                onSliderChange();
            });

            document.getElementById('off-slider').addEventListener('input', (e) => {
                currentMaxOff = parseInt(e.target.value, 10) / 100;
                document.getElementById('off-value').textContent = currentMaxOff.toFixed(2);
                document.getElementById('formula-off').textContent = currentMaxOff.toFixed(2);
                document.getElementById('formula-off2').textContent = currentMaxOff.toFixed(2);
                document.getElementById('formula-off3').textContent = currentMaxOff.toFixed(2);
                document.getElementById('formula-off4').textContent = currentMaxOff.toFixed(2);
                onSliderChange();
            });

            document.getElementById('clip-slider').addEventListener('input', (e) => {
                currentClipPct = parseInt(e.target.value, 10);
                if (currentClipPct === 0) {
                    currentAmaClipThreshold = data.amaPercentiles[data.amaPercentiles.length - 1];
                    currentKalClipThreshold = data.kalPercentiles[data.kalPercentiles.length - 1];
                } else {
                    currentAmaClipThreshold = data.amaPercentiles[100 - currentClipPct];
                    currentKalClipThreshold = data.kalPercentiles[100 - currentClipPct];
                }
                document.getElementById('clip-value').textContent = currentClipPct + '%';
                document.getElementById('formula-clip').textContent = currentClipPct;
                document.getElementById('formula-ama-clip').textContent = currentAmaClipThreshold.toFixed(2) + '%';
                document.getElementById('formula-kal-clip').textContent = currentKalClipThreshold.toFixed(2) + '%';
                onSliderChange();
            });

            document.getElementById('dw-slider').addEventListener('input', (e) => {
                currentDw = parseInt(e.target.value, 10) / 100;
                document.getElementById('dw-value').textContent = currentDw.toFixed(2);
                onSliderChange();
            });

            document.getElementById('nz-slider').addEventListener('input', (e) => {
                currentNz = parseInt(e.target.value, 10) / 100;
                document.getElementById('nz-value').textContent = currentNz.toFixed(2);
                onSliderChange();
            });
        }

        function sizeCharts() {
            if (!amaChart || !kalmanChart || !outputChart) return;
            [[amaChart, 'ama-panel'], [kalmanChart, 'kalman-panel'], [outputChart, 'output-panel']].forEach(([chart, id]) => {
                const el = document.getElementById(id);
                chart.setSize({ width: el.offsetWidth, height: el.offsetHeight });
            });
        }

        window.addEventListener('resize', sizeCharts);
        window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === '0') syncXRange(xMin, xMax); });

        init();
        requestAnimationFrame(() => { sizeCharts(); updateLegend(lastLiveIdx); });
    </script>
</body>
</html>`;
}

module.exports = { generateHTML };