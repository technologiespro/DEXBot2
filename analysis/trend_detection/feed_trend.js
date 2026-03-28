/**
 * Feed Trend Detector
 *
 * Uses a single Kaufman AMA compared against the on-chain settlement feed
 * price to detect bull / bear trends for feed-anchored MPAs (HONEST.Assets).
 *
 * Rationale:
 *   For MPAs the feed price IS the fundamental anchor.  When the smoothed
 *   market price (AMA) consistently deviates from feed, it indicates a real
 *   trend — not noise.  This is structurally different from dual-AMA where
 *   both lines derive from the same noisy source.
 *
 * Signals:
 *   UP   – AMA > feed by more than threshold, sustained for N bars
 *   DOWN – AMA < feed by more than threshold, sustained for N bars
 *   NEUTRAL – within threshold or not yet confirmed
 */

'use strict';

const { AMA } = require('../ama_fitting/ama');

const DEFAULTS = {
    erPeriod: 40,
    fastPeriod: 5,
    slowPeriod: 15,
    thresholdPercent: 1.0,
    minBarsForConfirmation: 3,
    maxHistoryLength: 500,
};

class FeedTrend {
    /**
     * @param {Object}  config
     * @param {number}  config.erPeriod           – AMA efficiency ratio period (default 40)
     * @param {number}  config.fastPeriod          – AMA fast smoothing period (default 5)
     * @param {number}  config.slowPeriod          – AMA slow smoothing period (default 15)
     * @param {number}  config.thresholdPercent     – Min AMA-vs-feed deviation to trigger (default 1%)
     * @param {number}  config.minBarsForConfirmation – Bars the signal must hold (default 3)
     */
    constructor(config = {}) {
        const cfg = { ...DEFAULTS, ...config };

        this.ama = new AMA(cfg.erPeriod, cfg.fastPeriod, cfg.slowPeriod);
        this.thresholdPercent = cfg.thresholdPercent;
        this.minBarsForConfirmation = cfg.minBarsForConfirmation;
        this.maxHistoryLength = cfg.maxHistoryLength;

        // Persist config for snapshot
        this._config = {
            erPeriod: cfg.erPeriod,
            fastPeriod: cfg.fastPeriod,
            slowPeriod: cfg.slowPeriod,
            thresholdPercent: cfg.thresholdPercent,
            minBarsForConfirmation: cfg.minBarsForConfirmation,
        };

        // History
        this.priceHistory = [];
        this.feedHistory = [];
        this.amaHistory = [];

        // Trend state
        this.prevRawTrend = null;
        this.barsInTrend = 0;
        this.updateCount = 0;
    }

    /**
     * Feed a new candle close + the feed price at that time.
     *
     * @param {number} marketPrice – Candle close (or mid-price).
     * @param {number} feedPrice   – On-chain settlement feed price (same units).
     * @returns {Object} Analysis snapshot.
     */
    update(marketPrice, feedPrice) {
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
            throw new Error('marketPrice must be a positive finite number');
        }
        if (!Number.isFinite(feedPrice) || feedPrice <= 0) {
            throw new Error('feedPrice must be a positive finite number');
        }

        const amaValue = this.ama.update(marketPrice);

        this.priceHistory.push(marketPrice);
        this.feedHistory.push(feedPrice);
        this.amaHistory.push(amaValue);

        if (this.priceHistory.length > this.maxHistoryLength) {
            this.priceHistory.shift();
            this.feedHistory.shift();
            this.amaHistory.shift();
        }

        this.updateCount++;

        // Update trend state
        const raw = this._rawTrend();
        if (raw !== this.prevRawTrend) {
            this.prevRawTrend = raw;
            this.barsInTrend = 1;
        } else {
            this.barsInTrend++;
        }

        return this.getAnalysis();
    }

    // ── Internals ──────────────────────────────────────────────

    /**
     * Raw direction: AMA above / below feed by more than threshold.
     * @private
     */
    _rawTrend() {
        if (this.amaHistory.length === 0 || this.feedHistory.length === 0) {
            return 'NEUTRAL';
        }
        const amaValue = this.amaHistory[this.amaHistory.length - 1];
        const feed = this.feedHistory[this.feedHistory.length - 1];
        const deviationPercent = ((amaValue - feed) / feed) * 100;

        if (deviationPercent > this.thresholdPercent) return 'UP';
        if (deviationPercent < -this.thresholdPercent) return 'DOWN';
        return 'NEUTRAL';
    }

    /**
     * Deviation of AMA from feed as a percentage.
     */
    getDeviationPercent() {
        if (this.amaHistory.length === 0 || this.feedHistory.length === 0) return 0;
        const amaValue = this.amaHistory[this.amaHistory.length - 1];
        const feed = this.feedHistory[this.feedHistory.length - 1];
        return ((amaValue - feed) / feed) * 100;
    }

    // ── Public API (mirrors DualAMA interface where possible) ──

    getConfirmedTrend() {
        const rawTrend = this._rawTrend();
        const deviationPercent = this.getDeviationPercent();
        const absDeviation = Math.abs(deviationPercent);

        const isConfirmed =
            rawTrend !== 'NEUTRAL' &&
            this.barsInTrend >= this.minBarsForConfirmation &&
            this.updateCount >= this.ama.erPeriod + 1;

        // Confidence: map deviation to 0-100.  threshold = 20%, 5× threshold = 100%.
        let confidence = 0;
        if (rawTrend !== 'NEUTRAL') {
            confidence = Math.min(100, (absDeviation / (this.thresholdPercent * 5)) * 100);
        }

        return {
            trend: isConfirmed ? rawTrend : 'NEUTRAL',
            isConfirmed,
            rawTrend,
            confidence: Math.round(confidence),
            deviationPercent: Math.round(deviationPercent * 10000) / 10000,
            barsInTrend: this.barsInTrend,
        };
    }

    getAnalysis() {
        const warmupNeeded = this.ama.erPeriod + 1;
        if (this.updateCount < warmupNeeded) {
            return {
                isReady: false,
                reason: `Warming up: ${this.updateCount}/${warmupNeeded} candles`,
                trend: 'NEUTRAL',
                confidence: 0,
            };
        }

        const confirmed = this.getConfirmedTrend();
        const amaValue = this.amaHistory[this.amaHistory.length - 1];
        const feedValue = this.feedHistory[this.feedHistory.length - 1];
        const marketPrice = this.priceHistory[this.priceHistory.length - 1];

        return {
            isReady: true,
            trend: confirmed.trend,
            confidence: confirmed.confidence,
            isConfirmed: confirmed.isConfirmed,
            rawTrend: confirmed.rawTrend,
            barsInTrend: confirmed.barsInTrend,
            deviationPercent: confirmed.deviationPercent,
            amaValue: Math.round(amaValue * 1000000) / 1000000,
            feedPrice: feedValue,
            marketPrice,
            updateCount: this.updateCount,
        };
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

    getFullSnapshot() {
        const analysis = this.getAnalysis();
        return {
            ...analysis,
            config: { ...this._config },
            historyLength: this.priceHistory.length,
        };
    }

    reset() {
        const cfg = this._config;
        this.ama = new AMA(cfg.erPeriod, cfg.fastPeriod, cfg.slowPeriod);
        this.priceHistory = [];
        this.feedHistory = [];
        this.amaHistory = [];
        this.prevRawTrend = null;
        this.barsInTrend = 0;
        this.updateCount = 0;
    }
}

module.exports = { FeedTrend };
