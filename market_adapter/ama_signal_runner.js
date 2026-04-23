#!/usr/bin/env node
'use strict';

const fs = require('fs');

/**
 * AMA SIGNAL RUNNER
 *
 * Runs one candle-sync cycle (same logic as price_adapter), then returns
 * machine-readable AMA outputs per bot.
 *
 * Usage:
 *   node market_adapter/ama_signal_runner.js
 *   node market_adapter/ama_signal_runner.js --bot XRP-BTS
 *   node market_adapter/ama_signal_runner.js --bot xrp-bts-0 --compact
 */

const { runOnceForAma } = require('./market_adapter');

function printHelp() {
    console.log('AMA signal runner (one cycle): updates candles and returns latest AMA values.');
    console.log('');
    console.log('Usage:');
    console.log('  node market_adapter/ama_signal_runner.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --bot <name|key>           Filter output to a specific bot name or botKey');
    console.log('  --deltaPercent <n>         Override trigger threshold percent');
    console.log('  --bootstrapHours <n>       Kibana bootstrap lookback hours');
    console.log('  --nativeBackfillHours <n>  Native incremental lookback hours');
    console.log('  --maxStaleHours <n>        Max accepted candle staleness');
    console.log('  --sourceRetries <n>        Retries for source calls');
    console.log('  --retryDelayMs <n>         Base retry delay in milliseconds');
    console.log('  --maxPages <n>             Max native history pages');
    console.log('  --pageLimit <n>            Native page size (max 101)');
    console.log('  --compact                  Print compact JSON');
    console.log('  --help, -h                 Show this help');
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        bot: null,
        compact: false,
        overrides: {},
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--bot':
                out.bot = v;
                i++;
                break;
            case '--deltaPercent':
                out.overrides.deltaThresholdPercent = Number(v);
                i++;
                break;
            case '--gridResetFactor':
                throw new Error('--gridResetFactor is no longer supported; use --deltaPercent <percent>');
            case '--bootstrapHours':
                out.overrides.bootstrapLookbackHours = Number(v);
                i++;
                break;
            case '--nativeBackfillHours':
                out.overrides.nativeBackfillHours = Number(v);
                i++;
                break;
            case '--maxStaleHours':
                out.overrides.maxStaleHours = Number(v);
                i++;
                break;
            case '--sourceRetries':
                out.overrides.sourceRetries = Number(v);
                i++;
                break;
            case '--retryDelayMs':
                out.overrides.retryDelayMs = Number(v);
                i++;
                break;
            case '--maxPages':
                out.overrides.maxPages = Number(v);
                i++;
                break;
            case '--pageLimit':
                out.overrides.pageLimit = Number(v);
                i++;
                break;
            case '--compact':
                out.compact = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
        }
    }

    return out;
}

function isFiniteOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

function buildOutput(payload, botFilter) {
    const bots = (payload?.results || []).map((r) => ({
        botName: r.botName,
        botKey: r.botKey,
        ok: !!r.ok,
        source: r.source || null,
        candleCount: Number.isFinite(r.candleCount) ? r.candleCount : null,
        amaPrice: isFiniteOrNull(r.amaPrice),
        previousCenterPrice: isFiniteOrNull(r.previousCenterPrice),
        deltaPercent: isFiniteOrNull(r.deltaPercent),
        thresholdPercent: isFiniteOrNull(r.thresholdPercent),
        finalOffset: isFiniteOrNull(r.weights?.meta?.finalOffset),
        amaSlopeGated: isFiniteOrNull(r.amaSlope?.amaSlopeGated),
        regimeMultiplier: isFiniteOrNull(r.amaSlope?.regimeMultiplier),
        triggered: !!r.triggered,
        triggerPath: r.triggerPath || null,
        reason: r.reason || null,
    }));

    let filtered = bots;
    if (botFilter) {
        const target = String(botFilter).trim().toLowerCase();
        filtered = bots.filter((b) => String(b.botName || '').toLowerCase() === target || String(b.botKey || '').toLowerCase() === target);
    }

    return {
        ok: true,
        updatedAt: payload?.updatedAt || new Date().toISOString(),
        metrics: payload?.metrics || null,
        botCount: filtered.length,
        bots: filtered,
    };
}

async function main() {
    const cli = parseArgs();
    const fixtureRaw = process.env.AMA_SIGNAL_RUNNER_FIXTURE_JSON;
    let payload;
    if (fixtureRaw) {
        payload = JSON.parse(fixtureRaw);
    } else {
        const original = {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
        };
        // Keep stdout clean for JSON output, but preserve diagnostics on stderr.
        console.log = () => {};
        console.warn = original.warn;
        console.error = original.error;
        try {
            payload = await runOnceForAma(cli.overrides);
        } finally {
            console.log = original.log;
            console.warn = original.warn;
            console.error = original.error;
        }
    }
    const out = buildOutput(payload, cli.bot);
    const json = cli.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2);
    fs.writeFileSync(1, `${json}\n`, 'utf8');
    return 0;
}

main().catch((err) => {
    const out = {
        ok: false,
        error: err.message,
    };
    fs.writeFileSync(1, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    process.exitCode = 1;
});
