#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * AMA REPOSITION FREQUENCY ANALYSIS
 *
 * Simulates AMA_DELTA_THRESHOLD_PERCENT grid-reposition logic for all four AMA
 * series on LP candle data.
 *
 * For each threshold (1%, 2%, 3%, 4%):
 *   - Set a baseline at the first post-warmup AMA value
 *   - Count candle steps until the AMA drifts ≥ threshold from that baseline
 *   - Record the reposition event, reset baseline to current AMA value
 *   - Repeat for the full live window
 *
 * Reports: reposition count, avg/min/max steps between repositions, frequency
 * per 1000 live steps — for each AMA × threshold combination.
 *
 * Usage:
 *   node analysis/ama_fitting/analyze_ama_price_changes.js --data <path-to-lp-candles.json> --results <path-to-optimization-results.json>
 */

const fs   = require('fs');
const path = require('path');
const { calculateAMA } = require('../../market_adapter/core/strategies/ama');

const THRESHOLDS = [1, 2, 3, 4]; // percent

// ── Load data ─────────────────────────────────────────────────────────────────

function loadData(filePath) {
    const json    = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const candles = json.candles ?? json;
    return {
        candles: candles.map(c => ({ timestamp: c[0], close: c[4] })),
        meta: json.meta ?? null,
    };
}

function loadAmaParams(resultsPath) {
    const json = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const amas = json.meta?.amas;
    if (!amas) throw new Error('No amas found in results file');
    return [
        { key: 'AMA1', label: amas.AMA1.label, er: amas.AMA1.er, fast: amas.AMA1.fast, slow: amas.AMA1.slow },
        { key: 'AMA2', label: amas.AMA2.label, er: amas.AMA2.er, fast: amas.AMA2.fast, slow: amas.AMA2.slow },
        { key: 'AMA3', label: amas.AMA3.label, er: amas.AMA3.er, fast: amas.AMA3.fast, slow: amas.AMA3.slow },
        { key: 'AMA4', label: amas.AMA4.label, er: amas.AMA4.er, fast: amas.AMA4.fast, slow: amas.AMA4.slow },
    ];
}

// ── Analysis ──────────────────────────────────────────────────────────────────

/**
 * Simulate AMA_DELTA_THRESHOLD_PERCENT reposition logic.
 *
 * Starting from the first post-warmup AMA value, track cumulative drift from
 * the last reposition baseline.  When drift reaches a threshold, a reposition
 * fires: record the step-count since the previous reposition, then reset the
 * baseline to the current AMA value.
 *
 * Returns { threshold -> { events, steps: number[], min, max, avg } }
 *   events  — total reposition count
 *   steps   — candle steps between consecutive repositions
 *   min/max/avg — statistics on those step-counts
 */
function trackRepositions(amaValues, thresholds, erPeriod) {
    const result = {};
    for (const t of thresholds) {
        result[t] = { events: 0, steps: [], min: Infinity, max: 0, avg: 0 };
    }

    // Each threshold has its own independent baseline + step counter
    const baselines    = {};
    const stepCounters = {};
    for (const t of thresholds) {
        baselines[t]    = amaValues[erPeriod];   // first post-warmup value
        stepCounters[t] = 0;
    }

    for (let i = erPeriod + 1; i < amaValues.length; i++) {
        const curr = amaValues[i];
        for (const t of thresholds) {
            const base = baselines[t];
            if (base === 0) continue;
            stepCounters[t]++;
            const driftPct = Math.abs((curr - base) / base) * 100;
            if (driftPct >= t) {
                const r = result[t];
                r.events++;
                r.steps.push(stepCounters[t]);
                baselines[t]    = curr;
                stepCounters[t] = 0;
            }
        }
    }

    // Compute stats
    for (const t of thresholds) {
        const r = result[t];
        if (r.steps.length === 0) { r.min = 0; r.avg = 0; continue; }
        r.min = Math.min(...r.steps);
        r.max = Math.max(...r.steps);
        r.avg = r.steps.reduce((a, b) => a + b, 0) / r.steps.length;
    }
    return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run() {
    const dataArgIdx    = process.argv.indexOf('--data');
    const resultsArgIdx = process.argv.indexOf('--results');

    if (dataArgIdx === -1) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }
    if (resultsArgIdx === -1) {
        throw new Error('--results <path-to-optimization-results.json> is required');
    }

    const dataFile    = path.resolve(process.argv[dataArgIdx + 1]);
    const resultsFile = path.resolve(process.argv[resultsArgIdx + 1]);

    const { candles, meta } = loadData(dataFile);
    const amaParams         = loadAmaParams(resultsFile);
    const closes            = candles.map(c => c.close);
    const totalSteps        = closes.length - 1; // candle-to-candle transitions

    const label = meta?.pool
        ? `LP Pool ${meta.pool}`
        : path.basename(dataFile, '.json');
    const interval = meta?.intervalSeconds
        ? `${meta.intervalSeconds / 3600}h`
        : '?h';

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log(' AMA Reposition Frequency Analysis  (AMA_DELTA_THRESHOLD_PERCENT simulation)');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log(` Dataset:    ${label}  (${interval} candles)`);
    console.log(` Candles:    ${candles.length}  →  ${totalSteps} steps total`);
    console.log(` Thresholds: ${THRESHOLDS.map(t => `${t}%`).join('  ')}`);
    console.log('');
    console.log(' Logic: set baseline at warmup end, count steps until AMA drifts ≥ threshold,');
    console.log('        record reposition + reset baseline.  Repeat for full live window.');
    console.log('');

    const cW = 10;
    const allResults = [];

    for (const params of amaParams) {
        const values = calculateAMA(closes, {
            erPeriod:   params.er,
            fastPeriod: params.fast,
            slowPeriod: params.slow,
        });

        const repoData  = trackRepositions(values, THRESHOLDS, params.er);
        const liveSteps = totalSteps - params.er;

        const suffix   = String(params.label).replace(/^AMA\d\s*/i, '').replace(/^[-:\s]+/, '').trim();
        const rowLabel = `${params.key} ${suffix}`;

        console.log(` ── ${rowLabel}  (warmup: ${params.er}  live: ${liveSteps} steps) ──`);
        console.log(
            '    ' +
            'threshold'.padEnd(12) +
            'repositions'.padStart(cW) +
            'avg steps'.padStart(cW) +
            'min steps'.padStart(cW) +
            'max steps'.padStart(cW) +
            ' /1000 steps'
        );
        console.log('    ' + '─'.repeat(12 + cW * 4 + 12));

        for (const t of THRESHOLDS) {
            const r    = repoData[t];
            const freq = liveSteps > 0 ? (r.events / liveSteps * 1000).toFixed(1) : '–';
            const avg  = r.events > 0 ? r.avg.toFixed(1) : '–';
            const min  = r.events > 0 ? String(r.min) : '–';
            const max  = r.events > 0 ? String(r.max) : '–';

            console.log(
                '    ' +
                `≥${t}%`.padEnd(12) +
                String(r.events).padStart(cW) +
                avg.padStart(cW) +
                min.padStart(cW) +
                max.padStart(cW) +
                `  ${freq}`
            );

            allResults.push({
                label: `${params.key} ≥${t}%`,
                events: r.events,
                avg: r.avg,
                freq: liveSteps > 0 ? r.events / liveSteps * 1000 : 0,
            });
        }
        console.log('');
    }

    console.log(' Note: warmup candles excluded (AMA initializes from SMA of the ER window).');
    console.log('');

    // ── Ranking: fewest repositions ────────────────────────────────────────────
    allResults.sort((a, b) => a.events - b.events);

    console.log(' Ranking — fewest repositions (least grid changes):');
    console.log('');
    console.log('    ' + '#'.padEnd(4) + 'AMA + threshold'.padEnd(20) + 'repositions'.padStart(12) + 'avg steps'.padStart(10) + ' /1000 steps');
    console.log('    ' + '─'.repeat(4 + 20 + 12 + 10 + 12));
    allResults.forEach((r, i) => {
        console.log(
            '    ' +
            String(i + 1).padEnd(4) +
            r.label.padEnd(20) +
            String(r.events).padStart(12) +
            r.avg.toFixed(1).padStart(10) +
            `  ${r.freq.toFixed(1)}`
        );
    });
    console.log('');
}

run();
export {};
