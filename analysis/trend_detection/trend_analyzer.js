/**
 * Trend Analyzer
 *
 * Feed-anchored trend detection for MPAs (HONEST.Assets).
 *
 * Two components:
 *   1. FeedTrend   – Single AMA vs on-chain feed price → trend direction
 *   2. FeedPremium – Instantaneous market price vs feed → premium/discount
 *
 * PriceRatio provides oscillation context for grid-width decisions.
 *
 * Optimized to be right, not fast.
 */

const { AMA } = require('../ama_fitting/ama');
const { PriceRatio } = require('./price_ratio');
const { FeedTrend } = require('./feed_trend');
const { FeedPremium } = require('./feed_premium');

class TrendAnalyzer {
    /**
     * @param {Object}  config
     * @param {number}  config.lookbackBars         – PriceRatio lookback (default 20)
     * @param {Object}  config.feedTrendConfig       – FeedTrend params (erPeriod, fastPeriod, slowPeriod, thresholdPercent, minBarsForConfirmation)
     * @param {Object}  config.feedPremiumConfig     – FeedPremium params (deadZonePercent)
     */
    constructor(config = {}) {
        this.feedTrend = new FeedTrend(config.feedTrendConfig || {});
        this.feedPremium = new FeedPremium(config.feedPremiumConfig || {});
        this.priceRatio = new PriceRatio(config.lookbackBars || 20);

        this.updateCount = 0;
    }

    /**
     * Update with market price and feed price.
     *
     * @param {number} marketPrice – Current market price (close, mid, or last trade)
     * @param {number} feedPrice   – On-chain settlement feed price (same units)
     * @returns {Object} Analysis result
     */
    update(marketPrice, feedPrice) {
        this.feedTrend.update(marketPrice, feedPrice);
        this.feedPremium.update(marketPrice, feedPrice);

        // Use the AMA value from FeedTrend as center reference for oscillation
        const amaValue = this.feedTrend.amaHistory.length > 0
            ? this.feedTrend.amaHistory[this.feedTrend.amaHistory.length - 1]
            : marketPrice;
        this.priceRatio.update(marketPrice, amaValue);

        this.updateCount++;
        return this.getAnalysis();
    }

    // ── Analysis ───────────────────────────────────────────────

    getAnalysis() {
        const ft = this.feedTrend.getAnalysis();
        const fp = this.feedPremium.getSnapshot();
        const osc = this.priceRatio.getSnapshot();

        if (!ft.isReady) {
            return {
                isReady: false,
                reason: ft.reason,
                trend: 'NEUTRAL',
                confidence: 0,
            };
        }

        return {
            isReady: true,
            trend: ft.trend,
            confidence: ft.confidence,
            isConfirmed: ft.isConfirmed,
            rawTrend: ft.rawTrend,
            barsInTrend: ft.barsInTrend,
            deviationPercent: ft.deviationPercent,
            amaValue: ft.amaValue,
            feedPrice: ft.feedPrice,
            marketPrice: ft.marketPrice,
            premium: {
                signal: fp.signal,
                percent: fp.premiumPercent,
            },
            oscillation: {
                ratio: osc ? osc.oscillationRatio : 0,
                description: this._getOscillationDescription(osc ? osc.oscillationRatio : 0),
            },
            priceAnalysis: osc ? osc.priceVsAMA : null,
            updateCount: this.updateCount,
        };
    }

    getSimpleTrend() {
        const a = this.getAnalysis();
        return { trend: a.trend, confidence: a.confidence, isReady: a.isReady };
    }

    isUptrend() {
        const a = this.getAnalysis();
        return a.trend === 'UP' && a.isConfirmed;
    }

    isDowntrend() {
        const a = this.getAnalysis();
        return a.trend === 'DOWN' && a.isConfirmed;
    }

    isNeutral() {
        return this.getAnalysis().trend === 'NEUTRAL';
    }

    // ── Direct accessors ───────────────────────────────────────

    getFeedPremium() {
        return this.feedPremium.getSnapshot();
    }

    getFeedTrend() {
        return this.feedTrend.getAnalysis();
    }

    // ── Full snapshot ──────────────────────────────────────────

    getFullSnapshot() {
        const ft = this.feedTrend.getFullSnapshot();

        if (!ft.isReady) {
            return { isReady: false, message: ft.reason || 'Warming up' };
        }

        const fp = this.feedPremium.getSnapshot();
        const fpStats = this.feedPremium.getStats();
        const osc = this.priceRatio.getSnapshot();

        return {
            timestamp: new Date().toISOString(),
            updateCount: this.updateCount,
            trend: {
                direction: ft.trend,
                confidence: ft.confidence,
                isConfirmed: ft.isConfirmed,
                rawTrend: ft.rawTrend,
                barsInTrend: ft.barsInTrend,
                deviationPercent: ft.deviationPercent,
            },
            ama: {
                value: ft.amaValue,
                config: ft.config,
            },
            feed: {
                price: ft.feedPrice,
            },
            market: {
                price: ft.marketPrice,
            },
            premium: {
                signal: fp.signal,
                percent: fp.premiumPercent,
                deadZone: fp.deadZonePercent,
                stats: fpStats,
            },
            oscillation: osc ? {
                ratio: osc.oscillationRatio,
                priceRange: osc.priceRange,
                description: this._getOscillationDescription(osc.oscillationRatio),
            } : null,
            priceDirection: osc ? osc.priceDirection : null,
        };
    }

    // ── Utilities ──────────────────────────────────────────────

    _getOscillationDescription(ratio) {
        if (ratio < 1) return 'Very tight - Ideal for grid trading';
        if (ratio < 3) return 'Tight - Good for grid trading';
        if (ratio < 5) return 'Normal - Moderate trading range';
        if (ratio < 10) return 'Wide - Choppy market';
        return 'Very wide - Highly volatile';
    }

    reset() {
        this.feedTrend.reset();
        this.feedPremium.reset();
        this.priceRatio.reset();
        this.updateCount = 0;
    }

    getUpdateCount() {
        return this.updateCount;
    }
}

module.exports = { TrendAnalyzer };
