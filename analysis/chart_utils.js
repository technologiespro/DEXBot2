'use strict';

/**
 * Chart utilities for analysis HTML generators.
 */

const fs = require('fs');
const path = require('path');

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

function toEpochSeconds(ts, fallbackIdx) {
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    return fallbackIdx * 3600;
}

function writeChartFile(filePath, html) {
    const chartDir = path.dirname(filePath);
    if (!fs.existsSync(chartDir)) fs.mkdirSync(chartDir, { recursive: true });
    fs.writeFileSync(filePath, html, 'utf8');
}

/**
 * Shared uPlot interaction boilerplate for embedded browser scripts.
 * Consumers must define `xMin`, `xMax`, `charts`, `pendingRange`, and `pendingRangeRaf`
 * before embedding this script block.
 */
const UPLOT_SHARED_SCRIPT = `
function clampXRange(min, max) {
    let nextMin = min, nextMax = max;
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMax <= nextMin) {
        return { min: xMin, max: xMax };
    }
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
    const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 0);
    pendingRangeRaf = raf(() => {
        const next = pendingRange;
        pendingRange = null;
        pendingRangeRaf = 0;
        if (!next) return;
        charts.forEach(c => c && c.batch(() => c.setScale('x', next)));
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
    let dragging = false, startClientX = 0, startMin = xMin, startMax = xMax;
    const getScale = () => {
        const s = chart.scales.x || {};
        return { currMin: Number.isFinite(s.min) ? s.min : xMin, currMax: Number.isFinite(s.max) ? s.max : xMax };
    };
    const onMouseMove = (e) => {
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
        window.removeEventListener('mousemove', onMouseMove);
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
        const cur = getScale();
        startMin = cur.currMin; startMax = cur.currMax;
        document.body.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', endDrag, { once: true });
    });
    chart.root.addEventListener('mouseleave', () => { if (dragging) document.body.style.cursor = 'grabbing'; });
}
`;

module.exports = {
    escapeHtml,
    serializeJsonForScript,
    toEpochSeconds,
    writeChartFile,
    UPLOT_SHARED_SCRIPT,
};
