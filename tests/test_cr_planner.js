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
  assert.strictEqual(plan.debtDelta, -37.5, 'debt reduction should not be capped by maxBorrowAmount');
  assert.strictEqual(plan.collateralDelta, 0, 'debt-first repair should fully resolve without adding collateral');
}

function testDebtCeilingOnIncrease() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.2,
    maxBorrowAmount: 110,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'plan should be produced for a high-CR position');
  assert.strictEqual(plan.action, 'increase_debt', 'high CR should still prefer debt increase');
  assert.strictEqual(plan.fallbackAction, 'withdraw_collateral', 'high CR should fallback to collateral withdrawal');
  assert.strictEqual(plan.debtDelta, 10, 'debt increase should be capped by total maxBorrowAmount');
  assert.strictEqual(plan.collateralDelta < 0, true, 'collateral should fall when debt increase is capped');
}

function testCollateralCapPercentage() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.5,
    maxBorrowAmount: 110,
    maxCollateralAmount: '5%',
  });

  assert(plan, 'plan should be produced for a high-CR position');
  assert.strictEqual(plan.blocked, undefined, 'total collateral ceiling should not block withdrawals when current is above limit');
  assert.strictEqual(plan.collateralDelta, -50, 'collateral withdrawal should proceed despite low limit');
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

function testCollateralFallbackPlannerClamped() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 200,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: 400,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.collateralDelta, 200, 'collateral increase should be clamped to total ceiling');
}

function testCollateralFallbackPlannerAtCeiling() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 450,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: 400,
  });

  assert.strictEqual(plan, null, 'fallback should return null when already above total ceiling');
}

function testCollateralFallbackPlannerUsesReferenceAmount() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 200,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: '50%',
    collateralLimitReferenceAmount: 800,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.collateralDelta, 200, 'percentage collateral ceiling should use the supplied total reference');
}

function testCompatibilityPlanner() {
  const plan = planCrAdjustment(250, 100, 2, 2.2);
  assert(plan, 'compatibility planner should return a plan');
  assert.strictEqual(plan.primaryAction, 'reduce_debt');
  assert.strictEqual(plan.needsGridReset, true);
}

testSharedFormulas();
testDebtFirstPlanner();
testDebtCeilingOnIncrease();
testCollateralCapPercentage();
testCollateralFallbackPlanner();
testCollateralFallbackPlannerClamped();
testCollateralFallbackPlannerAtCeiling();
testCollateralFallbackPlannerUsesReferenceAmount();
testCompatibilityPlanner();

console.log('cr planner tests passed');
