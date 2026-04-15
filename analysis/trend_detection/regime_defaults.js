'use strict';

/**
 * SHARED REGIME DEFAULTS
 *
 * Consolidated defaults for Hurst Exponent and Permutation Entropy analyzers.
 * Best-fit values obtained from historical grid-search (analyze_regime_windows.js).
 */

module.exports = {
    HURST_CONFIG: {
        window: 256,
        scales: [8, 16, 32, 64],
    },

    PE_CONFIG: {
        m:      5,
        delay:  1,
        window: 54,
    },
};
