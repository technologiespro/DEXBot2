/**
 * Position Health Assessment
 *
 * Evaluates collateral ratio zones and trend alignment for open positions.
 * Consumes position state from PositionManager and trend signals from
 * TrendAnalyzer to produce actionable health assessments.
 */

'use strict';

// CR Zone boundaries for HONEST.Assets (MCR = 1.4)
// Low zones: under-collateralized (liquidation risk)
// High zones: over-collateralized (capital inefficiency)
const CR_ZONES = Object.freeze({
  RED_HIGH:    Object.freeze({ min: 3.0,  label: 'red_high',    status: 'over_collateralized' }),
  ORANGE_HIGH: Object.freeze({ min: 2.5,  label: 'orange_high', status: 'excess_collateral' }),
  GREEN:       Object.freeze({ min: 2.0,  label: 'green',       status: 'safe' }),
  ORANGE_LOW:  Object.freeze({ min: 1.7,  label: 'orange_low',  status: 'temporary' }),
  RED_LOW:     Object.freeze({ min: 0,    label: 'red_low',     status: 'not_acceptable' }),
});

/**
 * Classify a collateral ratio into a zone.
 *
 * @param {number|null} cr – Collateral ratio (e.g. 2.1)
 * @returns {Object} { zone, label, status, cr }
 */
function classifyCrZone(cr) {
  if (!Number.isFinite(cr) || cr <= 0) {
    return { zone: 'unknown', label: 'unknown', status: 'no_data', cr: null };
  }
  if (cr >= CR_ZONES.RED_HIGH.min) {
    return { zone: 'red_high', label: CR_ZONES.RED_HIGH.label, status: CR_ZONES.RED_HIGH.status, cr };
  }
  if (cr >= CR_ZONES.ORANGE_HIGH.min) {
    return { zone: 'orange_high', label: CR_ZONES.ORANGE_HIGH.label, status: CR_ZONES.ORANGE_HIGH.status, cr };
  }
  if (cr >= CR_ZONES.GREEN.min) {
    return { zone: 'green', label: CR_ZONES.GREEN.label, status: CR_ZONES.GREEN.status, cr };
  }
  if (cr >= CR_ZONES.ORANGE_LOW.min) {
    return { zone: 'orange_low', label: CR_ZONES.ORANGE_LOW.label, status: CR_ZONES.ORANGE_LOW.status, cr };
  }
  return { zone: 'red_low', label: CR_ZONES.RED_LOW.label, status: CR_ZONES.RED_LOW.status, cr };
}

/**
 * Check if a position's direction is aligned with a trend signal.
 *
 * @param {string} positionSide – 'short' or 'long'
 * @param {string} trend        – 'UP', 'DOWN', or 'NEUTRAL'
 * @returns {string} 'aligned' | 'opposed' | 'neutral'
 */
function checkTrendAlignment(positionSide, trend) {
  if (trend === 'NEUTRAL') return 'neutral';
  if (positionSide === 'short' && trend === 'DOWN') return 'aligned';
  if (positionSide === 'short' && trend === 'UP') return 'opposed';
  if (positionSide === 'long' && trend === 'UP') return 'aligned';
  if (positionSide === 'long' && trend === 'DOWN') return 'opposed';
  return 'neutral';
}

/**
 * Assess the health of a position.
 *
 * @param {Object} position      – Position object from PositionManager
 * @param {Object} [trendSignal] – Optional { trend, confidence, premium } from TrendAnalyzer
 * @returns {Object} Health assessment
 */
function assessPosition(position, trendSignal = null) {
  const cr = position?.onChain?.collateralRatio ?? null;
  const crZone = classifyCrZone(cr);
  const status = position?.status || 'unknown';
  const hasDebt = (position?.onChain?.debtAmount || 0) > 0;

  const assessment = {
    positionId: position?.id || null,
    status,
    hasDebt,
    collateral: {
      ratio: cr,
      zone: crZone.zone,
      zoneStatus: crZone.status,
    },
    actions: [],
  };

  // CR zone actions
  if (hasDebt) {
    if (crZone.zone === 'red_low') {
      assessment.actions.push({
        priority: 'immediate',
        action: 'reduce_debt',
        reason: 'CR below 1.7 — reduce debt to restore CR (layer 1)',
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'add_collateral',
        reason: 'CR below 1.7 — add collateral if debt reduction insufficient (layer 2)',
      });
    } else if (crZone.zone === 'orange_low') {
      assessment.actions.push({
        priority: 'soon',
        action: 'reduce_debt',
        reason: 'CR between 1.7 and 2.0 — reduce debt to restore CR (layer 1)',
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'add_collateral',
        reason: 'CR between 1.7 and 2.0 — add collateral if needed (layer 2)',
      });
    } else if (crZone.zone === 'red_high') {
      assessment.actions.push({
        priority: 'immediate',
        action: 'increase_debt',
        reason: 'CR above 3.0 — increase debt to put capital to work (layer 1)',
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'withdraw_collateral',
        reason: 'CR above 3.0 — withdraw collateral if debt increase insufficient (layer 2)',
      });
    } else if (crZone.zone === 'orange_high') {
      assessment.actions.push({
        priority: 'soon',
        action: 'increase_debt',
        reason: 'CR between 2.5 and 3.0 — consider increasing debt (layer 1)',
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'withdraw_collateral',
        reason: 'CR between 2.5 and 3.0 — withdraw collateral if needed (layer 2)',
      });
    }
  }

  // Trend alignment (only for positions with debt = short positions)
  if (trendSignal && hasDebt) {
    const alignment = checkTrendAlignment('short', trendSignal.trend);
    assessment.trend = {
      signal: trendSignal.trend,
      confidence: trendSignal.confidence || 0,
      alignment,
      premium: trendSignal.premium || null,
    };

    if (alignment === 'opposed' && trendSignal.confidence >= 50) {
      assessment.actions.push({
        priority: 'evaluate',
        action: 'review_direction',
        reason: `Position opposed to ${trendSignal.trend} trend (confidence ${trendSignal.confidence}%)`,
      });
    }
  }

  return assessment;
}

/**
 * Assess all positions from a PositionManager state.
 *
 * @param {Array}  positions     – Array of position objects
 * @param {Object} [trendSignal] – Optional trend signal to apply to all
 * @returns {Array} Array of health assessments
 */
function assessAllPositions(positions, trendSignal = null) {
  return (positions || []).map((p) => assessPosition(p, trendSignal));
}

/**
 * Calculate the minimum collateral needed to reach a target CR.
 *
 * @param {number} debtAmount  – MPA debt amount
 * @param {number} feedPrice   – BTS per MPA (from feed)
 * @param {number} targetCr    – Target collateral ratio (default 2.0)
 * @returns {number} BTS collateral needed
 */
function collateralForTargetCr(debtAmount, feedPrice, targetCr = 2.0) {
  if (!Number.isFinite(debtAmount) || !Number.isFinite(feedPrice) || debtAmount <= 0 || feedPrice <= 0) {
    return 0;
  }
  return debtAmount * feedPrice * targetCr;
}

/**
 * Calculate how much collateral to add/remove to reach target CR.
 *
 * @param {number} currentCollateral – Current BTS collateral
 * @param {number} debtAmount        – MPA debt amount
 * @param {number} feedPrice         – BTS per MPA
 * @param {number} targetCr          – Target CR (default 2.0)
 * @returns {number} Delta (positive = add, negative = can remove)
 */
function collateralDeltaForTargetCr(currentCollateral, debtAmount, feedPrice, targetCr = 2.0) {
  const needed = collateralForTargetCr(debtAmount, feedPrice, targetCr);
  return needed - (currentCollateral || 0);
}

module.exports = {
  CR_ZONES,
  assessAllPositions,
  assessPosition,
  checkTrendAlignment,
  classifyCrZone,
  collateralDeltaForTargetCr,
  collateralForTargetCr,
};
