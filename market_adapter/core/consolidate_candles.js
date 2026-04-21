'use strict';

function consolidateCandlesByTimestamp(candles) {
    if (!candles.length) return candles;
    const sorted = [...candles].sort((a, b) => a[0] - b[0]);
    const out = [];

    for (const c of sorted) {
        const [ts, open, high, low, close, volume] = c;
        const last = out[out.length - 1];
        if (!last || last[0] !== ts) {
            out.push([ts, open, high, low, close, volume]);
            continue;
        }
        last[2] = Math.max(last[2], high);
        last[3] = Math.min(last[3], low);
        last[4] = close;
        last[5] += volume;
    }

    return out;
}

module.exports = {
    consolidateCandlesByTimestamp,
};
