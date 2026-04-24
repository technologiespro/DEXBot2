#!/usr/bin/env node
/**
 * Sync DEXBot2-owned package/plugin manifest versions from root package.json.
 *
 * package.json has to remain the source of truth because npm requires a literal
 * JSON version field. Runtime code should read modules/constants.APP_VERSION.
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rootPackagePath = path.join(rootDir, 'package.json');
const rootPackage = readJson(rootPackagePath);
const targetVersion = rootPackage.version;
const checkOnly = process.argv.includes('--check');

if (!targetVersion) {
    throw new Error('Root package.json is missing a version field');
}

const targets = [
    {
        file: 'package-lock.json',
        update(json) {
            json.version = targetVersion;
            if (json.packages && json.packages['']) {
                json.packages[''].version = targetVersion;
            }
        }
    },
    {
        file: 'claw/package.json',
        update(json) {
            json.version = targetVersion;
        }
    },
    {
        file: 'claw/runtimes/openclaw-plugin/package.json',
        update(json) {
            json.version = targetVersion;
        }
    },
    {
        file: 'claw/runtimes/openclaw-plugin/openclaw.plugin.json',
        update(json) {
            json.version = targetVersion;
        }
    }
];

const mismatches = [];

for (const target of targets) {
    const filePath = path.join(rootDir, target.file);
    const beforeText = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(beforeText);
    target.update(json);
    const afterText = `${JSON.stringify(json, null, 2)}\n`;

    if (beforeText !== afterText) {
        mismatches.push(target.file);
        if (!checkOnly) {
            fs.writeFileSync(filePath, afterText);
        }
    }
}

if (mismatches.length > 0) {
    if (checkOnly) {
        console.error(`Version mismatch with root package.json (${targetVersion}):`);
        for (const file of mismatches) {
            console.error(`- ${file}`);
        }
        process.exit(1);
    }

    console.log(`Synced ${mismatches.length} manifest(s) to ${targetVersion}:`);
    for (const file of mismatches) {
        console.log(`- ${file}`);
    }
} else {
    console.log(`All DEXBot2-owned manifests already match ${targetVersion}.`);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
