'use strict';

const { HurstAnalyzer } = require('../../../analysis/trend_detection/hurst_analyzer');
const { PermutationEntropyAnalyzer } = require('../../../analysis/trend_detection/permutation_entropy_analyzer');
const { HURST_CONFIG, PE_CONFIG } = require('../../../analysis/trend_detection/regime_defaults');

/**
 * Regime multiplier table (3×3).
 * Rows: H nodes [0.55, 0.50, 0.45]  (TRENDING, RANDOM, MEAN_REVERTING)
 * Cols: PE nodes [0.60, 0.725, 0.85] (STRUCTURED, MIXED, NOISE)
 *
 * Values from DYNAMIC_WEIGHT_RESEARCH.md bilinear lookup.
 */
const REGIME_TABLE = [
    [1.5, 1.1, 0.7], // TRENDING      (H node 0.55)
    [0.8, 0.5, 0.2], // RANDOM        (H node 0.50)
    [0.6, 0.3, 0.1], // MEAN_REVERTING (H node 0.45)
];

// Axis node values — bilinear interpolation is performed between adjacent nodes
const H_NODES  = [0.55, 0.50, 0.45]; // H decreasing: higher index = lower H
const PE_NODES = [0.60, 0.725, 0.85]; // PE increasing: higher index = higher PE

/**
 * Bilinear interpolation over the 3×3 regime table.
 *
 * For a given (h, pe), find the enclosing cell in the node grid, compute the
 * fractional position within that cell, and blend the four corner values.
 * Inputs outside the node range are clamped to the table boundary.
 *
 * @param {number} h  - Hurst exponent [0, 1]
 * @param {number} pe - Normalized permutation entropy [0, 1]
 * @returns {number}  - Interpolated multiplier
 */
function bilinearInterpolate(h, pe) {
    // --- Hurst axis (H_NODES = [0.55, 0.50, 0.45], decreasing) ---
    // Find which interval h falls in: row r0, r1 = r0+1, fraction tRow toward r1
    let r0, tRow;
    if (h >= H_NODES[0]) {
        r0 = 0; tRow = 0;                                           // at or above top node
    } else if (h <= H_NODES[2]) {
        r0 = 1; tRow = 1;                                           // at or below bottom node
    } else if (h >= H_NODES[1]) {
        r0 = 0; tRow = (H_NODES[0] - h) / (H_NODES[0] - H_NODES[1]); // between nodes 0 and 1
    } else {
        r0 = 1; tRow = (H_NODES[1] - h) / (H_NODES[1] - H_NODES[2]); // between nodes 1 and 2
    }
    const r1 = Math.min(2, r0 + 1);

    // --- PE axis (PE_NODES = [0.60, 0.725, 0.85], increasing) ---
    // Find which interval pe falls in: col c0, c1 = c0+1, fraction tCol toward c1
    let c0, tCol;
    if (pe <= PE_NODES[0]) {
        c0 = 0; tCol = 0;
    } else if (pe >= PE_NODES[2]) {
        c0 = 1; tCol = 1;
    } else if (pe <= PE_NODES[1]) {
        c0 = 0; tCol = (pe - PE_NODES[0]) / (PE_NODES[1] - PE_NODES[0]);
    } else {
        c0 = 1; tCol = (pe - PE_NODES[1]) / (PE_NODES[2] - PE_NODES[1]);
    }
    const c1 = Math.min(2, c0 + 1);

    // --- Bilinear blend ---
    const v00 = REGIME_TABLE[r0][c0];
    const v01 = REGIME_TABLE[r0][c1];
    const v10 = REGIME_TABLE[r1][c0];
    const v11 = REGIME_TABLE[r1][c1];

    const top    = v00 * (1 - tCol) + v01 * tCol;
    const bottom = v10 * (1 - tCol) + v11 * tCol;
    return top * (1 - tRow) + bottom * tRow;
}

/**
 * Compute the Hurst+PE regime multiplier from a price series.
 *
 * Feeds all prices through HurstAnalyzer and PermutationEntropyAnalyzer,
 * then bilinear-interpolates the regime table to produce a multiplier that
 * gates the AMA slope offset in production weight computation.
 *
 * @param {number[]} closes          - Full close price series (same array used for AMA)
 * @param {Object}   [opts]
 * @param {number}   [opts.regimeSensitivity=1.0] - Exponent on the base multiplier (0=off, 1=default)
 * @param {Object}   [opts.hurstConfig]           - Override for HurstAnalyzer config
 * @param {Object}   [opts.peConfig]              - Override for PermutationEntropyAnalyzer config
 * @returns {{ multiplier: number, hurst: number|null, pe: number|null,
 *             hurstRegime: string|null, peRegime: string|null, isReady: boolean }}
 */
function computeRegimeMultiplier(closes, opts = {}) {
    const sensitivity = Number.isFinite(opts.regimeSensitivity) ? opts.regimeSensitivity : 1.0;
    const hurstCfg = opts.hurstConfig ?? HURST_CONFIG;
    const peCfg    = opts.peConfig    ?? PE_CONFIG;

    const notReady = { multiplier: 1.0, hurst: null, pe: null, hurstRegime: null, peRegime: null, isReady: false };

    if (!Array.isArray(closes) || closes.length === 0) return notReady;

    const hurst = new HurstAnalyzer(hurstCfg);
    const pe    = new PermutationEntropyAnalyzer(peCfg);

    let hurstResult = null;
    let peResult    = null;

    for (const price of closes) {
        if (!Number.isFinite(price) || price <= 0) continue;
        try {
            hurstResult = hurst.update(price);
            peResult    = pe.update(price);
        } catch (_) {
            // skip invalid prices
        }
    }

    if (!hurstResult?.isReady || !peResult?.isReady) return notReady;

    const h  = hurstResult.hurst;
    const ne = peResult.normalizedEntropy;

    const baseMult  = bilinearInterpolate(h, ne);
    const finalMult = sensitivity === 1.0 ? baseMult : Math.pow(baseMult, sensitivity);

    return {
        multiplier:  Math.round(finalMult * 1000) / 1000,
        hurst:       h,
        pe:          Math.round(ne * 10000) / 10000,
        hurstRegime: hurstResult.regime,
        peRegime:    peResult.regime,
        isReady:     true,
    };
}

module.exports = { computeRegimeMultiplier, bilinearInterpolate, REGIME_TABLE };
