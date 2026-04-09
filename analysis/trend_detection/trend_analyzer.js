'use strict';

/**
 * Trend Analyzer
 *
 * Feed-compatible wrapper around DerivativeAnalyzer.
 *
 * Trend detection uses the derivative (rate of change) of SMA and KAMA:
 *   KAMA derivative → primary trend signal  (adaptive, faster)
 *   SMA  derivative → secondary trend signal (smoother, slower)
 *
 * Both signals are exposed in getAnalysis() as kamaTrend / smaTrend
 * so they can be compared to find which fits the asset best.
 *
 * Interface is backward-compatible: update(marketPrice, feedPrice)
 * feedPrice is accepted but not used for trend; it is recorded for
 * optional premium calculation via getFeedPremium().
 */

const { DerivativeAnalyzer } = require('../derivative_analyzer');

class TrendAnalyzer {
    /**
     * @param {Object} config
     * @param {number} config.slowSmaPeriod          – SMA period (default 800)
     * @param {number} config.fastKamaErPeriod        – KAMA ER period (default 100)
     * @param {number} config.fastKamaFastPeriod      – KAMA fast period (default 2)
     * @param {number} config.fastKamaSlowPeriod      – KAMA slow period (default 300)
     * @param {number} config.minBarsForConfirmation  – Bars to confirm trend (default 3)
     */
    constructor(config = {}) {
        this.analyzer = new DerivativeAnalyzer({
            slowSmaPeriod: config.slowSmaPeriod || 800,
            fastKamaErPeriod: config.fastKamaErPeriod || 100,
            fastKamaFastPeriod: config.fastKamaFastPeriod || 2,
            fastKamaSlowPeriod: config.fastKamaSlowPeriod || 300,
            minBarsForConfirmation: config.minBarsForConfirmation || 3,
        });

        // Feed price tracking for optional premium calculation
        this._lastFeedPrice = null;
        this._lastMarketPrice = null;
        this.updateCount = 0;
    }

    /**
     * Update with market price and optional feed price.
     * feedPrice is recorded but does not affect trend detection.
     *
     * @param {number} marketPrice
     * @param {number} [feedPrice]
     * @returns {Object} Analysis result
     */
    update(marketPrice, feedPrice = null) {
        this._lastMarketPrice = marketPrice;
        if (feedPrice !== null) this._lastFeedPrice = feedPrice;
        this.updateCount++;
        return this.analyzer.update(marketPrice);
    }

    // ── Analysis ───────────────────────────────────────────────

    getAnalysis() {
        return this.analyzer.getAnalysis();
    }

    getSimpleTrend() {
        const a = this.analyzer.getAnalysis();
        return { trend: a.trend, confidence: a.confidence, isReady: a.isReady };
    }

    isUptrend() {
        const a = this.analyzer.getAnalysis();
        return a.isReady && a.trend === 'UP' && a.isConfirmed;
    }

    isDowntrend() {
        const a = this.analyzer.getAnalysis();
        return a.isReady && a.trend === 'DOWN' && a.isConfirmed;
    }

    isNeutral() {
        const a = this.analyzer.getAnalysis();
        return !a.isReady || a.trend === 'NEUTRAL';
    }

    // ── Optional feed premium ──────────────────────────────────

    /**
     * Returns instantaneous premium/discount of market vs feed price.
     * Returns null if no feed price has been provided.
     */
    getFeedPremium() {
        if (this._lastFeedPrice === null || this._lastMarketPrice === null) return null;
        const pct = ((this._lastMarketPrice - this._lastFeedPrice) / this._lastFeedPrice) * 100;
        return {
            premiumPercent: Math.round(pct * 10000) / 10000,
            signal: pct > 0.25 ? 'PREMIUM' : pct < -0.25 ? 'DISCOUNT' : 'FAIR',
            marketPrice: this._lastMarketPrice,
            feedPrice: this._lastFeedPrice,
        };
    }

    // ── Full snapshot ──────────────────────────────────────────

    getFullSnapshot() {
        const a = this.analyzer.getAnalysis();

        if (!a.isReady) {
            return { isReady: false, message: a.reason || 'Warming up' };
        }

        return {
            timestamp: new Date().toISOString(),
            updateCount: this.updateCount,
            isReady: true,
            // Primary (KAMA derivative)
            trend: a.trend,
            confidence: a.confidence,
            isConfirmed: a.isConfirmed,
            // Per-indicator signals
            kama: {
                trend: a.kamaTrend,
                rawTrend: a.kamaRawTrend,
                barsInTrend: a.kamaBarsInTrend,
                confidence: a.kamaConfidence,
                value: a.fastKama,
            },
            sma: {
                trend: a.smaTrend,
                rawTrend: a.smaRawTrend,
                barsInTrend: a.smaBarsInTrend,
                confidence: a.smaConfidence,
                value: a.slowSma,
            },
            // Context
            price: a.price,
            feedPremium: this.getFeedPremium(),
        };
    }

    // ── Utilities ──────────────────────────────────────────────

    reset() {
        this.analyzer.reset();
        this._lastFeedPrice = null;
        this._lastMarketPrice = null;
        this.updateCount = 0;
    }

    getUpdateCount() {
        return this.updateCount;
    }
}

module.exports = { TrendAnalyzer };
