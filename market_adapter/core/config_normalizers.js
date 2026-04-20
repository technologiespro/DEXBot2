'use strict';

const { MARKET_ADAPTER } = require('../../modules/constants');

function normalizeAtrPeriod(period, fallback = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT) {
    const value = Number(period);
    if (!Number.isFinite(value) || value <= 0) return fallback;

    const rounded = Math.round(value);
    return rounded > 0 ? rounded : fallback;
}

function normalizeMaxVolatilityOffset(value, fallback = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

module.exports = {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
};
