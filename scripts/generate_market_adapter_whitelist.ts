'use strict';

const fs = require('fs');
const path = require('path');
const { createBotKey } = require('../modules/account_orders');

const PARENT = path.dirname(__dirname);
const ROOT = path.basename(PARENT) === 'dist' ? path.dirname(PARENT) : PARENT;
const BOTS_FILE = path.join(ROOT, 'profiles', 'bots.json');
const WHITELIST_FILE = path.join(ROOT, 'profiles', 'market_adapter_whitelist.json');

function isAmaGridPrice(value: any) {
    if (typeof value !== 'string') return false;
    return /^ama(?:[1-4])?$/i.test(value.trim());
}

function loadBotsConfig() {
    const raw = fs.readFileSync(BOTS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json?.bots) ? json.bots : [];
}

function parseOptions(argv: string[]) {
    const dynamicWeightEnabled = argv.includes('--dynamic-weight=true') || argv.includes('--dynamic-weight') || argv.includes('--with-dynamic-weight');
    const dynamicWeightDisabled = argv.includes('--dynamic-weight=false') || argv.includes('--no-dynamic-weight');
    const asymmetricBoundsDisabled = argv.includes('--asymmetric-bounds=false') || argv.includes('--no-asymmetric-bounds');

    return {
        dynamicWeight: dynamicWeightEnabled && !dynamicWeightDisabled,
        asymmetricBounds: !asymmetricBoundsDisabled,
    };
}

function normalizeWhitelistEntry(entry: any) {
    if (entry === true) {
        return { ama: true, dynamicWeight: true, asymmetricBounds: true };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
        asymmetricBounds: entry.asymmetricBounds === true,
    };
}

function loadExistingWhitelist() {
    if (!fs.existsSync(WHITELIST_FILE)) return {};

    let json;
    try {
        json = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    } catch (err: any) {
        process.stderr.write(`Warning: ignoring malformed ${WHITELIST_FILE}: ${err.message}\n`);
        return {};
    }
    const raw = json?.whitelist;
    const entries: any = {};

    if (Array.isArray(raw)) {
        for (const botKey of raw) {
            if (botKey) entries[String(botKey)] = { ama: true, dynamicWeight: true, asymmetricBounds: true };
        }
    } else if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            entries[String(botKey)] = entry;
        }
    }

    return entries;
}

function buildWhitelist(bots: any, existingWhitelist: any = {}, options = parseOptions(process.argv)) {
    const entries = new Map<string, any>();

    for (const [botKey, entry] of Object.entries(existingWhitelist || {})) {
        entries.set(String(botKey), entry);
    }

    for (const [index, bot] of bots.entries()) {
        const botKey = createBotKey(bot, index);
        if (!botKey || !isAmaGridPrice(bot?.gridPrice)) continue;
        const key = String(botKey);
        if (!entries.has(key)) {
            entries.set(key, {
                ama: true,
                dynamicWeight: options.dynamicWeight,
                asymmetricBounds: options.asymmetricBounds,
            });
        }
    }

    return {
        whitelist: Object.fromEntries([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    };
}

function main() {
    const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--print');
    const bots = loadBotsConfig();
    const existingWhitelist = loadExistingWhitelist();
    const whitelist = buildWhitelist(bots, existingWhitelist, parseOptions(process.argv));
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

module.exports = {
    isAmaGridPrice,
    parseOptions,
    normalizeWhitelistEntry,
    loadExistingWhitelist,
    buildWhitelist,
};
