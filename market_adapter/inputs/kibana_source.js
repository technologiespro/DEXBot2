/**
 * KIBANA ELASTICSEARCH SOURCE
 *
 * Fetches liquidity pool price data from the public BitShares Kibana instance.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*  (time field: block_data.block_time)
 *
 * LP swap operations (op_type 63 = liquidity_pool_exchange):
 *   Field: operation_history.op_object.pool.keyword          → pool ID  (e.g. '1.19.133')
 *   Field: operation_history.op_object.amount_to_sell        → what went INTO the pool
 *   Field: operation_history.operation_result_object         → actual amounts received (not min)
 *          .data_object.received.amount / .asset_id
 *
 * Price per bucket = sum(actual_received) / sum(sold)  — both precision-adjusted.
 * We query both swap directions (A→B and B→A), invert one side, merge into
 * a unified series expressed as "B per A".
 *
 * Output: [[timestamp_ms, open, high, low, close, volume_A], ...]
 * open=high=low=close=VWAP (bucket aggregation, not tick-level).
 * Compatible with calculateAMA() close-price input.
 *
 * Auth:
 *   Kibana saved_objects API is open. The search proxy may need an API key.
 *   If you get 401/403: Kibana → Stack Management → API Keys → Create.
 *   Pass via config.apiKey (base64-encoded "id:key").
 */

'use strict';

const { kibanaSearch, toFixedInterval, DEFAULT_CONFIG: BASE_CONFIG } = require('../core/kibana_client');
const { fillCandleGaps } = require('../candle_utils');

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_TYPE_LP = 63;  // liquidity_pool_exchange

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,   // bucket size (3600=1h, 14400=4h, 86400=1d)
    lookbackHours:   500,    // how far back (~20 days at 1h)
    consolidateByTimestamp: true,
};

// ─── Pool ID normalizer ───────────────────────────────────────────────────────

/**
 * Accept pool IDs as short number (133) or full ID (1.19.133).
 * Always returns full form '1.19.XXX'.
 */
function normalizePoolId(id) {
    if (id == null) return null;
    const s = String(id).trim();
    return s.startsWith('1.19.') ? s : `1.19.${s}`;
}

// ─── Query Builder ────────────────────────────────────────────────────────────

/**
 * Build the ES aggregation query for LP swaps in one direction.
 *
 * Filters (all required):
 *   operation_type = 63
 *   amount_to_sell.asset_id = soldAssetId   ← direction selector
 *   block_data.block_time in [now-lookbackHours, now]
 *
 * Optional filter:
 *   pool.keyword = poolId                   ← scope to a specific LP pool
 *
 * Aggregation:
 *   date_histogram → per bucket:
 *     sum_sold     = Σ amount_to_sell.amount              (integer, divide by soldPrecision)
 *     sum_received = Σ operation_result_object.received   (actual received, not min requested)
 *
 * Using operation_result_object.data_object.received.amount instead of
 * min_to_receive.amount gives the true executed amount from the pool formula,
 * not the user's minimum threshold.
 *
 * @param {string}      soldAssetId
 * @param {number}      lookbackHours
 * @param {number}      intervalSeconds
 * @param {string|null} poolId          - full pool ID e.g. '1.19.133', or null for any pool
 */
function buildQuery(soldAssetId, lookbackHours, intervalSeconds, poolId = null, timeRange = null, receivedAssetId = null) {
    const rangeValue = timeRange
        ? { gte: timeRange.gte, lte: timeRange.lte }
        : { gte: `now-${lookbackHours}h`, lte: 'now' };

    const filters = [
        { term:  { operation_type: OP_TYPE_LP } },
        { term:  { 'operation_history.op_object.amount_to_sell.asset_id.keyword': soldAssetId } },
        { range: { 'block_data.block_time': rangeValue } },
    ];

    if (poolId) {
        filters.push({ term: { 'operation_history.op_object.pool.keyword': poolId } });
    }

    if (receivedAssetId) {
        filters.push({ term: { 'operation_history.op_object.min_to_receive.asset_id.keyword': receivedAssetId } });
    }

    return {
        size: 0,
        query: { bool: { filter: filters } },
        aggs: {
            by_time: {
                date_histogram: {
                    field:          'block_data.block_time',
                    fixed_interval: toFixedInterval(intervalSeconds),
                    min_doc_count:  1,
                },
                aggs: {
                    sum_sold: {
                        sum: { field: 'operation_history.op_object.amount_to_sell.amount' },
                    },
                    // Actual received from operation result — more accurate than min_to_receive
                    sum_received: {
                        sum: { field: 'operation_history.operation_result_object.data_object.received.amount' },
                    },
                },
            },
        },
    };
}

/**
 * Build a discovery query: find the asset IDs that have been sold into a pool.
 * Returns a terms aggregation on amount_to_sell.asset_id — should yield exactly 2 buckets.
 */
function buildDiscoveryQuery(poolId, lookbackHours) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_TYPE_LP } },
                    { term:  { 'operation_history.op_object.pool.keyword': poolId } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            sold_assets: {
                terms: {
                    field: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
                    size:  5,
                },
            },
        },
    };
}

// ─── Bucket → Candle ──────────────────────────────────────────────────────────

function bucketsToCandles(buckets, soldPrecision, receivedPrecision) {
    const soldScale = Math.pow(10, soldPrecision);
    const recvScale = Math.pow(10, receivedPrecision);

    return buckets
        .filter((b) => b.sum_sold.value > 0 && b.sum_received.value > 0)
        .map((b) => {
            const soldAmt = b.sum_sold.value     / soldScale;
            const recvAmt = b.sum_received.value / recvScale;
            const vwap    = recvAmt / soldAmt;
            return [b.key, vwap, vwap, vwap, vwap, soldAmt];
            //      ts    open  high  low  close  volume
        });
}

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
        last[2] = Math.max(last[2], high);   // high
        last[3] = Math.min(last[3], low);    // low
        last[4] = close;                     // close (latest in bucket)
        last[5] += volume;                   // volume sum
    }

    return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-discover the two asset IDs for a pool by looking at what has been sold
 * into it. Returns an array of asset ID strings, e.g. ['1.3.0', '1.3.3926'].
 *
 * @param {string|number} poolId      - '1.19.133' or just 133
 * @param {Object}        [config]
 * @returns {Promise<string[]>}       - the 2 asset IDs found in this pool
 */
async function discoverPoolAssets(poolId, config = {}) {
    const cfg      = { ...DEFAULT_CONFIG, ...config };
    const fullId   = normalizePoolId(poolId);
    const query    = buildDiscoveryQuery(fullId, cfg.lookbackHours);
    const result   = await kibanaSearch(cfg, query);
    const buckets  = result.aggregations?.sold_assets?.buckets ?? [];
    return buckets.map((b) => b.key);
}

/**
 * Fetch candles for one swap direction in a specific pool.
 *
 * @param {string}  poolId           - full pool ID e.g. '1.19.133'
 * @param {string}  soldAssetId
 * @param {number}  soldPrecision
 * @param {number}  receivedPrecision
 * @param {Object}  config
 */
async function getLpCandles(poolId, soldAssetId, soldPrecision, receivedPrecision, config = {}, receivedAssetId = null) {
    const cfg     = { ...DEFAULT_CONFIG, ...config };
    const query   = buildQuery(soldAssetId, cfg.lookbackHours, cfg.intervalSeconds, poolId, cfg.timeRange ?? null, receivedAssetId);
    const result  = await kibanaSearch(cfg, query);
    const buckets = result.aggregations?.by_time?.buckets ?? [];
    return bucketsToCandles(buckets, soldPrecision, receivedPrecision);
}

/**
 * Fetch bidirectional LP price candles for a specific pool.
 *
 * A→B swaps: price = B_received / A_sold           (B per A)
 * B→A swaps: inverted B_sold / A_received          (also B per A)
 * Both merged and sorted by timestamp.
 *
 * @param {string|number} poolId  - '1.19.133' or 133
 * @param {Object}        assetA  - { id: '1.3.0', precision: 5, symbol: 'BTS' }
 * @param {Object}        assetB  - { id: '1.3.3926', precision: 8, symbol: 'XBTSX.XRP' }
 * @param {Object}        [config]
 * @returns {Promise<Array>}      OHLCV candles
 */
async function getLpCandlesForPool(poolId, assetA, assetB, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const fullId = normalizePoolId(poolId);

    // When poolId is null (any-pool path), filter on the counterpart asset
    // to avoid mixing swaps from unrelated pools.
    const pairScopeA = fullId ? null : assetB.id;
    const pairScopeB = fullId ? null : assetA.id;

    const [candlesAtoB, candlesBtoARaw] = await Promise.all([
        getLpCandles(fullId, assetA.id, assetA.precision, assetB.precision, cfg, pairScopeA),
        getLpCandles(fullId, assetB.id, assetB.precision, assetA.precision, cfg, pairScopeB),
    ]);

    // Invert B→A candles: price was A-per-B → convert to B-per-A
    // high/low swap on inversion: 1/low_price > 1/high_price
    // Convert volume from B-units to A-units for consistent merged volume_A.
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

    // Fill gaps and stretch to full requested range (lookbackHours)
    const nowMs = Date.now();
    const startTs = nowMs - (cfg.lookbackHours * 3600 * 1000);
    return fillCandleGaps(consolidated, cfg.intervalSeconds, startTs, nowMs);
}

/**
 * Close prices only — convenience wrapper for AMA input.
 *
 * @param {string|number} poolId
 * @param {Object}        assetA
 * @param {Object}        assetB
 * @param {Object}        [config]
 * @returns {Promise<number[]>}
 */
async function getLpClosePricesForPool(poolId, assetA, assetB, config = {}) {
    const candles = await getLpCandlesForPool(poolId, assetA, assetB, config);
    return candles.map(([, , , , close]) => close);
}

/**
 * Diagnostic: raw ES buckets for one direction in one pool.
 * Useful for verifying field values before building price logic.
 *
 * @param {string|number} poolId
 * @param {string}        soldAssetId
 * @param {Object}        [config]
 */
async function getRawBuckets(poolId, soldAssetId, config = {}) {
    const cfg    = { ...DEFAULT_CONFIG, ...config };
    const fullId = normalizePoolId(poolId);
    const query  = buildQuery(soldAssetId, cfg.lookbackHours, cfg.intervalSeconds, fullId);
    const result = await kibanaSearch(cfg, query);
    return result.aggregations?.by_time?.buckets ?? [];
}

/**
 * Bidirectional candles scoped to an asset pair (any pool).
 * Retained for analysis tooling that is not pool-id scoped.
 */
async function getLpCandlesBidirectional(assetA, assetB, config = {}) {
    return getLpCandlesForPool(null, assetA, assetB, config);
}

async function getLpClosePrices(assetA, assetB, config = {}) {
    return getLpClosePricesForPool(null, assetA, assetB, config);
}

module.exports = {
    // Pool-centric API (preferred)
    discoverPoolAssets,
    getLpCandlesForPool,
    getLpClosePricesForPool,
    getRawBuckets,

    // Asset-pair API (any pool)
    getLpCandlesBidirectional,
    getLpClosePrices,

    // Low-level (testing / custom queries)
    kibanaSearch,
    buildQuery,
    normalizePoolId,
};
