/**
 * Decision Loop
 *
 * Core cycle that ties position discovery, health assessment, and trend
 * detection into an actionable evaluation. Runs on a schedule or on demand.
 *
 * Flow:
 *   1. Discover on-chain positions (position_discovery)
 *   2. Fetch trend input per market (feed_price_source)
 *   3. Update trend analyzer per market (trend_analyzer)
 *   4. Assess each position's health (position_health)
 *   5. Return assessments with prioritized actions
 *
 * This module evaluates and recommends — it does NOT execute trades.
 * Execution is a separate concern.
 */

'use strict';

const { discoverPositions } = require('./position_discovery');
const { assessPosition } = require('./position_health');
const { fetchTrendInput } = require('./feed_price_source');

// Lazy-load TrendAnalyzer to avoid circular dependency issues at startup
let TrendAnalyzer = null;
function getTrendAnalyzer() {
  if (!TrendAnalyzer) {
    TrendAnalyzer = require('../../analysis/trend_detection/trend_analyzer').TrendAnalyzer;
  }
  return TrendAnalyzer;
}

/**
 * Per-market trend analyzer instances, keyed by MPA symbol.
 * Persists across loop iterations so KAMA state accumulates.
 */
const analyzers = new Map();

function getOrCreateAnalyzer(mpaSymbol, config = {}) {
  if (!analyzers.has(mpaSymbol)) {
    const TA = getTrendAnalyzer();
    analyzers.set(mpaSymbol, new TA(config));
  }
  return analyzers.get(mpaSymbol);
}

/**
 * Run one evaluation cycle for all positions on an account.
 *
 * @param {string} accountName – BitShares account name
 * @param {Object} [options]
 * @param {Object} [options.analyzerConfig] – TrendAnalyzer config overrides
 * @param {Function} [options.logger]       – Log function (default console.log)
 * @returns {Object} { account, evaluatedAt, positions: [...assessments] }
 */
async function evaluate(accountName, options = {}) {
  const logger = options.logger || console.log;
  const analyzerConfig = options.analyzerConfig || {};

  // 1. Discover positions
  const positions = await discoverPositions(accountName);
  if (positions.length === 0) {
    return {
      account: accountName,
      evaluatedAt: new Date().toISOString(),
      positionCount: 0,
      positions: [],
    };
  }

  // 2–4. For each position: fetch trend, update analyzer, assess health
  const assessments = [];
  const marketsSeen = new Set();

  for (const position of positions) {
    const mpa = position.mpaSymbol;
    let trendSignal = null;

    // Fetch trend data once per market
    if (!marketsSeen.has(mpa)) {
      marketsSeen.add(mpa);
      try {
        const trendInput = await fetchTrendInput(mpa);
        if (trendInput.marketPrice != null && trendInput.feedPrice != null) {
          const analyzer = getOrCreateAnalyzer(mpa, analyzerConfig);
          const result = analyzer.update(trendInput.marketPrice, trendInput.feedPrice);
          trendSignal = {
            trend: result.trend,
            confidence: result.confidence,
            premium: trendInput.premium,
          };
        }
      } catch (err) {
        logger(`[decision_loop] trend fetch failed for ${mpa}: ${err.message}`);
      }
    } else {
      // Reuse last trend signal for same market
      const analyzer = analyzers.get(mpa);
      if (analyzer) {
        const snapshot = analyzer.getAnalysis();
        trendSignal = {
          trend: snapshot.trend,
          confidence: snapshot.confidence,
          premium: snapshot.premium?.percent || null,
        };
      }
    }

    // Assess health
    const assessment = assessPosition(position, trendSignal);
    assessment.market = position.market;
    assessment.mpaSymbol = mpa;
    assessment.onChain = position.onChain;
    assessments.push(assessment);
  }

  // 5. Sort by action priority: immediate first, then soon, then evaluate
  const priorityOrder = { immediate: 0, soon: 1, evaluate: 2, fallback: 3 };
  assessments.sort((a, b) => {
    const aPriority = a.actions[0]?.priority || 'fallback';
    const bPriority = b.actions[0]?.priority || 'fallback';
    return (priorityOrder[aPriority] ?? 99) - (priorityOrder[bPriority] ?? 99);
  });

  return {
    account: accountName,
    evaluatedAt: new Date().toISOString(),
    positionCount: assessments.length,
    positions: assessments,
    summary: buildSummary(assessments),
  };
}

/**
 * Build a quick summary of the evaluation results.
 */
function buildSummary(assessments) {
  const zones = { red_low: 0, orange_low: 0, green: 0, orange_high: 0, red_high: 0, unknown: 0 };
  let immediateActions = 0;
  let soonActions = 0;

  for (const a of assessments) {
    const zone = a.collateral?.zone || 'unknown';
    zones[zone] = (zones[zone] || 0) + 1;

    for (const action of a.actions) {
      if (action.priority === 'immediate') immediateActions++;
      if (action.priority === 'soon') soonActions++;
    }
  }

  return {
    zones,
    immediateActions,
    soonActions,
    allGreen: zones.green === assessments.length,
  };
}

/**
 * Reset all cached trend analyzers. Useful for testing or config changes.
 */
function resetAnalyzers() {
  analyzers.clear();
}

module.exports = {
  evaluate,
  getOrCreateAnalyzer,
  resetAnalyzers,
};
