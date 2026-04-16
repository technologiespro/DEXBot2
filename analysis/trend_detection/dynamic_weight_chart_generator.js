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

    const ma = data.marketAdapter || {};
    const amaWeightConfig = data.amaWeightConfig || {};
    const defaultAlpha        = data.alpha            ?? ma.alpha;
    const defaultGain         = data.gain             ?? ma.gain;
    const defaultNeutralZone  = amaWeightConfig.neutralZonePct ?? ma.amaNeutralZonePct;
    const defaultDispWeight   = data.dispWeight       ?? ma.dispWeight;
    const maxSlopePct         = amaWeightConfig.maxSlopePct    ?? ma.amaMaxSlopePct;
    const defaultClipPct      = data.clipPct          ?? ma.clipPercentile;
    const lookbackBars        = amaWeightConfig.lookbackBars  ?? ma.amaLookbackBars;

    // Log mapping for lookback slider (4 to 256 bars)
    const LB_LOG_MIN_N = Math.log(4);
    const LB_LOG_MAX_N = Math.log(256);
    const clampedLb = Math.min(Math.max(lookbackBars, 4), 256);
    const lbInitSlider = Math.round((Math.log(clampedLb) - LB_LOG_MIN_N) / (LB_LOG_MAX_N - LB_LOG_MIN_N) * 1000);

    // Log mapping for gain slider
    const GAIN_LOG_MIN_N = Math.log(0.1);
    const GAIN_LOG_MAX_N = Math.log(3.0);
    const clampedGain = Math.min(Math.max(defaultGain, 0.001), 3.0);
    const gainInitSlider = Math.round((Math.log(clampedGain) - GAIN_LOG_MIN_N) / (GAIN_LOG_MAX_N - GAIN_LOG_MIN_N) * 1000);

    // Log mapping for maxS% slider
    const MS_LOG_MIN_N = Math.log(0.05);
    const MS_LOG_MAX_N = Math.log(20.0);
    const clampedMs = Math.min(Math.max(maxSlopePct, 0.05), 20.0);
    const msInitSlider = Math.round((Math.log(clampedMs) - MS_LOG_MIN_N) / (MS_LOG_MAX_N - MS_LOG_MIN_N) * 1000);

    const defaultRegimeSensitivity  = data.regimeSensitivity ?? ma.regimeSensitivity;
    const defaultAbsoluteThreshold  = ma.absoluteThreshold ?? 0;
    const dispScaleAtrMult          = data.dispScaleAtrMult ?? ma.dispScaleAtrMult;
    const dispScaleMinPct           = data.dispScaleMinPct  ?? ma.dispScaleMinPct;
    const regimeInitSlider = Math.round(defaultRegimeSensitivity * 100);

    const interval = results.length > 1 ?
        (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000 : 3600;

    const dates              = results.map((r, idx) => toEpochSeconds(r.timestamp || Date.now(), idx));
    const prices             = results.map((r) => r.price);
    const hurstArr           = results.map((r) => r.hurst ?? null);
    const peArr             = results.map((r) => r.pe ?? null);
    const hurstSegments     = results.map((r) => r.hurstSegment ?? null);
    const peSegments        = results.map((r) => r.peSegment ?? null);
    const amaSlopePct       = results.map((r) => r.amaSlopePct ?? null);
    const kalmanVelocityPct  = results.map((r) => r.velocityPct ?? null);
    const kalmanDisplacementPct = results.map((r) => r.displacementPct ?? null);
    const kalmanIsReady      = results.map((r) => r.isReady ?? false);
    const signals            = results.map((r) => r.signal);
    const ama3Prices         = results.map((r) => r.ama3Price ?? null);
    const weightVarianceArr  = results.map((r) => r.weightVariance ?? null);

    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 150; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        hurstArr.push(null);
        peArr.push(null);
        hurstSegments.push(null);
        peSegments.push(null);
        amaSlopePct.push(null);
        kalmanVelocityPct.push(null);
        kalmanDisplacementPct.push(null);
        kalmanIsReady.push(null);
        signals.push(null);
        ama3Prices.push(null);
        weightVarianceArr.push(null);
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
    const maxDispPct = Math.ceil(maxAbsPct(kalmanDisplacementPct) * 1.15) || 5;

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
        #price-panel  { flex: 0 0 34%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #ama-panel    { flex: 0 0 14%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #kalman-panel { flex: 0 0 21%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #output-panel { flex: 1 1 0;   min-height: 0; position: relative; }
        .uplot { background: #0b0e14; }
        .legend { position: absolute; top: 8px; left: 70px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 8px; color: #8b949e; white-space: nowrap; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 3px; }
        .legend-val { font-family: monospace; display: inline-block; text-align: right; min-width: 45px; }
        #l-price, #l-ama3 { min-width: 62px; }
        #l-ama-slope, #l-kal-vel, #l-kal-disp { min-width: 54px; }
        #l-signal { min-width: 70px; text-align: left; }
        #l-combined { min-width: 42px; }
        #l-mult { min-width: 38px; }
        #l-sell, #l-buy { min-width: 30px; }
        .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top:  1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }
        .ctrl { pointer-events: auto; display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; }
        .ctrl label { color: #8b949e; font-size: 10px; min-width: 24px; text-align: right; margin-right: 2px; }
        .ctrl.alpha label { min-width: 8px; }
        .ctrl.ms label { min-width: 32px; }
        .ctrl.clip label { min-width: 30px; }
        .ctrl.off label { min-width: 24px; }
        .ctrl.regime label { min-width: 24px; }
        .ctrl input[type="range"] { width: 80px; height: 3px; }
        .ctrl .val { font-weight: bold; font-size: 10px; min-width: 30px; display: inline-block; text-align: right; }
        .group-sep { border-left: 1px solid #30363d; margin-left: 6px; padding-left: 4px; display: inline-flex; align-items: center; height: 16px; }
        .group-label { font-size: 9px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 8px; font-weight: bold; }
        .ctrl.alpha input[type="range"] { accent-color: #58a6ff; width: 80px; }
        .ctrl.alpha .val { color: #58a6ff; }
        .ctrl.dw label { min-width: 20px; }
        .ctrl.dw input[type="range"] { accent-color: #a371f7; width: 80px; }
        .ctrl.dw .val { color: #a371f7; }
        .ctrl.lb label { min-width: 20px; }
        .ctrl.lb input[type="range"] { accent-color: #39d0d8; width: 80px; }
        .ctrl.lb .val { color: #39d0d8; }
        .ctrl.off input[type="range"] { accent-color: #3fb950; }
        .ctrl.off .val { color: #3fb950; }
        .ctrl.nz input[type="range"] { accent-color: #8b949e; }
        .ctrl.nz .val { color: #8b949e; }
        .copy-btn, .paste-btn { pointer-events: auto; margin-left: 6px; padding: 2px 10px; font-size: 10px; background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; }
        .copy-btn:hover, .paste-btn:hover { background: #30363d; color: #e6edf3; }
        .copy-btn.copied { color: #3fb950; border-color: #3fb950; }
        .paste-btn.pasted { color: #58a6ff; border-color: #58a6ff; }
        .paste-btn.error  { color: #f85149; border-color: #f85149; }
        #paste-confirm { display: none; position: fixed; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 14px 16px; z-index: 1000; box-shadow: 0 4px 24px rgba(0,0,0,0.7); min-width: 200px; }
        #paste-confirm-title { font-size: 10px; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        #paste-confirm-vals { font-size: 11px; font-family: monospace; color: #e6edf3; line-height: 1.7; margin-bottom: 12px; }
        #paste-confirm-vals span { color: #58a6ff; }
        #paste-confirm-btns { display: flex; gap: 6px; justify-content: flex-end; }
        #paste-confirm-btns button { padding: 3px 12px; font-size: 10px; border-radius: 4px; cursor: pointer; border: 1px solid #30363d; background: #21262d; color: #8b949e; }
        #paste-confirm-apply { background: #1f4e23 !important; color: #3fb950 !important; border-color: #3fb950 !important; }
        #paste-confirm-apply:hover { background: #2ea043 !important; color: #fff !important; }

        .ctrl.ms input[type="range"] { accent-color: #f0883e; }
        .ctrl.ms .val { color: #f0883e; }
        .ctrl.clip input[type="range"] { accent-color: #da3633; }
        .ctrl.clip .val { color: #da3633; }
        .ctrl.regime input[type="range"] { accent-color: #d2a8ff; }
        .ctrl.regime .val { color: #d2a8ff; }

.section-label { position: absolute; top: 8px; right: 12px; font-size: 9px; color: #30363d; text-transform: uppercase; letter-spacing: 1px; z-index: 10; pointer-events: none; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Log Price &nbsp;\u2192&nbsp; AMA Slope &nbsp;\u2192&nbsp; Kalman Composite &nbsp;\u2192&nbsp; Dynamic Weight &nbsp;&nbsp;|&nbsp;&nbsp; Scroll \u00b7 Drag \u00b7 Ctrl+0</div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>AMA3: <span id="l-ama3" class="legend-val" style="font-weight:bold;">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="ama-panel">
            <div class="section-label">AMA SLOPE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#f0a000;"></div>Slope%: <span id="l-ama-slope" class="legend-val" style="font-weight:bold;">-</span></div>
            </div>
            <div id="ama-chart"></div>
        </div>
        <div id="kalman-panel">
            <div class="section-label">KALMAN COMPOSITE INPUT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Vel%: <span id="l-kal-vel" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#79c0ff;"></div>Disp%: <span id="l-kal-disp" class="legend-val">-</span></div>
                <div class="legend-item">Signal: <span id="l-signal" class="legend-val" style="font-weight:bold;">-</span></div>
            </div>
            <div id="kalman-chart"></div>
        </div>
        <div id="output-panel">
            <div class="section-label">COMBINED WEIGHT OUTPUT</div>
            <div class="legend" style="gap: 4px;">
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#2ea043,#f85149);"></div>Off: <span id="l-combined" class="legend-val" style="font-weight:bold;">-</span></div>
                <div class="legend-item">xMult: <span id="l-mult" class="legend-val" style="font-weight:bold;color:#d2a8ff;">-</span></div>
                <div class="legend-item">S: <span id="l-sell" class="legend-val" style="color:#ff7b72;">-</span></div>
                <div class="legend-item">B: <span id="l-buy" class="legend-val" style="color:#58a6ff;">-</span></div>
                
                <div class="group-sep"></div>
                <div class="ctrl alpha"><label for="alpha-slider">α</label><input type="range" id="alpha-slider" min="0" max="100" value="${Math.round(defaultAlpha * 100)}" title="Alpha Mix (AMA vs Kalman)"><span class="val" id="alpha-value">${defaultAlpha.toFixed(2)}</span></div>
                <div class="ctrl dw"><label for="dw-slider">dw</label><input type="range" id="dw-slider" min="0" max="100" value="${Math.round(defaultDispWeight * 100)}" title="Displacement Weight"><span class="val" id="dw-value">${defaultDispWeight.toFixed(2)}</span></div>

                <div class="group-sep"></div>
                <div class="ctrl nz"><label for="nz-slider">nz%</label><input type="range" id="nz-slider" min="0" max="100" value="${Math.round(defaultNeutralZone * 100)}" title="Neutral Zone %"><span class="val" id="nz-value">${defaultNeutralZone.toFixed(2)}</span></div>
                <div class="ctrl lb"><label for="lb-slider">lb</label><input type="range" id="lb-slider" min="0" max="1000" value="${lbInitSlider}" title="Lookback Bars (4-256)"><span class="val" id="lb-value">${lookbackBars}</span></div>
                <div class="ctrl ms"><label for="ms-slider">maxS%</label><input type="range" id="ms-slider" min="0" max="1000" value="${msInitSlider}" title="Max Slope % (Saturation Point)"><span class="val" id="ms-value">${maxSlopePct.toFixed(2)}</span></div>
                <div class="ctrl clip"><label for="clip-slider">clip%</label><input type="range" id="clip-slider" min="0" max="55" value="${Math.min(defaultClipPct, 55)}" title="Outlier Clip %"><span class="val" id="clip-value">${Math.min(defaultClipPct, 55)}%</span></div>

                <div class="group-sep"></div>
                <div class="ctrl off"><label for="gain-slider">gain</label><input type="range" id="gain-slider" min="0" max="1000" value="${gainInitSlider}" title="Master Gain (Amplitude)"><span class="val" id="gain-value">${defaultGain.toFixed(3)}</span></div>
                <div class="ctrl regime"><label for="regime-slider">regi</label><input type="range" id="regime-slider" min="0" max="200" value="${regimeInitSlider}" title="Regime Sensitivity"><span class="val" id="regime-value">${defaultRegimeSensitivity.toFixed(2)}</span></div>

                <div class="group-sep"></div>
                <button class="copy-btn" id="copy-params-btn">copy</button>
                <button class="paste-btn" id="paste-params-btn">paste</button>
            </div>
            <div id="output-chart"></div>
        </div>
    </div>

    <div id="paste-confirm">
        <div id="paste-confirm-title">Confirm paste parameters</div>
        <div id="paste-confirm-vals"></div>
        <div id="paste-confirm-btns">
            <button id="paste-confirm-cancel">Cancel</button>
            <button id="paste-confirm-apply">Apply</button>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript({ dates, prices, hurstArr, peArr, hurstSegments, peSegments, ama3Prices, amaSlopePct, kalmanVelocityPct, kalmanDisplacementPct, kalmanIsReady, signals, alpha: defaultAlpha, gain: defaultGain, neutralZonePct: defaultNeutralZone, dispWeight: defaultDispWeight, maxSlopePct, maxDispPct, clipPct: defaultClipPct, regimeSensitivity: defaultRegimeSensitivity, absoluteThreshold: defaultAbsoluteThreshold, lookbackBars, realBarCount, amaPctMax, kalPctMax, amaPercentiles, kalPercentiles, msLogMin: MS_LOG_MIN_N, msLogMax: MS_LOG_MAX_N, lbLogMin: LB_LOG_MIN_N, lbLogMax: LB_LOG_MAX_N, gainLogMin: GAIN_LOG_MIN_N, gainLogMax: GAIN_LOG_MAX_N, weightVarianceArr, dispScaleAtrMult, dispScaleMinPct })}</script>

    <script>
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = "dyn-wt-res-v3";
        const Y_AXIS_SIZE = 58;

        const ABSOLUTE_THRESHOLD = data.absoluteThreshold ?? 0;

        let currentAlpha   = data.alpha;
        let currentGain  = data.gain ?? ma.gain;
        let currentNz      = (data.neutralZonePct ?? amaWeightConfig.neutralZonePct) ?? ma.amaNeutralZonePct;
        let currentDw      = data.dispWeight ?? ma.dispWeight;
        let currentMaxSlopePct = (data.maxSlopePct ?? amaWeightConfig.maxSlopePct) ?? ma.amaMaxSlopePct;
        const MS_LOG_MIN = data.msLogMin;
        const MS_LOG_MAX = data.msLogMax;
        const msSliderToVal = (pos) => Math.exp(MS_LOG_MIN + (pos / 1000) * (MS_LOG_MAX - MS_LOG_MIN));

        let currentLookbackBars = (data.lookbackBars ?? amaWeightConfig.lookbackBars) ?? ma.amaLookbackBars;
        const LB_LOG_MIN = data.lbLogMin;
        const LB_LOG_MAX = data.lbLogMax;
        const lbSliderToVal = (pos) => Math.round(Math.exp(LB_LOG_MIN + (pos / 1000) * (LB_LOG_MAX - LB_LOG_MIN)));
        const lbValToSlider = (val) => Math.round((Math.log(Math.max(4, val)) - LB_LOG_MIN) / (LB_LOG_MAX - LB_LOG_MIN) * 1000);

        const GAIN_LOG_MIN = data.gainLogMin;
        const GAIN_LOG_MAX = data.gainLogMax;
        const gainSliderToVal = (pos) => Math.exp(GAIN_LOG_MIN + (pos / 1000) * (GAIN_LOG_MAX - GAIN_LOG_MIN));
        const gainValToSlider = (val) => Math.round((Math.log(Math.max(Math.exp(GAIN_LOG_MIN), val)) - GAIN_LOG_MIN) / (GAIN_LOG_MAX - GAIN_LOG_MIN) * 1000);

        let currentClipPct = data.clipPct;
        const maxAmaSlope = data.amaPercentiles[data.amaPercentiles.length - 1];
        const maxKalVel = data.kalPercentiles[data.kalPercentiles.length - 1];
        let currentAmaClipThreshold = currentClipPct === 0 ? maxAmaSlope : data.amaPercentiles[100 - currentClipPct];
        let currentKalClipThreshold = currentClipPct === 0 ? maxKalVel : data.kalPercentiles[100 - currentClipPct];

        // Regime table from payload (allows custom tables) or default
        const REGIME_TABLE = data.regimeTable || [
            // PE: <0.60 (Structured)  0.725 (Mixed)  >0.85 (Noise)
            [ 1.0,                 0.7,           0.3  ],  // H > 0.55  trending (hNode 0.60)
            [ 0.6,                 0.4,           0.15 ],  // H 0.45-0.55  random (hNode 0.50)
            [ 0.3,                 0.2,           0.05 ],  // H < 0.45  mean-rev (hNode 0.40)
        ];

        /**
         * Bilinear interpolation for smooth regime multiplier
         */
        function getRegimeMultiplier(H, PE) {
            if (H == null || PE == null) return 1.0;

            // Define grid coordinates
            const hNodes = [0.60, 0.50, 0.40]; // Indices 0, 1, 2
            const pNodes = [0.55, 0.725, 0.90]; // Indices 0, 1, 2

            // Clamp inputs to grid range
            const h = Math.max(0.40, Math.min(0.60, H));
            const p = Math.max(0.55, Math.min(0.90, PE));

            // Find H segment
            let i = h > 0.50 ? 0 : 1;
            let h0 = hNodes[i], h1 = hNodes[i+1];
            let th = (h - h1) / (h0 - h1); // 0 at h1, 1 at h0

            // Find PE segment
            let j = p < 0.725 ? 0 : 1;
            let p0 = pNodes[j], p1 = pNodes[j+1];
            let tp = (p - p0) / (p1 - p0); // 0 at p0, 1 at p1

            // 4-point lookup
            const v00 = REGIME_TABLE[i][j];     // h0, p0
            const v01 = REGIME_TABLE[i][j+1];   // h0, p1
            const v10 = REGIME_TABLE[i+1][j];   // h1, p0
            const v11 = REGIME_TABLE[i+1][j+1]; // h1, p1

            // Bilinear interpolation
            const row0 = v00 * (1 - tp) + v01 * tp;
            const row1 = v10 * (1 - tp) + v11 * tp;
            return row0 * th + row1 * (1 - th);
        }

        let currentRegimeSensitivity = data.regimeSensitivity ?? ma.regimeSensitivity;

        const dynamicAmaOff      = new Array(data.dates.length).fill(null);
        const dynamicAmaSlopePct = new Array(data.dates.length).fill(null);
        const dynamicKalOff      = new Array(data.dates.length).fill(null);
        const combinedOff     = new Array(data.dates.length).fill(null);
        const combinedSell    = new Array(data.dates.length).fill(null);
        const combinedBuy     = new Array(data.dates.length).fill(null);
        const currentMults    = new Array(data.dates.length).fill(null);

        function computeSlopeAtIndex(idx, lb) {
            if (idx < lb || !data.ama3Prices[idx] || !data.ama3Prices[idx - lb]) return 0;
            const current = data.ama3Prices[idx];
            const past = data.ama3Prices[idx - lb];
            if (past <= 0) return 0;
            return (current - past) / past * 100;
        }

        function recalcInputs() {
            const nz = currentNz;
            const ms = currentMaxSlopePct;
            const mo = currentGain;
            const dw = currentDw;
            const lb = currentLookbackBars;
            const acl = currentAmaClipThreshold;
            const kcl = currentKalClipThreshold;

            // Recompute clip threshold based on current lookback
            let dynamicClipThreshold = Infinity;
            if (currentClipPct > 0) {
                const slopes = [];
                for (let i = lb; i < data.realBarCount; i++) {
                    const s = computeSlopeAtIndex(i, lb);
                    if (s !== 0) slopes.push(Math.abs(s));
                }
                if (slopes.length > 0) {
                    slopes.sort((a, b) => a - b);
                    const idx = Math.min(Math.floor((100 - currentClipPct) / 100 * slopes.length), slopes.length - 1);
                    dynamicClipThreshold = slopes[idx];
                }
            }

            for (let i = 0; i < data.realBarCount; i++) {
                // AMA: compute slope dynamically with current lookback, then clip and convert to offset
                const sp = computeSlopeAtIndex(i, lb);
                dynamicAmaSlopePct[i] = i < lb ? null : sp;
                const effectiveAcl = currentClipPct > 0 ? dynamicClipThreshold : acl;
                const clippedA = Math.max(-effectiveAcl, Math.min(effectiveAcl, sp));
                if (Math.abs(clippedA) < nz || i < lb) { dynamicAmaOff[i] = 0; }
                else { dynamicAmaOff[i] = Math.max(-mo, Math.min(mo, (clippedA / ms) * mo)); }

                // Kalman: use pre-computed values from payload
                const vp = data.kalmanVelocityPct[i];
                const dp = data.kalmanDisplacementPct[i];
                const kr = data.kalmanIsReady[i];

                if (!kr || vp === null || dp === null) { dynamicKalOff[i] = null; }
                else {
                    const clippedV = Math.max(-kcl, Math.min(kcl, vp));
                    if (Math.abs(clippedV) < nz) { dynamicKalOff[i] = 0; }
                    else {
                        const wv = data.weightVarianceArr[i] ?? 0;
                        const dispScale = Math.max(wv * data.dispScaleAtrMult, data.dispScaleMinPct);
                        const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
                        const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
                        const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
                        dynamicKalOff[i] = Math.max(-mo, Math.min(mo, (composite / ms) * mo));
                    }
                }
            }
            for (let i = data.realBarCount; i < data.dates.length; i++) {
                dynamicAmaOff[i] = null;
                dynamicAmaSlopePct[i] = null;
                dynamicKalOff[i] = null;
            }
        }

        function recalcWeights() {
            // Normalize each channel to its own peak so alpha is a pure ratio knob
            // and gain is the sole amplitude controller
            let aMax = 0, kMax = 0;
            for (let i = 0; i < data.realBarCount; i++) {
                if (dynamicAmaOff[i] !== null) aMax = Math.max(aMax, Math.abs(dynamicAmaOff[i]));
                if (dynamicKalOff[i] !== null) kMax = Math.max(kMax, Math.abs(dynamicKalOff[i]));
            }
            if (aMax === 0) aMax = 1;
            if (kMax === 0) kMax = 1;

            const mo = currentGain;
            for (let i = 0; i < data.dates.length; i++) {
                const aOff = dynamicAmaOff[i];
                const kOff = dynamicKalOff[i];
                if (aOff === null || kOff === null) {
                    combinedOff[i] = null; combinedSell[i] = null; combinedBuy[i] = null; currentMults[i] = null;
                } else {
                    const rawOff = (currentAlpha * (aOff / aMax) + (1 - currentAlpha) * (kOff / kMax)) * mo;
                    const baseMult = getRegimeMultiplier(data.hurstArr[i], data.peArr[i]);
                    // Use power for sensitivity: pushes away from 1.0 in both directions without flipping sign
                    const rawMult = Math.pow(baseMult, currentRegimeSensitivity);
                    // Dead-band: only apply regime multiplier when |mult - 1.0| >= absoluteThreshold
                    // Clamp to 1.0 max: regime only dampens, never amplifies
                    const finalMult = Math.abs(rawMult - 1.0) >= ABSOLUTE_THRESHOLD ? Math.min(rawMult, 1.0) : 1.0;
                    currentMults[i] = finalMult;
                    const off = Math.max(-0.5, Math.min(0.5, rawOff * finalMult));
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
        let priceChart, amaChart, kalmanChart, outputChart;

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
                [priceChart, amaChart, kalmanChart, outputChart].forEach(c => c.batch(() => c.setScale('x', next)));
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

            const price = data.prices[idx];
            const priceEl = document.getElementById('l-price');
            if (price == null) { priceEl.textContent = '-'; priceEl.style.color = '#8b949e'; }
            else { priceEl.textContent = price.toFixed(4); priceEl.style.color = '#58a6ff'; }

            const ama3 = data.ama3Prices[idx];
            const ama3El = document.getElementById('l-ama3');
            if (ama3 == null) { ama3El.textContent = '-'; ama3El.style.color = '#8b949e'; }
            else { ama3El.textContent = ama3.toFixed(4); ama3El.style.color = '#e3b341'; }

            const sp = dynamicAmaSlopePct[idx];
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

            const mult = currentMults[idx];
            const multEl = document.getElementById('l-mult');
            if (mult == null) { multEl.textContent = '-'; }
            else { multEl.textContent = 'x' + mult.toFixed(2); multEl.style.color = mult > 1.05 ? '#3fb950' : mult < 0.95 ? '#f85149' : '#d2a8ff'; }

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
            // Force all sliders to match JS state — overrides browser form-restore memory
            document.getElementById('alpha-slider').value = Math.round(currentAlpha * 100);
            document.getElementById('ms-slider').value = Math.round((Math.log(currentMaxSlopePct) - MS_LOG_MIN) / (MS_LOG_MAX - MS_LOG_MIN) * 1000);
            document.getElementById('gain-slider').value = gainValToSlider(currentGain);
            document.getElementById('clip-slider').value = currentClipPct;
            document.getElementById('nz-slider').value = Math.round(currentNz * 100);
            document.getElementById('lb-slider').value = lbValToSlider(currentLookbackBars);

            const priceEl  = document.getElementById('price-panel');
            const amaEl    = document.getElementById('ama-panel');
            const kalmanEl = document.getElementById('kalman-panel');
            const outputEl = document.getElementById('output-panel');


            priceChart = new uPlot({
                width: priceEl.offsetWidth, height: priceEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: {
                    x: { time: true },
                    y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.9, max * 1.1] }
                },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'AMA3',  stroke: '#e3b341', width: 1.5, scale: 'y', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'y', stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? x.toFixed(4) : ''), }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makeSignalBgHook('y')] }
            }, [data.dates, data.prices, data.ama3Prices], document.getElementById('price-chart'));

            amaChart = new uPlot({
                width: amaEl.offsetWidth, height: amaEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, p: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Slope%', stroke: '#f0a000', width: 2, scale: 'p', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'p', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : '') }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makePctFillHook(dynamicAmaSlopePct, 'p', 'rgba(46,160,67,0.20)', 'rgba(248,81,73,0.20)'), makeSignalBgHook('p')] }
            }, [data.dates, dynamicAmaSlopePct], document.getElementById('ama-chart'));

            kalmanChart = new uPlot({
                width: kalmanEl.offsetWidth, height: kalmanEl.offsetHeight,
                padding: [4, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, v: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Vel%', stroke: '#d2a8ff', width: 2, scale: 'v', points: { show: false } },
                    { label: 'Disp%', stroke: '#79c0ff', width: 1.5, dash: [6, 3], scale: 'v', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30303d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'v', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : '') }
                ],
                cursor: cursorCfg,
                hooks: { draw: [
                    makePctFillHook(data.kalmanVelocityPct, 'v', 'rgba(210,168,255,0.18)', 'rgba(210,168,255,0.18)'),
                    makeSignalBgHook('v')
                ] }
            }, [data.dates, data.kalmanVelocityPct, data.kalmanDisplacementPct], document.getElementById('kalman-chart'));

            outputChart = new uPlot({
                width: outputEl.offsetWidth, height: outputEl.offsetHeight,
                padding: [20, 8, 0, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, ow: { auto: true, range: (u, min, max) => {
                    const m = 0.5;
                    const pad = (max - min) * 0.1 || 0.02;
                    return [Math.min(min - pad, -m), Math.max(max + pad, m)];
                }}},
                series: [
                    { label: 'Time' },
                    { label: 'Off', stroke: 'transparent', scale: 'ow', points: { show: false } }
                ],
                axes: [
                    { show: false, stroke: '#30363d', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 34, font: '11px Segoe UI, sans-serif' },
                    { scale: 'ow', stroke: '#30363d', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30303d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(2) : ''),
                      splits: () => { const m = 0.5; return [-m, -m/2, 0, m/2, m]; } }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makePctFillHook(combinedOff, 'ow', 'rgba(46,160,67,0.30)', 'rgba(248,81,73,0.30)')] }
            }, [data.dates, combinedOff], document.getElementById('output-chart'));

            let leavePending = null;
            [priceChart, amaChart, kalmanChart, outputChart].forEach(chart => {
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
                amaChart.setData([data.dates, dynamicAmaSlopePct]);
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

            document.getElementById('dw-slider').addEventListener('input', (e) => {
                currentDw = parseInt(e.target.value, 10) / 100;
                document.getElementById('dw-value').textContent = currentDw.toFixed(2);
                onSliderChange();
            });

            document.getElementById('ms-slider').addEventListener('input', (e) => {
                currentMaxSlopePct = msSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('ms-value').textContent = currentMaxSlopePct.toFixed(2);
                onSliderChange();
            });

            document.getElementById('gain-slider').addEventListener('input', (e) => {
                currentGain = gainSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('gain-value').textContent = currentGain.toFixed(3);
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
                onSliderChange();
            });


            document.getElementById('nz-slider').addEventListener('input', (e) => {
                currentNz = parseInt(e.target.value, 10) / 100;
                document.getElementById('nz-value').textContent = currentNz.toFixed(2);
                onSliderChange();
            });

            document.getElementById('lb-slider').addEventListener('input', (e) => {
                currentLookbackBars = lbSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('lb-value').textContent = currentLookbackBars;
                onSliderChange();
            });

            document.getElementById('regime-slider').addEventListener('input', (e) => {
                currentRegimeSensitivity = parseInt(e.target.value, 10) / 100;
                document.getElementById('regime-value').textContent = currentRegimeSensitivity.toFixed(2);
                recalcWeights();
                const xs = outputChart.scales.x;
                const savedX = xs ? { min: Number.isFinite(xs.min) ? xs.min : xMin, max: Number.isFinite(xs.max) ? xs.max : xMax } : null;
                outputChart.setData([data.dates, combinedOff]);
                if (savedX) outputChart.setScale('x', savedX);
            });

function applyParams(p, btn) {
                if (typeof p !== 'object' || p === null) throw new Error('not an object');
                if (p.alpha != null) {
                    currentAlpha = Math.max(0, Math.min(1, p.alpha));
                    document.getElementById('alpha-slider').value = Math.round(currentAlpha * 100);
                    document.getElementById('alpha-value').textContent = currentAlpha.toFixed(2);
                }
                if (p.dispWeight != null) {
                    currentDw = Math.max(0, Math.min(1, p.dispWeight));
                    document.getElementById('dw-slider').value = Math.round(currentDw * 100);
                    document.getElementById('dw-value').textContent = currentDw.toFixed(2);
                }
                if (p.maxSlopePct != null) {
                    currentMaxSlopePct = Math.max(0.05, Math.min(20, p.maxSlopePct));
                    document.getElementById('ms-slider').value = Math.round((Math.log(currentMaxSlopePct) - MS_LOG_MIN) / (MS_LOG_MAX - MS_LOG_MIN) * 1000);
                    document.getElementById('ms-value').textContent = currentMaxSlopePct.toFixed(2);
                }
                if (p.gain != null) {
                    currentGain = Math.max(0, Math.min(3.0, p.gain));
                    document.getElementById('gain-slider').value = gainValToSlider(currentGain);
                    document.getElementById('gain-value').textContent = currentGain.toFixed(3);
                }
                if (p.clipPct != null) {
                    currentClipPct = Math.max(0, Math.min(55, Math.round(p.clipPct)));
                    document.getElementById('clip-slider').value = currentClipPct;
                    document.getElementById('clip-value').textContent = currentClipPct + '%';
                    if (currentClipPct === 0) {
                        currentAmaClipThreshold = data.amaPercentiles[data.amaPercentiles.length - 1];
                        currentKalClipThreshold = data.kalPercentiles[data.kalPercentiles.length - 1];
                    } else {
                        currentAmaClipThreshold = data.amaPercentiles[100 - currentClipPct];
                        currentKalClipThreshold = data.kalPercentiles[100 - currentClipPct];
                    }
                }
                if (p.neutralZonePct != null) {
                    currentNz = Math.max(0, Math.min(1, p.neutralZonePct));
                    document.getElementById('nz-slider').value = Math.round(currentNz * 100);
                    document.getElementById('nz-value').textContent = currentNz.toFixed(2);
                }
                if (p.regimeSensitivity != null) {
                    currentRegimeSensitivity = Math.max(0, Math.min(2, p.regimeSensitivity));
                    document.getElementById('regime-slider').value = Math.round(currentRegimeSensitivity * 100);
                    document.getElementById('regime-value').textContent = currentRegimeSensitivity.toFixed(2);
                }
if (p.lookbackBars != null) {
                    currentLookbackBars = Math.max(4, Math.min(256, Math.round(p.lookbackBars)));
                    document.getElementById('lb-slider').value = lbValToSlider(currentLookbackBars);
                    document.getElementById('lb-value').textContent = currentLookbackBars;
                }
                recalcInputs();
                recalcWeights();
                amaChart.setData([data.dates, dynamicAmaSlopePct]);
                outputChart.setData([data.dates, combinedOff]);
                if (btn) { btn.textContent = 'pasted!'; btn.classList.add('pasted'); setTimeout(() => { btn.textContent = 'paste'; btn.classList.remove('pasted'); }, 1500); }
            }

            let _confirmPending = null;
            function showConfirm(p, btn) {
                _confirmPending = { p, btn };
                const labels = { alpha: 'alpha', maxSlopePct: 'maxS%', gain: 'gain', clipPct: 'clip%', neutralZonePct: 'nz%', regimeSensitivity: 'regime', dispWeight: 'dw', lookbackBars: 'lb' };
                document.getElementById('paste-confirm-vals').innerHTML = Object.entries(labels)
                    .filter(([k]) => p[k] != null)
                    .map(([k, label]) => label + ': <span>' + p[k] + '</span>')
                    .join('<br>');
                const popup = document.getElementById('paste-confirm');
                popup.style.display = 'block';
                const r = btn.getBoundingClientRect();
                const pw = popup.offsetWidth, ph = popup.offsetHeight;
                let top = r.top - ph - 6;
                let left = r.right - pw;
                if (top < 4) top = r.bottom + 6;
                if (left < 4) left = 4;
                popup.style.top  = top + 'px';
                popup.style.left = left + 'px';
            }

            document.getElementById('paste-confirm-apply').addEventListener('click', () => {
                document.getElementById('paste-confirm').style.display = 'none';
                if (_confirmPending) { applyParams(_confirmPending.p, _confirmPending.btn); _confirmPending = null; }
            });
            document.getElementById('paste-confirm-cancel').addEventListener('click', () => {
                document.getElementById('paste-confirm').style.display = 'none';
                _confirmPending = null;
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && document.getElementById('paste-confirm').style.display !== 'none') {
                    document.getElementById('paste-confirm').style.display = 'none';
                    _confirmPending = null;
                }
            });

            const LS_KEY = 'dw_research_params';

            document.getElementById('copy-params-btn').addEventListener('click', () => {
                const btn = document.getElementById('copy-params-btn');
                const params = {
                    alpha:             +currentAlpha.toFixed(2),
                    maxSlopePct:       +currentMaxSlopePct.toFixed(2),
                    gain:              +currentGain.toFixed(3),
                    clipPct:           currentClipPct,
                    neutralZonePct:    +currentNz.toFixed(3),
                    regimeSensitivity: +currentRegimeSensitivity.toFixed(2),
                    dispWeight:        +currentDw.toFixed(2),
                    lookbackBars:      currentLookbackBars,
                };
                const json = JSON.stringify(params, null, 2);
                localStorage.setItem(LS_KEY, json);
                navigator.clipboard.writeText(json).catch(() => {});
                btn.textContent = 'copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1500);
            });

            document.getElementById('paste-params-btn').addEventListener('click', () => {
                const btn = document.getElementById('paste-params-btn');
                const tryParse = (text) => {
                    try { showConfirm(JSON.parse(text), btn); }
                    catch { btn.textContent = 'error'; btn.classList.add('error'); setTimeout(() => { btn.textContent = 'paste'; btn.classList.remove('error'); }, 1500); }
                };
                // Use localStorage first (same-tab copy/paste), fallback to Ctrl+V
                const stored = localStorage.getItem(LS_KEY);
                if (stored) {
                    try { showConfirm(JSON.parse(stored), btn); return; } catch {}
                }
                // No localStorage data - use Ctrl+V method
                btn.textContent = 'Ctrl+V…';
                btn.classList.add('pasted');
                const ta = document.createElement('textarea');
                ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;width:1px;height:1px;font-size:16px;';
                document.body.appendChild(ta);
                ta.focus();
                const cleanup = () => { document.body.removeChild(ta); btn.textContent = 'paste'; btn.classList.remove('pasted'); };
                ta.addEventListener('paste', (e) => {
                    const text = (e.clipboardData || window.clipboardData).getData('text');
                    cleanup();
                    tryParse(text);
                }, { once: true });
                ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(); });
                setTimeout(cleanup, 10000);
            });
        }

        function sizeCharts() {
            if (!priceChart || !amaChart || !kalmanChart || !outputChart) return;
            [[priceChart, 'price-panel'], [amaChart, 'ama-panel'], [kalmanChart, 'kalman-panel'], [outputChart, 'output-panel']].forEach(([chart, id]) => {
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