#!/usr/bin/env node
'use strict';

/**
 * scripts/shadow_report.js — Parse shadow test logs and produce mismatch summary
 *
 * Reads the shadow test JSONL log and the consolidated report JSON,
 * producing a human-readable summary of interoperability issues found.
 *
 * Usage:
 *   node scripts/shadow_report.js [logFile] [reportFile]
 *
 * Defaults:
 *   logFile: profiles/shadow_test/shadow_*.jsonl (most recent)
 *   reportFile: profiles/shadow_test/shadow_report.json
 */

const fs = require('fs');
const path = require('path');

function findMostRecentLog(dir) {
    if (!fs.existsSync(dir)) {
        console.error(`No shadow test logs found in ${dir}`);
        return null;
    }
    const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('shadow_') && f.endsWith('.jsonl'))
        .sort()
        .reverse();
    if (files.length === 0) {
        console.error(`No shadow test logs found in ${dir}`);
        return null;
    }
    return path.join(dir, files[0]);
}

const logFile = process.argv[2]
    || findMostRecentLog(path.join(__dirname, '..', 'profiles', 'shadow_test'));

const reportFile = process.argv[3]
    || path.join(__dirname, '..', 'profiles', 'shadow_test', 'shadow_report.json');

if (!logFile) {
    process.exit(1);
}

console.log(`Shadow Report`);
console.log(`  Log: ${logFile}`);
console.log(`  Report: ${reportFile}`);
console.log('');

// Read report summary
if (fs.existsSync(reportFile)) {
    try {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        console.log(`Duration: ${report.startTime} → ${report.endTime} (${report.durationHours}h planned)`);
        console.log(`Queries: ${report.totalQueries}`);
        console.log(`Mismatches: ${report.mismatches} (${report.mismatchRate})`);
        console.log('');
    } catch (_) {}
}

// Parse log and group by method
const methodStats = {};
const mismatchDetails = [];
let lineCount = 0;

try {
    const data = fs.readFileSync(logFile, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());

    for (const line of lines) {
        lineCount++;
        try {
            const entry = JSON.parse(line);
            const method = entry.method;

            if (!methodStats[method]) {
                methodStats[method] = { count: 0, first: entry.timestamp, last: entry.timestamp };
            }
            methodStats[method].count++;
            methodStats[method].last = entry.timestamp;

            mismatchDetails.push(entry);
        } catch (_) {}
    }
} catch (err) {
    console.error(`Error reading log: ${err.message}`);
    process.exit(1);
}

console.log(`Entries: ${lineCount}`);
console.log('');

if (Object.keys(methodStats).length === 0) {
    console.log('No mismatches found. Native client matches btsdex output.');
    console.log('Eligible to proceed to Phase 3.');
    process.exit(0);
}

console.log('Mismatches by method:');
console.log('---');
const sortedMethods = Object.entries(methodStats).sort((a, b) => b[1].count - a[1].count);
for (const [method, stats] of sortedMethods) {
    console.log(`  ${method}: ${stats.count} mismatches (${stats.first} → ${stats.last})`);
}

console.log('');
console.log('Top 10 mismatch details:');
console.log('---');
for (const entry of mismatchDetails.slice(-10)) {
    console.log(`  [${entry.timestamp}] ${entry.method}`);
    if (entry.diff) {
        console.log(`    Path: ${entry.diff.path}`);
        console.log(`    Reason: ${entry.diff.reason}`);
        if (entry.diff.a !== undefined) console.log(`    btsdex: ${String(entry.diff.a).slice(0, 200)}`);
        if (entry.diff.b !== undefined) console.log(`    native: ${String(entry.diff.b).slice(0, 200)}`);
    }
    console.log('');
}

console.log(`Total: ${mismatchDetails.length} mismatches across ${Object.keys(methodStats).length} methods`);
console.error(`\nShadow report FAILED: ${mismatchDetails.length} mismatches detected.`);
console.error('Fix mismatches before merging. Re-run with: node scripts/shadow_report.js');
process.exit(1);
