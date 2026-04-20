'use strict';

const { MARKET_ADAPTER } = require('../../modules/constants');

function normalizeAtrPeriod(period, fallback = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT) {
    const value = Number(period);
    if (!Number.isFinite(value) || value <= 0) return fallback;

    const rounded = Math.round(value);
    // Sync with research tool bounds: 3 to 30 bars
    return Math.max(3, Math.min(30, rounded));
}

function normalizeMaxVolatilityOffset(value, fallback = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP) {
    const numeric = Number(value);
    // Allow 0 to explicitly disable volatility shift
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeVolatilityThreshold(value, fallback = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

module.exports = {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
};
