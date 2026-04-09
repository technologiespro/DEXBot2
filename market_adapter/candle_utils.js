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

function detectMissingCandleTimestamps(candles, intervalSeconds = 3600) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
        return { gapCount: 0, missingTimestamps: [] };
    }

    const sorted = (Array.isArray(candles) ? candles : [])
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
        .slice()
        .sort((a, b) => a[0] - b[0]);

    if (sorted.length === 0) {
        return { gapCount: 0, missingTimestamps: [] };
    }

    const missingTimestamps = [];

    for (let i = 1; i < sorted.length; i++) {
        const prevTs = sorted[i - 1][0];
        const nextTs = sorted[i][0];
        let expectedTs = prevTs + bucketMs;

        while (nextTs > expectedTs) {
            missingTimestamps.push(expectedTs);
            expectedTs += bucketMs;
        }
    }

    return {
        gapCount: missingTimestamps.length,
        missingTimestamps,
    };
}

/**
 * Fills gaps in a candle series by carrying forward the last known close price.
 * Volume for filled candles is 0.
 *
 * @param {Array}  candles         - [[ts, o, h, l, c, v], ...]
 * @param {number} intervalSeconds - bucket size in seconds
 * @param {number} [startTs]       - optional start timestamp (ms) to stretch to the past
 * @param {number} [endTs]         - optional end timestamp (ms) to stretch to the future
 */
function fillCandleGaps(candles, intervalSeconds, startTs = null, endTs = null) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!candles || !Array.isArray(candles)) return [];
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return candles;

    const sorted = candles
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
        .slice()
        .sort((a, b) => a[0] - b[0]);

    if (sorted.length === 0) {
        // If we have no data, we can't really fill unless we have a baseline price.
        // For now, return empty.
        return [];
    }

    const filled = [];

    // Determine absolute timeline range
    const firstKnownTs = sorted[0][0];
    const lastKnownTs = sorted[sorted.length - 1][0];

    let currentTs = startTs != null
        ? Math.floor(Number(startTs) / bucketMs) * bucketMs
        : firstKnownTs;

    const finalTs = endTs != null
        ? Math.floor(Number(endTs) / bucketMs) * bucketMs
        : lastKnownTs;

    let sourceIdx = 0;
    let lastKnownCandle = sorted[0];

    // Find first available candle at or after currentTs to initialize lastKnownCandle
    while (sourceIdx < sorted.length && sorted[sourceIdx][0] < currentTs) {
        lastKnownCandle = sorted[sourceIdx];
        sourceIdx++;
    }

    while (currentTs <= finalTs) {
        if (sourceIdx < sorted.length && sorted[sourceIdx][0] === currentTs) {
            lastKnownCandle = sorted[sourceIdx];
            filled.push(lastKnownCandle);
            sourceIdx++;
        } else {
            // Gap: carry forward lastKnownCandle's close
            const p = lastKnownCandle[4]; // close
            // Format: [ts, open, high, low, close, volume]
            filled.push([currentTs, p, p, p, p, 0]);
        }
        currentTs += bucketMs;
    }

    return filled;
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
    detectMissingCandleTimestamps,
    fillCandleGaps,
    writeCandlesJson,
    writeCandlesCsv,
};
