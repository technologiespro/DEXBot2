'use strict';

const assert = require('assert');
const {
  BASELINE_WEIGHT,
  DOUBLE_MOUNTAIN,
  TREND_SCENARIOS,
  classifyTrendScenario,
  computeDynamicWeights,
  computePositionBias,
  computeSlotFillProbabilities,
  oscillationFactor,
} = require('../market_adapter/dynamic_weights');

// ── classifyTrendScenario ──

function testClassifyTrendScenario() {
  console.log('  classifyTrendScenario...');

  assert.strictEqual(classifyTrendScenario(90), TREND_SCENARIOS.STRONG);
  assert.strictEqual(classifyTrendScenario(80), TREND_SCENARIOS.STRONG);
  assert.strictEqual(classifyTrendScenario(70), TREND_SCENARIOS.MODERATE);
  assert.strictEqual(classifyTrendScenario(60), TREND_SCENARIOS.MODERATE);
  assert.strictEqual(classifyTrendScenario(50), TREND_SCENARIOS.WEAK);
  assert.strictEqual(classifyTrendScenario(40), TREND_SCENARIOS.WEAK);
  assert.strictEqual(classifyTrendScenario(30), TREND_SCENARIOS.MINIMAL);
  assert.strictEqual(classifyTrendScenario(0), TREND_SCENARIOS.MINIMAL);
  assert.strictEqual(classifyTrendScenario(null), TREND_SCENARIOS.MINIMAL);

  console.log('    PASS');
}

// ── computePositionBias ──

function testComputePositionBias() {
  console.log('  computePositionBias...');

  // At center (0.5): no bias
  const mid = computePositionBias(0.5);
  assert.ok(Math.abs(mid.sellBias) === 0, 'sell bias at center should be zero');
  assert.ok(Math.abs(mid.buyBias) === 0, 'buy bias at center should be zero');

  // At top (1.0): sell bias positive, buy bias negative
  const top = computePositionBias(1.0);
  assert.ok(top.sellBias > 0, 'sell bias should be positive at top');
  assert.ok(top.buyBias < 0, 'buy bias should be negative at top');

  // At bottom (0.0): sell bias negative, buy bias positive
  const bottom = computePositionBias(0.0);
  assert.ok(bottom.sellBias < 0, 'sell bias should be negative at bottom');
  assert.ok(bottom.buyBias > 0, 'buy bias should be positive at bottom');

  // Symmetry
  assert.strictEqual(top.sellBias, -bottom.sellBias);
  assert.strictEqual(top.buyBias, -bottom.buyBias);

  // Handles invalid input
  const invalid = computePositionBias(NaN);
  assert.ok(Math.abs(invalid.sellBias) === 0, 'invalid input sell bias should be zero');
  assert.ok(Math.abs(invalid.buyBias) === 0, 'invalid input buy bias should be zero');

  console.log('    PASS');
}

// ── oscillationFactor ──

function testOscillationFactor() {
  console.log('  oscillationFactor...');

  assert.strictEqual(oscillationFactor(15), 0.5);   // very volatile
  assert.strictEqual(oscillationFactor(10), 0.5);
  assert.strictEqual(oscillationFactor(7), 0.7);    // choppy
  assert.strictEqual(oscillationFactor(5), 0.7);
  assert.strictEqual(oscillationFactor(4), 0.85);   // normal
  assert.strictEqual(oscillationFactor(3), 0.85);
  assert.strictEqual(oscillationFactor(2), 1.0);    // tight
  assert.strictEqual(oscillationFactor(1), 1.0);
  assert.strictEqual(oscillationFactor(0.5), 1.2);  // very tight
  assert.strictEqual(oscillationFactor(0), 1.2);

  console.log('    PASS');
}

// ── computeDynamicWeights ──

function testDynamicWeightsNotReady() {
  console.log('  computeDynamicWeights (not ready)...');

  const result = computeDynamicWeights(null);
  assert.strictEqual(result.sell, BASELINE_WEIGHT);
  assert.strictEqual(result.buy, BASELINE_WEIGHT);
  assert.strictEqual(result.meta.source, 'static');

  const notReady = computeDynamicWeights({ isReady: false, trend: 'NEUTRAL', confidence: 0 });
  assert.strictEqual(notReady.sell, BASELINE_WEIGHT);
  assert.strictEqual(notReady.buy, BASELINE_WEIGHT);

  console.log('    PASS');
}

function testDynamicWeightsNeutralDoubleMountain() {
  console.log('  computeDynamicWeights (NEUTRAL → double mountain)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'NEUTRAL', confidence: 50 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );

  // Neutral trend = double mountain: BOTH sides above baseline (front-loaded)
  assert.ok(result.sell > BASELINE_WEIGHT, `sell ${result.sell} should be above baseline in double mountain`);
  assert.ok(result.buy > BASELINE_WEIGHT, `buy ${result.buy} should be above baseline in double mountain`);
  assert.strictEqual(result.profile, 'double_mountain');
  assert.strictEqual(result.meta.source, 'dynamic');
  assert.strictEqual(result.meta.trend, 'NEUTRAL');

  // Both sides should be roughly equal at center position
  assert.ok(Math.abs(result.sell - result.buy) < 0.1, 'double mountain should be roughly symmetric at center');

  console.log('    PASS');
}

function testDynamicWeightsStrongDownMountainValley() {
  console.log('  computeDynamicWeights (strong DOWN → buy=mountain, sell=valley)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'DOWN', confidence: 90 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );

  // Strong downtrend: buy = mountain (front-loaded), sell = valley (flattened)
  assert.ok(result.buy > BASELINE_WEIGHT, `buy ${result.buy} should be mountain (above baseline)`);
  assert.ok(result.sell < BASELINE_WEIGHT, `sell ${result.sell} should be valley (below baseline)`);
  assert.ok(result.buy > result.sell, 'mountain (buy) should exceed valley (sell)');
  assert.strictEqual(result.profile, 'mountain_valley');

  console.log('    PASS');
}

function testDynamicWeightsStrongUpMountainValley() {
  console.log('  computeDynamicWeights (strong UP → sell=mountain, buy=valley)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'UP', confidence: 85 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );

  // Strong uptrend: sell = mountain (front-loaded), buy = valley (flattened)
  assert.ok(result.sell > BASELINE_WEIGHT, `sell ${result.sell} should be mountain (above baseline)`);
  assert.ok(result.buy < BASELINE_WEIGHT, `buy ${result.buy} should be valley (below baseline)`);
  assert.ok(result.sell > result.buy, 'mountain (sell) should exceed valley (buy)');
  assert.strictEqual(result.profile, 'mountain_valley');

  console.log('    PASS');
}

function testDynamicWeightsPriceAtTop() {
  console.log('  computeDynamicWeights (double mountain, price at top)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'NEUTRAL', confidence: 50 },
    { pricePositionInRange: 0.9, oscillationRatio: 2 }
  );

  // Double mountain with price at top: both still above baseline,
  // but sell mountain is taller (sells more likely to fill near top)
  assert.ok(result.sell > result.buy, `sell ${result.sell} should exceed buy ${result.buy} when price near top`);
  assert.strictEqual(result.profile, 'double_mountain');

  console.log('    PASS');
}

function testDynamicWeightsPriceAtBottom() {
  console.log('  computeDynamicWeights (double mountain, price at bottom)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'NEUTRAL', confidence: 50 },
    { pricePositionInRange: 0.1, oscillationRatio: 2 }
  );

  // Double mountain with price at bottom: both still above baseline,
  // but buy mountain is taller (buys more likely to fill near bottom)
  assert.ok(result.buy > result.sell, `buy ${result.buy} should exceed sell ${result.sell} when price near bottom`);
  assert.strictEqual(result.profile, 'double_mountain');

  console.log('    PASS');
}

function testDynamicWeightsHighVolatilityDampens() {
  console.log('  computeDynamicWeights (high volatility dampens mountain/valley contrast)...');

  const tight = computeDynamicWeights(
    { isReady: true, trend: 'DOWN', confidence: 80 },
    { pricePositionInRange: 0.5, oscillationRatio: 1 }
  );

  const volatile = computeDynamicWeights(
    { isReady: true, trend: 'DOWN', confidence: 80 },
    { pricePositionInRange: 0.5, oscillationRatio: 12 }
  );

  // Both should show buy > sell (downtrend mountain/valley),
  // but volatile version has less contrast (mountain less tall, valley less deep)
  const tightContrast = tight.buy - tight.sell;
  const volatileContrast = volatile.buy - volatile.sell;
  assert.ok(volatileContrast < tightContrast,
    `volatile contrast ${volatileContrast} should be less than tight ${tightContrast}`);
  // Both still mountain/valley
  assert.strictEqual(tight.profile, 'mountain_valley');
  assert.strictEqual(volatile.profile, 'mountain_valley');

  console.log('    PASS');
}

function testDynamicWeightsClampsToBounds() {
  console.log('  computeDynamicWeights (clamped to bounds)...');

  // Extreme: strong trend + price at edge + tight oscillation
  const extreme = computeDynamicWeights(
    { isReady: true, trend: 'UP', confidence: 100 },
    { pricePositionInRange: 1.0, oscillationRatio: 0 }
  );

  assert.ok(extreme.sell <= 1.5, `sell ${extreme.sell} should not exceed MAX_WEIGHT`);
  assert.ok(extreme.buy >= -0.5, `buy ${extreme.buy} should not be below MIN_WEIGHT`);

  console.log('    PASS');
}

function testDoubleMountainTightOscillation() {
  console.log('  computeDynamicWeights (double mountain, very tight oscillation)...');

  const result = computeDynamicWeights(
    { isReady: true, trend: 'NEUTRAL', confidence: 60 },
    { pricePositionInRange: 0.5, oscillationRatio: 0.5 }
  );

  // Very tight oscillation in sideways market → extra concentrated double mountain
  assert.ok(result.sell >= DOUBLE_MOUNTAIN.target, `sell ${result.sell} should reach tight-boost target`);
  assert.ok(result.buy >= DOUBLE_MOUNTAIN.target, `buy ${result.buy} should reach tight-boost target`);
  assert.strictEqual(result.profile, 'double_mountain');

  console.log('    PASS');
}

function testProfileTransition() {
  console.log('  computeDynamicWeights (profile transitions with trend)...');

  const neutral = computeDynamicWeights(
    { isReady: true, trend: 'NEUTRAL', confidence: 50 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );
  assert.strictEqual(neutral.profile, 'double_mountain');

  const weakDown = computeDynamicWeights(
    { isReady: true, trend: 'DOWN', confidence: 45 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );
  assert.strictEqual(weakDown.profile, 'mountain_valley');
  // Even weak trend should show buy > sell
  assert.ok(weakDown.buy > weakDown.sell, 'weak downtrend: buy mountain > sell valley');

  const strongDown = computeDynamicWeights(
    { isReady: true, trend: 'DOWN', confidence: 90 },
    { pricePositionInRange: 0.5, oscillationRatio: 2 }
  );
  assert.strictEqual(strongDown.profile, 'mountain_valley');
  // Strong trend should have more contrast than weak
  const weakContrast = weakDown.buy - weakDown.sell;
  const strongContrast = strongDown.buy - strongDown.sell;
  assert.ok(strongContrast > weakContrast,
    `strong contrast ${strongContrast} should exceed weak ${weakContrast}`);

  console.log('    PASS');
}

// ── computeSlotFillProbabilities ──

function testSlotFillProbabilitiesBasic() {
  console.log('  computeSlotFillProbabilities (basic)...');

  const levels = [90, 95, 100, 105, 110];
  const probs = computeSlotFillProbabilities(levels, 100, 'NEUTRAL', 50);

  // Should sum to ~1
  const total = probs.reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(total - 1.0) < 0.01, `total ${total} should be ~1.0`);

  // Center slot (100) should have highest probability
  assert.ok(probs[2] >= probs[0], 'center should be >= far left');
  assert.ok(probs[2] >= probs[4], 'center should be >= far right');

  // Probabilities should be symmetric for NEUTRAL
  assert.ok(Math.abs(probs[0] - probs[4]) < 0.05, 'NEUTRAL should be roughly symmetric');
  assert.ok(Math.abs(probs[1] - probs[3]) < 0.05, 'NEUTRAL should be roughly symmetric');

  console.log('    PASS');
}

function testSlotFillProbabilitiesUptrend() {
  console.log('  computeSlotFillProbabilities (UP trend)...');

  const levels = [90, 95, 100, 105, 110];
  const probs = computeSlotFillProbabilities(levels, 100, 'UP', 80);

  // In uptrend: levels above market (105, 110) should be boosted
  // Levels below market (90, 95) should be dampened
  // Compare symmetric pairs
  assert.ok(probs[3] > probs[1], 'level above market should have higher prob than symmetric below in uptrend');
  assert.ok(probs[4] > probs[0], 'far above should have higher prob than far below in uptrend');

  console.log('    PASS');
}

function testSlotFillProbabilitiesDowntrend() {
  console.log('  computeSlotFillProbabilities (DOWN trend)...');

  const levels = [90, 95, 100, 105, 110];
  const probs = computeSlotFillProbabilities(levels, 100, 'DOWN', 80);

  // In downtrend: levels below market (90, 95) should be boosted
  assert.ok(probs[1] > probs[3], 'level below market should have higher prob than symmetric above in downtrend');
  assert.ok(probs[0] > probs[4], 'far below should have higher prob than far above in downtrend');

  console.log('    PASS');
}

function testSlotFillProbabilitiesWithRange() {
  console.log('  computeSlotFillProbabilities (with observed range)...');

  const levels = [80, 90, 95, 100, 105, 110, 120];
  const probs = computeSlotFillProbabilities(levels, 100, 'NEUTRAL', 50, { min: 92, max: 108 });

  // Levels within observed range should get a boost
  // 95, 100, 105 are within [92, 108] → should have relatively higher probability
  const inRange = probs[2] + probs[3] + probs[4]; // 95, 100, 105
  const outRange = probs[0] + probs[1] + probs[5] + probs[6]; // 80, 90, 110, 120
  assert.ok(inRange > outRange, `in-range sum ${inRange} should exceed out-of-range sum ${outRange}`);

  console.log('    PASS');
}

function testSlotFillProbabilitiesEdgeCases() {
  console.log('  computeSlotFillProbabilities (edge cases)...');

  // Empty levels
  assert.deepStrictEqual(computeSlotFillProbabilities([], 100, 'UP', 50), []);

  // Invalid price
  const uniform = computeSlotFillProbabilities([90, 100, 110], NaN, 'UP', 50);
  assert.strictEqual(uniform.length, 3);

  // Single level
  const single = computeSlotFillProbabilities([100], 100, 'UP', 50);
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0], 1);

  console.log('    PASS');
}

// ── Run all ──

function main() {
  console.log('dynamic_weights tests\n');

  testClassifyTrendScenario();
  testComputePositionBias();
  testOscillationFactor();
  testDynamicWeightsNotReady();
  testDynamicWeightsNeutralDoubleMountain();
  testDynamicWeightsStrongDownMountainValley();
  testDynamicWeightsStrongUpMountainValley();
  testDynamicWeightsPriceAtTop();
  testDynamicWeightsPriceAtBottom();
  testDynamicWeightsHighVolatilityDampens();
  testDynamicWeightsClampsToBounds();
  testDoubleMountainTightOscillation();
  testProfileTransition();
  testSlotFillProbabilitiesBasic();
  testSlotFillProbabilitiesUptrend();
  testSlotFillProbabilitiesDowntrend();
  testSlotFillProbabilitiesWithRange();
  testSlotFillProbabilitiesEdgeCases();

  console.log('\n=== All 18 tests passed ===');
}

main();
