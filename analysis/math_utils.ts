// @ts-nocheck
'use strict';

/**
 * Math utilities for analysis scripts.
 */

function range(min, max, step, decimals = 4) {
    const out = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(decimals)));
    return [...new Set(out)];
}

function computeATR(candles, period = 14) {
    const atrs = [];
    if (!Array.isArray(candles) || candles.length === 0) return atrs;

    const safePeriod = Math.max(1, Math.round(period));
    let prevClose = Number(getCandleClose(candles[0]) ?? 0);
    let atrVal = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const high = Number(getCandleHigh(c) ?? 0);
        const low = Number(getCandleLow(c) ?? 0);
        const close = Number(getCandleClose(c) ?? 0);
        if (i === 0) {
            atrs.push(0);
            prevClose = close;
            continue;
        }
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        if (i <= safePeriod) {
            atrVal = atrVal === 0 ? tr : (atrVal * (i - 1) + tr) / i;
        } else {
            atrVal = (atrVal * (safePeriod - 1) + tr) / safePeriod;
        }
        atrs.push(atrVal);
        prevClose = close;
    }

    return atrs;
}

function getCandleOpen(candle) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[1] : candle.open;
}

function getCandleHigh(candle) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[2] : candle.high;
}

function getCandleLow(candle) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[3] : candle.low;
}

function getCandleClose(candle) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[4] : candle.close;
}

function getCandleTimestamp(candle) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[0] : candle.timestamp;
}

function normalizeCandle(candle) {
    if (!candle) return null;
    if (Array.isArray(candle)) {
        const ts = Number(candle[0]);
        const open = Number(candle[1]);
        const high = Number(candle[2]);
        const low = Number(candle[3]);
        const close = Number(candle[4]);
        const volume = Number(candle[5] ?? 0);
        if (![ts, open, high, low, close].every(Number.isFinite)) return null;
        return { time: Math.floor(ts / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    const ts = Number(candle.timestamp ?? candle.ts ?? candle.time);
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume ?? candle.volumeA ?? 0);
    if (![ts, open, high, low, close].every(Number.isFinite)) return null;
    return { time: Math.floor(ts / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

export = {
    range,
    computeATR,
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
};
