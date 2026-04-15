/**
 * Tests for position_health.js
 *
 * Validates the 5-zone CR classification and two-layer action system.
 */

'use strict';

const assert = require('assert');
const {
  CR_ZONES,
  classifyCrZone,
  checkTrendAlignment,
  assessPosition,
  buildMarginTradingPlan,
  classifyPriceRangeRatio,
  collateralForTargetCr,
  collateralDeltaForTargetCr,
  computePriceRangeRatioPlan,
  computeOrderWeightBias,
  crWeight,
  debtDeltaForTargetCr,
  debtForTargetCr,
  planCrAdjustment,
  trendWeight,
} = require('../modules/position_health');

// --- classifyCrZone ---

function testCrZoneBoundaries() {
  console.log('  classifyCrZone boundaries...');

  // Red low: below 1.7
  assert.strictEqual(classifyCrZone(1.0).zone, 'red_low');
  assert.strictEqual(classifyCrZone(1.4).zone, 'red_low');
  assert.strictEqual(classifyCrZone(1.69).zone, 'red_low');

  // Orange low: 1.7 – 2.0
  assert.strictEqual(classifyCrZone(1.7).zone, 'orange_low');
  assert.strictEqual(classifyCrZone(1.85).zone, 'orange_low');
  assert.strictEqual(classifyCrZone(1.99).zone, 'orange_low');

  // Green: 2.0 – 2.5
  assert.strictEqual(classifyCrZone(2.0).zone, 'green');
  assert.strictEqual(classifyCrZone(2.25).zone, 'green');
  assert.strictEqual(classifyCrZone(2.49).zone, 'green');

  // Orange high: 2.5 – 3.0
  assert.strictEqual(classifyCrZone(2.5).zone, 'orange_high');
  assert.strictEqual(classifyCrZone(2.75).zone, 'orange_high');
  assert.strictEqual(classifyCrZone(2.99).zone, 'orange_high');

  // Red high: above 3.0
  assert.strictEqual(classifyCrZone(3.0).zone, 'red_high');
  assert.strictEqual(classifyCrZone(5.0).zone, 'red_high');
  assert.strictEqual(classifyCrZone(100).zone, 'red_high');

  // Edge: invalid
  assert.strictEqual(classifyCrZone(null).zone, 'unknown');
  assert.strictEqual(classifyCrZone(0).zone, 'unknown');
  assert.strictEqual(classifyCrZone(-1).zone, 'unknown');
  assert.strictEqual(classifyCrZone(NaN).zone, 'unknown');
  assert.strictEqual(classifyCrZone(Infinity).zone, 'unknown');

  console.log('    PASS');
}

function testCrZoneStatuses() {
  console.log('  classifyCrZone statuses...');

  assert.strictEqual(classifyCrZone(3.5).status, 'over_collateralized');
  assert.strictEqual(classifyCrZone(2.7).status, 'excess_collateral');
  assert.strictEqual(classifyCrZone(2.2).status, 'safe');
  assert.strictEqual(classifyCrZone(1.8).status, 'temporary');
  assert.strictEqual(classifyCrZone(1.5).status, 'not_acceptable');
  assert.strictEqual(classifyCrZone(null).status, 'no_data');

  console.log('    PASS');
}

// --- checkTrendAlignment ---

function testTrendAlignment() {
  console.log('  checkTrendAlignment...');

  assert.strictEqual(checkTrendAlignment('short', 'DOWN'), 'aligned');
  assert.strictEqual(checkTrendAlignment('short', 'UP'), 'opposed');
  assert.strictEqual(checkTrendAlignment('short', 'NEUTRAL'), 'neutral');
  assert.strictEqual(checkTrendAlignment('long', 'UP'), 'aligned');
  assert.strictEqual(checkTrendAlignment('long', 'DOWN'), 'opposed');
  assert.strictEqual(checkTrendAlignment('long', 'NEUTRAL'), 'neutral');

  console.log('    PASS');
}

// --- assessPosition: two-layer actions ---

function makePosition(cr, debtAmount = 100) {
  return {
    id: 'test_pos',
    status: 'debt_open',
    onChain: {
      btsPerMpa: 50,
      collateralAmount: cr && debtAmount ? cr * debtAmount * 50 : 0,
      collateralRatio: cr,
      debtAmount
    },
  };
}

function testAssessRedLow() {
  console.log('  assessPosition red_low (two-layer)...');

  const result = assessPosition(makePosition(1.5));
  assert.strictEqual(result.collateral.zone, 'red_low');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'reduce_debt');
  assert.strictEqual(result.actions[0].priority, 'immediate');
  assert.strictEqual(result.actions[1].action, 'add_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessOrangeLow() {
  console.log('  assessPosition orange_low (two-layer)...');

  const result = assessPosition(makePosition(1.85));
  assert.strictEqual(result.collateral.zone, 'orange_low');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'reduce_debt');
  assert.strictEqual(result.actions[0].priority, 'soon');
  assert.strictEqual(result.actions[1].action, 'add_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessGreen() {
  console.log('  assessPosition green (no actions)...');

  const result = assessPosition(makePosition(2.2));
  assert.strictEqual(result.collateral.zone, 'green');
  assert.strictEqual(result.actions.length, 0);

  console.log('    PASS');
}

function testAssessOrangeHigh() {
  console.log('  assessPosition orange_high (two-layer)...');

  const result = assessPosition(makePosition(2.7));
  assert.strictEqual(result.collateral.zone, 'orange_high');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'increase_debt');
  assert.strictEqual(result.actions[0].priority, 'soon');
  assert.strictEqual(result.actions[1].action, 'withdraw_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessRedHigh() {
  console.log('  assessPosition red_high (two-layer)...');

  const result = assessPosition(makePosition(3.5));
  assert.strictEqual(result.collateral.zone, 'red_high');
  assert.strictEqual(result.actions.length, 2);
  assert.strictEqual(result.actions[0].action, 'increase_debt');
  assert.strictEqual(result.actions[0].priority, 'immediate');
  assert.strictEqual(result.actions[1].action, 'withdraw_collateral');
  assert.strictEqual(result.actions[1].priority, 'fallback');

  console.log('    PASS');
}

function testAssessNoDebt() {
  console.log('  assessPosition no debt (no CR actions)...');

  const result = assessPosition(makePosition(1.5, 0));
  assert.strictEqual(result.hasDebt, false);
  assert.strictEqual(result.actions.length, 0);

  console.log('    PASS');
}

// --- assessPosition: trend actions ---

function testAssessTrendOpposed() {
  console.log('  assessPosition trend opposed adds review action...');

  const trend = { trend: 'UP', confidence: 70, premium: 1.5 };
  const result = assessPosition(makePosition(2.2), trend);
  assert.strictEqual(result.trend.alignment, 'opposed');
  const reviewAction = result.actions.find(a => a.action === 'review_direction');
  assert.ok(reviewAction, 'should have review_direction action');
  assert.strictEqual(reviewAction.priority, 'evaluate');

  console.log('    PASS');
}

function testAssessTrendAligned() {
  console.log('  assessPosition trend aligned no extra action...');

  const trend = { trend: 'DOWN', confidence: 80, premium: -1.0 };
  const result = assessPosition(makePosition(2.2), trend);
  assert.strictEqual(result.trend.alignment, 'aligned');
  assert.strictEqual(result.actions.length, 0);

  console.log('    PASS');
}

function testAssessTrendLowConfidence() {
  console.log('  assessPosition trend opposed but low confidence...');

  const trend = { trend: 'UP', confidence: 30, premium: 0.5 };
  const result = assessPosition(makePosition(2.2), trend);
  assert.strictEqual(result.trend.alignment, 'opposed');
  assert.strictEqual(result.actions.length, 0, 'low confidence should not trigger review');

  console.log('    PASS');
}

// --- collateral calculations ---

function testCollateralForTargetCr() {
  console.log('  collateralForTargetCr...');

  // 100 MPA debt * 50 BTS/MPA * 2.0 CR = 10000 BTS
  assert.strictEqual(collateralForTargetCr(100, 50, 2.0), 10000);
  assert.strictEqual(collateralForTargetCr(100, 50, 2.5), 12500);
  assert.strictEqual(collateralForTargetCr(0, 50, 2.0), 0);
  assert.strictEqual(collateralForTargetCr(-1, 50, 2.0), 0);

  console.log('    PASS');
}

function testCollateralDelta() {
  console.log('  collateralDeltaForTargetCr...');

  // Need 10000, have 8000 → add 2000
  assert.strictEqual(collateralDeltaForTargetCr(8000, 100, 50, 2.0), 2000);
  // Need 10000, have 12000 → remove 2000
  assert.strictEqual(collateralDeltaForTargetCr(12000, 100, 50, 2.0), -2000);
  // Need 10000, have 10000 → no change
  assert.strictEqual(collateralDeltaForTargetCr(10000, 100, 50, 2.0), 0);

  console.log('    PASS');
}

function testDebtForTargetCr() {
  console.log('  debtForTargetCr...');

  assert.strictEqual(debtForTargetCr(10000, 50, 2.0), 100);
  assert.strictEqual(debtForTargetCr(12000, 50, 2.0), 120);
  assert.strictEqual(debtForTargetCr(0, 50, 2.0), 0);
  assert.strictEqual(debtForTargetCr(10000, 0, 2.0), 0);

  console.log('    PASS');
}

function testDebtDeltaForTargetCr() {
  console.log('  debtDeltaForTargetCr...');

  assert.strictEqual(debtDeltaForTargetCr(8000, 100, 50, 2.0), -20);
  assert.strictEqual(debtDeltaForTargetCr(12000, 100, 50, 2.0), 20);
  assert.strictEqual(debtDeltaForTargetCr(10000, 100, 50, 2.0), 0);

  console.log('    PASS');
}

function testPlanCrAdjustment() {
  console.log('  planCrAdjustment...');

  const lowCr = planCrAdjustment(8000, 100, 50, 2.0);
  assert.strictEqual(lowCr.primaryAction, 'reduce_debt');
  assert.strictEqual(lowCr.fallbackAction, 'add_collateral');
  assert.strictEqual(lowCr.debtDelta, -20);
  assert.strictEqual(lowCr.collateralDelta, 2000);

  const highCr = planCrAdjustment(12000, 100, 50, 2.0);
  assert.strictEqual(highCr.primaryAction, 'increase_debt');
  assert.strictEqual(highCr.fallbackAction, 'withdraw_collateral');
  assert.strictEqual(highCr.debtDelta, 20);
  assert.strictEqual(highCr.collateralDelta, -2000);

  const onTarget = planCrAdjustment(10000, 100, 50, 2.0);
  assert.strictEqual(onTarget.primaryAction, 'hold');
  assert.strictEqual(onTarget.fallbackAction, 'hold');
  assert.strictEqual(onTarget.debtDelta, 0);
  assert.strictEqual(onTarget.collateralDelta, 0);

  console.log('    PASS');
}

// --- CR_ZONES constant ---

function testCrZonesConstant() {
  console.log('  CR_ZONES constant values...');

  assert.strictEqual(CR_ZONES.RED_HIGH.min, 3.0);
  assert.strictEqual(CR_ZONES.ORANGE_HIGH.min, 2.5);
  assert.strictEqual(CR_ZONES.GREEN.min, 2.0);
  assert.strictEqual(CR_ZONES.ORANGE_LOW.min, 1.7);
  assert.strictEqual(CR_ZONES.RED_LOW.min, 0);

  // Deep frozen
  assert.throws(() => { CR_ZONES.GREEN.min = 999; }, TypeError);

  console.log('    PASS');
}

// --- Weight factor ---

function testTrendWeight() {
  console.log('  trendWeight...');

  assert.strictEqual(trendWeight('UP', 90), 1.0);
  assert.strictEqual(trendWeight('DOWN', 80), 1.0);
  assert.strictEqual(trendWeight('UP', 70), 0.7);
  assert.strictEqual(trendWeight('DOWN', 60), 0.7);
  assert.strictEqual(trendWeight('UP', 50), 0.4);
  assert.strictEqual(trendWeight('DOWN', 40), 0.4);
  assert.strictEqual(trendWeight('UP', 30), 0.2);
  assert.strictEqual(trendWeight('DOWN', 0), 0.2);
  // NEUTRAL always 0.4 regardless of confidence
  assert.strictEqual(trendWeight('NEUTRAL', 100), 0.4);
  assert.strictEqual(trendWeight('NEUTRAL', 0), 0.4);

  console.log('    PASS');
}

function testCrWeight() {
  console.log('  crWeight...');

  assert.strictEqual(crWeight('red_high'), 1.5);
  assert.strictEqual(crWeight('orange_high'), 1.2);
  assert.strictEqual(crWeight('green'), 1.0);
  assert.strictEqual(crWeight('orange_low'), 0.5);
  assert.strictEqual(crWeight('red_low'), 0.0);
  assert.strictEqual(crWeight('unknown'), 1.0);

  console.log('    PASS');
}

function testComputeOrderWeightBias() {
  console.log('  computeOrderWeightBias...');

  const down = computeOrderWeightBias('DOWN', 80);
  assert.strictEqual(down.profile, 'mountain_valley');
  assert.strictEqual(down.buyBias, 1.0);
  assert.strictEqual(down.sellBias, -1.0);

  const up = computeOrderWeightBias('UP', 60);
  assert.strictEqual(up.profile, 'mountain_valley');
  assert.strictEqual(up.buyBias, -0.7);
  assert.strictEqual(up.sellBias, 0.7);

  const neutral = computeOrderWeightBias('NEUTRAL', 90);
  assert.strictEqual(neutral.profile, 'balanced');
  assert.strictEqual(neutral.buyBias, 0);
  assert.strictEqual(neutral.sellBias, 0);
  assert.strictEqual(neutral.strength, 0);

  console.log('    PASS');
}

function testClassifyPriceRangeRatio() {
  console.log('  classifyPriceRangeRatio...');

  assert.strictEqual(classifyPriceRangeRatio(1.8), 'very_competitive');
  assert.strictEqual(classifyPriceRangeRatio(2.0), 'competitive');
  assert.strictEqual(classifyPriceRangeRatio(2.7), 'competitive');
  assert.strictEqual(classifyPriceRangeRatio(3.0), 'conservative');
  assert.strictEqual(classifyPriceRangeRatio(4.0), 'very_conservative');

  console.log('    PASS');
}

function testComputePriceRangeRatioPlan() {
  console.log('  computePriceRangeRatioPlan...');

  const widen = computePriceRangeRatioPlan(
    {
      minPrice: '3x',
      maxPrice: '3x'
    },
    {
      rangeContext: {
        observedMaxPrice: 145,
        observedMinPrice: 70
      },
      referencePrice: 100
    }
  );

  assert.strictEqual(widen.currentRatio, 3);
  assert.strictEqual(widen.observedRatio, 1.45);
  assert.strictEqual(widen.recommendedRatio, 1.6);
  assert.strictEqual(widen.classification, 'very_competitive');
  assert.strictEqual(widen.reason, 'historical_range_supports_tighter_bounds');
  assert.strictEqual(widen.shouldUpdate, true);

  const keep = computePriceRangeRatioPlan(
    {
      minPrice: '2x',
      maxPrice: '2x'
    },
    {
      rangeContext: {
        observedMaxPrice: 195,
        observedMinPrice: 55
      },
      referencePrice: 100
    }
  );

  assert.strictEqual(keep.currentRatio, 2);
  assert.strictEqual(keep.recommendedRatio, 2.15);
  assert.strictEqual(keep.classification, 'competitive');
  assert.strictEqual(keep.shouldUpdate, false);

  console.log('    PASS');
}

function testBuildMarginTradingPlanDowntrend() {
  console.log('  buildMarginTradingPlan (downtrend unified plan)...');

  const plan = buildMarginTradingPlan(
    makePosition(1.6, 100),
    {
      confidence: 80,
      isReady: true,
      oscillation: { ratio: 2 },
      priceAnalysis: { inRange: 50 },
      trend: 'DOWN'
    },
    {
      weightDistribution: { sell: 0.5, buy: 0.5 }
    },
    {
      priceContext: {
        oscillationRatio: 2,
        pricePositionInRange: 0.5
      },
      rangeContext: {
        observedMaxPrice: 165,
        observedMinPrice: 60
      },
      referencePrice: 100,
      resolveTargetCr: () => 2.2
    }
  );

  assert.strictEqual(plan.targetCr, 2.2);
  assert.strictEqual(plan.crPlan.primaryAction, 'reduce_debt');
  assert.strictEqual(plan.crPlan.fallbackAction, 'add_collateral');
  assert.strictEqual(plan.gridPlan.finalPriceRangeRatio, 1.83);
  assert.strictEqual(plan.botPatch.minPrice, '1.83x');
  assert.strictEqual(plan.botPatch.maxPrice, '1.83x');

  console.log('    PASS');
}

function testBuildMarginTradingPlanStillPlansWeightsWithoutOffset() {
  console.log('  buildMarginTradingPlan (still plans weights without offset)...');

  const plan = buildMarginTradingPlan(
    makePosition(1.6, 100),
    {
      confidence: 80,
      isReady: true,
      oscillation: { ratio: 2 },
      priceAnalysis: { inRange: 50 },
      trend: 'DOWN'
    },
    {
      weightDistribution: { sell: 0.5, buy: 0.5 }
    },
    {
      priceContext: {
        oscillationRatio: 2,
        pricePositionInRange: 0.5
      },
      rangeContext: {
        observedMaxPrice: 165,
        observedMinPrice: 60
      },
      referencePrice: 100,
      resolveTargetCr: () => 2.2
    }
  );

  assert.strictEqual(plan.targetCr, 2.2);
  assert.strictEqual(plan.crPlan.primaryAction, 'reduce_debt');
  assert.strictEqual(plan.gridPlan.finalPriceRangeRatio, 1.83);

  console.log('    PASS');
}

function testBuildMarginTradingPlanNeutralKeepsCenter() {
  console.log('  buildMarginTradingPlan (neutral keeps center)...');

  const plan = buildMarginTradingPlan(
    makePosition(2.2, 100),
    {
      confidence: 90,
      isReady: true,
      oscillation: { ratio: 2 },
      priceAnalysis: { inRange: 50 },
      trend: 'NEUTRAL'
    },
    {
      weightDistribution: { sell: 0.5, buy: 0.5 }
    },
    {
      priceContext: {
        oscillationRatio: 2,
        pricePositionInRange: 0.5
      },
      rangeContext: {
        observedMaxPrice: 130,
        observedMinPrice: 80
      },
      referencePrice: 100
    }
  );

  assert.strictEqual(plan.crPlan.primaryAction, 'hold');
  assert.strictEqual(plan.gridPlan.finalPriceRangeRatio, 1.43);
  assert.strictEqual(plan.botPatch.minPrice, '1.43x');
  assert.strictEqual(plan.botPatch.maxPrice, '1.43x');

  console.log('    PASS');
}

// --- Run all ---

function main() {
  console.log('position_health tests\n');

  testCrZonesConstant();
  testCrZoneBoundaries();
  testCrZoneStatuses();
  testTrendAlignment();
  testAssessRedLow();
  testAssessOrangeLow();
  testAssessGreen();
  testAssessOrangeHigh();
  testAssessRedHigh();
  testAssessNoDebt();
  testAssessTrendOpposed();
  testAssessTrendAligned();
  testAssessTrendLowConfidence();
  testCollateralForTargetCr();
  testCollateralDelta();
  testDebtForTargetCr();
  testDebtDeltaForTargetCr();
  testPlanCrAdjustment();
  testTrendWeight();
  testCrWeight();
  testComputeOrderWeightBias();
  testClassifyPriceRangeRatio();
  testComputePriceRangeRatioPlan();
  testBuildMarginTradingPlanDowntrend();
  testBuildMarginTradingPlanStillPlansWeightsWithoutOffset();
  testBuildMarginTradingPlanNeutralKeepsCenter();

  console.log('\n=== All 26 tests passed ===');
}

main();
