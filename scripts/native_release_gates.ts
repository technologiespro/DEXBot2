#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveProjectRoot } = require('../modules/launcher/runtime_entry');
const { readJSON } = require('../modules/utils/fs_utils');

const ROOT_DEPTH_1 = path.dirname(__dirname);
const root = resolveProjectRoot(ROOT_DEPTH_1);
const nodeBin = process.execPath;

function run(label: any, args: any, env: any = {}) {
    console.log(`\n=== ${label} ===`);
    const result = spawnSync(nodeBin, args, {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function assertMainnetCorpusReport() {
    const reportPath = process.env.NATIVE_MAINNET_CORPUS_REPORT
        || path.join(root, 'profiles', 'native_validation', 'mainnet_corpus_report.json');

    if (!fs.existsSync(reportPath)) {
        console.error('\nMissing mainnet corpus validation report.');
        console.error(`Expected: ${reportPath}`);
        console.error('Generate a report proving 50+ real mainnet transactions serialize byte-for-byte with native serialization before release.');
        process.exit(1);
    }

    let report;
    try {
        report = readJSON(reportPath);
    } catch (err: any) {
        console.error(`\nInvalid mainnet corpus report JSON: ${err.message}`);
        process.exit(1);
    }

    const txCount = Number(report.transactionCount || report.transactions || 0);
    if (report.passed !== true || txCount < 50) {
        console.error('\nMainnet corpus report did not satisfy release requirements.');
        console.error('Required: passed=true and transactionCount>=50');
        console.error(`Actual: passed=${report.passed}, transactionCount=${txCount}`);
        process.exit(1);
    }

    console.log(`\nMainnet corpus report accepted: ${txCount} transaction(s).`);
}

run('Native serializer snapshots', ['--import', 'tsx', 'tests/test_native_serial_ops.ts']);

run('Native ECC invariants', ['--import', 'tsx', 'tests/test_native_ecc.ts']);

assertMainnetCorpusReport();

console.log('\nNative release gates passed.');
export {};
