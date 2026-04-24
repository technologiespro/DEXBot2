'use strict';

const { kibanaSearch, toFixedInterval, DEFAULT_CONFIG: BASE_CONFIG } = require('./kibana_client');
const { fillCandleGaps } = require('../candle_utils');
const { consolidateCandlesByTimestamp } = require('./consolidate_candles');

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,
    lookbackHours: 500,
    consolidateByTimestamp: true,
};

function buildDirectionalQuery({ opType, soldAssetField, receivedAssetField, soldAmountField, receivedAmountField, poolField, soldAssetId, receivedAssetId, lookbackHours, intervalSeconds, poolId, timeRange }) {
    const rangeValue = timeRange
        ? { gte: timeRange.gte, lte: timeRange.lte }
        : { gte: `now-${lookbackHours}h`, lte: 'now' };

    const filters = [
        { term: { operation_type: opType } },
        { term: { [soldAssetField]: soldAssetId } },
        { range: { 'block_data.block_time': rangeValue } },
    ];

    if (receivedAssetId && receivedAssetField) {
        filters.push({ term: { [receivedAssetField]: receivedAssetId } });
    }

    if (poolId && poolField) {
        filters.push({ term: { [poolField]: poolId } });
    }

    return {
        size: 0,
        query: { bool: { filter: filters } },
        aggs: {
            by_time: {
                date_histogram: {
                    field: 'block_data.block_time',
                    fixed_interval: toFixedInterval(intervalSeconds),
                    min_doc_count: 1,
                },
                aggs: {
                    sum_sold: { sum: { field: soldAmountField } },
                    sum_received: { sum: { field: receivedAmountField } },
                },
            },
        },
    };
}

function bucketsToCandles(buckets, soldPrecision, receivedPrecision) {
    const soldScale = Math.pow(10, soldPrecision);
    const recvScale = Math.pow(10, receivedPrecision);

    return buckets
        .filter((b) => b.sum_sold.value > 0 && b.sum_received.value > 0)
        .map((b) => {
            const soldAmt = b.sum_sold.value / soldScale;
            const recvAmt = b.sum_received.value / recvScale;
            const vwap = recvAmt / soldAmt;
            return [b.key, vwap, vwap, vwap, vwap, soldAmt];
        });
}

async function fetchKibanaCandles({ opType, fieldMap, assetA, assetB, config = {}, poolId = null }) {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const queryAtoB = buildDirectionalQuery({
        opType,
        ...fieldMap,
        soldAssetId: assetA.id,
        receivedAssetId: assetB.id,
        lookbackHours: cfg.lookbackHours,
        intervalSeconds: cfg.intervalSeconds,
        poolId,
        timeRange: cfg.timeRange ?? null,
    });

    const queryBtoA = buildDirectionalQuery({
        opType,
        ...fieldMap,
        soldAssetId: assetB.id,
        receivedAssetId: assetA.id,
        lookbackHours: cfg.lookbackHours,
        intervalSeconds: cfg.intervalSeconds,
        poolId,
        timeRange: cfg.timeRange ?? null,
    });

    const [resultAtoB, resultBtoA] = await Promise.all([
        kibanaSearch(cfg, queryAtoB),
        kibanaSearch(cfg, queryBtoA),
    ]);

    const candlesAtoB = bucketsToCandles(
        resultAtoB.aggregations?.by_time?.buckets ?? [],
        assetA.precision, assetB.precision
    );

    const candlesBtoARaw = bucketsToCandles(
        resultBtoA.aggregations?.by_time?.buckets ?? [],
        assetB.precision, assetA.precision
    );

    const candlesBtoA = candlesBtoARaw.map(([ts, o, h, l, c, volB]) => {
        const invO = 1 / o;
        const invH = 1 / l;
        const invL = 1 / h;
        const invC = 1 / c;
        const volA = invC > 0 ? (volB / invC) : 0;
        return [ts, invO, invH, invL, invC, volA];
    });

    const merged = [...candlesAtoB, ...candlesBtoA].sort((a, b) => a[0] - b[0]);
    const consolidated = cfg.consolidateByTimestamp ? consolidateCandlesByTimestamp(merged) : merged;

    const nowMs = Date.now();
    const startTs = nowMs - (cfg.lookbackHours * 3600 * 1000);
    return fillCandleGaps(consolidated, cfg.intervalSeconds, startTs, nowMs);
}

async function fetchKibanaClosePrices(params) {
    const candles = await fetchKibanaCandles(params);
    return candles.map(([, , , , close]) => close);
}

module.exports = {
    buildDirectionalQuery,
    bucketsToCandles,
    fetchKibanaCandles,
    fetchKibanaClosePrices,
    DEFAULT_CONFIG,
};
