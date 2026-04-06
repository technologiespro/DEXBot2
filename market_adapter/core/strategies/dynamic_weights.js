/**
 * Dynamic Weight Distribution — Mountain / Valley Strategy
 *
 * Computes order sizing weights based on current trend, observed price range,
 * and the probability of price reaching each grid level. This is market-adapter
 * logic only: it produces suggested weightDistribution values for a bot config,
 * but does not modify the order engine directly.
 *
 * Two strategy profiles:
 *
 *   DOUBLE MOUNTAIN (sideways / NEUTRAL):
 *     Both buy and sell sides are front-loaded (high W). Price bounces within
 *     a range, so large orders near market on BOTH sides capture spread.
 *     Visual: two peaks flanking the spread gap.
 *
 *   MOUNTAIN / VALLEY (trending):
 *     The with-trend side is the MOUNTAIN — front-loaded, large orders near
 *     market where fills are most probable (price is moving toward them).
 *     The against-trend side is the VALLEY — flattened or inverted, capital
 *     spread thin across levels that price is moving away from.
 *     Visual: one peak (mountain) on the with-trend side, one trough (valley)
 *     on the against-trend side.
 *
 *     DOWN trend: buy = mountain, sell = valley
 *     UP trend:   sell = mountain, buy = valley
 */

'use strict';

// Mountain weight: front-loaded, large orders near market
const MOUNTAIN_WEIGHT = 1.0;

// Valley weight: flattened, capital spread evenly or inverted
const VALLEY_WEIGHT = 0.0;

// Baseline for fallback (no signal)
const BASELINE_WEIGHT = 0.5;

// Weight bounds to prevent extreme allocations
const MIN_WEIGHT = -0.5;
const MAX_WEIGHT = 1.5;

/**
 * Strategy profiles derived from trend state.
 *
 * DOUBLE_MOUNTAIN: sideways — both sides front-loaded toward market
 * MOUNTAIN_VALLEY: trending — with-trend side concentrated, against-trend spread
 *
 * mountainTarget: W value for the mountain (with-trend or both) side
 * valleyTarget:   W value for the valley (against-trend) side
 * blend:          how aggressively to move from baseline toward target (0–1)
 */
const TREND_SCENARIOS = Object.freeze({
  STRONG:   { minConfidence: 80, mountainTarget: 1.2,  valleyTarget: -0.15, blend: 1.0 },
  MODERATE: { minConfidence: 60, mountainTarget: 1.0,  valleyTarget: 0.1,   blend: 0.75 },
  WEAK:     { minConfidence: 40, mountainTarget: 0.8,  valleyTarget: 0.25,  blend: 0.5 },
  MINIMAL:  { minConfidence: 0,  mountainTarget: 0.65, valleyTarget: 0.4,   blend: 0.25 },
});

/**
 * Double-mountain targets for sideways markets.
 * Both sides get front-loaded weight, scaled by oscillation tightness.
 */
const DOUBLE_MOUNTAIN = Object.freeze({
  target: 1.0,        // Both sides aim for W=1.0 (front-loaded)
  tightBoost: 1.2,    // Very tight oscillation → even more concentrated
});

function classifyTrendScenario(confidence) {
  const c = Number(confidence) || 0;
  if (c >= TREND_SCENARIOS.STRONG.minConfidence) return TREND_SCENARIOS.STRONG;
  if (c >= TREND_SCENARIOS.MODERATE.minConfidence) return TREND_SCENARIOS.MODERATE;
  if (c >= TREND_SCENARIOS.WEAK.minConfidence) return TREND_SCENARIOS.WEAK;
  return TREND_SCENARIOS.MINIMAL;
}

function computePositionBias(pricePositionInRange) {
  const pos = Number.isFinite(pricePositionInRange) ? pricePositionInRange : 0.5;
  const clamped = Math.max(0, Math.min(1, pos));
  const deviation = clamped - 0.5;
  const biasScale = 0.6;
  return {
    sellBias: deviation * biasScale,
    buyBias: -deviation * biasScale
  };
}

function oscillationFactor(oscillationRatio) {
  const r = Number(oscillationRatio) || 0;
  if (r >= 10) return 0.5;
  if (r >= 5) return 0.7;
  if (r >= 3) return 0.85;
  if (r >= 1) return 1.0;
  return 1.2;
}

function computeDynamicWeights(trendAnalysis, priceContext = {}, baseWeights = { sell: BASELINE_WEIGHT, buy: BASELINE_WEIGHT }) {
  if (!trendAnalysis || !trendAnalysis.isReady) {
    return {
      sell: baseWeights.sell,
      buy: baseWeights.buy,
      profile: 'static',
      meta: { source: 'static', reason: 'trend not ready' }
    };
  }

  const { trend, confidence } = trendAnalysis;
  const scenario = classifyTrendScenario(confidence);
  const oscRatio = priceContext.oscillationRatio ??
    (trendAnalysis.oscillation?.ratio ?? 0);
  const oscFactor = oscillationFactor(oscRatio);
  const posInRange = priceContext.pricePositionInRange ??
    (trendAnalysis.priceAnalysis?.inRange != null ? trendAnalysis.priceAnalysis.inRange / 100 : 0.5);
  const bias = computePositionBias(posInRange);

  let sellW;
  let buyW;
  let profile;

  if (trend === 'NEUTRAL') {
    profile = 'double_mountain';
    const target = oscFactor >= 1.2 ? DOUBLE_MOUNTAIN.tightBoost : DOUBLE_MOUNTAIN.target;
    const neutralBlend = Math.min(1.0, scenario.blend + 0.5);
    sellW = BASELINE_WEIGHT + (target - BASELINE_WEIGHT) * neutralBlend;
    buyW = BASELINE_WEIGHT + (target - BASELINE_WEIGHT) * neutralBlend;
    sellW += bias.sellBias * 0.5;
    buyW += bias.buyBias * 0.5;
  } else {
    profile = 'mountain_valley';
    const mountainW = BASELINE_WEIGHT + (scenario.mountainTarget - BASELINE_WEIGHT) * scenario.blend;
    const valleyW = BASELINE_WEIGHT + (scenario.valleyTarget - BASELINE_WEIGHT) * scenario.blend;

    if (trend === 'DOWN') {
      buyW = mountainW;
      sellW = valleyW;
    } else {
      sellW = mountainW;
      buyW = valleyW;
    }

    sellW += bias.sellBias;
    buyW += bias.buyBias;

    sellW = BASELINE_WEIGHT + (sellW - BASELINE_WEIGHT) * oscFactor;
    buyW = BASELINE_WEIGHT + (buyW - BASELINE_WEIGHT) * oscFactor;
  }

  sellW = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, sellW));
  buyW = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, buyW));
  sellW = Math.round(sellW * 100) / 100;
  buyW = Math.round(buyW * 100) / 100;

  const scenarioName = scenario === TREND_SCENARIOS.STRONG ? 'strong'
    : scenario === TREND_SCENARIOS.MODERATE ? 'moderate'
    : scenario === TREND_SCENARIOS.WEAK ? 'weak' : 'minimal';

  return {
    sell: sellW,
    buy: buyW,
    profile,
    meta: {
      source: 'dynamic',
      trend,
      confidence,
      scenario: scenarioName,
      pricePositionInRange: Math.round(posInRange * 100) / 100,
      oscillationRatio: oscRatio,
      oscillationFactor: oscFactor,
      biases: bias
    }
  };
}

function computeSlotFillProbabilities(priceLevels, currentPrice, trend, confidence, priceRange = null) {
  if (!priceLevels || priceLevels.length === 0) return [];
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return new Array(priceLevels.length).fill(1 / priceLevels.length);
  }

  const c = (Number(confidence) || 0) / 100;
  const observedRange = priceRange
    ? (priceRange.max - priceRange.min)
    : currentPrice * 0.1;
  const rangeScale = observedRange > 0 ? observedRange : currentPrice * 0.1;

  const rawProbs = priceLevels.map((price) => {
    const distance = Math.abs(price - currentPrice) / rangeScale;
    let prob = Math.exp(-distance * 1.5);

    if (trend === 'UP' && price > currentPrice) {
      prob *= 1 + c * 0.5;
    } else if (trend === 'UP' && price < currentPrice) {
      prob *= 1 - c * 0.3;
    } else if (trend === 'DOWN' && price < currentPrice) {
      prob *= 1 + c * 0.5;
    } else if (trend === 'DOWN' && price > currentPrice) {
      prob *= 1 - c * 0.3;
    }

    if (priceRange && price >= priceRange.min && price <= priceRange.max) {
      prob *= 1.2;
    }

    return Math.max(0, prob);
  });

  const total = rawProbs.reduce((s, p) => s + p, 0) || 1;
  return rawProbs.map((p) => Math.round((p / total) * 10000) / 10000);
}

module.exports = {
  BASELINE_WEIGHT,
  DOUBLE_MOUNTAIN,
  MAX_WEIGHT,
  MIN_WEIGHT,
  MOUNTAIN_WEIGHT,
  TREND_SCENARIOS,
  VALLEY_WEIGHT,
  classifyTrendScenario,
  computeDynamicWeights,
  computePositionBias,
  computeSlotFillProbabilities,
  oscillationFactor,
};
