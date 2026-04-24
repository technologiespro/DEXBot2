'use strict';

/**
 * Price Source Abstraction
 *
 * Unified interface for fetching market prices from multiple sources:
 * - JSON candle files
 * - Market adapter state
 * - Kibana LP pool data (basic)
 *
 * Each source returns: { marketPrice, timestamp }
 */

const fs = require('fs');
const path = require('path');
const { fillCandleGaps } = require('../market_adapter/candle_utils');

class JsonFileSource {
    constructor(config = {}) {
        this.filePath = config.filePath;
        this.name = `json:${path.basename(this.filePath)}`;
        if (!fs.existsSync(this.filePath)) {
            throw new Error(`[JsonFileSource] File not found: ${this.filePath}`);
        }
    }

    async fetchCandles() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));

            let candles = null;
            let meta = null;

            if (Array.isArray(data)) {
                candles = data;
            } else if (data.candles && Array.isArray(data.candles)) {
                candles = data.candles;
                meta = data.meta;
            } else if (data.data && Array.isArray(data.data)) {
                candles = data.data;
                meta = data;
            } else {
                throw new Error('Expected JSON array or object with .candles or .data property');
            }

            const intervalSeconds = meta?.intervalSeconds || 3600;
            const lookbackHours = meta?.lookbackHours;

            if (lookbackHours && candles.length > 0) {
                const nowMs = new Date(meta.fetchedAt || Date.now()).getTime();
                const startTs = nowMs - (lookbackHours * 3600 * 1000);
                return fillCandleGaps(candles, intervalSeconds, startTs, nowMs);
            }

            return candles;
        } catch (err) {
            throw new Error(`[JsonFileSource] Failed to read ${this.filePath}: ${err.message}`);
        }
    }

    extractMarketPrice(candle) {
        const close = Array.isArray(candle) ? candle[4] : candle.close;
        const ts = Array.isArray(candle) ? candle[0] : candle.timestamp;
        return { marketPrice: close, timestamp: ts };
    }
}

class MarketAdapterSource {
    constructor(config = {}) {
        this.stateDir = config.stateDir || path.join(__dirname, '..', 'market_adapter', 'state');
        this.botKey = config.botKey;
        this.name = `market_adapter:${this.botKey}`;
    }

    async fetchCandles() {
        const centersFile = path.join(this.stateDir, 'price_adapter_centers.json');
        if (!fs.existsSync(centersFile)) {
            throw new Error(`[MarketAdapterSource] Centers file not found: ${centersFile}`);
        }

        try {
            const data = JSON.parse(fs.readFileSync(centersFile, 'utf8'));

            let botData = data[this.botKey];
            if (!botData && data.bots && data.bots[this.botKey]) {
                botData = data.bots[this.botKey];
            }

            if (!botData) {
                throw new Error(`Bot '${this.botKey}' not found in centers file`);
            }

            return botData.history?.map(entry => ({
                timestamp: entry.timestamp,
                open: entry.center,
                high: entry.center,
                low: entry.center,
                close: entry.center,
                volume: 0,
            })) || [];
        } catch (err) {
            throw new Error(`[MarketAdapterSource] Failed to read: ${err.message}`);
        }
    }

    extractMarketPrice(candle) {
        return { marketPrice: candle.close, timestamp: candle.timestamp };
    }
}

class KibanaSource {
    constructor(config = {}) {
        this.poolId = config.poolId;
        this.soldAssetId = config.soldAssetId;
        this.receivedAssetId = config.receivedAssetId;
        this.precA = config.precA;
        this.precB = config.precB;
        this.intervalSeconds = config.intervalSeconds || 3600;
        this.lookbackHours = config.lookbackHours || 720;
        this.name = `kibana:pool=${this.poolId}`;
    }

    async fetchCandles() {
        throw new Error('[KibanaSource] Kibana source requires kibana_source module (not available in this build)');
    }

    extractMarketPrice(candle) {
        return {
            marketPrice: candle.close || candle[4],
            timestamp: candle.timestamp || candle[0],
        };
    }
}

function createSource(type, config) {
    switch (type.toLowerCase()) {
        case 'kibana':
            return new KibanaSource(config);
        case 'json':
            return new JsonFileSource(config);
        case 'market_adapter':
            return new MarketAdapterSource(config);
        default:
            throw new Error(`[PriceSource] Unknown type: ${type}`);
    }
}

module.exports = {
    KibanaSource,
    JsonFileSource,
    MarketAdapterSource,
    createSource,
};
