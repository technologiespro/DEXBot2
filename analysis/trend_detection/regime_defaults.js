'use strict';

/**
 * SHARED REGIME DEFAULTS
 *
 * Consolidated defaults for Hurst Exponent and Permutation Entropy analyzers.
 * Synchronized with modules/constants.js
 */

const { MARKET_ADAPTER } = require('../../modules/constants');

module.exports = {
    HURST_CONFIG: MARKET_ADAPTER.HURST_CONFIG,
    PE_CONFIG:    MARKET_ADAPTER.PE_CONFIG,
};
