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

  const originalBitshares = setCachedModule(bitsharesClientPath, {
    BitShares: {
      db: {
        call: async (method, args) => {
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
              if (Object.prototype.hasOwnProperty.call(offersById, id)) return offersById[id];
              return null;
            });
          }
          if (method === 'get_credit_deals_by_borrower') {
            const response = dealResponses[Math.min(dealResponseIndex, dealResponses.length - 1)];
            dealResponseIndex += 1;
            return response;
          }
          return [];
        },
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
    executeBatch: async (accountName, privateKey, operations) => {
      calls.push({ accountName, privateKey, operations });
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
        maxFeeRate: 30000,
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
  const restore = installStubs(calls, dbCalls);
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
    assert.strictEqual(runtime.state.debtAssetId, '1.3.10', 'debt asset should be tracked');

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

async function testRepayAndReborrowFlow() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
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
            maxFeeRate: 30000,
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
    const result = await runtime.repayCreditDeal('1.19.77', 200, { reborrowAmount: 200 });
    assert.strictEqual(result.tx_id, 'tx-1', 'repay flow should broadcast one batch');
    assert.strictEqual(calls.length, 1, 'repay flow should use one batch');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_deal_repay', 'first op should repay the deal');
    assert.strictEqual(calls[0].operations[1].op_name, 'credit_offer_accept', 'second op should reborrow the deal');
    assert.strictEqual(calls[0].operations[1].op_data.borrow_amount.amount, 200, 'reborrow amount should match request');
    assert.strictEqual(calls[0].operations[1].op_data.collateral.amount, 400, 'reborrow collateral should follow offer price');
    assert.strictEqual(calls[0].operations[0].op_data.credit_fee.amount, 6, 'credit fee should be derived from fee rate');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-1.json'), 'utf8'));
    assert.strictEqual(persisted.reborrowPending, false, 'reborrow queue should be empty after successful batch');
    assert.strictEqual(typeof persisted.lastRepayAt, 'string', 'repay timestamp should be persisted');
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

async function testMissingFeeCapIsRejected() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
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
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        borrowAmount: 100,
        collateralAmount: { amount: 200, asset_id: '1.3.0' },
      }),
      /maxFeeRate is required/,
      'credit offers must fail closed without a maxFeeRate'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditBorrowLimitIsEnforced() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-borrow-cap-'));

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
        borrowAmount: 1001,
      }),
      /exceeds maxBorrowAmount/,
      'credit borrows should fail closed above maxBorrowAmount'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
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
            maxFeeRate: 30000,
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
            maxFeeRate: 30000,
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
    const result = await runtime.repayCreditDeal('1.19.77', 200, { reborrowAmount: 200 });
    assert.strictEqual(result.tx_id, 'tx-1', 'repay should still broadcast successfully');
    assert.strictEqual(calls.length, 1, 'only the repay batch should be sent when reborrow cannot be built inline');
    assert.strictEqual(calls[0].operations.length, 1, 'repay batch should not include a speculative reborrow');
    assert.strictEqual(runtime.state.pendingReborrows.length, 1, 'confirmed repay without inline reborrow should queue a deferred reborrow');
    assert.strictEqual(runtime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'queued deferred reborrow should reference the repaid deal');
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
            maxFeeRate: 30000,
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

(async () => {
  await testRefreshAndMpaPlan();
  await testMpaPrecisionAwareBroadcast();
  await testRepayAndReborrowFlow();
  await testMultipleMpaPositionsAreBlocked();
  await testMissingFeeCapIsRejected();
  await testCreditBorrowLimitIsEnforced();
  await testDealDisappearanceDoesNotAutoQueueReborrow();
  await testDeferredReborrowQueuesAfterConfirmedRepay();
  await testAutoReborrowQueueIsIgnoredWhenDisabled();
  await testStatePersistsAcrossRestart();
  console.log('credit runtime tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
