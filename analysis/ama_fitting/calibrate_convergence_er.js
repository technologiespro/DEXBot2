#!/usr/bin/env node
'use strict';

/**
 * AMA CONVERGENCE ER CALIBRATION
 *
 * Computes the correct AMA_CONVERGENCE_ER_AVG from real LP candle data.
 *
 * The formula `(ER_avg × deltaSC + slowSC)²` suffers from Jensen's inequality:
 * E[f(ER)] ≠ f(E[ER]) when f is convex (x²). The arithmetic mean ER
 * underestimates the true average SC because high-ER periods contribute
 * quadratically more to convergence.
 *
 * This script computes the implied ER — the value that, when plugged into
 * the formula, reproduces the empirical arithmetic SC_avg — and prints
 * the recommended constant for modules/constants.js.
 *
 * Usage:
 *   node analysis/ama_fitting/calibrate_convergence_er.js
 *   node analysis/ama_fitting/calibrate_convergence_er.js --data <lp-file.json>
 *   node analysis/ama_fitting/calibrate_convergence_er.js --data <lp-file.json> --amas AMA3
 */

const fs   = require('fs');
const path = require('path');
const { MARKET_ADAPTER } = require('../../modules/constants');

const DEFAULT_DATA = path.join(__dirname, '..', '..', 'market_adapter', 'data', 'lp',
    '1_3_5537_1_3_0', 'lp_pool_133_1h.json');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { data: DEFAULT_DATA, amas: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--data' && args[i + 1]) opts.data = args[++i];
        if (args[i] === '--amas' && args[i + 1]) opts.amas = args[++i].split(',');
    }
    return opts;
}

function computeSCavg(closes, erPeriod, fastPeriod, slowPeriod) {
    const fastSC = 2 / (fastPeriod + 1);
    const slowSC = 2 / (slowPeriod + 1);
    const deltaSC = fastSC - slowSC;

    let sumSC = 0, count = 0;
    for (let i = erPeriod; i < closes.length; i++) {
        const dir = Math.abs(closes[i] - closes[i - erPeriod]);
        let vol = 0;
        for (let j = i - erPeriod + 1; j <= i; j++) {
            vol += Math.abs(closes[j] - closes[j - 1]);
        }
        const er = vol === 0 ? 0 : dir / vol;
        sumSC += (er * deltaSC + slowSC) ** 2;
        count++;
    }
    return { scAvg: sumSC / count, count };
}

function main() {
    const opts = parseArgs();

    if (!fs.existsSync(opts.data)) {
        console.error('Data file not found:', opts.data);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(opts.data, 'utf8'));
    const closes = (data.candles || []).map(c => Number(c[4]))
        .filter(v => Number.isFinite(v) && v > 0);

    if (closes.length < 100) {
        console.error('Not enough candles (need > 100, got', closes.length + ')');
        process.exit(1);
    }

    const amas = MARKET_ADAPTER.AMAS;
    const keys = opts.amas || Object.keys(amas);
    const eps = MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON;

    console.log(`Data: ${opts.data}`);
    console.log(`Candles: ${closes.length}  |  EPSILON: ${eps}`);
    console.log('');

    // ER distribution (using the first AMA's erPeriod)
    const erP = amas[keys[0]]?.erPeriod || 781;
    const erVals = [];
    {
        for (let i = erP; i < closes.length; i++) {
            const dir = Math.abs(closes[i] - closes[i - erP]);
            let vol = 0;
            for (let j = i - erP + 1; j <= i; j++) vol += Math.abs(closes[j] - closes[j - 1]);
            erVals.push(vol === 0 ? 0 : dir / vol);
        }
        erVals.sort((a, b) => a - b);
    }
    const n = erVals.length;
    const avgER = erVals.reduce((a, b) => a + b) / n;

    console.log('--- ER distribution (erPeriod=' + erP + ') ---');
    console.log(`  p5  ${erVals[Math.floor(0.05 * n)].toFixed(4)}  p50 ${erVals[Math.floor(0.50 * n)].toFixed(4)}  p95 ${erVals[Math.floor(0.95 * n)].toFixed(4)}`);
    console.log(`  avg ${avgER.toFixed(4)}`);
    console.log('');

    console.log('--- Per-AMA SC analysis ---');
    console.log('| AMA   | fastSC  | slowSC  | emp SC_avg | naive SC (E[ER]) | implied ER | conv bars |');
    console.log('|-------|---------|---------|------------|------------------|------------|-----------|');

    const impliedERs = [];

    for (const key of keys) {
        const cfg = amas[key];
        if (!cfg) continue;

        const fastSC = 2 / (cfg.fastPeriod + 1);
        const slowSC = 2 / (cfg.slowPeriod + 1);
        const deltaSC = fastSC - slowSC;

        const { scAvg } = computeSCavg(closes, cfg.erPeriod, cfg.fastPeriod, cfg.slowPeriod);
        const naiveSC = (avgER * deltaSC + slowSC) ** 2;
        const impliedER = Math.max(0, Math.min(1, (Math.sqrt(scAvg) - slowSC) / deltaSC));
        const convBars = Math.ceil(Math.log(eps) / Math.log(1 - scAvg));

        impliedERs.push(impliedER);

        console.log('| ' + key.padEnd(5) + '| ' + fastSC.toFixed(4).padEnd(8) + '| ' + slowSC.toFixed(4).padEnd(8) +
            '| ' + scAvg.toExponential(4).padEnd(11) + '| ' + naiveSC.toExponential(4).padEnd(17) +
            '| ' + impliedER.toFixed(4).padEnd(11) + '| ' + String(convBars).padEnd(10) + '|');
    }

    // Recommended constant
    const recER = impliedERs.reduce((a, b) => a + b) / impliedERs.length;
    const recRounded = Math.round(recER * 1000) / 1000;

    console.log('');
    console.log('--- Recommended constant ---');
    console.log(`  Average implied ER: ${recER.toFixed(4)}`);
    console.log(`  Rounded:            ${recRounded.toFixed(3)}`);
    console.log('');
    console.log(`  Current in constants.js: AMA_CONVERGENCE_ER_AVG = ${MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG}`);
    console.log(`  Suggested update:        AMA_CONVERGENCE_ER_AVG = ${recRounded.toFixed(3)}`);

    // Compare convergence bars: current vs recommended
    console.log('');
    console.log('--- Convergence bars comparison (current vs recommended ER) ---');
    console.log('| AMA   | current ER=' + String(MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG).padEnd(6) + '| rec ER=' + recRounded.toFixed(3).padEnd(6) + '| empirical |');
    console.log('|-------|---------------|---------------|-----------|');

    for (const key of keys) {
        const cfg = amas[key];
        if (!cfg) continue;

        const fastSC = 2 / (cfg.fastPeriod + 1);
        const slowSC = 2 / (cfg.slowPeriod + 1);
        const deltaSC = fastSC - slowSC;

        const { scAvg } = computeSCavg(closes, cfg.erPeriod, cfg.fastPeriod, cfg.slowPeriod);
        const empBars = Math.ceil(Math.log(eps) / Math.log(1 - scAvg));

        const curSC = (MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG * deltaSC + slowSC) ** 2;
        const curBars = Math.ceil(Math.log(eps) / Math.log(1 - curSC));

        const recSC = (recRounded * deltaSC + slowSC) ** 2;
        const recBars = Math.ceil(Math.log(eps) / Math.log(1 - recSC));

        console.log('| ' + key.padEnd(5) + '| ' + String(curBars + cfg.erPeriod).padEnd(14) +
            '| ' + String(recBars + cfg.erPeriod).padEnd(14) +
            '| ' + String(empBars + cfg.erPeriod).padEnd(10) + '|');
    }
}

main();
