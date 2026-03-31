const assert = require('assert');
const Module = require('module');
const path = require('path');

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

async function testClawBitsharesClientLoadsEventPatchAndDetectsExistingConnection() {
  const clawBitsharesPath = require.resolve('../modules/bitshares_client');
  const originalLoad = Module._load;
  let patchLoaded = false;

  Module._load = function(request, parent, isMain) {
    if (request === 'btsdex' && parent?.filename === clawBitsharesPath) {
      return {
        subscribe(event, callback) {
          if (event === 'connected') {
            callback();
          }
        }
      };
    }

    if (request === '../../modules/btsdex_event_patch' && parent?.filename === clawBitsharesPath) {
      patchLoaded = true;
      return { patched: true };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    clearModule(clawBitsharesPath);
    const clawBitshares = require('../modules/bitshares_client');

    await clawBitshares.waitForConnected(5);

    assert.strictEqual(patchLoaded, true, 'claw BitShares client should load the shared reconnect patch');
    assert.strictEqual(clawBitshares.isConnected(), true, 'connected callback should immediately mark the shared client ready');
    assert.throws(() => clawBitshares.createAccountClient('', 'wif'), /accountName is required/);
    assert.throws(() => clawBitshares.createAccountClient('alice', ''), /privateKey is required/);
  } finally {
    Module._load = originalLoad;
    clearModule(clawBitsharesPath);
  }
}

function testClawRootExportsAvoidSilentCollisions() {
  const clawIndexPath = require.resolve('..');
  clearModule(clawIndexPath);

  const claw = require('..');
  const manifest = claw.describeZeroClawBridge();

  assert.strictEqual(typeof claw.resolveSigningAccountName, 'function');
  assert.strictEqual(claw.resolveSigningAccountName({ accountName: 'alice' }), 'alice');
  assert.strictEqual(typeof claw.resolveAccountName, 'function');
  assert.strictEqual(claw.resolveAccountName('alice') instanceof Promise, true);
  assert.strictEqual(manifest.options.runtimeName, 'zeroclaw');
  assert.strictEqual(manifest.commandExamples.some((example) => example.includes('zeroclaw_bridge.js')), true);
  assert.strictEqual(typeof claw.describeZeroClawRuntimeBridge, 'function');
}

function testZeroClawSkillQuotesPayloadPlaceholders() {
  const skillPath = require.resolve('../modules/zeroclaw_skill');
  const catalogPath = require.resolve('../modules/zeroclaw_catalog');
  const manifestPath = require.resolve('../modules/zeroclaw_manifest');
  clearModule(catalogPath);
  clearModule(manifestPath);
  clearModule(skillPath);
  const { buildZeroClawCommandExamples, listZeroClawCommandNames } = require('../modules/zeroclaw_catalog');
  const { describeZeroClawBridge } = require('../modules/zeroclaw_manifest');
  const { buildZeroClawSkillToml } = require('../modules/zeroclaw_skill');

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
  const bitsharesPath = require.resolve('../modules/bitshares_client');
  const dexbotBridgePath = require.resolve('../modules/dexbot_bridge');
  const liquidityPoolsPath = require.resolve('../modules/liquidity_pools');
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

  const liquidityPools = require('../modules/liquidity_pools');

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
  const decisionLoopPath = require.resolve('../modules/decision_loop');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const healthPath = require.resolve('../modules/position_health');
  const feedPriceSourcePath = require.resolve('../modules/feed_price_source');
  const trendAnalyzerPath = require.resolve('../../analysis/trend_detection/trend_analyzer');
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

  const { evaluate, resetAnalyzers } = require('../modules/decision_loop');
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

async function testDecisionLoopReplacesAnalyzerOnConfigChange() {
  const decisionLoopPath = require.resolve('../modules/decision_loop');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const healthPath = require.resolve('../modules/position_health');
  const feedPriceSourcePath = require.resolve('../modules/feed_price_source');
  const trendAnalyzerPath = require.resolve('../../analysis/trend_detection/trend_analyzer');
  let constructionCount = 0;

  class ConfigTrackingAnalyzer {
    constructor(config) {
      constructionCount += 1;
      this.config = config;
    }

    update(marketPrice, feedPrice) {
      return { confidence: 50, isReady: true, trend: 'NEUTRAL' };
    }

    getAnalysis() {
      return { confidence: 50, isReady: true, premium: { percent: 0 }, trend: 'NEUTRAL' };
    }
  }

  require.cache[discoveryPath] = {
    id: discoveryPath, filename: discoveryPath, loaded: true,
    exports: {
      discoverPositions: async () => ([
        { id: 'pos-1', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 5 } }
      ])
    }
  };
  require.cache[healthPath] = {
    id: healthPath, filename: healthPath, loaded: true,
    exports: { assessPosition: (position, trendSignal) => ({ actions: [], positionId: position.id, trend: trendSignal }) }
  };
  require.cache[feedPriceSourcePath] = {
    id: feedPriceSourcePath, filename: feedPriceSourcePath, loaded: true,
    exports: { fetchTrendInput: async () => ({ feedPrice: 100, marketPrice: 95, premium: -5 }) }
  };
  require.cache[trendAnalyzerPath] = {
    id: trendAnalyzerPath, filename: trendAnalyzerPath, loaded: true,
    exports: { TrendAnalyzer: ConfigTrackingAnalyzer }
  };
  clearModule(decisionLoopPath);

  const { evaluate, resetAnalyzers } = require('../modules/decision_loop');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 10 } });
  assert.strictEqual(constructionCount, 1, 'first evaluate should create one analyzer');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 10 } });
  assert.strictEqual(constructionCount, 1, 'same config should reuse the cached analyzer');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 20 } });
  assert.strictEqual(constructionCount, 2, 'changed config should replace the analyzer');

  resetAnalyzers();
  clearModule(decisionLoopPath);
  clearModule(discoveryPath);
  clearModule(healthPath);
  clearModule(feedPriceSourcePath);
  clearModule(trendAnalyzerPath);
}

async function testPositionManagerEntryExposesSellPriceInBts() {
  const positionManagerPath = require.resolve('../modules/position_manager');
  const chainQueriesPath = require.resolve('../modules/chain_queries');

  require.cache[chainQueriesPath] = {
    id: chainQueriesPath, filename: chainQueriesPath, loaded: true,
    exports: {
      getAsset: async (sym) => ({ id: `1.3.${sym.length}`, symbol: sym, precision: 5, bitasset_data_id: '2.4.1' }),
      getBackingAsset: async () => ({ id: '1.3.0', symbol: 'BTS', precision: 5 }),
      getBitassetData: async () => ({
        asset_id: '1.3.999',
        options: { short_backing_asset: '1.3.0' }
      }),
      dbCall: async () => null,
      waitForConnected: async () => {}
    }
  };

  clearModule(positionManagerPath);
  const { PositionManager } = require('../modules/position_manager');

  const savedState = {};
  const pm = new PositionManager({
    loadState: async () => savedState.data || { positions: [] },
    saveState: async (state) => { savedState.data = state; }
  });

  const position = await pm.createShortPosition({
    accountName: 'alice',
    mpaAsset: 'HONEST.USD',
    debtAmount: 10,
    collateralAmount: 25000,
    sellPriceInBts: 1000
  });

  assert.strictEqual(position.entry.sellPriceInBts, 1000, 'entry must expose sellPriceInBts for openShort');
  assert.strictEqual(position.entry.priceInBts, 1000, 'entry must also have generic priceInBts from createOrderTracking');

  clearModule(positionManagerPath);
  clearModule(chainQueriesPath);
}

function testClawBridgeRespectsRuntimeNameOption() {
  const clawBridgePath = require.resolve('../modules/claw_bridge');
  const clawInfraPath = require.resolve('../modules/claw_infra');

  let capturedOptions = null;
  require.cache[clawInfraPath] = {
    id: clawInfraPath, filename: clawInfraPath, loaded: true,
    exports: {
      createClawInfrastructure: (opts) => {
        capturedOptions = opts;
        return {
          runtime: { name: opts.runtime?.name || 'claw-bridge' },
          profiles: {},
          market: {}
        };
      }
    }
  };

  clearModule(clawBridgePath);
  const { createClawBridge } = require('../modules/claw_bridge');

  createClawBridge({ runtimeName: 'openclaw' });
  assert.strictEqual(capturedOptions.runtime.name, 'openclaw', 'runtimeName option should propagate to runtime.name');

  createClawBridge({ runtime: { name: 'picoclaw' } });
  assert.strictEqual(capturedOptions.runtime.name, 'picoclaw', 'runtime.name should still work directly');

  createClawBridge({});
  assert.strictEqual(capturedOptions.runtime.name, 'claw-bridge', 'should fall back to claw-bridge');

  clearModule(clawBridgePath);
  clearModule(clawInfraPath);
}

function testAccountOrdersBotKeyFallsBackToAssetIds() {
  const { createBotKey } = require('../../modules/account_orders');

  const idOnlyBot = { assetAId: '1.3.1', assetBId: '1.3.0' };
  const key = createBotKey(idOnlyBot, 0);
  assert.ok(key.includes('1-3-1'), `account_orders botKey should derive from assetAId, got: ${key}`);
  assert.ok(key.includes('1-3-0'), `account_orders botKey should include assetBId, got: ${key}`);

  // Symbol fields still take precedence
  const symBot = { assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' };
  const symKey = createBotKey(symBot, 0);
  assert.ok(symKey.includes('iob'), `symbol-based key should take precedence, got: ${symKey}`);
  assert.ok(!symKey.includes('1-3-1'), `symbol key should not include asset ID, got: ${symKey}`);

  // Aligns with claw's createBotKey
  const clawProfiles = require('../modules/dexbot_profiles');
  const clawKey = clawProfiles.createBotKey(idOnlyBot, 0);
  assert.strictEqual(key, clawKey, `account_orders and claw botKey must match for same input, got: ${key} vs ${clawKey}`);
}

function testZeroClawCommandInjectsRuntimeName() {
  const zeroclawBridgePath = require.resolve('../modules/zeroclaw_bridge');
  const clawBridgePath = require.resolve('../modules/claw_bridge');
  const clawInfraPath = require.resolve('../modules/claw_infra');

  let capturedOptions = null;
  require.cache[clawInfraPath] = {
    id: clawInfraPath, filename: clawInfraPath, loaded: true,
    exports: {
      createClawInfrastructure: (opts) => {
        capturedOptions = opts;
        return {
          runtime: { name: opts.runtime?.name || 'claw-bridge', accountName: null },
          profiles: {},
          market: {}
        };
      }
    }
  };

  clearModule(clawBridgePath);
  clearModule(zeroclawBridgePath);

  const { runZeroClawCommand } = require('../modules/zeroclaw_bridge');
  const result = runZeroClawCommand('runtime', {});

  assert.strictEqual(capturedOptions.runtime.name, 'zeroclaw', 'runZeroClawCommand should inject zeroclaw as runtimeName');

  clearModule(zeroclawBridgePath);
  clearModule(clawBridgePath);
  clearModule(clawInfraPath);
}

function testBuildQueryScopesAnyPoolByReceivedAsset() {
  const { buildQuery } = require('../../market_adapter/kibana_source');

  // With poolId: no received asset filter needed
  const poolScoped = buildQuery('1.3.0', 100, 3600, '1.19.133');
  const poolFilters = poolScoped.query.bool.filter;
  assert.ok(
    poolFilters.some((f) => f.term?.['operation_history.op_object.pool.keyword'] === '1.19.133'),
    'pool-scoped query should filter by pool'
  );
  assert.ok(
    !poolFilters.some((f) => f.term?.['operation_history.op_object.min_to_receive.asset_id.keyword']),
    'pool-scoped query should not add receivedAssetId filter'
  );

  // Without poolId but with receivedAssetId: must scope by counterpart
  const pairScoped = buildQuery('1.3.0', 100, 3600, null, null, '1.3.1');
  const pairFilters = pairScoped.query.bool.filter;
  assert.ok(
    !pairFilters.some((f) => f.term?.['operation_history.op_object.pool.keyword']),
    'any-pool query should not have pool filter'
  );
  assert.ok(
    pairFilters.some((f) => f.term?.['operation_history.op_object.min_to_receive.asset_id.keyword'] === '1.3.1'),
    'any-pool query should filter by received asset ID'
  );
}

function testClawDefaultDataPathsStayInsideClawFolder() {
  const clawDataDir = path.join(__dirname, '..', 'data');
  const clawStateDir = path.join(clawDataDir, 'state');
  const clawInfra = require('../modules/claw_infra');
  const { DEFAULT_STATE_PATH } = require('../modules/position_manager');
  const { DEFAULT_HEALTH_PATH } = require('../modules/position_manager_watch');

  assert.strictEqual(DEFAULT_STATE_PATH, path.join(clawDataDir, 'positions.json'));
  assert.strictEqual(DEFAULT_HEALTH_PATH, path.join(clawDataDir, 'watcher-health.json'));

  const runtime = clawInfra.createRuntimeContext();
  assert.strictEqual(runtime.dataDir, clawDataDir);
  assert.strictEqual(runtime.stateDir, clawStateDir);

  const stateStore = clawInfra.createStateStore();
  assert.strictEqual(stateStore.filePath, path.join(clawStateDir, 'claw-state.json'));
}

async function main() {
  await testClawBitsharesClientLoadsEventPatchAndDetectsExistingConnection();
  testClawRootExportsAvoidSilentCollisions();
  testZeroClawSkillQuotesPayloadPlaceholders();
  testLiquidityPoolWrapperInjectsSharedBitSharesClient();
  await testDecisionLoopReusesAnalyzerStateForDuplicateMarkets();
  await testDecisionLoopReplacesAnalyzerOnConfigChange();
  await testPositionManagerEntryExposesSellPriceInBts();
  testClawBridgeRespectsRuntimeNameOption();
  testZeroClawCommandInjectsRuntimeName();
  testAccountOrdersBotKeyFallsBackToAssetIds();
  testBuildQueryScopesAnyPoolByReceivedAsset();
  testClawDefaultDataPathsStayInsideClawFolder();
  console.log('claw regression tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
