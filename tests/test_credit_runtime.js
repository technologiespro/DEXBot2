'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running credit runtime tests');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.js');
const chainOrdersPath = path.resolve(__dirname, '../modules/chain_orders.js');
const creditRuntimePath = path.resolve(__dirname, '../modules/credit_runtime.js');

function installStubs(calls, dbCalls, options = {}) {
  const callOrders = options.callOrders || [
    {
      id: '1.8.1',
      borrower: '1.2.3',
      debt: { amount: 100, asset_id: '1.3.10' },
      collateral: { amount: 250, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 2, asset_id: '1.3.0' },
        quote: { amount: 1, asset_id: '1.3.10' },
      },
    },
  ];
  const dealResponses = options.dealResponses || [[
    {
      id: '1.19.77',
      borrower: '1.2.3',
      offer_id: '1.18.42',
      offer_owner: '1.2.9',
      debt_asset: '1.3.10',
      debt_amount: 500,
      collateral_asset: '1.3.0',
      collateral_amount: 1000,
      fee_rate: 30000,
      latest_repay_time: '2030-01-01T00:00:00',
      auto_repay: 0,
    },
  ]];
  let dealResponseIndex = 0;
  const assetsById = options.assetsById || {
    '1.3.10': {
      id: '1.3.10',
      symbol: 'HONEST.USD',
      precision: 0,
      bitasset_data_id: '2.4.1',
    },
    '1.3.0': {
      id: '1.3.0',
      symbol: 'BTS',
      precision: 0,
      bitasset_data_id: null,
    },
  };
  const assetsBySymbol = new Map(Object.values(assetsById).map((asset) => [asset.symbol, asset]));
  const bitassetObjects = options.bitassetObjects || {
    '2.4.1': {
      id: '2.4.1',
      current_feed: {
        settlement_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    },
  };
  const assetDynamicData = options.assetDynamicData || {};
  const offersById = options.offersById || {
    '1.18.42': {
      id: '1.18.42',
      asset_type: '1.3.10',
      current_balance: 10000,
      fee_rate: 30000,
      min_deal_amount: 100,
      enabled: true,
      max_duration_seconds: 86400,
      acceptable_collateral: {
        '1.3.0': {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    },
  };
  const creditOffersByOwner = options.creditOffersByOwner || Object.values(offersById);
  const poolByShareAsset = options.poolByShareAsset || {};
  const poolByAssetPair = options.poolByAssetPair || {};
  const pairKey = (left, right) => [String(left), String(right)].sort().join('|');
  const handleDbCall = async (method, args) => {
    dbCalls.push({ method, args });
    if (method === 'get_full_accounts') {
      return [
        ['alice', {
          account: {
            id: '1.2.3',
            name: 'alice',
            call_orders: callOrders,
          },
        }],
      ];
    }
    if (method === 'get_assets') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => assetsById[id] || null);
    }
    if (method === 'lookup_asset_symbols') {
      const symbols = Array.isArray(args?.[0]) ? args[0] : [];
      return symbols.map((symbol) => assetsBySymbol.get(symbol) || null);
    }
    if (method === 'get_objects') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => {
        if (bitassetObjects[id]) return bitassetObjects[id];
        if (assetDynamicData[id]) return assetDynamicData[id];
        if (Object.prototype.hasOwnProperty.call(offersById, id)) return offersById[id];
        return null;
      });
    }
    if (method === 'get_liquidity_pools_by_share_asset') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => poolByShareAsset[id] || null);
    }
    if (method === 'get_liquidity_pool_by_asset_ids') {
      const left = args?.[0];
      const right = args?.[1];
      return poolByAssetPair[pairKey(left, right)] || null;
    }
    if (method === 'get_credit_deals_by_borrower') {
      const response = dealResponses[Math.min(dealResponseIndex, dealResponses.length - 1)];
      dealResponseIndex += 1;
      return response;
    }
    if (method === 'get_credit_offers_by_owner') {
      return creditOffersByOwner;
    }
    if (method === 'get_on_chain_asset_balances') {
      return options.assetBalances || {};
    }
    return [];
  };

  const onExecuteBatch = typeof options.onExecuteBatch === 'function' ? options.onExecuteBatch : null;

  const originalBitshares = setCachedModule(bitsharesClientPath, {
    BitShares: {
      db: {
        call: handleDbCall,
        lookup_asset_symbols: async (symbols) => handleDbCall('lookup_asset_symbols', [symbols]),
        get_assets: async (ids) => handleDbCall('get_assets', [ids]),
        get_objects: async (ids) => handleDbCall('get_objects', [ids]),
        get_liquidity_pools_by_share_asset: async (ids, subscribe, withStatistics) => handleDbCall('get_liquidity_pools_by_share_asset', [ids, subscribe, withStatistics]),
        get_liquidity_pool_by_asset_ids: async (left, right) => handleDbCall('get_liquidity_pool_by_asset_ids', [left, right]),
        get_credit_deals_by_borrower: async (accountId) => handleDbCall('get_credit_deals_by_borrower', [accountId]),
        get_credit_offers_by_owner: async (accountId) => handleDbCall('get_credit_offers_by_owner', [accountId]),
        get_on_chain_asset_balances: async (accountRef, assets) => handleDbCall('get_on_chain_asset_balances', [accountRef, assets]),
      },
    },
    waitForConnected: async () => {},
    createAccountClient: () => ({}),
    setSuppressConnectionLog() {},
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    _internal: { connected: true },
  });

  const originalChainOrders = setCachedModule(chainOrdersPath, {
    resolveAccountId: async (accountName) => {
      if (accountName === 'alice' || accountName === '1.2.3') return '1.2.3';
      return null;
    },
    resolveAccountName: async (accountRef) => {
      if (accountRef === '1.2.3' || accountRef === 'alice') return 'alice';
      return null;
    },
    getOnChainAssetBalances: async (accountRef, assets) => {
      const balanceMap = options.assetBalances || {};
      const out = {};
      for (const asset of assets || []) {
        const key = String(asset);
        out[key] = balanceMap[key] || balanceMap[String(key)] || { free: 0, locked: 0, total: 0 };
      }
      return out;
    },
    executeBatch: async (accountName, privateKey, operations) => {
      calls.push({ accountName, privateKey, operations });
      if (onExecuteBatch) {
        await onExecuteBatch({ accountName, privateKey, operations });
      }
      return { tx_id: `tx-${calls.length}`, operation_results: operations.map((op, index) => [index, op.op_name]) };
    },
  });

  return () => {
    restoreCachedModule(bitsharesClientPath, originalBitshares);
    restoreCachedModule(chainOrdersPath, originalChainOrders);
  };
}

function createBaseBotConfig(overrides = {}) {
  return {
    botKey: 'credit-bot',
    preferredAccount: 'alice',
    debtPolicy: {
      mpa: {
        allowedDebtAssets: ['1.3.10'],
        allowedCollateralAssets: ['1.3.0'],
        maxBorrowAmount: 1000,
        maxCollateralAmount: 10000,
        minCollateralRatio: 2,
        maxCollateralRatio: 2.5,
        targetCollateralRatio: 2.2,
      },
      creditOffer: {
        allowedOfferIds: ['1.18.42'],
        allowedDebtAssets: ['1.3.10'],
        allowedCollateralAssets: ['1.3.0'],
        maxBorrowAmount: 1000,
        maxCollateralRatio: 2.5,
        maxFeeRatePerDay: 0.05,
        autoReborrow: true,
      },
    },
    dryRun: false,
    ...overrides,
  };
}

async function testRefreshAndMpaPlan() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.1',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      for (const op of operations) {
        if (op.op_name !== 'call_order_update') continue;
        callOrders[0].debt.amount += Number(op.op_data?.delta_debt?.amount || 0);
        callOrders[0].collateral.amount += Number(op.op_data?.delta_collateral?.amount || 0);
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-runtime-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-0' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.activeCallOrderId, '1.8.1', 'MPA call order should be discovered');
    assert.deepStrictEqual(runtime.state.activeDealIds, ['1.19.77'], 'credit deal should be discovered');
    assert.deepStrictEqual(runtime.state.mpaCallOrders.map((entry) => entry.id), ['1.8.1'], 'MPA call orders should be captured in state');
    assert.strictEqual(runtime.state.ownedCreditOffers.length, 1, 'owned credit offers should be discovered');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.0'].mpaCollateral, 250, 'MPA collateral should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.0'].creditCollateral, 10, 'credit deal collateral should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.10'].offeredBalance, 100, 'owned credit offer balance should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.debtAssetId, '1.3.10', 'debt asset should be tracked');
    assert(dbCalls.some((entry) => entry.method === 'get_credit_offers_by_owner'), 'refreshState should query owned credit offers');

    const plan = runtime._buildMpaPlanFromState();
    assert(plan, 'MPA plan should be generated');
    assert.strictEqual(plan.action, 'reduce_debt', 'below-min CR should reduce debt first');
    assert.strictEqual(plan.targetCollateralRatio, 2, 'plan should target the lower CR floor');

    const op = await runtime.buildMpaUpdateOperation(plan);
    assert.strictEqual(op.op_name, 'call_order_update', 'MPA plan should build a call_order_update op');
    assert.strictEqual(op.op_data.extensions.target_collateral_ratio, 2, 'target CR should be embedded in the op');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.context, 'periodic', 'maintenance context should round-trip');
    assert.strictEqual(calls.length, 1, 'MPA maintenance should broadcast one operation');
    assert.strictEqual(calls[0].operations[0].op_name, 'call_order_update', 'broadcast op should be call_order_update');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-0.json'), 'utf8'));
    assert.strictEqual(persisted.botKey, 'credit-bot-0', 'state file should be keyed by bot');
    assert.strictEqual(persisted.activeCallOrderId, '1.8.1', 'state file should store the active call order');
    assert.strictEqual(persisted.activeDealIds[0], '1.19.77', 'state file should store the active credit deal');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferCollateralPercentUsesDebtSnapshot() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 10, locked: 25990, total: 26000 },
    },
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 1,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-percent-snapshot-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-percent-snapshot',
        debtPolicy: {
          mpa: {
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: '50%',
            minCollateralRatio: 2,
            maxCollateralRatio: 2.5,
            targetCollateralRatio: 2.2,
          },
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: 1000000,
            maxCollateralRatio: 1000,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.currentCollateralFundsTotal, 27250, 'collateral total should include free, locked, and contract collateral');
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 13625, 'percentage collateral should resolve against the full collateral base');
    assert.strictEqual(dbCalls.filter((entry) => entry.method === 'get_credit_offers_by_owner').length > 0, true, 'credit offer ownership should be queried');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferCollateralPercentDoesNotRequireRefresh() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 10, locked: 25990, total: 26000 },
    },
    dealResponses: [[
      {
        id: '1.19.77',
        borrower: '1.2.3',
        offer_id: '1.18.42',
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 500,
        collateral_asset: '1.3.0',
        collateral_amount: 1000,
        fee_rate: 30000,
        latest_repay_time: '2030-01-01T00:00:00',
        auto_repay: 0,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-stale-free-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-stale-free',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: 1000000,
            maxCollateralRatio: 1000,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    runtime.state.currentCollateralFundsTotal = 1;
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 13625, 'percentage collateral should ignore stale runtime state and use a fresh collateral base');
    assert(dbCalls.some((entry) => entry.method === 'get_credit_deals_by_borrower'), 'fresh collateral base should query current deals');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaPrecisionAwareBroadcast() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 4,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 5,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200000, asset_id: '1.3.0' },
            quote: { amount: 10000, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders: [
      {
        id: '1.8.9',
        borrower: '1.2.3',
        debt: { amount: 10000, asset_id: '1.3.10' },
        collateral: { amount: 250000, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 200000, asset_id: '1.3.0' },
          quote: { amount: 10000, asset_id: '1.3.10' },
        },
      },
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-precision-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-precision' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const plan = runtime._buildMpaPlanFromState();
    assert(plan, 'precision-aware MPA plan should be generated');
    assert.strictEqual(plan.action, 'reduce_debt', 'under-collateralized position should reduce debt');
    assert.strictEqual(plan.debtDelta, -0.375, 'debt delta should remain in human units');

    const op = await runtime.buildMpaUpdateOperation(plan);
    assert.strictEqual(op.op_data.delta_debt.amount, -3750, 'debt delta should convert to blockchain units once');
    assert.strictEqual(op.op_data.delta_collateral.amount, 0, 'collateral should not change for debt-first recovery');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFirstThenCollateralFallbackTriggersReset() {
  const calls = [];
  const dbCalls = [];
  const resetCalls = [];
  const callOrders = [
    {
      id: '1.8.9',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 60000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      for (const op of operations) {
        if (op.op_name !== 'call_order_update') continue;
        const debtDelta = Number(op.op_data?.delta_debt?.amount || 0);
        const collateralDelta = Number(op.op_data?.delta_collateral?.amount || 0);
        callOrders[0].debt.amount += debtDelta;
        callOrders[0].collateral.amount += collateralDelta;
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-cr-reset-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-cr-reset',
        debtPolicy: {
          mpa: {
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 110,
            maxCollateralAmount: 10000,
            minCollateralRatio: 2,
            maxCollateralRatio: 2.5,
            targetCollateralRatio: 2.2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
      requestGridReset: async (reason, options = {}) => {
        resetCalls.push({ reason, options });
        return { requested: true, reason, options };
      },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.runMaintenance('periodic');

    assert.strictEqual(calls.length, 2, 'CR repair should broadcast debt and collateral legs separately');
    assert.strictEqual(calls[0].operations[0].op_data.delta_debt.amount, 1000, 'first leg should increase debt up to the total cap');
    assert.strictEqual(calls[0].operations[0].op_data.delta_collateral.amount, 0, 'debt leg should not change collateral');
    assert.strictEqual(calls[1].operations[0].op_data.delta_debt.amount, 0, 'collateral leg should not change debt');
    assert.strictEqual(calls[1].operations[0].op_data.delta_collateral.amount < 0, true, 'second leg should withdraw collateral after the capped debt increase');
    assert.deepStrictEqual(result.mpa.executed.map((entry) => entry.leg), ['debt', 'collateral'], 'maintenance should record both legs');
    assert.strictEqual(result.mpa.resetResult.reason, 'cr-adjustment', 'grid reset should be requested after CR adjustment');
    assert.strictEqual(resetCalls[0].options.fillLockAlreadyHeld, true, 'periodic CR reset should reuse the existing fill lock');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-cr-reset.json'), 'utf8'));
    assert.strictEqual(typeof persisted.lastGridResetAt, 'string', 'reset timestamp should be persisted');
    assert.strictEqual(typeof persisted.lastCrAdjustment, 'object', 'CR adjustment metadata should be persisted');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testRepayAndReborrowFlow() {
  const calls = [];
  const dbCalls = [];
  const activeDeal = {
    id: '1.19.77',
    borrower: '1.2.3',
    offer_id: '1.18.42',
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: 500,
    collateral_asset: '1.3.0',
    collateral_amount: 1000,
    fee_rate: 30000,
    latest_repay_time: '2030-01-01T00:00:00',
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-repay-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-1',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
            autoRepay: 2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200);
    assert.strictEqual(result.tx_id, 'tx-1', 'repay flow should broadcast one batch');
    assert.strictEqual(calls.length, 1, 'repay flow should not execute a second reborrow after a successful inline reborrow');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_deal_repay', 'first op should repay the deal');
    assert.strictEqual(calls[0].operations[1].op_name, 'credit_offer_accept', 'second op should reborrow the deal');
    assert.strictEqual(calls[0].operations[1].op_data.borrow_amount.amount, 200, 'default reborrow amount should match the repaid amount');
    assert.strictEqual(calls[0].operations[1].op_data.collateral.amount, 400, 'default reborrow collateral should follow offer price');
    assert.deepStrictEqual(calls[0].operations[1].op_data.extensions, { auto_repay: 2 }, 'credit offer accept should carry forward auto_repay from policy');
    assert.strictEqual(calls[0].operations[0].op_data.credit_fee.amount, 6, 'credit fee should be derived from fee rate');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-1.json'), 'utf8'));
    assert.strictEqual(persisted.reborrowPending, false, 'reborrow queue should be empty after successful batch');
    assert.strictEqual(typeof persisted.lastRepayAt, 'string', 'repay timestamp should be persisted');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testFixedCreditCollateralDoesNotResolvePercentageBase() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fixed-collateral-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-fixed-collateral',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: 200, asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 200, 'fixed collateral should still build the requested amount');
    assert.strictEqual(
      dbCalls.some((entry) => entry.method === 'get_on_chain_asset_balances' || entry.method === 'get_full_accounts' || entry.method === 'get_credit_deals_by_borrower'),
      false,
      'fixed collateral should not query the percentage collateral base'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaPolicyRejectsInvalidBorrowCap() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-mpa-invalid-borrow-cap-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'mpa-invalid-borrow-cap',
        debtPolicy: {
          mpa: {
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 0,
            minCollateralRatio: 2,
            maxCollateralRatio: 2.5,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    const validation = runtime._validateMpaPolicy(runtime.debtPolicy.mpa, '1.3.10', '1.3.0');
    assert.strictEqual(validation.allow, false, 'MPA policy should reject a provided non-positive maxBorrowAmount');
    assert(validation.reason.includes('maxBorrowAmount'), 'rejection should identify maxBorrowAmount');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMultipleMpaPositionsAreBlocked() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    callOrders: [
      {
        id: '1.8.1',
        borrower: '1.2.3',
        debt: { amount: 100, asset_id: '1.3.10' },
        collateral: { amount: 250, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
      {
        id: '1.8.2',
        borrower: '1.2.3',
        debt: { amount: 75, asset_id: '1.3.10' },
        collateral: { amount: 200, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-block-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-mpa-block' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.activeCallOrderId, null, 'multiple call orders should not select an active position');
    assert(runtime.state.mpaSelectionConflict, 'multiple positions should be marked as a conflict');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.mpa.blocked, true, 'maintenance should block MPA actions when the position is ambiguous');
    assert.strictEqual(calls.length, 0, 'no blockchain write should happen when MPA is ambiguous');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testDefaultFeeRateCapRejectsExpensiveOffer() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fee-cap-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: {
        botKey: 'credit-bot-fee-cap',
        preferredAccount: 'alice',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: 1000000,
            maxCollateralRatio: 2.5,
            autoReborrow: true,
          },
        },
        dryRun: false,
      },
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Default maxFeeRatePerDay is ~0.000333 (1/3000 = 0.033% per day).
    // Offer: 3% flat / 1 day = 3% per day → should be rejected by default.
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 86400, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 200, asset_id: '1.3.0' },
      }),
      /exceeds maxFeeRatePerDay/,
      'expensive offer should be rejected by default maxFeeRatePerDay'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMaxFeeRatePerDayRejectsExpensiveOffer() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fee-day-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: {
        botKey: 'credit-bot-fee-day',
        preferredAccount: 'alice',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: '50%',
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.001,
            autoReborrow: true,
          },
        },
        dryRun: false,
      },
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Offer: 3% flat fee, 1 day duration → 3% per day. Policy limit: 0.1% per day.
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 86400, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 200, asset_id: '1.3.0' },
      }),
      /daily fee rate .* exceeds maxFeeRatePerDay/,
      'expensive daily fee rate should be rejected'
    );

    // Offer: 3% flat fee, 30 day duration → 0.1% per day. Policy limit: 0.1% per day.
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 2592000, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
      collateralAmount: { amount: 200, asset_id: '1.3.0' },
    });
    assert.strictEqual(op.op_name, 'credit_offer_accept', 'acceptable daily fee rate should pass');

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 2592000, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 1000, asset_id: '1.3.0' },
      }),
      /exceeds? maxCollateralAmount/,
      'credit offer collateral cap should accept percentages and enforce the resolved limit'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditBorrowIsDerivedFromCollateral() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-borrow-derivation-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-borrow-cap' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });
    assert.strictEqual(op.op_data.collateral.amount, 825, 'percentage collateral should resolve against the full collateral base');
    assert.strictEqual(op.op_data.borrow_amount.amount, 412, 'borrow amount should derive from the full collateral base');

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        collateralAmount: { amount: 3000, asset_id: '1.3.0' },
      }),
      /exceeds? maxBorrowAmount/,
      'collateral-derived borrows should still enforce maxBorrowAmount'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferTotalCeilingEnforcement() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-total-ceiling-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-total-ceiling',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: 1200,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Existing default deal: debt 500, collateral 1000
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 600,
        collateralAmount: { amount: 1200, asset_id: '1.3.0' },
      }),
      /exceeds? maxBorrowAmount/,
      'total borrow ceiling should include existing credit deals'
    );

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 100,
        collateralAmount: { amount: 300, asset_id: '1.3.0' },
      }),
      /exceeds? maxCollateralAmount/,
      'total collateral ceiling should include existing credit deals'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferTotalCeilingUsesAssetPrecision() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    assetBalances: {
      '1.3.0': { free: 40000, locked: 0, total: 40000 },
    },
    dealResponses: [[
      {
        id: '1.19.77',
        borrower: '1.2.3',
        offer_id: '1.18.42',
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 50000,
        collateral_asset: '1.3.0',
        collateral_amount: 100000,
        fee_rate: 30000,
        latest_repay_time: '2030-01-01T00:00:00',
        auto_repay: 0,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-total-ceiling-precision-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-total-ceiling-precision',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralAmount: 1200,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 200, asset_id: '1.3.0' },
              quote: { amount: 100, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 600,
        collateralAmount: { amount: 1200, asset_id: '1.3.0' },
      }),
      /current total 500/,
      'existing credit debt should be converted from chain precision before cap comparison'
    );

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 200, asset_id: '1.3.0' },
              quote: { amount: 100, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 100,
        collateralAmount: { amount: 300, asset_id: '1.3.0' },
      }),
      /current total 1000/,
      'existing credit collateral should be converted from chain precision before cap comparison'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testLpCollateralRatioGate() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.11': {
        id: '1.3.11',
        symbol: 'ALT',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.20': {
        id: '1.3.20',
        symbol: 'LP-USD-BTS',
        precision: 0,
        bitasset_data_id: null,
        dynamic_asset_data_id: '2.4.20',
        for_liquidity_pool: '1.19.1',
      },
    },
    assetDynamicData: {
      '2.4.20': {
        id: '2.4.20',
        current_supply: 10000,
      },
    },
    poolByShareAsset: {
      '1.3.20': {
        id: '1.19.1',
        asset_a: '1.3.0',
        asset_b: '1.3.11',
        balance_a: 10000,
        balance_b: 10000,
        share_asset: '1.3.20',
      },
    },
    poolByAssetPair: {
      '1.3.0|1.3.10': {
        id: '1.19.2',
        asset_a: '1.3.0',
        asset_b: '1.3.10',
        balance_a: 10000,
        balance_b: 5000,
        share_asset: '1.3.21',
      },
      '1.3.10|1.3.11': {
        id: '1.19.3',
        asset_a: '1.3.10',
        asset_b: '1.3.11',
        balance_a: 5000,
        balance_b: 10000,
        share_asset: '1.3.22',
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-lp-cr-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const offer = {
      id: '1.18.42',
      asset_type: '1.3.10',
      fee_rate: 30000,
      enabled: true,
      min_deal_amount: 1,
      acceptable_collateral: {
        '1.3.20': {
          base: { amount: 2, asset_id: '1.3.20' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    };

    const rejectRuntime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-lp-reject',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.20'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 1.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime_reject') });

    await rejectRuntime.refreshState();
    await assert.rejects(
      () => rejectRuntime.buildCreditOfferAcceptOperation({
        offer,
        borrowAmount: 100,
      }),
      /maxCollateralRatio/,
      'LP-backed credit offers must be rejected when the actual CR exceeds the cap'
    );

    const acceptRuntime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-lp-accept',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.20'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
            autoRepay: 2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime_accept') });

    await acceptRuntime.refreshState();
    const op = await acceptRuntime.buildCreditOfferAcceptOperation({
      offer,
      borrowAmount: 100,
    });

    assert.strictEqual(op.op_name, 'credit_offer_accept', 'LP-backed offer should still build a credit accept op');
    assert.strictEqual(op.op_data.collateral.amount, 20000, 'offer collateral should be resolved from the configured price in chain units');
    assert.strictEqual(op.op_data.borrow_amount.amount, 10000, 'borrow amount should remain intact in chain units');
  } finally {
    restore();
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (err) { }
  }
}

async function testDealDisappearanceDoesNotAutoQueueReborrow() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.77',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
            autoRepay: 2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.activeDealIds[0], '1.19.77', 'initial credit deal should be tracked');

    await runtime.refreshCreditState();
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'disappearance alone should not queue a reborrow');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.credit.processed, 0, 'maintenance should not process a reborrow without a confirmed repay');
    assert.strictEqual(calls.length, 0, 'no reborrow should be broadcast from disappearance alone');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testDeferredReborrowQueuesAfterConfirmedRepay() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.77',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
    offersById: {
      '1.18.42': null,
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-confirmed-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow-confirmed',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
            autoRepay: 2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200);
    assert.strictEqual(result.tx_id, 'tx-1', 'repay should still broadcast successfully');
    assert.strictEqual(calls.length, 1, 'only the repay batch should be sent when reborrow cannot be built inline');
    assert.strictEqual(calls[0].operations.length, 1, 'repay batch should not include a speculative reborrow');
    assert.strictEqual(runtime.state.pendingReborrows.length, 1, 'confirmed repay without inline reborrow should queue a deferred reborrow');
    assert.strictEqual(runtime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'queued deferred reborrow should reference the repaid deal');
    assert.strictEqual(runtime.state.pendingReborrows[0].autoRepay, 2, 'queued deferred reborrow should preserve policy autoRepay mode');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditDealUpdatePreservesAutoRepayMode() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-update-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-update',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: true,
            autoRepay: 2,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    const op = await runtime.buildCreditDealUpdateOperation({ id: '1.19.77' }, 2);
    assert.strictEqual(op.op_name, 'credit_deal_update', 'credit deal update op should be built');
    assert.strictEqual(op.op_data.auto_repay, 2, 'credit deal update should preserve autoRepay mode 2');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testAutoReborrowQueueIsIgnoredWhenDisabled() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.88',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-off-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow-off',
        debtPolicy: {
          creditOffer: {
            allowedOfferIds: ['1.18.42'],
            allowedDebtAssets: ['1.3.10'],
            allowedCollateralAssets: ['1.3.0'],
            maxBorrowAmount: 1000,
            maxCollateralRatio: 2.5,
            maxFeeRatePerDay: 0.05,
            autoReborrow: false,
          },
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    await runtime.refreshCreditState();
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'autoReborrow=false should not queue missing deals');
    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.credit.skipped, true, 'pending reborrow processing should be skipped when autoReborrow is disabled');
    assert.strictEqual(calls.length, 0, 'no reborrow should be broadcast when autoReborrow is disabled');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testStatePersistsAcrossRestart() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-persist-'));
  const stateDir = path.join(baseDir, 'credit_runtime');

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');

    const firstRuntime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-persist' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir });

    await firstRuntime.refreshState();
    firstRuntime.state.pendingReborrows = [
      {
        sourceDealId: '1.19.77',
        offerId: '1.18.42',
        borrowAmount: 50,
        collateralAmount: null,
        requestedAt: '2030-01-01T00:00:00.000Z',
        reason: 'unit-test',
      },
    ];
    await firstRuntime.persistState('test');
    await firstRuntime.shutdown();

    delete require.cache[creditRuntimePath];
    const ReloadedCreditRuntime = require('../modules/credit_runtime');
    const secondRuntime = new ReloadedCreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-persist' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir });

    await secondRuntime.loadState({ forceReload: true });
    assert.strictEqual(secondRuntime.state.botKey, 'credit-bot-persist', 'bot key should survive reload');
    assert.strictEqual(secondRuntime.state.pendingReborrows.length, 1, 'pending reborrows should survive reload');
    assert.strictEqual(secondRuntime.state.reborrowPending, true, 'reborrow flag should survive reload');
    assert.strictEqual(secondRuntime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'queued deal should survive reload');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testGetCollateralOffsets() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.1',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-offsets-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime');
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-offsets' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const offsets = runtime.getCollateralOffsets(['1.3.0', '1.3.10']);
    assert.strictEqual(offsets['1.3.0'], 260, 'total collateral for 1.3.0 should include MPA (250) + credit deal (10) in user units');
    assert.strictEqual(offsets['1.3.10'], 0, 'total collateral for 1.3.10 should be 0 when no collateral is held');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

(async () => {
  await testRefreshAndMpaPlan();
  await testCreditOfferCollateralPercentUsesDebtSnapshot();
  await testCreditOfferCollateralPercentDoesNotRequireRefresh();
  await testMpaPrecisionAwareBroadcast();
  await testMpaDebtFirstThenCollateralFallbackTriggersReset();
  await testRepayAndReborrowFlow();
  await testFixedCreditCollateralDoesNotResolvePercentageBase();
  await testMpaPolicyRejectsInvalidBorrowCap();
  await testMultipleMpaPositionsAreBlocked();
  await testDefaultFeeRateCapRejectsExpensiveOffer();
  await testMaxFeeRatePerDayRejectsExpensiveOffer();
  await testCreditBorrowIsDerivedFromCollateral();
  await testCreditOfferTotalCeilingEnforcement();
  await testCreditOfferTotalCeilingUsesAssetPrecision();
  await testLpCollateralRatioGate();
  await testDealDisappearanceDoesNotAutoQueueReborrow();
  await testDeferredReborrowQueuesAfterConfirmedRepay();
  await testCreditDealUpdatePreservesAutoRepayMode();
  await testAutoReborrowQueueIsIgnoredWhenDisabled();
  await testStatePersistsAcrossRestart();
  await testGetCollateralOffsets();
  console.log('credit runtime tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
