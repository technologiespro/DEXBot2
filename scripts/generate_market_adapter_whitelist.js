'use strict';

const fs = require('fs');
const path = require('path');
const { createBotKey } = require('../modules/account_orders');

const ROOT = path.join(__dirname, '..');
const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
const WHITELIST_FILE = path.join(ROOT, 'profiles', 'market_adapter_whitelist.json');

function isAmaGridPrice(value) {
    if (typeof value !== 'string') return false;
    return /^ama(?:[1-4])?$/i.test(value.trim());
}

function loadBotsConfig() {
    const raw = fs.readFileSync(BOTS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json?.bots) ? json.bots : [];
}

function buildWhitelist(bots) {
    const dynamicWeight = process.argv.includes('--dynamic-weight=false')
        || process.argv.includes('--no-dynamic-weight')
        ? false
        : true;
    const entries = [];

    for (const [index, bot] of bots.entries()) {
        const botKey = createBotKey(bot, index);
        if (!botKey || !isAmaGridPrice(bot?.gridPrice)) continue;
        entries.push([String(botKey), { ama: true, dynamicWeight }]);
    }

    entries.sort((a, b) => a[0].localeCompare(b[0]));

    return {
        whitelist: Object.fromEntries(entries),
    };
}

function main() {
    const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--print');
    const bots = loadBotsConfig();
    const whitelist = buildWhitelist(bots);
    const output = JSON.stringify(whitelist, null, 2) + '\n';

    if (dryRun) {
        process.stdout.write(output);
        return;
    }

    fs.writeFileSync(WHITELIST_FILE, output, 'utf8');
    process.stdout.write(`Wrote ${WHITELIST_FILE} with ${Object.keys(whitelist.whitelist).length} bot(s)\n`);
}

if (require.main === module) {
    main();
}
