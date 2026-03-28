/**
 * Feed Premium / Discount Detector
 *
 * Compares the current market price against the on-chain settlement feed price
 * for an MPA (e.g. HONEST.USD).  No smoothing — this is an instantaneous
 * snapshot of whether the market values the MPA above or below its peg.
 *
 * Signals:
 *   PREMIUM   – market price > feed price  (MPA is overvalued)
 *   DISCOUNT  – market price < feed price  (MPA is undervalued)
 *   FAIR      – within the configured dead-zone (noise)
 */

'use strict';

const DEFAULT_DEAD_ZONE_PERCENT = 0.25;

class FeedPremium {
    /**
     * @param {Object}  config
     * @param {number}  config.deadZonePercent  – Minimum absolute deviation
     *        from feed price before a signal fires (default 0.25%).
     *        Prevents noise when market oscillates right around the peg.
     */
    constructor(config = {}) {
        this.deadZonePercent = Number.isFinite(config.deadZonePercent)
            ? config.deadZonePercent
            : DEFAULT_DEAD_ZONE_PERCENT;

        this.history = [];
        this.maxHistoryLength = 500;
    }

    /**
     * Record a new observation.
     *
     * @param {number} marketPrice  – Current market price (e.g. BTS per MPA
     *        on the order book — last trade, mid-price, or best bid/ask avg).
     * @param {number} feedPrice    – Current on-chain settlement feed price
     *        in the same units as marketPrice.
     * @returns {Object} Snapshot (same shape as getSnapshot).
     */
    update(marketPrice, feedPrice) {
        if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
            throw new Error('marketPrice must be a positive finite number');
        }
        if (!Number.isFinite(feedPrice) || feedPrice <= 0) {
            throw new Error('feedPrice must be a positive finite number');
        }

        this.history.push({ marketPrice, feedPrice, ts: Date.now() });

        if (this.history.length > this.maxHistoryLength) {
            this.history.shift();
        }

        return this.getSnapshot();
    }

    /**
     * Premium percentage: positive = market above feed, negative = below.
     * Formula: ((market - feed) / feed) * 100
     */
    getPremiumPercent() {
        if (this.history.length === 0) return 0;
        const last = this.history[this.history.length - 1];
        return ((last.marketPrice - last.feedPrice) / last.feedPrice) * 100;
    }

    /**
     * Current signal: PREMIUM | DISCOUNT | FAIR
     */
    getSignal() {
        const pct = this.getPremiumPercent();
        if (pct > this.deadZonePercent) return 'PREMIUM';
        if (pct < -this.deadZonePercent) return 'DISCOUNT';
        return 'FAIR';
    }

    /**
     * Complete snapshot for consumers.
     */
    getSnapshot() {
        if (this.history.length === 0) {
            return {
                isReady: false,
                signal: 'FAIR',
                premiumPercent: 0,
                marketPrice: null,
                feedPrice: null,
                deadZonePercent: this.deadZonePercent,
            };
        }

        const last = this.history[this.history.length - 1];
        const premiumPercent = this.getPremiumPercent();

        return {
            isReady: true,
            signal: this.getSignal(),
            premiumPercent: Math.round(premiumPercent * 10000) / 10000,
            marketPrice: last.marketPrice,
            feedPrice: last.feedPrice,
            deadZonePercent: this.deadZonePercent,
        };
    }

    /**
     * Statistics over the recorded history window.
     */
    getStats() {
        if (this.history.length === 0) {
            return { count: 0, avgPremium: 0, minPremium: 0, maxPremium: 0 };
        }

        const premiums = this.history.map(
            (h) => ((h.marketPrice - h.feedPrice) / h.feedPrice) * 100
        );

        const sum = premiums.reduce((a, b) => a + b, 0);
        return {
            count: premiums.length,
            avgPremium: Math.round((sum / premiums.length) * 10000) / 10000,
            minPremium: Math.round(Math.min(...premiums) * 10000) / 10000,
            maxPremium: Math.round(Math.max(...premiums) * 10000) / 10000,
        };
    }

    reset() {
        this.history = [];
    }
}

module.exports = { FeedPremium };
