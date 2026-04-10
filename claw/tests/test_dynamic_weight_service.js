'use strict';

const assert = require('assert');
const {
  DEFAULT_DYNAMIC_WEIGHT_POLICY,
  createDynamicWeightService
} = require('../modules/dynamic_weight_service');

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
      applyBotSettingsPatch: async (identifier, patch, options) => {
        appliedPatches.push({ identifier, options, patch });
        return {
          botKey: identifier,
          triggerPath: `profiles/recalculate.${identifier}.trigger`,
          updatedBot: {
            botKey: identifier,
            ...patch
          }
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
  assert.strictEqual(appliedPatches[0].patch.gridPriceOffsetPct, undefined);
  assert.strictEqual(appliedPatches[0].options.trigger, true);
  assert.strictEqual(appliedPatches[0].options.triggerPayload.reason, 'dynamic_weight_update');
  assert.strictEqual(triggerWrites.length, 0, 'writeTrigger fallback should not run when applyBotSettingsPatch is available');
  assert.strictEqual(state.dynamicWeights['honest-usd-0'].lastReason, 'dynamic_weight_update');
}

async function testWeightsOnlyPatchDoesNotIncludeOffset() {
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
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      minWeightDelta: 0.25
    }
  });

  // Weights below minWeightDelta — nothing to apply
  assert.strictEqual(applied.applied, false);
  assert.strictEqual(applied.reason, 'changes_below_threshold');
  assert.strictEqual(appliedPatches.length, 0);
  assert.strictEqual(triggerWrites.length, 0);
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
      minWeightDelta: 0.1
    }
  });

  assert.strictEqual(applied.applied, false);
  assert.strictEqual(applied.reason, 'neutral_updates_disabled');
  assert.strictEqual(updateCalled, false);
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

async function testNonBtsQuoteRequiresCompatibleTrendSource() {
  let fetchCalls = 0;

  const service = createDynamicWeightService({
    fetchTrendInput: async () => {
      fetchCalls += 1;
      return {
        feedPrice: 1,
        marketPrice: 1.1,
        premium: 10,
        publicationTime: '2026-01-01T00:00:00Z'
      };
    },
    market: {
      getAsset: async (ref) => (ref === 'USD' ? { symbol: 'USD' } : null)
    },
    supportsNonBtsQuotes: false,
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

  const preview = await service.evaluateSelectedBot({
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'USD',
    botKey: 'non-bts-unsupported',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  }, {
    policy: {
      enabled: true,
      requireBtsQuote: false
    }
  });

  assert.strictEqual(preview.eligible, false);
  assert.strictEqual(preview.reason, 'trend_source_requires_bts_quote');
  assert.strictEqual(fetchCalls, 0, 'incompatible bots should be rejected before trend fetch');
}

async function testCustomTrendSourceCanHandleNonBtsQuotes() {
  let fetchArgs = null;

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.4,
      profile: 'mountain_valley',
      sell: 0.9
    }),
    fetchTrendInput: async (marketRef, context) => {
      fetchArgs = { marketRef, context };
      return {
        feedPrice: 1,
        marketPrice: 1.1,
        premium: 10,
        publicationTime: '2026-01-01T00:00:00Z'
      };
    },
    market: {
      getAsset: async (ref) => (ref === 'USD' ? { symbol: 'USD' } : null)
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

  const preview = await service.evaluateSelectedBot({
    active: true,
    assetA: 'HONEST.USD',
    assetB: 'USD',
    botKey: 'non-bts-supported',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  }, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      requireBtsQuote: false
    }
  });

  assert.strictEqual(preview.eligible, true);
  assert.strictEqual(preview.reason, 'preview_only');
  assert.strictEqual(fetchArgs.marketRef, 'HONEST.USD');
  assert.strictEqual(fetchArgs.context.quoteRef, 'USD');
  assert.strictEqual(fetchArgs.context.requireBtsQuote, false);
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
      policy: { cooldownMs: 0, enabled: true }
    }),
    service.applySelectedBot(makeBot('honest-usd-b'), {
      policy: { cooldownMs: 0, enabled: true }
    })
  ]);

  assert.ok(state.dynamicWeights, 'dynamicWeights state should exist');
  assert.ok(state.dynamicWeights['honest-usd-a'], 'first bot state should be preserved');
  assert.ok(state.dynamicWeights['honest-usd-b'], 'second bot state should be preserved');
}

async function testApplyPathPreservesEmptyTriggerSemanticsWhenPayloadsAreDisabled() {
  const appliedPatches = [];

  const service = createDynamicWeightService({
    computeDynamicWeights: () => ({
      buy: 0.3,
      profile: 'dynamic',
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
      applyBotSettingsPatch: async (identifier, patch, options) => {
        appliedPatches.push({ identifier, options, patch });
        return {
          triggerPath: `profiles/recalculate.${identifier}.trigger`,
          updatedBot: { botKey: identifier, ...patch }
        };
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
    botKey: 'empty-trigger-0',
    gridPrice: 'ama',
    name: 'HONEST-USD',
    weightDistribution: { buy: 0.5, sell: 0.5 }
  };

  const applied = await service.applySelectedBot(bot, {
    policy: {
      cooldownMs: 0,
      enabled: true,
      writeTriggerPayload: false
    }
  });

  assert.strictEqual(applied.applied, true);
  assert.strictEqual(appliedPatches.length, 1);
  assert.strictEqual(appliedPatches[0].options.trigger, true);
  assert.strictEqual(appliedPatches[0].options.triggerPayload, null, 'apply path should request an empty trigger file when payload writing is disabled');
}

async function main() {
  await testPreviewAndApplyFlow();
  await testWeightsOnlyPatchDoesNotIncludeOffset();
  await testPolicyDefaultsAndGates();
  await testNeutralTrendRespectsAllowNeutralUpdateFlag();
  await testRequireConfirmedTrendBlocksWeightUpdates();
  await testNonBtsQuoteRequiresCompatibleTrendSource();
  await testCustomTrendSourceCanHandleNonBtsQuotes();
  await testConcurrentAppliesPreserveAllBotState();
  await testApplyPathPreservesEmptyTriggerSemanticsWhenPayloadsAreDisabled();
  console.log('dynamic weight service tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
