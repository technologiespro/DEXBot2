'use strict';

const assert = require('assert');
const {
  DEFAULT_DYNAMIC_WEIGHT_POLICY,
  createDynamicWeightService
} = require('../claw/modules/dynamic_weight_service');

class FakeTrendAnalyzer {
  constructor() {
    this.calls = 0;
  }

  update(marketPrice, feedPrice) {
    this.calls += 1;
    return {
      confidence: 82,
      isConfirmed: true,
      isReady: true,
      marketPrice,
      oscillation: { ratio: 2 },
      priceAnalysis: { inRange: 55 },
      trend: 'UP'
    };
  }
}

async function testPreviewAndApplyFlow() {
  const appliedPatches = [];
  const triggerWrites = [];
  const state = {};

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.3,
      meta: { source: 'dynamic' },
      profile: 'mountain_valley',
      sell: 1.1
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.15,
      premium: 15,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async (ref) => (ref === 'BTS' ? { symbol: 'BTS' } : null)
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => {
        appliedPatches.push({ identifier, patch });
        return {
          botKey: identifier,
          ...patch
        };
      },
      writeTrigger: async (botKey, payload) => {
        triggerWrites.push({ botKey, payload });
      }
    },
    stateStore: {
      async patch(partial) {
        Object.assign(state, partial);
        return state;
      },
      async read() {
        return state;
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'honest-usd-0',
    gridPrice: 'ama',
    gridPriceOffsetPct: 0.2,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const preview = await service.evaluateSelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true
    }
  });

  assert.strictEqual(preview.applied, false);
  assert.strictEqual(preview.reason, 'preview_only');
  assert.strictEqual(preview.nextWeights.sell, 1.1);
  assert.strictEqual(preview.delta.magnitude, 0.6);
  assert.strictEqual(preview.gridPriceOffsetPct, 0.41);
  assert.strictEqual(preview.gridPriceOffsetReason, 'trend_up');

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.triggerPath, 'profiles/recalculate.honest-usd-0.trigger');
  assert.strictEqual(applied.updatedBot.weightDistribution.sell, 1.1);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].identifier, 'honest-usd-0');
  assert.strictEqual(appliedPatches[0].patch.weightDistribution.buy, 0.3);
  assert.strictEqual(appliedPatches[0].patch.weightDistribution.sell, 1.1);
  assert.deepStrictEqual(Object.keys(appliedPatches[0].patch.weightDistribution).sort(), ['buy', 'sell']);
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, 0.41);
  assert.strictEqual(triggerWrites.length, 1);
  assert.strictEqual(triggerWrites[0].botKey, 'honest-usd-0');
  assert.strictEqual(triggerWrites[0].payload.reason, 'dynamic_weight_update');
  assert.strictEqual(triggerWrites[0].payload.gridPriceOffsetPct, 0.41);
  assert.strictEqual(state.dynamicWeights['honest-usd-0'].lastReason, 'dynamic_weight_update');
}

async function testOffsetOnlyApplyDoesNotRewriteWeights() {
  const appliedPatches = [];
  const triggerWrites = [];

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.5,
      profile: 'static',
      sell: 0.5
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.15,
      premium: 15,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async (ref) => (ref === 'BTS' ? { symbol: 'BTS' } : null)
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => {
        appliedPatches.push({ identifier, patch });
        return {
          botKey: identifier,
          ...patch
        };
      },
      writeTrigger: async (botKey, payload) => {
        triggerWrites.push({ botKey, payload });
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'honest-usd-1',
    gridPrice: 'ama',
    gridPriceOffsetPct: 0.2,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      gridPriceOffsetMinDeltaPct: 0.1,
      minWeightDelta: 0.25
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.canUpdateWeights, false);
  assert.strictEqual(applied.canUpdateGridPriceOffset, true);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].identifier, 'honest-usd-1');
  assert.strictEqual(appliedPatches[0].patch.weightDistribution, undefined);
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, 0.41);
  assert.strictEqual(triggerWrites.length, 1);
  assert.strictEqual(triggerWrites[0].payload.gridPriceOffsetPct, 0.41);
}

async function testZeroOffsetCanUpdate() {
  const appliedPatches = [];
  const triggerWrites = [];

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.5,
      profile: 'static',
      sell: 0.5
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.15,
      premium: 15,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async (ref) => (ref === 'BTS' ? { symbol: 'BTS' } : null)
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => {
        appliedPatches.push({ identifier, patch });
        return {
          botKey: identifier,
          ...patch
        };
      },
      writeTrigger: async (botKey, payload) => {
        triggerWrites.push({ botKey, payload });
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'honest-usd-1b',
    gridPrice: 'ama',
    gridPriceOffsetPct: 0,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.25
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.canUpdateWeights, false);
  assert.strictEqual(applied.canUpdateGridPriceOffset, true);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].identifier, 'honest-usd-1b');
  assert.strictEqual(appliedPatches[0].patch.weightDistribution, undefined);
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, 0.41);
  assert.strictEqual(triggerWrites.length, 1);
  assert.strictEqual(triggerWrites[0].payload.gridPriceOffsetPct, 0.41);
}

async function testNonAmaGridPriceCanUpdateOffset() {
  const appliedPatches = [];
  const triggerWrites = [];

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.5,
      profile: 'static',
      sell: 0.5
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.02,
      premium: 2,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async (ref) => (ref === 'BTS' ? { symbol: 'BTS' } : null)
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => {
        appliedPatches.push({ identifier, patch });
        return {
          botKey: identifier,
          ...patch
        };
      },
      writeTrigger: async (botKey, payload) => {
        triggerWrites.push({ botKey, payload });
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'honest-usd-2',
    gridPrice: 'market',
    gridPriceOffsetPct: 0.1,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.25
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.canUpdateWeights, false);
  assert.strictEqual(applied.canUpdateGridPriceOffset, true);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].identifier, 'honest-usd-2');
  assert.strictEqual(appliedPatches[0].patch.weightDistribution, undefined);
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, 0.41);
  assert.strictEqual(triggerWrites.length, 1);
  assert.strictEqual(triggerWrites[0].payload.gridPriceOffsetPct, 0.41);
}

async function testOffsetConfidenceGateHoldsPersistedBias() {
  let updateCalled = false;

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.5,
      profile: 'static',
      sell: 0.5
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.05,
      premium: 5,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async () => {
        updateCalled = true;
        throw new Error('should not be called');
      },
      writeTrigger: async () => {
        throw new Error('should not be called');
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: class {
      update() {
        return {
          confidence: 50,
          isConfirmed: true,
          isReady: true,
          oscillation: { ratio: 2 },
          priceAnalysis: { inRange: 55 },
          trend: 'UP'
        };
      }
    }
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'offset-confidence-0',
    gridPrice: 'ama',
    gridPriceOffsetPct: 0.4,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const preview = await service.evaluateSelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      gridPriceOffsetMinConfidence: 70,
      minWeightDelta: 1
    }
  });

  assert.strictEqual(preview.applied, false);
  assert.strictEqual(preview.reason, 'changes_below_threshold');
  assert.strictEqual(preview.canUpdateGridPriceOffset, undefined);
  assert.strictEqual(preview.gridPriceOffsetPct, 0.4);
  assert.strictEqual(preview.gridPriceOffsetReason, 'confidence_below_threshold');
  assert.strictEqual(preview.gridPriceOffsetDelta, 0);

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      gridPriceOffsetMinConfidence: 70,
      minWeightDelta: 1
    }
  });

  assert.strictEqual(applied.applied, false);
  assert.strictEqual(applied.reason, 'changes_below_threshold');
  assert.strictEqual(updateCalled, false);
}

async function testPolicyDefaultsAndGates() {
  const service = createDynamicWeightService({
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async () => {
        throw new Error('should not be called');
      },
      writeTrigger: async () => {
        throw new Error('should not be called');
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const policy = service.getPolicy();
  assert.strictEqual(policy.enabled, DEFAULT_DYNAMIC_WEIGHT_POLICY.enabled);
  assert.strictEqual(policy.minConfidence, DEFAULT_DYNAMIC_WEIGHT_POLICY.minConfidence);
  assert.strictEqual(policy.requireBtsQuote, true);
  assert.strictEqual(policy.gridPriceOffsetAllowNeutralReset, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetAllowNeutralReset);

  const skipped = await service.evaluateSelectedBot({
    active: false,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'inactive-0',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  }, {
    policy: {
      enabled: true
    }
  });

  assert.strictEqual(skipped.eligible, false);
  assert.strictEqual(skipped.reason, 'bot_inactive');
}

async function testNeutralTrendRespectsAllowNeutralUpdateFlag() {
  let updateCalled = false;

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.1,
      profile: 'double_mountain',
      sell: 0.9
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1,
      premium: 0,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async () => {
        updateCalled = true;
        throw new Error('should not be called');
      },
      writeTrigger: async () => {
        throw new Error('should not be called');
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: class {
      update() {
        return {
          confidence: 95,
          isConfirmed: true,
          isReady: true,
          oscillation: { ratio: 2 },
          priceAnalysis: { inRange: 50 },
          trend: 'NEUTRAL'
        };
      }
    }
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'neutral-0',
    gridPrice: 'ama',
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const preview = await service.evaluateSelectedBot(bot, {
    policy: {
      allowNeutralUpdate: false,
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.1
    }
  });

  assert.strictEqual(preview.applied, false);
  assert.strictEqual(preview.reason, 'neutral_updates_disabled');
  assert.strictEqual(preview.eligible, true);

  const applied = await service.applySelectedBot(bot, {
    policy: {
      allowNeutralUpdate: false,
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.1
    }
  });

  assert.strictEqual(applied.applied, false);
  assert.strictEqual(applied.reason, 'neutral_updates_disabled');
  assert.strictEqual(updateCalled, false);
}

async function testNeutralOffsetResetRemainsAvailableWhenNeutralWeightsAreDisabled() {
  const appliedPatches = [];
  const triggerWrites = [];

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.1,
      profile: 'double_mountain',
      sell: 0.9
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1,
      premium: 0,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => {
        appliedPatches.push({ identifier, patch });
        return {
          botKey: identifier,
          ...patch
        };
      },
      writeTrigger: async (botKey, payload) => {
        triggerWrites.push({ botKey, payload });
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: class {
      update() {
        return {
          confidence: 95,
          isConfirmed: true,
          isReady: true,
          oscillation: { ratio: 2 },
          priceAnalysis: { inRange: 50 },
          trend: 'NEUTRAL'
        };
      }
    }
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'neutral-offset-0',
    gridPrice: 'ama',
    gridPriceOffsetPct: 0.4,
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const preview = await service.evaluateSelectedBot(bot, {
    policy: {
      allowNeutralUpdate: false,
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetAllowNeutralReset: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.1
    }
  });

  assert.strictEqual(preview.applied, false);
  assert.strictEqual(preview.reason, 'preview_only');
  assert.strictEqual(preview.canUpdateWeights, false);
  assert.strictEqual(preview.canUpdateGridPriceOffset, true);
  assert.strictEqual(preview.gridPriceOffsetPct, 0);
  assert.strictEqual(preview.gridPriceOffsetReason, 'neutral_reset');

  const applied = await service.applySelectedBot(bot, {
    policy: {
      allowNeutralUpdate: false,
      cooldownMs: 0,
      enabled: true,
      gridPriceOffsetAllowNeutralReset: true,
      gridPriceOffsetCooldownMs: 0,
      minWeightDelta: 0.1
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.canUpdateWeights, false);
  assert.strictEqual(applied.canUpdateGridPriceOffset, true);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].identifier, 'neutral-offset-0');
  assert.strictEqual(appliedPatches[0].patch.weightDistribution, undefined);
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, 0);
  assert.strictEqual(triggerWrites.length, 1);
  assert.strictEqual(triggerWrites[0].payload.gridPriceOffsetPct, 0);
}

async function testRequireConfirmedTrendBlocksWeightUpdates() {
  let updateCalled = false;

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.1,
      profile: 'double_mountain',
      sell: 0.9
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.01,
      premium: 1,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async () => {
        updateCalled = true;
        throw new Error('should not be called');
      },
      writeTrigger: async () => {
        throw new Error('should not be called');
      }
    },
    stateStore: {
      async patch() {
        return {};
      },
      async read() {
        return {};
      }
    },
    TrendAnalyzerClass: class {
      update() {
        return {
          confidence: 95,
          isConfirmed: false,
          isReady: true,
          oscillation: { ratio: 2 },
          priceAnalysis: { inRange: 50 },
          rawTrend: 'UP',
          trend: 'NEUTRAL'
        };
      }
    }
  });

  const bot = {
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey: 'unconfirmed-0',
    gridPrice: 'ama',
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const preview = await service.evaluateSelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      minWeightDelta: 0.1,
      requireConfirmedTrend: true
    }
  });

  assert.strictEqual(preview.applied, false);
  assert.strictEqual(preview.reason, 'trend_not_confirmed');
  assert.strictEqual(preview.eligible, true);

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      minWeightDelta: 0.1,
      requireConfirmedTrend: true
    }
  });

  assert.strictEqual(applied.applied, false);
  assert.strictEqual(applied.reason, 'trend_not_confirmed');
  assert.strictEqual(updateCalled, false);
}

async function testConcurrentAppliesPreserveAllBotState() {
  const state = {};
  let updateQueue = Promise.resolve();

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.3,
      profile: 'mountain_valley',
      sell: 1.1
    }),
    fetchTrendInput: async () => ({
      feedPrice: 1,
      marketPrice: 1.15,
      premium: 15,
      publicationTime: '2026-01-01T00:00:00Z'
    }),
    market: {
      getAsset: async () => ({ symbol: 'BTS' })
    },
    profiles: {
      updateBotSettings: async (identifier, patch) => ({
        botKey: identifier,
        ...patch
      }),
      writeTrigger: async () => {}
    },
    stateStore: {
      async patch(partial) {
        Object.assign(state, partial);
        return state;
      },
      async read() {
        return JSON.parse(JSON.stringify(state));
      },
      async update(updater) {
        const run = updateQueue.then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const next = await updater(JSON.parse(JSON.stringify(state)));
          Object.keys(state).forEach((key) => delete state[key]);
          Object.assign(state, next);
          return state;
        });
        updateQueue = run.catch(() => {});
        return run;
      }
    },
    TrendAnalyzerClass: FakeTrendAnalyzer
  });

  const makeBot = (botKey) => ({
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'BTS',
    botKey,
    gridPrice: 'ama',
    name: botKey,
    weightDistribution: { buy: 0.5, sell: 0.5 }
  });

  await Promise.all([
    service.applySelectedBot(makeBot('honest-usd-a'), {
      policy: { cooldownMs: 0, enabled: true, gridPriceOffsetCooldownMs: 0 }
    }),
    service.applySelectedBot(makeBot('honest-usd-b'), {
      policy: { cooldownMs: 0, enabled: true, gridPriceOffsetCooldownMs: 0 }
    })
  ]);

  assert.ok(state.dynamicWeights, 'dynamicWeights state should exist');
  assert.ok(state.dynamicWeights['honest-usd-a'], 'first bot state should be preserved');
  assert.ok(state.dynamicWeights['honest-usd-b'], 'second bot state should be preserved');
}

async function main() {
  await testPreviewAndApplyFlow();
  await testOffsetOnlyApplyDoesNotRewriteWeights();
  await testZeroOffsetCanUpdate();
  await testNonAmaGridPriceCanUpdateOffset();
  await testOffsetConfidenceGateHoldsPersistedBias();
  await testPolicyDefaultsAndGates();
  await testNeutralTrendRespectsAllowNeutralUpdateFlag();
  await testNeutralOffsetResetRemainsAvailableWhenNeutralWeightsAreDisabled();
  await testRequireConfirmedTrendBlocksWeightUpdates();
  await testConcurrentAppliesPreserveAllBotState();
  console.log('dynamic weight service tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
