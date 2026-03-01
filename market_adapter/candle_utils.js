'use strict';

const fs = require('fs');
const path = require('path');

function toIntervalLabel(intervalSeconds) {
    if (intervalSeconds % 86400 === 0) return `${intervalSeconds / 86400}d`;
    if (intervalSeconds % 3600 === 0) return `${intervalSeconds / 3600}h`;
    if (intervalSeconds % 60 === 0) return `${intervalSeconds / 60}m`;
    return `${intervalSeconds}s`;
}

function buildOutputPath(poolId, intervalSeconds, ext = 'json') {
    const id = String(poolId).replace('1.19.', '');
    const label = toIntervalLabel(intervalSeconds);
    return path.join(__dirname, 'data', `lp_pool_${id}_${label}.${ext}`);
}

function rawToHuman(rawAmount, precision) {
    return Number(rawAmount || 0) / Math.pow(10, Number(precision || 0));
}

function tradeToBPerA(trade, assetA, assetB) {
    const sell = trade.sell || {};
    const recv = trade.received || {};
    const sellId = sell.asset_id;
    const recvId = recv.asset_id;

    if (!sellId || !recvId) return null;
    if (sellId === assetA.id && recvId === assetB.id) {
        const a = rawToHuman(sell.amount, assetA.precision);
        const b = rawToHuman(recv.amount, assetB.precision);
        if (a <= 0 || b <= 0) return null;
        return { price: b / a, volumeA: a };
    }
    if (sellId === assetB.id && recvId === assetA.id) {
        const b = rawToHuman(sell.amount, assetB.precision);
        const a = rawToHuman(recv.amount, assetA.precision);
        if (a <= 0 || b <= 0) return null;
        return { price: b / a, volumeA: a };
    }
    return null;
}

function tradesToCandles(trades, assetA, assetB, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const sorted = trades.slice().sort((a, b) => a.tsMs - b.tsMs);
    const map = new Map();

    for (const t of sorted) {
        if (!Number.isFinite(t.tsMs)) continue;
        const converted = tradeToBPerA(t, assetA, assetB);
        if (!converted) continue;

        const key = Math.floor(t.tsMs / bucketMs) * bucketMs;
        const p = converted.price;
        const vA = converted.volumeA;

        const cur = map.get(key);
        if (!cur) {
            map.set(key, { open: p, high: p, low: p, close: p, volumeA: vA });
        } else {
            cur.high = Math.max(cur.high, p);
            cur.low = Math.min(cur.low, p);
            cur.close = p;
            cur.volumeA += vA;
        }
    }

    return [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, c]) => [ts, c.open, c.high, c.low, c.close, c.volumeA]);
}

function writeCandlesJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function writeCandlesCsv(filePath, candles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const header = 'timestamp_ms,open,high,low,close,volume_A';
    const rows = candles.map((c) => c.join(','));
    fs.writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`);
}

module.exports = {
    toIntervalLabel,
    buildOutputPath,
    tradesToCandles,
    writeCandlesJson,
    writeCandlesCsv,
};
