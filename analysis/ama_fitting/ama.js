/**
 * Kaufman's Adaptive Moving Average (KAMA)
 */
class AMA {
    constructor(erPeriod, fastPeriod, slowPeriod) {
        if (!Number.isFinite(erPeriod) || erPeriod <= 0) {
            throw new TypeError(`AMA erPeriod must be a positive finite number, got ${erPeriod}`);
        }
        if (!Number.isFinite(fastPeriod) || fastPeriod <= 0) {
            throw new TypeError(`AMA fastPeriod must be a positive finite number, got ${fastPeriod}`);
        }
        if (!Number.isFinite(slowPeriod) || slowPeriod <= 0) {
            throw new TypeError(`AMA slowPeriod must be a positive finite number, got ${slowPeriod}`);
        }
        this.erPeriod = erPeriod;
        this.fastSC = 2 / (fastPeriod + 1);
        this.slowSC = 2 / (slowPeriod + 1);
        this.prevAMA = null;
        this.history = []; // Keep track of closing prices for ER calc
        this.warmedUp = false;
        this.smaSum = 0;
        this.smaCount = 0;
    }

    /**
     * Calculate AMA for a new price point
     * @param {number} price - Current closing price
     * @returns {number} Current AMA value
     */
    update(price) {
        this.history.push(price);

        // Maintain history buffer
        if (this.history.length > this.erPeriod + 1) {
            this.history.shift();
        }

        // Warmup phase: accumulate SMA over the ER buffer window.
        // Initializing prevAMA to the first price (p0) creates a bias that
        // persists through the recursive AMA formula; using the SMA of the
        // full ER window eliminates that bias.
        if (!this.warmedUp) {
            this.smaSum += price;
            this.smaCount++;
            if (this.smaCount < this.erPeriod + 1) {
                return price;
            }
            this.warmedUp = true;
            this.prevAMA = this.smaSum / this.smaCount;
            return this.prevAMA;
        }

        // 1. Efficiency Ratio (ER) — buffer is rolling at erPeriod+1
        // Direction = |Price - Price(n-ago)|
        const direction = Math.abs(price - this.history[0]);

        // Volatility = Sum( |Price(i) - Price(i-1)| )
        let volatility = 0;
        for (let i = 1; i < this.history.length; i++) {
            volatility += Math.abs(this.history[i] - this.history[i-1]);
        }

        const er = volatility === 0 ? 0 : direction / volatility;

        // 2. Smoothing Constant (SC)
        // sc = [ER * (fast - slow) + slow]^2
        const smooth = Math.pow(er * (this.fastSC - this.slowSC) + this.slowSC, 2);

        // 3. AMA Calculation
        // AMA = PriorAMA + SC * (Price - PriorAMA)
        const ama = this.prevAMA + smooth * (price - this.prevAMA);

        this.prevAMA = ama;
        return ama;
    }
}

/**
 * AMA convergence from cold start — the initialization bias at the end of
 * the ER buffer decays asymptotically as ∏(1−SC_i).  Using a typical-market
 * Efficiency Ratio the average effective SC is:
 *
 *   SC_avg = [ER_avg × (fastSC − slowSC) + slowSC]²
 *
 * Bars needed to reduce initialization bias below fraction ε:
 *
 *   K = ln(ε) / ln(1 − SC_avg)
 *
 * The dominant term is O(slowPeriod²), not O(slowPeriod), so a multiplier
 * on slowPeriod alone cannot stay accurate across different AMA presets.
 *
 * Calibration constants are in modules/constants.js (MARKET_ADAPTER):
 */
const { MARKET_ADAPTER } = require('../../modules/constants');

function getAmaWarmupBars(erPeriod, slowPeriod, lookbackBars, fastPeriod) {
    if (!Number.isFinite(erPeriod) || erPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars erPeriod must be a positive finite number, got ${erPeriod}`);
    }
    if (!Number.isFinite(slowPeriod) || slowPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars slowPeriod must be a positive finite number, got ${slowPeriod}`);
    }
    if (!Number.isFinite(lookbackBars) || lookbackBars < 0) {
        throw new TypeError(`getAmaWarmupBars lookbackBars must be a non-negative finite number, got ${lookbackBars}`);
    }
    if (!Number.isFinite(fastPeriod) || fastPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars fastPeriod must be a positive finite number, got ${fastPeriod}`);
    }

    const safeErPeriod = Math.ceil(erPeriod);
    const safeSlowPeriod = Math.ceil(slowPeriod);
    const safeLookbackBars = Math.ceil(lookbackBars);
    const safeFastPeriod = fastPeriod;

    const fastSC = 2 / (safeFastPeriod + 1);
    const slowSC = 2 / (safeSlowPeriod + 1);
    const deltaSC = fastSC - slowSC;
    const scAvg = (MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG * deltaSC + slowSC) ** 2;
    const convergenceBars = Math.ceil(
        Math.log(MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON) / Math.log(1 - scAvg)
    );

    return safeErPeriod + convergenceBars + safeLookbackBars;
}

/**
 * Batch process a list of candles
 * @param {Array} closes - Array of closing prices
 * @param {Object} params - { erPeriod, fastPeriod, slowPeriod }
 * @returns {Array} Array of AMA values corresponding to the inputs
 */
function calculateAMA(closes, params) {
    if (!params || typeof params !== 'object') {
        throw new TypeError('calculateAMA params must be an object with erPeriod, fastPeriod, slowPeriod');
    }
    if (!Number.isFinite(params.erPeriod) || params.erPeriod <= 0) {
        throw new TypeError(`calculateAMA params.erPeriod must be a positive finite number, got ${params.erPeriod}`);
    }
    if (!Number.isFinite(params.fastPeriod) || params.fastPeriod <= 0) {
        throw new TypeError(`calculateAMA params.fastPeriod must be a positive finite number, got ${params.fastPeriod}`);
    }
    if (!Number.isFinite(params.slowPeriod) || params.slowPeriod <= 0) {
        throw new TypeError(`calculateAMA params.slowPeriod must be a positive finite number, got ${params.slowPeriod}`);
    }
    const indicator = new AMA(params.erPeriod, params.fastPeriod, params.slowPeriod);
    return closes.map(price => indicator.update(price));
}

module.exports = {
    AMA,
    calculateAMA,
    getAmaWarmupBars,
};
