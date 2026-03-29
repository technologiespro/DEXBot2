/**
 * Position Health Assessment
 *
 * Evaluates collateral ratio zones and trend alignment for open positions.
 * Consumes position state from PositionManager and trend signals from
 * TrendAnalyzer to produce actionable health assessments.
 */

'use strict';

const { computeDynamicWeights } = require('../../market_adapter/dynamic_weights');

const DEFAULT_PRICE_RANGE_RATIO = 3.0;

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

/**
 * Calculate the maximum debt supportable by the current collateral at a target CR.
 *
 * @param {number} currentCollateral – Current BTS collateral
 * @param {number} feedPrice         – BTS per MPA
 * @param {number} targetCr          – Target collateral ratio (default 2.0)
 * @returns {number} Debt level that matches the target CR
 */
function debtForTargetCr(currentCollateral, feedPrice, targetCr = 2.0) {
  if (!Number.isFinite(currentCollateral) || !Number.isFinite(feedPrice) || !Number.isFinite(targetCr)) {
    return 0;
  }
  if (currentCollateral <= 0 || feedPrice <= 0 || targetCr <= 0) {
    return 0;
  }
  return currentCollateral / (feedPrice * targetCr);
}

/**
 * Calculate how much debt to add/remove to reach a target CR using debt first.
 *
 * @param {number} currentCollateral – Current BTS collateral
 * @param {number} debtAmount        – Current MPA debt
 * @param {number} feedPrice         – BTS per MPA
 * @param {number} targetCr          – Target collateral ratio (default 2.0)
 * @returns {number} Delta (positive = can increase debt, negative = should reduce debt)
 */
function debtDeltaForTargetCr(currentCollateral, debtAmount, feedPrice, targetCr = 2.0) {
  const targetDebt = debtForTargetCr(currentCollateral, feedPrice, targetCr);
  return targetDebt - (debtAmount || 0);
}

/**
 * Build a CR adjustment plan using the actual strategy levers:
 * change debt first, then collateral if needed or desired.
 *
 * @param {number} currentCollateral – Current BTS collateral
 * @param {number} debtAmount        – Current MPA debt
 * @param {number} feedPrice         – BTS per MPA
 * @param {number} targetCr          – Target collateral ratio (default 2.0)
 * @returns {Object} Adjustment plan
 */
function planCrAdjustment(currentCollateral, debtAmount, feedPrice, targetCr = 2.0) {
  const targetDebt = debtForTargetCr(currentCollateral, feedPrice, targetCr);
  const debtDelta = debtDeltaForTargetCr(currentCollateral, debtAmount, feedPrice, targetCr);
  const targetCollateral = collateralForTargetCr(debtAmount, feedPrice, targetCr);
  const collateralDelta = collateralDeltaForTargetCr(currentCollateral, debtAmount, feedPrice, targetCr);

  let primaryAction = 'hold';
  let fallbackAction = 'hold';
  if (debtDelta < 0) {
    primaryAction = 'reduce_debt';
    fallbackAction = collateralDelta > 0 ? 'add_collateral' : 'hold';
  } else if (debtDelta > 0) {
    primaryAction = 'increase_debt';
    fallbackAction = collateralDelta < 0 ? 'withdraw_collateral' : 'hold';
  }

  return {
    targetCr,
    targetDebt,
    targetCollateral,
    debtDelta,
    collateralDelta,
    primaryAction,
    fallbackAction
  };
}

function roundNumber(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function normalizeWeightDistribution(weightDistribution) {
  return {
    sell: Number.isFinite(Number(weightDistribution?.sell)) ? Number(weightDistribution.sell) : 0.5,
    buy: Number.isFinite(Number(weightDistribution?.buy)) ? Number(weightDistribution.buy) : 0.5
  };
}

function parseRatioValue(value, referencePrice, mode) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
    if (match) {
      const ratio = Number(match[1]);
      return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    }
  }

  const numeric = Number(value);
  const reference = Number(referencePrice);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }
  return mode === 'min' ? reference / numeric : numeric / reference;
}

function formatRatioAsMultiplier(ratio) {
  const rounded = roundNumber(ratio, 2);
  return `${rounded}x`;
}

function classifyPriceRangeRatio(ratio) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 'unknown';
  }
  if (numeric < 2) {
    return 'very_competitive';
  }
  if (numeric < 3) {
    return 'competitive';
  }
  if (numeric <= 3.25) {
    return 'conservative';
  }
  return 'very_conservative';
}

function resolveCurrentPriceRangeRatio(botConfig = {}, referencePrice, options = {}) {
  const forced = Number(options.currentPriceRangeRatio);
  if (Number.isFinite(forced) && forced > 0) {
    return {
      isSymmetric: true,
      maxRatio: forced,
      minRatio: forced,
      ratio: forced
    };
  }

  const minRatio = parseRatioValue(botConfig.minPrice, referencePrice, 'min');
  const maxRatio = parseRatioValue(botConfig.maxPrice, referencePrice, 'max');
  const ratioCandidates = [minRatio, maxRatio].filter((value) => Number.isFinite(value) && value > 0);
  const ratio = ratioCandidates.length > 0 ? Math.max(...ratioCandidates) : DEFAULT_PRICE_RANGE_RATIO;

  return {
    isSymmetric: Number.isFinite(minRatio) && Number.isFinite(maxRatio) && Math.abs(minRatio - maxRatio) < 0.05,
    maxRatio,
    minRatio,
    ratio
  };
}

function computePriceRangeRatioPlan(botConfig = {}, options = {}) {
  const referencePrice = Number(options.referencePrice);
  const current = resolveCurrentPriceRangeRatio(botConfig, referencePrice, options);
  const rangeContext = options.rangeContext && typeof options.rangeContext === 'object' ? options.rangeContext : {};
  const observedMinPrice = Number(rangeContext.observedMinPrice);
  const observedMaxPrice = Number(rangeContext.observedMaxPrice);
  const touchCount = Math.max(0, Number(rangeContext.boundTouchCount || 0));
  const headroomFactor = Number.isFinite(Number(options.priceRangeHeadroomFactor))
    ? Math.max(1, Number(options.priceRangeHeadroomFactor))
    : 1.1;
  const touchExpansionFactor = 1 + Math.min(touchCount, 5) * 0.025;
  const minRatio = Number.isFinite(Number(options.minPriceRangeRatio))
    ? Math.max(1.05, Number(options.minPriceRangeRatio))
    : 1.25;
  const maxRatio = Number.isFinite(Number(options.maxPriceRangeRatio))
    ? Math.max(minRatio, Number(options.maxPriceRangeRatio))
    : 6.0;
  const minRangeRatioDelta = Number.isFinite(Number(options.minRangeRatioDelta))
    ? Math.max(0, Number(options.minRangeRatioDelta))
    : 0.25;

  let observedRatio = null;
  if (
    Number.isFinite(referencePrice) &&
    referencePrice > 0 &&
    Number.isFinite(observedMinPrice) &&
    observedMinPrice > 0 &&
    Number.isFinite(observedMaxPrice) &&
    observedMaxPrice > 0
  ) {
    observedRatio = Math.max(referencePrice / observedMinPrice, observedMaxPrice / referencePrice);
  }

  const recommendedRatio = Number.isFinite(observedRatio)
    ? Math.min(maxRatio, Math.max(minRatio, observedRatio * headroomFactor * touchExpansionFactor))
    : current.ratio;
  const roundedRecommendedRatio = roundNumber(recommendedRatio, 2);
  const ratioDelta = roundNumber(roundedRecommendedRatio - current.ratio, 2);
  const shouldUpdate = Math.abs(ratioDelta) >= minRangeRatioDelta;
  let reason = 'keep_existing_range_ratio';
  if (!Number.isFinite(observedRatio)) {
    reason = 'insufficient_range_history';
  } else if (ratioDelta > 0) {
    reason = 'historical_range_requires_wider_bounds';
  } else if (ratioDelta < 0) {
    reason = 'historical_range_supports_tighter_bounds';
  }

  return {
    classification: classifyPriceRangeRatio(roundedRecommendedRatio),
    currentClassification: classifyPriceRangeRatio(current.ratio),
    currentRatio: roundNumber(current.ratio, 2),
    isSymmetric: current.isSymmetric,
    observedRatio: Number.isFinite(observedRatio) ? roundNumber(observedRatio, 2) : null,
    ratioDelta,
    reason,
    recommendedRatio: roundedRecommendedRatio,
    referencePrice: Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null,
    shouldUpdate,
    touchCount
  };
}

function resolveTargetCr(position, trendSignal, botConfig, assessment, options) {
  if (typeof options.resolveTargetCr === 'function') {
    const resolved = options.resolveTargetCr(position, trendSignal, botConfig, assessment);
    return Number.isFinite(Number(resolved)) && Number(resolved) > 0 ? Number(resolved) : null;
  }
  if (Number.isFinite(Number(options.targetCr)) && Number(options.targetCr) > 0) {
    return Number(options.targetCr);
  }

  const currentCr = position?.onChain?.collateralRatio;
  return Number.isFinite(Number(currentCr)) && Number(currentCr) > 0 ? Number(currentCr) : null;
}

/**
 * Compute trend weight from confidence and trend direction.
 *
 * @param {string} trend       – 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} confidence  – 0–100
 * @returns {number} Weight multiplier (0.2 – 1.0)
 */
function trendWeight(trend, confidence) {
  if (trend === 'NEUTRAL') return 0.4;
  const c = Number(confidence) || 0;
  if (c >= 80) return 1.0;
  if (c >= 60) return 0.7;
  if (c >= 40) return 0.4;
  return 0.2;
}

/**
 * Compute CR weight from the current collateral ratio zone.
 *
 * @param {string} zone – CR zone label from classifyCrZone
 * @returns {number} Weight multiplier (0.0 – 1.5)
 */
function crWeight(zone) {
  switch (zone) {
    case 'red_high':    return 1.5;
    case 'orange_high': return 1.2;
    case 'green':       return 1.0;
    case 'orange_low':  return 0.5;
    case 'red_low':     return 0.0;
    default:            return 1.0;
  }
}

/**
 * Compute a signed price-offset bias from trend direction and confidence.
 *
 * @param {string} trend       – 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} confidence  – 0–100
 * @returns {number} Signed bias in the range [-1, 1]
 */
function computePriceOffsetBias(trend = 'NEUTRAL', confidence = 0) {
  if (trend === 'NEUTRAL') {
    return 0;
  }
  const strength = trendWeight(trend, confidence);
  if (trend === 'UP') {
    return strength;
  }
  if (trend === 'DOWN') {
    return -strength;
  }
  return 0;
}

/**
 * Compute directional order-weight bias from trend direction and confidence.
 * Positive bias means front-load that side; negative means flatten that side.
 *
 * @param {string} trend       – 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} confidence  – 0–100
 * @returns {{ profile: string, buyBias: number, sellBias: number, strength: number }}
 */
function computeOrderWeightBias(trend = 'NEUTRAL', confidence = 0) {
  if (trend === 'NEUTRAL') {
    return {
      profile: 'balanced',
      buyBias: 0,
      sellBias: 0,
      strength: 0
    };
  }

  const strength = trendWeight(trend, confidence);
  if (trend === 'DOWN') {
    return {
      profile: 'mountain_valley',
      buyBias: strength,
      sellBias: -strength,
      strength
    };
  }

  if (trend === 'UP') {
    return {
      profile: 'mountain_valley',
      buyBias: -strength,
      sellBias: strength,
      strength
    };
  }

  return {
    profile: 'balanced',
    buyBias: 0,
    sellBias: 0,
    strength: 0
  };
}

/**
 * Build a unified margin-trading plan that combines:
 * - CR adjustment intent (debt first, collateral second)
 * - final grid price offset percentage
 * - final weightDistribution values
 *
 * @param {Object} position      – Position object with onChain collateral/debt/feed data
 * @param {Object} [trendSignal] – Optional trend signal
 * @param {Object} [botConfig]   – Current bot config
 * @param {Object} [options]     – Planning options
 * @returns {Object} Unified plan with concrete bot patch outputs
 */
function buildMarginTradingPlan(position, trendSignal = null, botConfig = {}, options = {}) {
  const assessment = assessPosition(position, trendSignal);
  const targetCr = resolveTargetCr(position, trendSignal, botConfig, assessment, options);
  const feedPrice = Number(options.feedPrice ?? trendSignal?.feedPrice ?? position?.onChain?.btsPerMpa);
  const referencePrice = Number(
    options.referencePrice ??
    options.gridReferencePrice ??
    trendSignal?.marketPrice ??
    feedPrice
  );
  const currentCollateral = Number(position?.onChain?.collateralAmount || 0);
  const currentDebt = Number(position?.onChain?.debtAmount || 0);
  const currentGridPriceOffsetPct = Number.isFinite(Number(botConfig?.gridPriceOffsetPct))
    ? Number(botConfig.gridPriceOffsetPct)
    : 0;
  const offsetEnabled = botConfig?.gridPriceOffsetEnabled !== false && options.gridPriceOffsetEnabled !== false;
  const allowNeutralReset = options.allowNeutralGridReset !== undefined
    ? !!options.allowNeutralGridReset
    : botConfig?.gridPriceOffsetAllowNeutralReset !== false;
  const maxGridPriceOffsetPct = Number.isFinite(Number(options.maxGridPriceOffsetPct))
    ? Math.max(0, Number(options.maxGridPriceOffsetPct))
    : Number.isFinite(Number(botConfig?.gridPriceOffsetMaxPct))
      ? Math.max(0, Number(botConfig.gridPriceOffsetMaxPct))
      : 0.5;
  const priceOffsetScale = Number.isFinite(Number(options.priceOffsetScale))
    ? Math.max(0, Number(options.priceOffsetScale))
    : 1;

  const trend = trendSignal?.trend || 'NEUTRAL';
  const confidence = Number(trendSignal?.confidence || 0);
  const priceOffsetBias = computePriceOffsetBias(trend, confidence);
  const orderWeightBias = computeOrderWeightBias(trend, confidence);
  const priceRangePlan = computePriceRangeRatioPlan(botConfig, {
    ...options,
    referencePrice
  });

  let finalGridPriceOffsetPct = currentGridPriceOffsetPct;
  if (!offsetEnabled) {
    finalGridPriceOffsetPct = 0;
  } else if (trend === 'NEUTRAL') {
    finalGridPriceOffsetPct = allowNeutralReset ? 0 : currentGridPriceOffsetPct;
  } else {
    const scaledBias = Math.max(-1, Math.min(1, priceOffsetBias * priceOffsetScale));
    finalGridPriceOffsetPct = roundNumber(scaledBias * maxGridPriceOffsetPct, 3);
  }

  const currentWeights = normalizeWeightDistribution(botConfig?.weightDistribution);
  const weightPlan = computeDynamicWeights(
    trendSignal
      ? {
        confidence,
        isReady: trendSignal.isReady !== false,
        oscillation: trendSignal.oscillation,
        priceAnalysis: trendSignal.priceAnalysis,
        trend
      }
      : null,
    options.priceContext || {},
    currentWeights
  );

  const crPlan = targetCr && Number.isFinite(feedPrice) && feedPrice > 0
    ? planCrAdjustment(currentCollateral, currentDebt, feedPrice, targetCr)
    : {
      targetCr,
      targetDebt: null,
      targetCollateral: null,
      debtDelta: 0,
      collateralDelta: 0,
      primaryAction: 'hold',
      fallbackAction: 'hold'
    };
  const finalPriceRangeRatio = priceRangePlan.shouldUpdate
    ? priceRangePlan.recommendedRatio
    : priceRangePlan.currentRatio;

  return {
    assessment,
    targetCr,
    crPlan,
    marketPlan: {
      confidence,
      trend,
      priceOffsetBias,
      orderWeightBias
    },
    gridPlan: {
      currentGridPriceOffsetPct,
      finalGridPriceOffsetPct,
      finalPriceRangeRatio,
      maxGridPriceOffsetPct,
      priceRangePlan,
      weightProfile: weightPlan.profile,
      weightDistribution: {
        sell: weightPlan.sell,
        buy: weightPlan.buy
      }
    },
    botPatch: {
      gridPriceOffsetPct: finalGridPriceOffsetPct,
      maxPrice: formatRatioAsMultiplier(finalPriceRangeRatio),
      minPrice: formatRatioAsMultiplier(finalPriceRangeRatio),
      weightDistribution: {
        sell: weightPlan.sell,
        buy: weightPlan.buy
      }
    }
  };
}

module.exports = {
  CR_ZONES,
  assessAllPositions,
  assessPosition,
  buildMarginTradingPlan,
  checkTrendAlignment,
  classifyCrZone,
  classifyPriceRangeRatio,
  collateralDeltaForTargetCr,
  collateralForTargetCr,
  computePriceRangeRatioPlan,
  computeOrderWeightBias,
  computePriceOffsetBias,
  crWeight,
  debtDeltaForTargetCr,
  debtForTargetCr,
  planCrAdjustment,
  trendWeight,
};
