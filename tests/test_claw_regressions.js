const assert = require('assert');

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

function testZeroClawSkillQuotesPayloadPlaceholders() {
  const skillPath = require.resolve('../claw/modules/zeroclaw_skill');
  const catalogPath = require.resolve('../claw/modules/zeroclaw_catalog');
  const manifestPath = require.resolve('../claw/modules/zeroclaw_manifest');
  clearModule(catalogPath);
  clearModule(manifestPath);
  clearModule(skillPath);
  const { buildZeroClawCommandExamples, listZeroClawCommandNames } = require('../claw/modules/zeroclaw_catalog');
  const { describeZeroClawBridge } = require('../claw/modules/zeroclaw_manifest');
  const { buildZeroClawSkillToml } = require('../claw/modules/zeroclaw_skill');

  const toml = buildZeroClawSkillToml({
    profileRoot: '/tmp/profile root',
    repoRoot: '/tmp/repo root'
  });

  assert(
    toml.includes("'--payload' '{{payload_json}}'"),
    'generated skill commands must shell-quote payload placeholders'
  );
  assert(
    toml.includes("'--profile-root' '/tmp/profile root'"),
    'generated skill commands must shell-quote profile roots with spaces'
  );

  const manifest = describeZeroClawBridge();
  assert.deepStrictEqual(
    manifest.commands,
    listZeroClawCommandNames(),
    'manifest command list must stay in sync with the shared ZeroClaw catalog'
  );
  assert.deepStrictEqual(
    manifest.commandExamples,
    buildZeroClawCommandExamples(),
    'manifest examples must stay in sync with the shared ZeroClaw catalog'
  );
}

function testLiquidityPoolWrapperInjectsSharedBitSharesClient() {
  const bitsharesPath = require.resolve('../claw/modules/bitshares_client');
  const dexbotBridgePath = require.resolve('../claw/modules/dexbot_bridge');
  const liquidityPoolsPath = require.resolve('../claw/modules/liquidity_pools');
  const sharedBitShares = { name: 'shared-bitshares-client' };
  let capturedPoolArgs = null;
  let capturedPriceArgs = null;

  require.cache[bitsharesPath] = {
    id: bitsharesPath,
    filename: bitsharesPath,
    loaded: true,
    exports: { BitShares: sharedBitShares }
  };
  require.cache[dexbotBridgePath] = {
    id: dexbotBridgePath,
    filename: dexbotBridgePath,
    loaded: true,
    exports: {
      getDexbot2Root: () => '/tmp',
      loadDexbotOrderSystemUtils: () => ({
        cloneMap: (value) => value,
        deepFreeze: (value) => value,
        derivePoolPrice: (...args) => {
          capturedPoolArgs = args;
          return 'pool-price';
        },
        derivePrice: (...args) => {
          capturedPriceArgs = args;
          return 'derived-price';
        },
        loadAmaCenterPrice: () => null,
        lookupAsset: () => null
      }),
      requireDexbot2Module: () => null
    }
  };
  clearModule(liquidityPoolsPath);

  const liquidityPools = require('../claw/modules/liquidity_pools');

  assert.strictEqual(liquidityPools.derivePoolPrice('HONEST.USD', 'BTS'), 'pool-price');
  assert.deepStrictEqual(
    capturedPoolArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS'],
    'derivePoolPrice wrapper must inject the shared BitShares client'
  );

  assert.strictEqual(liquidityPools.derivePrice('HONEST.USD', 'BTS', 'pool'), 'derived-price');
  assert.deepStrictEqual(
    capturedPriceArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS', 'pool'],
    'derivePrice wrapper must inject the shared BitShares client'
  );

  clearModule(liquidityPoolsPath);
  clearModule(dexbotBridgePath);
  clearModule(bitsharesPath);
}

async function testDecisionLoopReusesAnalyzerStateForDuplicateMarkets() {
  const decisionLoopPath = require.resolve('../claw/modules/decision_loop');
  const discoveryPath = require.resolve('../claw/modules/position_discovery');
  const healthPath = require.resolve('../claw/modules/position_health');
  const feedPriceSourcePath = require.resolve('../claw/modules/feed_price_source');
  const trendAnalyzerPath = require.resolve('../analysis/trend_detection/trend_analyzer');
  let trendFetchCount = 0;

  class FakeTrendAnalyzer {
    update(marketPrice, feedPrice) {
      this.analysis = {
        confidence: 77,
        isReady: true,
        marketPrice,
        premium: {
          percent: ((marketPrice - feedPrice) / feedPrice) * 100
        },
        trend: 'DOWN'
      };
      return this.analysis;
    }

    getAnalysis() {
      return this.analysis || {
        confidence: 0,
        isReady: false,
        premium: {
          percent: null
        },
        trend: 'NEUTRAL'
      };
    }
  }

  require.cache[discoveryPath] = {
    id: discoveryPath,
    filename: discoveryPath,
    loaded: true,
    exports: {
      discoverPositions: async () => ([
        { id: 'pos-1', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 5 } },
        { id: 'pos-2', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 3 } }
      ])
    }
  };
  require.cache[healthPath] = {
    id: healthPath,
    filename: healthPath,
    loaded: true,
    exports: {
      assessPosition: (position, trendSignal) => ({
        actions: [],
        positionId: position.id,
        trend: trendSignal
      })
    }
  };
  require.cache[feedPriceSourcePath] = {
    id: feedPriceSourcePath,
    filename: feedPriceSourcePath,
    loaded: true,
    exports: {
      fetchTrendInput: async () => {
        trendFetchCount += 1;
        return {
          feedPrice: 100,
          marketPrice: 95,
          premium: -5
        };
      }
    }
  };
  require.cache[trendAnalyzerPath] = {
    id: trendAnalyzerPath,
    filename: trendAnalyzerPath,
    loaded: true,
    exports: { TrendAnalyzer: FakeTrendAnalyzer }
  };
  clearModule(decisionLoopPath);

  const { evaluate, resetAnalyzers } = require('../claw/modules/decision_loop');
  const result = await evaluate('alice');

  assert.strictEqual(trendFetchCount, 1, 'trend input should be fetched once per market');
  assert.strictEqual(result.positionCount, 2, 'both positions should be evaluated');
  assert.strictEqual(result.positions[0].trend.trend, 'DOWN');
  assert.strictEqual(result.positions[1].trend.trend, 'DOWN');
  assert.strictEqual(result.positions[1].trend.premium, -5, 'reused trend signal should come from cached analyzer state');

  resetAnalyzers();
  clearModule(decisionLoopPath);
  clearModule(discoveryPath);
  clearModule(healthPath);
  clearModule(feedPriceSourcePath);
  clearModule(trendAnalyzerPath);
}

async function main() {
  testZeroClawSkillQuotesPayloadPlaceholders();
  testLiquidityPoolWrapperInjectsSharedBitSharesClient();
  await testDecisionLoopReusesAnalyzerStateForDuplicateMarkets();
  console.log('claw regression tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
