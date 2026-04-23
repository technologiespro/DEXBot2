'use strict';

const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const WHITELIST_FILE = path.join(PROFILES_DIR, 'market_adapter_whitelist.json');

let _whitelistCache = null; // Map<string, { ama: boolean, dynamicWeight: boolean }> | false | null

function resetMarketAdapterWhitelistCache() {
    _whitelistCache = null;
}

function normalizeEntry(entry) {
    if (entry === true) {
        return { ama: true, dynamicWeight: true };
    }
    if (!entry || typeof entry !== 'object') {
        return { ama: false, dynamicWeight: false };
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
    };
}

function loadMarketAdapterWhitelist() {
    if (_whitelistCache !== null) return _whitelistCache;
    if (!fs.existsSync(WHITELIST_FILE)) {
        _whitelistCache = false;
        return _whitelistCache;
    }

    try {
        const json = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        const raw = json?.whitelist;
        const map = new Map();

        if (Array.isArray(raw)) {
            for (const botKey of raw) {
                map.set(String(botKey), { ama: true, dynamicWeight: true });
            }
        } else if (raw && typeof raw === 'object') {
            for (const [botKey, entry] of Object.entries(raw)) {
                map.set(String(botKey), normalizeEntry(entry));
            }
        }

        _whitelistCache = map;
        return _whitelistCache;
    } catch (_) {
        _whitelistCache = false;
        return _whitelistCache;
    }
}

function getWhitelistFlags(botKey) {
    const whitelist = loadMarketAdapterWhitelist();
    if (whitelist === false || !botKey) {
        return { ama: false, dynamicWeight: false };
    }
    return whitelist.get(String(botKey)) || { ama: false, dynamicWeight: false };
}

function isBotWhitelisted(botKey) {
    return getWhitelistFlags(botKey).ama === true;
}

function isBotDynamicWeightWhitelisted(botKey) {
    return getWhitelistFlags(botKey).dynamicWeight === true;
}

module.exports = {
    WHITELIST_FILE,
    resetMarketAdapterWhitelistCache,
    getWhitelistFlags,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
};
