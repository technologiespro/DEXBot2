'use strict';

const { TrendAnalyzer } = require('../../../../analysis/trend_detection/trend_analyzer');

/**
 * Trend Detection Service
 * Wraps TrendAnalyzer for market_adapter logic.
 */
class TrendDetectionService {
    constructor(config = {}) {
        this.analyzer = new TrendAnalyzer(config);
    }

    /**
     * Update trend detection with current data.
     * @param {number} marketPrice 
     * @param {number} feedPrice 
     */
    update(marketPrice, feedPrice) {
        return this.analyzer.update(marketPrice, feedPrice);
    }

    getAnalysis() {
        return this.analyzer.getAnalysis();
    }

    reset() {
        this.analyzer.reset();
    }
}

module.exports = { TrendDetectionService };
