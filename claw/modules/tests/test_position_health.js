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
  collateralForTargetCr,
  collateralDeltaForTargetCr,
} = require('../position_health');

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
    onChain: { collateralRatio: cr, debtAmount },
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

  console.log('\n=== All 15 tests passed ===');
}

main();
