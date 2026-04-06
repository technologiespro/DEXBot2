#!/usr/bin/env node
'use strict';

const { BitShares, waitForConnected } = require('../../modules/bitshares_client');
const {
    buildOutputPath,
    toIntervalLabel,
    tradesToCandles,
    writeCandlesJson,
    writeCandlesCsv,
} = require('../candle_utils');
const { normalizePoolId } = require('./kibana_source');

const OP_TYPE_LP_EXCHANGE = 63;
const API_MAX_LIMIT = 101;

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = {
        pool: '133',
        hours: 24,
        pageLimit: 100,
        maxPages: 200,
        intervalSeconds: 3600,
        saveCandles: false,
        out: null,
        csv: false,
    };

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
            case '--pageLimit':
                cfg.pageLimit = Number(val);
                i++;
                break;
            case '--maxPages':
                cfg.maxPages = Number(val);
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
    if (!Number.isFinite(cfg.pageLimit) || cfg.pageLimit <= 0) {
        throw new Error('--pageLimit must be a positive number');
    }
    if (cfg.pageLimit > API_MAX_LIMIT) {
        cfg.pageLimit = API_MAX_LIMIT;
    }

    if (!Number.isFinite(cfg.maxPages) || cfg.maxPages <= 0) {
        throw new Error('--maxPages must be a positive number');
    }
    if (!Number.isFinite(cfg.intervalSeconds) || cfg.intervalSeconds <= 0) {
        throw new Error('--interval must be a positive number of seconds (or 1h)');
    }

    return cfg;
}

function printHelp() {
    console.log('Fetch LP swap trades from native BitShares history API (no Kibana).');
    console.log('');
    console.log('Usage:');
    console.log('  node market_adapter/native_api.js --pool 133 --hours 24');
    console.log('');
    console.log('Options:');
    console.log('  --pool       LP pool id (short or full), default 133');
    console.log('  --hours      Lookback window in hours, default 24');
    console.log('  --pageLimit  API page size (max 101), default 100');
    console.log('  --maxPages   Safety cap for pagination, default 200');
    console.log('  --interval   Candle interval (seconds or 1h), default 3600');
    console.log('  --saveCandles Save OHLCV file for analysis');
    console.log('  --out        Output JSON path (optional)');
    console.log('  --csv        Also save CSV next to JSON');
}

function parseChainTimeToMs(chainTime) {
    if (!chainTime) return Number.NaN;
    return Date.parse(`${chainTime}Z`);
}

function fmt(isoNoZ) {
    const ms = parseChainTimeToMs(isoNoZ);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : String(isoNoZ);
}

async function fetchPage(poolId, pageLimit, startSequenceInclusive) {
    if (startSequenceInclusive == null) {
        return BitShares.history.get_liquidity_pool_history(
            poolId,
            null,
            null,
            pageLimit,
            OP_TYPE_LP_EXCHANGE
        );
    }

    return BitShares.history.get_liquidity_pool_history_by_sequence(
        poolId,
        startSequenceInclusive,
        null,
        pageLimit,
        OP_TYPE_LP_EXCHANGE
    );
}

async function resolvePoolAssets(poolId) {
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

function extractTrade(row) {
    const opPayload = Array.isArray(row?.op?.op) ? row.op.op[1] : null;
    const resultPayload = Array.isArray(row?.op?.result) ? row.op.result[1] : null;
    const paid = Array.isArray(resultPayload?.paid) ? resultPayload.paid[0] : null;
    const received = Array.isArray(resultPayload?.received) ? resultPayload.received[0] : null;

    return {
        sequence: row.sequence,
        blockTime: row.op?.block_time || row.time,
        blockNum: row.op?.block_num,
        account: opPayload?.account,
        sell: opPayload?.amount_to_sell || null,
        minReceive: opPayload?.min_to_receive || null,
        paid: paid || null,
        received: received || null,
    };
}

async function main() {
    const cfg = parseArgs();
    const poolId = normalizePoolId(cfg.pool);
    const cutoffMs = Date.now() - (cfg.hours * 60 * 60 * 1000);

    console.log('=== LP Trades (Native BitShares API) ===');
    console.log(`Pool:      ${poolId}`);
    console.log(`Window:    last ${cfg.hours}h`);
    console.log(`Page size: ${cfg.pageLimit} (API max ${API_MAX_LIMIT})`);

    await waitForConnected(30000);

    let startSeq = null;
    let pages = 0;
    const trades = [];

    while (pages < cfg.maxPages) {
        const page = await fetchPage(poolId, cfg.pageLimit, startSeq);
        if (!Array.isArray(page) || page.length === 0) break;

        pages++;
        let hitOlderThanWindow = false;

        for (const row of page) {
            const ts = parseChainTimeToMs(row.time);
            if (!Number.isFinite(ts)) continue;
            if (ts < cutoffMs) {
                hitOlderThanWindow = true;
                break;
            }
            trades.push(extractTrade(row));
        }

        const last = page[page.length - 1];
        if (!last || typeof last.sequence !== 'number' || last.sequence === 0) break;
        if (hitOlderThanWindow) break;

        startSeq = last.sequence - 1;
    }

    trades.sort((a, b) => parseChainTimeToMs(a.blockTime) - parseChainTimeToMs(b.blockTime));

    console.log(`Pages fetched: ${pages}`);
    console.log(`Trades found:  ${trades.length}`);

    if (trades.length === 0) {
        console.log('No LP trades found in window.');
        return;
    }

    console.log(`First trade:   ${fmt(trades[0].blockTime)}`);
    console.log(`Last trade:    ${fmt(trades[trades.length - 1].blockTime)}`);
    console.log('');
    console.log('Last 20 trades:');

    trades.slice(-20).forEach((t) => {
        console.log(
            `${fmt(t.blockTime)} | seq ${t.sequence} | ` +
            `sell ${t.sell?.amount || 0} ${t.sell?.asset_id || '?'} -> ` +
            `min ${t.minReceive?.amount || 0} ${t.minReceive?.asset_id || '?'} | ` +
            `actual ${t.received?.amount || 0} ${t.received?.asset_id || '?'}`
        );
    });

    if (cfg.saveCandles) {
        const { assetA, assetB } = await resolvePoolAssets(poolId);
        const candleTrades = trades.map((t) => ({
            tsMs: parseChainTimeToMs(t.blockTime),
            sell: t.sell,
            received: t.received,
        }));
        const candles = tradesToCandles(candleTrades, assetA, assetB, cfg.intervalSeconds);
        const outPath = cfg.out || buildOutputPath(poolId, cfg.intervalSeconds, 'json');
        writeCandlesJson(outPath, {
            meta: {
                fetchedAt: new Date().toISOString(),
                source: `native_api.js (${poolId}, history_api op_type 63)`,
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

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    });
