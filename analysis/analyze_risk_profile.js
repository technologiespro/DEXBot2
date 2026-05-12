#!/usr/bin/env node

/**
 * RISK PROFILE ANALYZER
 *
 * Unified utility to measure historical inventory drift (divergence quantiles
 * and max divergence) to characterize risk bounds and establish safe ranges.
 */

'use strict';

const fs = require('fs');
const { calculateAMA } = require('./ama_fitting/ama');
const { MARKET_ADAPTER } = require('../modules/constants');
const { generateHTML } = require('../market_adapter/lp_chart_core');

function getDivergenceDist(closes, amaConfig) {
    const amaValues = calculateAMA(closes, amaConfig);
    const dists = [];
    // Skip initial warmup
    for (let i = 1600; i < closes.length; i++) {
        const ama = amaValues[i];
        if (!ama) continue;
        dists.push(Math.abs(closes[i] - ama) / ama);
    }
    return dists.sort((a, b) => a - b);
}

function main() {
    const args = process.argv.slice(2);
    
    const dataIdx = args.indexOf('--data');
    const dataPath = dataIdx !== -1 ? args[dataIdx + 1] : null;

    if (!dataPath) {
        console.error('Usage: node analysis/analyze_risk_profile.js --data <path_to_json> [--ama <AMA_PRESET>] [--output <output_path>]');
        process.exit(1);
    }

    const amaIdx = args.indexOf('--ama');
    const selectedAma = amaIdx !== -1 ? args[amaIdx + 1] : 'AMA3';
    
    const outIdx = args.indexOf('--output');
    const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
    
    if (!fs.existsSync(dataPath)) {
        console.error(`Data file not found: ${dataPath}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (!data.candles || !Array.isArray(data.candles)) {
        console.error('Invalid data format: Expected "candles" array.');
        process.exit(1);
    }
    const closes = data.candles.map(c => Number(c[4]));

    const presets = ['AMA1', 'AMA2', 'AMA3', 'AMA4'];
    const quantiles = [0.999, 0.9999, 0.99999];

    console.log(`Analyzing: ${dataPath}`);
    console.log('Preset, Max_Divergence(x), 99.9% (Soft), 99.99% (Hard), 99.999% (Emergency)');
    presets.forEach(name => {
        const config = MARKET_ADAPTER.AMAS[name];
        const allDists = getDivergenceDist(closes, config);
        
        if (allDists.length === 0) {
            console.log(`${name}, N/A, N/A, N/A, N/A`);
            return;
        }

        const maxDist = allDists[allDists.length - 1];
        const quantileResults = quantiles.map(q => {
            const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
            return `${(1 + val).toFixed(3)}x`;
        });

        console.log(`${name}, ${(1 + maxDist).toFixed(3)}x, ${quantileResults.join(', ')}`);
    });

    if (outPath) {
        if (!MARKET_ADAPTER.AMAS[selectedAma]) {
            console.error(`Invalid AMA preset for output: ${selectedAma}. Choose from: ${Object.keys(MARKET_ADAPTER.AMAS).join(', ')}`);
            process.exit(1);
        }
        
        const config = MARKET_ADAPTER.AMAS[selectedAma];
        const amaValues = calculateAMA(closes, config);
        const candleArrays = data.candles.map(c => [c[0], c[1], c[2], c[3], c[4], c[5]]);
        
        // Calculate thresholds for display
        const allDists = getDivergenceDist(closes, config);
        const quantiles = [0.999, 0.9999, 0.99999];
        const thresholds = quantiles.map(q => {
            const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
            return { quantile: q, multiplier: (1 + val).toFixed(3) };
        });
        
        const amaResult = { 
            name: selectedAma, 
            values: amaValues, 
            color: '#e3b341', 
            lineWidth: 2,
            erPeriod: config.erPeriod,
            fastPeriod: config.fastPeriod,
            slowPeriod: config.slowPeriod
        };
        
        // Try to extract symbols from path or metadata if available, otherwise use generic
        const pairMatch = dataPath.match(/\/lp\/([^\/]+)\//);
        const pairName = pairMatch ? pairMatch[1].replace(/_/g, '-') : 'Market';

        const meta = { 
            pool: `${pairName} ${selectedAma} Risk Analysis`, 
            assetA: { symbol: 'Base' }, 
            assetB: { symbol: 'Quote' }, 
            intervalSeconds: data.candles.length > 1 ? (data.candles[1][0] - data.candles[0][0]) / 1000 : 3600,
            thresholds: thresholds
        };
        
        const html = generateHTML(meta, candleArrays, [amaResult]);
        fs.writeFileSync(outPath, html);
        console.log(`\nRisk dashboard generated: ${outPath}`);
    }
}

main();
