'use strict';

/**
 * Shared utilities for bot-fitting scripts.
 */

const fs = require('fs');
const path = require('path');

function toCandles(arr) {
    return arr.map((c) => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
    }));
}

function parseListOrRange(spec, fallback) {
    if (!spec) return fallback;
    if (spec.includes(':')) {
        const [a, b, s] = spec.split(':').map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(s) || s <= 0) return fallback;
        const out = [];
        for (let v = a; v <= b + 1e-9; v += s) out.push(Number(v.toFixed(4)));
        return out;
    }
    const vals = spec.split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
    return vals.length ? vals : fallback;
}

function loadLpData(filePath) {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { candles: toCandles(json.candles ?? json), meta: json.meta ?? null };
}

function fmt(x, d = 2) {
    if (!Number.isFinite(x)) return '  n/a';
    return Number(x).toFixed(d);
}

export = {
    toCandles,
    parseListOrRange,
    loadLpData,
    fmt,
};
