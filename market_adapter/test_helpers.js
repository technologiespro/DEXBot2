'use strict';

/**
 * TEST HELPERS for market_adapter
 *
 * Canonical import point for tests that need internal market-adapter helpers.
 * Keeps test dependencies centralized and explicit.
 */

const {
    _resetCycleCache,
    writeCenterSnapshot,
    writeBotDynamicGrid,
    sleepUntilAlignedBoundary,
    normalizeMarketSource,
} = require('./market_adapter');

const {
    resolveAsset,
    findPoolByAssets,
    resolveBotContext,
    resolveMarketSourceForBot,
} = require('./utils/chain');

module.exports = {
    _resetCycleCache,
    writeCenterSnapshot,
    writeBotDynamicGrid,
    sleepUntilAlignedBoundary,
    normalizeMarketSource,
    resolveMarketSourceForBot,
    resolveAsset,
    findPoolByAssets,
    resolveBotContext,
};
