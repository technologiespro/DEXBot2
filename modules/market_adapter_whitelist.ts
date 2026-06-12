'use strict';

const fs = require('fs');
const path = require('path');
const { BUILD_DIR } = require('./constants');

const CODE_ROOT = path.join(__dirname, '..');
const ROOT = path.basename(CODE_ROOT) === BUILD_DIR ? path.dirname(CODE_ROOT) : CODE_ROOT;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const WHITELIST_FILE = process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE
    || path.join(PROFILES_DIR, 'market_adapter_whitelist.json');

interface WhitelistFlags {
    ama: boolean;
    dynamicWeight: boolean;
    asymmetricBounds: boolean;
}

let _whitelistCache: Map<string, WhitelistFlags> | false | null = null;

function resetMarketAdapterWhitelistCache(): void {
    _whitelistCache = null;
}

function normalizeEntry(entry: any): WhitelistFlags {
    if (entry === true) {
        return { ama: true, dynamicWeight: true, asymmetricBounds: true };
    }
    if (!entry || typeof entry !== 'object') {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
        asymmetricBounds: entry.asymmetricBounds === true,
    };
}

function loadMarketAdapterWhitelist(): Map<string, WhitelistFlags> | false {
    if (_whitelistCache !== null) return _whitelistCache;
    if (!fs.existsSync(WHITELIST_FILE)) {
        _whitelistCache = false;
        return _whitelistCache;
    }

    try {
        const json = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
        const raw = json?.whitelist;
        const map = new Map<string, WhitelistFlags>();

        if (Array.isArray(raw)) {
            for (const botKey of raw) {
                map.set(String(botKey), { ama: true, dynamicWeight: true, asymmetricBounds: true });
            }
        } else if (raw && typeof raw === 'object') {
            for (const [botKey, entry] of Object.entries(raw)) {
                map.set(String(botKey), normalizeEntry(entry));
            }
        }

        _whitelistCache = map;
        return _whitelistCache;
    } catch (_: any) {
        console.warn(`[WARN] Failed to parse ${WHITELIST_FILE}: ${_.message}. All whitelist features disabled.`);
        _whitelistCache = false;
        return _whitelistCache;
    }
}

function getWhitelistFlags(botKey: string): WhitelistFlags {
    const whitelist = loadMarketAdapterWhitelist();
    if (whitelist === false || !botKey) {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return whitelist.get(String(botKey)) || { ama: false, dynamicWeight: false, asymmetricBounds: false };
}

function isBotWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).ama === true;
}

function isBotDynamicWeightWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).dynamicWeight === true;
}

function isBotAsymmetricBoundsWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).asymmetricBounds === true;
}

function isBotGridRangeScalingWhitelisted(botKey: string): boolean {
    return isBotAsymmetricBoundsWhitelisted(botKey);
}

export = {
    WHITELIST_FILE,
    resetMarketAdapterWhitelistCache,
    getWhitelistFlags,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    isBotGridRangeScalingWhitelisted,
};
