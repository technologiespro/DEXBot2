'use strict';

const assert = require('assert');
const {
  buildDebtFirstCrPlan,
  buildCollateralFallbackPlan,
  collateralDeltaForTargetCr,
  collateralForTargetCr,
  debtDeltaForTargetCr,
  debtForTargetCr,
  planCrAdjustment,
} = require('../modules/cr_planner');

function testSharedFormulas() {
  assert.strictEqual(collateralForTargetCr(100, 50, 2.0), 10000);
  assert.strictEqual(collateralDeltaForTargetCr(8000, 100, 50, 2.0), 2000);
  assert.strictEqual(debtForTargetCr(10000, 50, 2.0), 100);
  assert.strictEqual(debtDeltaForTargetCr(8000, 100, 50, 2.0), -20);
}

function testDebtFirstPlanner() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 250,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.2,
    maxBorrowAmount: 10,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'plan should be produced for an out-of-band CR');
  assert.strictEqual(plan.action, 'reduce_debt', 'low CR should reduce debt first');
  assert.strictEqual(plan.fallbackAction, 'add_collateral', 'low CR should fallback to collateral');
  assert.strictEqual(plan.needsGridReset, true, 'CR change should require a grid reset');
  assert.strictEqual(plan.debtDelta < 0, true, 'debt delta should reduce debt');
  assert.strictEqual(plan.collateralDelta > 0, true, 'collateral delta should add collateral when debt cap limits the repair');
}

function testCollateralFallbackPlanner() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 250,
    currentDebtAmount: 90,
    feedPrice: 2,
    targetCollateralRatio: 2,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.needsGridReset, true, 'fallback collateral change should reset the grid');
}

function testCompatibilityPlanner() {
  const plan = planCrAdjustment(250, 100, 2, 2.2);
  assert(plan, 'compatibility planner should return a plan');
  assert.strictEqual(plan.primaryAction, 'reduce_debt');
  assert.strictEqual(plan.needsGridReset, true);
}

testSharedFormulas();
testDebtFirstPlanner();
testCollateralFallbackPlanner();
testCompatibilityPlanner();

console.log('cr planner tests passed');
