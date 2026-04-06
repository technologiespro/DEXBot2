/**
 * Bot Auto-Tuner
 *
 * Analyzes position health assessments from decision_loop and generates
 * tuning recommendations covering both bot settings patches and CR actions.
 *
 * Weight adjustments are delegated to market_adapter/dynamic_weights
 * (mountain/valley strategy) so sizing logic stays in one place.
 *
 * Green zone  → patch weightDistribution via computeDynamicWeights
 * Non-green   → crAction (reduce_debt / add_collateral / increase_debt /
 *               withdraw_collateral) derived from assessment.actions
 */

'use strict';

const { computeDynamicWeights } = require('../../market_adapter/core/strategies/dynamic_weights');

/**
 * Generate a universal tuning recommendation for a bot position.
 *
 * Return shape:
 *   {
 *     canTune:    boolean   — true if patch has entries or crAction is set
 *     patch:      Object    — bot settings to apply via applyBotSettingsPatch
 *     crAction:   Object|null — CR adjustment to execute on-chain
 *       { action, targetCr, priority, reason }
 *     confidence: number    — 0–1
 *     reasoning:  string[]
 *   }
 *
 * @param {Object} bot        - Bot config with current settings
 * @param {Object} assessment - Health assessment from assessPosition / decision_loop
 * @returns {Object}
 */
function tuneBot(bot, assessment = {}) {
  if (!bot || typeof bot !== 'object') {
    return { canTune: false, patch: {}, crAction: null, confidence: 0, reasoning: ['Invalid bot configuration'] };
  }

  if (!assessment || typeof assessment !== 'object') {
    return { canTune: false, patch: {}, crAction: null, confidence: 0, reasoning: ['Invalid position assessment'] };
  }

  const zone = assessment.collateral?.zone || 'unknown';
  const trend = assessment.trend;
  const trendConfidence = trend?.confidence ?? 0;

  if (zone === 'unknown' || trendConfidence < 40) {
    return {
      canTune: false,
      patch: {},
      crAction: null,
      confidence: 0,
      reasoning: [`Insufficient data: zone=${zone}, trendConfidence=${trendConfidence}%`]
    };
  }

  const patch = {};
  let crAction = null;
  const reasoning = [];
  let baseConfidence = 0.5;

  // Weight distribution via market_adapter mountain/valley strategy
  const currentWeights = bot.weightDistribution ?? { buy: 0.5, sell: 0.5 };
  const nextWeights = computeDynamicWeights(
    { isReady: true, trend: trend.signal, confidence: trendConfidence },
    {},
    currentWeights
  );

  if (nextWeights.profile !== 'static') {
    patch.weightDistribution = { buy: nextWeights.buy, sell: nextWeights.sell };
    reasoning.push(
      `${nextWeights.meta.scenario} ${nextWeights.meta.trend} (${trendConfidence}%): ` +
      `buy ${currentWeights.buy} → ${nextWeights.buy}, sell ${currentWeights.sell} → ${nextWeights.sell}`
    );
    baseConfidence = 0.75;
  }

  // CR actions: only for non-green zones
  if (zone !== 'green') {
    const primaryAction = assessment.actions?.[0] || null;

    if (primaryAction) {
      // Target CR: for low zones aim for green floor (2.0); for high zones aim for green ceiling (2.5)
      const targetCr = (zone === 'red_low' || zone === 'orange_low') ? 2.0 : 2.5;

      crAction = {
        action: primaryAction.action,
        targetCr,
        priority: primaryAction.priority,
        reason: primaryAction.reason
      };

      reasoning.push(`CR ${zone}: ${primaryAction.action} → target CR ${targetCr} (${primaryAction.priority})`);
      baseConfidence = zone.startsWith('red') ? 0.70 : 0.65;
    } else {
      reasoning.push(`CR ${zone}: no action in assessment`);
    }
  }

  const hasPatch = Object.keys(patch).length > 0;
  const confidence = Math.min(
    1.0,
    baseConfidence +
      (hasPatch || crAction ? 0.15 : 0) +
      (trendConfidence / 100) * 0.2
  );

  const canTune = hasPatch || crAction !== null;

  return {
    canTune,
    patch,
    crAction,
    confidence: Math.round(confidence * 100) / 100,
    reasoning: reasoning.length > 0 ? reasoning : ['No tuning adjustments recommended']
  };
}

module.exports = { tuneBot };
