/**
 * KIBANA MARKET CANDLES
 *
 * Fetches OHLCV candles from order book fill operations (op_type 4)
 * for any asset pair on BitShares. Unlike kibana_source.js which handles
 * LP pool swaps (op_type 63), this module handles regular limit order fills.
 *
 * Use case: historical price candles for MPA/BTS markets where the margin
 * trading system needs trend detection input beyond just the current
 * on-chain feed price.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*
 *   Operation type: 4 (fill_order)
 *
 * ES field paths for fill_order:
 *   op_object.pays.amount    – integer amount paid
 *   op_object.pays.asset_id  – asset ID paid
 *   op_object.receives.amount     – integer amount received
 *   op_object.receives.asset_id   – asset ID received
 *   op_object.account_id          – whose order was filled
 *   op_object.order_id            – the limit order that filled
 *
 * Output: [[timestamp_ms, open, high, low, close, volume_base], ...]
 * Same OHLCV format as kibana_source.js for compatibility with candle_utils.
 */

'use strict';

const { kibanaSearch, toFixedInterval, DEFAULT_CONFIG: BASE_CONFIG } = require('./kibana_client');
const { fillCandleGaps } = require('../candle_utils');

const OP_FILL_ORDER = 4;

const DEFAULT_CONFIG = {
  ...BASE_CONFIG,
  intervalSeconds: 3600,   // 1h candles
  lookbackHours:   500,    // ~20 days
  consolidateByTimestamp: true,
};

// ─── Query Builders ──────────────────────────────────────────────────────────

/**
 * Build ES query for fill_order aggregation in one direction.
 *
 * Filters fills where pays.asset_id = soldAssetId, aggregates by time bucket:
 *   sum_sold     = Σ pays.amount
 *   sum_received = Σ receives.amount
 *
 * VWAP per bucket = sum_received / sum_sold (precision-adjusted externally).
 *
 * @param {string}      soldAssetId    – e.g. '1.3.0' (BTS)
 * @param {string}      receivedAssetId – e.g. '1.3.5649' (HONEST.USD)
 * @param {number}      lookbackHours
 * @param {number}      intervalSeconds
 * @param {Object|null} timeRange      – { gte, lte } ISO strings
 */
function buildFillCandleQuery(soldAssetId, receivedAssetId, lookbackHours, intervalSeconds, timeRange = null) {
  const rangeValue = timeRange
    ? { gte: timeRange.gte, lte: timeRange.lte }
    : { gte: `now-${lookbackHours}h`, lte: 'now' };

  return {
    size: 0,
    query: {
      bool: {
        filter: [
          { term:  { operation_type: OP_FILL_ORDER } },
          { term:  { 'operation_history.op_object.pays.asset_id.keyword': soldAssetId } },
          { term:  { 'operation_history.op_object.receives.asset_id.keyword': receivedAssetId } },
          { range: { 'block_data.block_time': rangeValue } },
        ],
      },
    },
    aggs: {
      by_time: {
        date_histogram: {
          field:          'block_data.block_time',
          fixed_interval: toFixedInterval(intervalSeconds),
          min_doc_count:  1,
        },
        aggs: {
          sum_sold: {
            sum: { field: 'operation_history.op_object.pays.amount' },
          },
          sum_received: {
            sum: { field: 'operation_history.op_object.receives.amount' },
          },
        },
      },
    },
  };
}

// ─── Bucket → Candle ─────────────────────────────────────────────────────────

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
    last[4] = close;                     // close (latest)
    last[5] += volume;                   // volume sum
  }

  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch bidirectional fill candles for an asset pair.
 *
 * Queries both directions (A→B fills and B→A fills), inverts B→A to
 * unified "B per A" pricing, merges by timestamp.
 *
 * @param {Object} assetA  – { id: '1.3.0', precision: 5, symbol: 'BTS' }
 * @param {Object} assetB  – { id: '1.3.5649', precision: 4, symbol: 'HONEST.USD' }
 * @param {Object} [config]
 * @returns {Promise<Array>} OHLCV candles in B-per-A units
 */
async function getMarketCandles(assetA, assetB, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Direction 1: A sold → B received (price = B/A)
  const queryAtoB = buildFillCandleQuery(
    assetA.id, assetB.id,
    cfg.lookbackHours, cfg.intervalSeconds, cfg.timeRange ?? null
  );

  // Direction 2: B sold → A received (price = A/B, needs inversion)
  const queryBtoA = buildFillCandleQuery(
    assetB.id, assetA.id,
    cfg.lookbackHours, cfg.intervalSeconds, cfg.timeRange ?? null
  );

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

  // Invert B→A: price was A-per-B → convert to B-per-A
  const candlesBtoA = candlesBtoARaw.map(([ts, o, h, l, c, volB]) => {
    const invO = 1 / o;
    const invH = 1 / l;   // high/low swap on inversion
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
 * Close prices only — convenience wrapper for AMA / trend analyzer input.
 */
async function getMarketClosePrices(assetA, assetB, config = {}) {
  const candles = await getMarketCandles(assetA, assetB, config);
  return candles.map(([, , , , close]) => close);
}

/**
 * Fetch candles for an MPA/BTS market using symbol strings.
 * Resolves asset objects internally using chain queries if available,
 * or accepts pre-resolved asset objects.
 *
 * @param {Object} baseAsset   – { id, precision, symbol } for BTS
 * @param {Object} quoteAsset  – { id, precision, symbol } for the MPA
 * @param {Object} [config]
 * @returns {Promise<Array>} OHLCV candles (quote-per-base, e.g. HONEST.USD per BTS)
 */
async function getMpaCandles(baseAsset, quoteAsset, config = {}) {
  return getMarketCandles(baseAsset, quoteAsset, config);
}

module.exports = {
  // Primary API
  getMarketCandles,
  getMarketClosePrices,
  getMpaCandles,

  // Low-level (testing / custom queries)
  buildFillCandleQuery,
  bucketsToCandles,
};
