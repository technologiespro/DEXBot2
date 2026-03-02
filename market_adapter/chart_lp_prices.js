/**
 * CHART LP PRICE DATA
 *
 * Reads the exported LP candle data and generates an interactive Plotly HTML chart.
 * Opens in your default browser automatically.
 *
 * Usage:
 *   node market_adapter/chart_lp_prices.js
 *   node market_adapter/chart_lp_prices.js --file market_adapter/data/lp_prices_BTS_XBTSX_XRP.json
 *   node market_adapter/chart_lp_prices.js --no-open   (generate HTML without opening browser)
 *
 * Chart shows:
 *   - Price line (VWAP per bucket)
 *   - 4 AMA overlays (from profiles/ama_profiles.json)
 *   - AMA deviation % lines (bottom subplot, one per AMA)
 *   - Volume bars (middle subplot)
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');

// AMA from existing analysis module
const { calculateAMA } = require('../analysis/ama_fitting/ama');

// Shared chart HTML generation (also used by analysis/ama_fitting/generate_unified_comparison_chart.js)
const { generateHTML } = require('./lp_chart_core');

const AMA_PROFILES_FILE = path.join(__dirname, '..', 'profiles', 'ama_profiles.json');

function normalizeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function inferIntervalLabel(meta) {
    const sec = Number(meta?.intervalSeconds);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    if (sec % 3600 === 0) return `${Math.round(sec / 3600)}h`;
    if (sec % 60 === 0) return `${Math.round(sec / 60)}m`;
    return `${sec}s`;
}

function loadAmaConfigsFromProfiles(meta) {
    if (!fs.existsSync(AMA_PROFILES_FILE)) return null;

    try {
        const json = JSON.parse(fs.readFileSync(AMA_PROFILES_FILE, 'utf8'));
        const profiles = Array.isArray(json?.profiles) ? json.profiles : [];
        if (profiles.length === 0) return null;

        const assetASymbol = normalizeSymbol(meta?.assetA?.symbol);
        const assetBSymbol = normalizeSymbol(meta?.assetB?.symbol);
        const assetAId = normalizeSymbol(meta?.assetA?.id);
        const assetBId = normalizeSymbol(meta?.assetB?.id);
        const intervalSeconds = Number(meta?.intervalSeconds);
        const intervalLabel = inferIntervalLabel(meta);

        const matches = profiles.filter((p) => {
            const pA = normalizeSymbol(p?.assetA);
            const pB = normalizeSymbol(p?.assetB);
            const pAId = normalizeSymbol(p?.assetAId);
            const pBId = normalizeSymbol(p?.assetBId);

            const bySymbol = assetASymbol && assetBSymbol && pA === assetASymbol && pB === assetBSymbol;
            const byId = assetAId && assetBId && pAId === assetAId && pBId === assetBId;
            return bySymbol || byId;
        });
        if (matches.length === 0) return null;

        const sameInterval = matches.filter((p) => {
            if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && Number(p?.intervalSeconds) === intervalSeconds) return true;
            if (intervalLabel && String(p?.intervalLabel || '').toLowerCase() === intervalLabel.toLowerCase()) return true;
            return false;
        });

        const candidates = sameInterval.length > 0 ? sameInterval : matches;
        const profile = [...candidates].sort((a, b) => {
            const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
            const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
            return bTs - aTs;
        })[0];

        const ama1 = profile?.amas?.AMA1;
        const ama2 = profile?.amas?.AMA2;
        const ama3 = profile?.amas?.AMA3;
        const ama4 = profile?.amas?.AMA4;
        if (!ama1 || !ama2 || !ama3 || !ama4) return null;

        return [
            { name: ama1.name || 'AMA1', erPeriod: ama1.erPeriod, fastPeriod: ama1.fastPeriod, slowPeriod: ama1.slowPeriod, color: '#fb8c00', dash: 'solid', lineWidth: 1.5 },
            { name: ama2.name || 'AMA2', erPeriod: ama2.erPeriod, fastPeriod: ama2.fastPeriod, slowPeriod: ama2.slowPeriod, color: '#42a5f5', dash: 'dash', lineWidth: 2 },
            { name: ama3.name || 'AMA3', erPeriod: ama3.erPeriod, fastPeriod: ama3.fastPeriod, slowPeriod: ama3.slowPeriod, color: '#66bb6a', dash: 'longdash', lineWidth: 1.5 },
            { name: ama4.name || 'AMA4', erPeriod: ama4.erPeriod, fastPeriod: ama4.fastPeriod, slowPeriod: ama4.slowPeriod, color: '#ef5350', dash: 'longdashdot', lineWidth: 1.5 },
        ];
    } catch {
        return null;
    }
}

function loadAmaConfigs(meta) {
    const fromProfiles = loadAmaConfigsFromProfiles(meta);
    if (fromProfiles) return fromProfiles;
    const pair = `${meta?.assetA?.symbol || '?'} / ${meta?.assetB?.symbol || '?'}`;
    throw new Error(`AMA profile not found in profiles/ama_profiles.json for pair ${pair}`);
}

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
    const args   = process.argv.slice(2);
    let dataFile = null;
    let noOpen   = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) {
            dataFile = path.resolve(args[i + 1]);
            i++;
        } else if (args[i] === '--no-open') {
            noOpen = true;
        } else if (!args[i].startsWith('--')) {
            dataFile = path.resolve(args[i]);
        }
    }

    return { dataFile, noOpen };
}

// ─── Find Latest Data File ────────────────────────────────────────────────────

function findDataFile() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) return null;

    const out = [];
    const stack = [dataDir];
    while (stack.length > 0) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            if (!(entry.name.startsWith('lp_pool_') || entry.name.startsWith('lp_prices_'))) continue;
            out.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return out.length > 0 ? out[0].path : null;
}

// ─── Open in Browser ──────────────────────────────────────────────────────────

function openInBrowser(filePath) {
    const url = `file://${filePath}`;
    // Linux: xdg-open, macOS: open, Windows: start
    const cmd = process.platform === 'darwin' ? `open "${url}"` :
                process.platform === 'win32'  ? `start "" "${url}"` :
                                                `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.warn(`  Could not auto-open browser: ${err.message}`);
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function run() {
    const { dataFile: argFile, noOpen } = parseArgs();

    // Locate data file
    const dataFile = argFile ?? findDataFile();
    if (!dataFile) {
        console.error('No data file found. Run fetch first:');
        console.error('  node market_adapter/fetch_lp_data.js');
        process.exit(1);
    }
    if (!fs.existsSync(dataFile)) {
        console.error(`File not found: ${dataFile}`);
        process.exit(1);
    }

    console.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);

    const raw    = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const { meta, candles } = raw;

    if (!candles || candles.length === 0) {
        console.error('No candles in data file.');
        process.exit(1);
    }

    const poolLabel = meta.pool ? `pool ${meta.pool}` : `${meta.assetA.symbol}/${meta.assetB.symbol}`;
    console.log(`  ${candles.length} candles · ${poolLabel}`);

    // Calculate all 4 AMAs on close prices
    const closes = candles.map(c => c[4]);
    const amaConfigs = loadAmaConfigs(meta);
    const amaResults = amaConfigs.map(cfg => ({
        ...cfg,
        values: calculateAMA(closes, cfg),
    }));

    const lastClose = closes[closes.length - 1];
    for (const a of amaResults) {
        const lastAMA  = a.values[a.values.length - 1];
        const deviation = ((lastClose - lastAMA) / lastAMA) * 100;
        console.log(`  ${a.name.padEnd(24)} AMA: ${lastAMA.toFixed(6)}  dev: ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);
    }

    // Generate HTML
    const html    = generateHTML(meta, candles, amaResults);
    const suffix  = meta.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta.assetA.symbol}_${meta.assetB.symbol}`;
    const outFile = path.join(__dirname, `lp_chart_${suffix}.html`).replace(/\./g, '_').replace('_html', '.html');
    fs.writeFileSync(outFile, html);

    console.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);

    if (!noOpen) {
        console.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        console.log(`Open manually: file://${outFile}`);
    }
}

run();
