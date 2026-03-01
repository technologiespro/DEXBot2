#!/usr/bin/env node
'use strict';

const kibanaSource = require('./kibana_source');
const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const {
    buildOutputPath,
    toIntervalLabel,
    tradesToCandles,
    writeCandlesJson,
    writeCandlesCsv,
} = require('./candle_utils');

const DEFAULTS = {
    pool: '133',
    hours: 24,
    limit: 1000,
    apiKey: null,
    intervalSeconds: 3600,
    saveCandles: false,
    out: null,
    csv: false,
};

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = { ...DEFAULTS };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];
        switch (arg) {
            case '--pool':
                cfg.pool = val;
                i++;
                break;
            case '--hours':
                cfg.hours = Number(val);
                i++;
                break;
            case '--limit':
                cfg.limit = Number(val);
                i++;
                break;
            case '--apiKey':
                cfg.apiKey = val;
                i++;
                break;
            case '--interval':
                cfg.intervalSeconds = val === '1h' ? 3600 : Number(val);
                i++;
                break;
            case '--saveCandles':
                cfg.saveCandles = true;
                break;
            case '--out':
                cfg.out = val;
                i++;
                break;
            case '--csv':
                cfg.csv = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
        }
    }

    if (!Number.isFinite(cfg.hours) || cfg.hours <= 0) {
        throw new Error('--hours must be a positive number');
    }
    if (!Number.isFinite(cfg.limit) || cfg.limit <= 0) {
        throw new Error('--limit must be a positive number');
    }
    if (!Number.isFinite(cfg.intervalSeconds) || cfg.intervalSeconds <= 0) {
        throw new Error('--interval must be a positive number of seconds (or 1h)');
    }

    return cfg;
}

function printHelp() {
    console.log('Fetch LP trades from Kibana API (no local files), last N hours.');
    console.log('');
    console.log('Usage:');
    console.log('  node market_adapter/kibana_api.js [--pool 133] [--hours 24] [--limit 1000] [--apiKey <base64>]');
    console.log('');
    console.log('Options:');
    console.log('  --pool   LP pool id (short or full), default 133');
    console.log('  --hours  Time window in hours, default 24');
    console.log('  --limit  Max trades to fetch, default 1000');
    console.log('  --apiKey Kibana API key if required');
    console.log('  --interval Candle interval (seconds or 1h), default 3600');
    console.log('  --saveCandles Save OHLCV file for analysis');
    console.log('  --out    Output JSON path (optional)');
    console.log('  --csv    Also save CSV next to JSON');
}

async function resolvePoolAssets(poolId) {
    await waitForConnected(30000);
    const [pool] = await BitShares.db.get_objects([poolId]);
    if (!pool?.asset_a || !pool?.asset_b) {
        throw new Error(`Pool not found on chain: ${poolId}`);
    }
    const assets = await BitShares.db.get_objects([pool.asset_a, pool.asset_b]);
    const map = new Map((assets || []).filter(Boolean).map((a) => [a.id, a]));
    const a = map.get(pool.asset_a);
    const b = map.get(pool.asset_b);
    if (!a || !b) throw new Error(`Failed to resolve pool assets for ${poolId}`);
    return {
        assetA: { id: a.id, precision: a.precision, symbol: a.symbol || a.id },
        assetB: { id: b.id, precision: b.precision, symbol: b.symbol || b.id },
    };
}

function formatTs(isoLike) {
    const ms = Date.parse(isoLike);
    if (Number.isNaN(ms)) return String(isoLike);
    return new Date(ms).toISOString();
}

function buildTradesQuery(poolId, hours, limit) {
    return {
        size: limit,
        track_total_hits: true,
        query: {
            bool: {
                filter: [
                    { term: { operation_type: 63 } },
                    { term: { 'operation_history.op_object.pool.keyword': poolId } },
                    { range: { 'block_data.block_time': { gte: `now-${hours}h`, lte: 'now' } } },
                ],
            },
        },
        _source: [
            'block_data.block_time',
            'operation_history.op_object.account',
            'operation_history.op_object.amount_to_sell.amount',
            'operation_history.op_object.amount_to_sell.asset_id',
            'operation_history.op_object.min_to_receive.amount',
            'operation_history.op_object.min_to_receive.asset_id',
            'operation_history.operation_result_object.data_object.received',
            'operation_history.op_object.pool',
        ],
    };
}

async function main() {
    const cfg = parseArgs();
    const poolId = kibanaSource.normalizePoolId(cfg.pool);

    console.log('=== LP Trades API Test (Kibana only) ===');
    console.log(`Pool:   ${poolId}`);
    console.log(`Window: last ${cfg.hours}h`);
    console.log(`Limit:  ${cfg.limit} trades`);

    const esQuery = buildTradesQuery(poolId, cfg.hours, cfg.limit);
    const result = await kibanaSource.kibanaSearch({ apiKey: cfg.apiKey }, esQuery);
    const hits = result?.hits?.hits || [];

    console.log(`LP trades fetched: ${hits.length}`);
    if (hits.length === 0) {
        console.log('No LP trades in the selected window.');
        return;
    }

    const sortedAsc = hits.slice().sort((a, b) => {
        const ta = Date.parse(a?._source?.block_data?.block_time || '');
        const tb = Date.parse(b?._source?.block_data?.block_time || '');
        return ta - tb;
    });

    const firstTs = sortedAsc[0]?._source?.block_data?.block_time;
    const lastTs = sortedAsc[sortedAsc.length - 1]?._source?.block_data?.block_time;

    console.log(`First trade: ${formatTs(firstTs)}`);
    console.log(`Last trade:  ${formatTs(lastTs)}`);
    console.log('');
    console.log('Last 20 LP trades (raw amounts):');

    const sample = sortedAsc.slice(-20);
    sample.forEach((hit) => {
        const src = hit._source || {};
        const op = src.operation_history?.op_object || {};
        const res = src.operation_history?.operation_result_object?.data_object || {};
        const sell = op.amount_to_sell || {};
        const minRecv = op.min_to_receive || {};
        const recv = Array.isArray(res.received) ? res.received[0] : (res.received || {});

        console.log(
            `${formatTs(src.block_data?.block_time)} | ${hit._id} | ` +
            `sell ${sell.amount || 0} ${sell.asset_id || '?'} -> ` +
            `min ${minRecv.amount || 0} ${minRecv.asset_id || '?'} | ` +
            `actual ${recv.amount || 0} ${recv.asset_id || '?'}`
        );
    });

    if (cfg.saveCandles) {
        const { assetA, assetB } = await resolvePoolAssets(poolId);
        const trades = sortedAsc.map((hit) => {
            const src = hit._source || {};
            const op = src.operation_history?.op_object || {};
            const res = src.operation_history?.operation_result_object?.data_object || {};
            const recv = Array.isArray(res.received) ? res.received[0] : (res.received || {});
            return {
                tsMs: Date.parse(src.block_data?.block_time || ''),
                sell: op.amount_to_sell || null,
                received: recv || null,
            };
        });

        const candles = tradesToCandles(trades, assetA, assetB, cfg.intervalSeconds);
        const outPath = cfg.out || buildOutputPath(poolId, cfg.intervalSeconds, 'json');
        writeCandlesJson(outPath, {
            meta: {
                fetchedAt: new Date().toISOString(),
                source: `kibana_api.js (${poolId}, op_type 63)` ,
                pool: poolId,
                assetA,
                assetB,
                intervalSeconds: cfg.intervalSeconds,
                lookbackHours: cfg.hours,
                candleCount: candles.length,
                priceUnit: `${assetB.symbol} per ${assetA.symbol}`,
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles,
        });
        console.log('');
        console.log(`Saved candles JSON: ${outPath}`);
        if (cfg.csv) {
            const csvPath = outPath.replace(/\.json$/i, '.csv');
            writeCandlesCsv(csvPath, candles);
            console.log(`Saved candles CSV:  ${csvPath}`);
        }
        console.log(`Interval: ${toIntervalLabel(cfg.intervalSeconds)}, Candles: ${candles.length}`);
    }
}

main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
