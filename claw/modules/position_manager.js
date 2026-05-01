const fs = require('fs/promises');
const path = require('path');
const {
  closeShortOnBts,
  openShortOnBts,
  placeTakeProfitBuyOrderOnBts
} = require('./short_mpa_strategy');
const {
  getAsset,
  getBackingAsset,
  getBalances,
  getBitassetData,
  getFullAccount
} = require('./chain_queries');
const { requireBtsBackedMpa } = require('./mpa_utils');
const { listenForFills } = require('./chain_actions');
const { writeJsonFileAtomic } = require('./dexbot_profiles');
const { loadDexbotOrderUtils } = require('./dexbot_bridge');

function getBlockchainToFloat() {
  return loadDexbotOrderUtils().blockchainToFloat;
}

const DEFAULT_STATE_PATH = path.resolve(__dirname, '..', 'data', 'positions.json');
const STRATEGY_NAME = 'short-mpa-bts';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function createPositionId() {
  return `pos_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function requirePositiveNumber(value, fieldName) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return numericValue;
}

function almostZero(value, epsilon = 1e-12) {
  return Math.abs(Number(value) || 0) <= epsilon;
}

function toNumberOrNull(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function extractOrderIds(operationResults = []) {
  const orderIds = [];

  for (const result of operationResults) {
    if (!Array.isArray(result) || result.length < 2) {
      continue;
    }

    const payload = result[1];
    if (typeof payload === 'string' && /^1\.7\.\d+$/.test(payload)) {
      orderIds.push(payload);
      continue;
    }

    const objectId = payload?.object_id || payload?.order_id || payload?.result;
    if (typeof objectId === 'string' && /^1\.7\.\d+$/.test(objectId)) {
      orderIds.push(objectId);
    }
  }

  return orderIds;
}

function createOrderTracking({ sellAsset, receiveAsset, targetSellAmount, targetReceiveAmount, priceInBts = null }) {
  return {
    averageExecutionPriceInBts: null,
    fillCount: 0,
    fillStatus: 'unfilled',
    filledReceiveAmount: 0,
    filledSellAmount: 0,
    isFullyFilled: false,
    lastFillAt: null,
    orderId: null,
    orderOpen: false,
    placedAt: null,
    priceInBts,
    receiveAsset,
    receiveAmountRemaining: targetReceiveAmount,
    sellAsset,
    sellAmountRemaining: targetSellAmount,
    targetReceiveAmount,
    targetSellAmount,
    tx: null
  };
}

function createPositionPnl() {
  return {
    averageEntryPriceInBts: null,
    averageExitPriceInBts: null,
    netBtsFlow: null,
    realizedCoverAmount: 0,
    realizedGrossPnlInBts: 0,
    updatedAt: null
  };
}

function toTrackedAsset(asset) {
  return asset ? { id: asset.id, precision: asset.precision, symbol: asset.symbol } : null;
}

function resolvePositionAssets(position) {
  const tracked = position?.assets || {};
  return {
    collateral: tracked.collateral || null,
    mpa: tracked.mpa || null
  };
}

function getOrderTracking(position, side) {
  return side === 'entry' ? position.entry : position.exit;
}

function getAssetPrecisionFromTracking(orderTracking, assetId) {
  if (orderTracking?.sellAsset?.id === assetId) {
    return orderTracking.sellAsset.precision;
  }
  if (orderTracking?.receiveAsset?.id === assetId) {
    return orderTracking.receiveAsset.precision;
  }
  return null;
}

function classifyFillAgainstOrder(orderTracking, payload) {
  const paysAssetId = payload?.pays?.asset_id;
  const receivesAssetId = payload?.receives?.asset_id;
  if (!paysAssetId || !receivesAssetId) {
    return null;
  }
  if (orderTracking?.sellAsset?.id !== paysAssetId) {
    return null;
  }
  if (orderTracking?.receiveAsset?.id !== receivesAssetId) {
    return null;
  }
  return {
    receivePrecision: getAssetPrecisionFromTracking(orderTracking, receivesAssetId),
    sellPrecision: getAssetPrecisionFromTracking(orderTracking, paysAssetId)
  };
}

function updateOrderTrackingFromFill(orderTracking, fill) {
  const payload = Array.isArray(fill?.op) ? fill.op[1] : null;
  const classification = classifyFillAgainstOrder(orderTracking, payload);
  if (!classification) {
    return false;
  }

  const blockchainToFloat = getBlockchainToFloat();
  const soldAmount = blockchainToFloat(payload?.pays?.amount, classification.sellPrecision);
  const receivedAmount = blockchainToFloat(payload?.receives?.amount, classification.receivePrecision);
  if (!Number.isFinite(soldAmount) || !Number.isFinite(receivedAmount)) {
    return false;
  }

  orderTracking.fillCount += 1;
  orderTracking.filledSellAmount += soldAmount;
  orderTracking.filledReceiveAmount += receivedAmount;
  orderTracking.lastFillAt = nowIso();

  if (orderTracking.sellAsset?.symbol === 'BTS') {
    orderTracking.averageExecutionPriceInBts = orderTracking.filledReceiveAmount > 0
      ? orderTracking.filledSellAmount / orderTracking.filledReceiveAmount
      : null;
  } else if (orderTracking.receiveAsset?.symbol === 'BTS') {
    orderTracking.averageExecutionPriceInBts = orderTracking.filledSellAmount > 0
      ? orderTracking.filledReceiveAmount / orderTracking.filledSellAmount
      : null;
  }

  orderTracking.sellAmountRemaining = Math.max(0, orderTracking.targetSellAmount - orderTracking.filledSellAmount);
  orderTracking.receiveAmountRemaining = Math.max(0, orderTracking.targetReceiveAmount - orderTracking.filledReceiveAmount);
  refreshOrderFillState(orderTracking);
  return true;
}

function updateOrderTrackingFromOpenOrder(orderTracking, openOrder) {
  if (!orderTracking) {
    return;
  }

  orderTracking.orderOpen = Boolean(openOrder);
  if (!openOrder) {
    orderTracking.sellAmountRemaining = Math.max(0, orderTracking.targetSellAmount - orderTracking.filledSellAmount);
    orderTracking.receiveAmountRemaining = Math.max(0, orderTracking.targetReceiveAmount - orderTracking.filledReceiveAmount);
    refreshOrderFillState(orderTracking);
    return;
  }

  const blockchainToFloat = getBlockchainToFloat();
  const remainingSellAmount = blockchainToFloat(openOrder.for_sale, orderTracking.sellAsset?.precision);
  if (Number.isFinite(remainingSellAmount)) {
    orderTracking.sellAmountRemaining = remainingSellAmount;

    if (Number.isFinite(orderTracking.targetSellAmount) && orderTracking.targetSellAmount >= remainingSellAmount) {
      const derivedFilledSell = orderTracking.targetSellAmount - remainingSellAmount;
      if (derivedFilledSell > orderTracking.filledSellAmount) {
        orderTracking.filledSellAmount = derivedFilledSell;
      }
    }

    if (Number.isFinite(orderTracking.targetSellAmount) && orderTracking.targetSellAmount > 0) {
      const remainingRatio = remainingSellAmount / orderTracking.targetSellAmount;
      orderTracking.receiveAmountRemaining = Math.max(0, orderTracking.targetReceiveAmount * remainingRatio);
    }
  }

  refreshOrderFillState(orderTracking);
}

function refreshOrderFillState(orderTracking) {
  const hasFills = (orderTracking?.fillCount || 0) > 0;
  const remainingSell = orderTracking?.sellAmountRemaining || 0;
  const orderOpen = Boolean(orderTracking?.orderOpen);

  orderTracking.isFullyFilled = !orderOpen && almostZero(remainingSell);

  if (orderTracking.isFullyFilled) {
    orderTracking.fillStatus = 'filled';
    return;
  }
  if (hasFills) {
    orderTracking.fillStatus = orderOpen ? 'partially_filled' : 'filled_or_closed';
    return;
  }
  orderTracking.fillStatus = orderOpen ? 'open' : 'unfilled';
}

function refreshPositionPnl(position) {
  const entryFilledMpa = position?.entry?.filledSellAmount || 0;
  const entryReceivedBts = position?.entry?.filledReceiveAmount || 0;
  const exitCoveredMpa = position?.exit?.filledReceiveAmount || 0;
  const exitSpentBts = position?.exit?.filledSellAmount || 0;
  const realizedCoverAmount = Math.min(entryFilledMpa, exitCoveredMpa);
  const averageEntryPriceInBts = entryFilledMpa > 0 ? entryReceivedBts / entryFilledMpa : null;
  const averageExitPriceInBts = exitCoveredMpa > 0 ? exitSpentBts / exitCoveredMpa : null;

  position.pnl = position.pnl || createPositionPnl();
  position.pnl.averageEntryPriceInBts = averageEntryPriceInBts;
  position.pnl.averageExitPriceInBts = averageExitPriceInBts;
  position.pnl.realizedCoverAmount = realizedCoverAmount;
  position.pnl.realizedGrossPnlInBts =
    averageEntryPriceInBts !== null && averageExitPriceInBts !== null
      ? (averageEntryPriceInBts - averageExitPriceInBts) * realizedCoverAmount
      : 0;
  position.pnl.netBtsFlow = entryReceivedBts - exitSpentBts;
  position.pnl.updatedAt = nowIso();
}

function computeBtsPerMpaFromSettlement(settlementPrice, mpaAsset, backingAsset) {
  const base = settlementPrice?.base;
  const quote = settlementPrice?.quote;
  if (!base || !quote) {
    return null;
  }

  const blockchainToFloat = getBlockchainToFloat();
  const baseAmount = blockchainToFloat(base.amount, base.asset_id === mpaAsset.id ? mpaAsset.precision : backingAsset.precision);
  const quoteAmount = blockchainToFloat(quote.amount, quote.asset_id === mpaAsset.id ? mpaAsset.precision : backingAsset.precision);
  if (!baseAmount || !quoteAmount) {
    return null;
  }

  if (base.asset_id === backingAsset.id && quote.asset_id === mpaAsset.id) {
    return baseAmount / quoteAmount;
  }

  if (base.asset_id === mpaAsset.id && quote.asset_id === backingAsset.id) {
    return quoteAmount / baseAmount;
  }

  return null;
}

function normalizeCallPosition(callOrder, mpaAsset, backingAsset, bitassetData) {
  if (!callOrder) {
    return {
      collateralAmount: 0,
      collateralRatio: null,
      debtAmount: 0,
      debtValueInBts: 0,
      exists: false,
      feedPublicationTime: bitassetData?.current_feed_publication_time || null
    };
  }

  const blockchainToFloat = getBlockchainToFloat();
  const debtAmount = blockchainToFloat(callOrder.debt, mpaAsset.precision);
  const collateralAmount = blockchainToFloat(callOrder.collateral, backingAsset.precision);
  const btsPerMpa = computeBtsPerMpaFromSettlement(bitassetData?.current_feed?.settlement_price, mpaAsset, backingAsset);
  const debtValueInBts = debtAmount && btsPerMpa ? debtAmount * btsPerMpa : 0;
  const collateralRatio = debtValueInBts > 0 ? collateralAmount / debtValueInBts : null;

  return {
    collateralAmount: collateralAmount || 0,
    collateralRatio,
    debtAmount: debtAmount || 0,
    debtValueInBts,
    exists: true,
    feedPublicationTime: bitassetData?.current_feed_publication_time || null
  };
}

class PositionManager {
  constructor(options = {}) {
    this.statePath = options.statePath || DEFAULT_STATE_PATH;
    this.state = null;
  }

  async loadState() {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        positions: Array.isArray(parsed?.positions) ? parsed.positions : [],
        updatedAt: parsed?.updatedAt || nowIso(),
        version: 1
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }

      this.state = {
        positions: [],
        updatedAt: nowIso(),
        version: 1
      };
    }

    return this.state;
  }

  async saveState() {
    const state = await this.loadState();
    state.updatedAt = nowIso();
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await writeJsonFileAtomic(this.statePath, state);
    return state;
  }

  async listPositions() {
    const state = await this.loadState();
    return clone(state.positions);
  }

  async getPosition(positionId) {
    const state = await this.loadState();
    const position = state.positions.find((entry) => entry.id === positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    return clone(position);
  }

  async createShortPosition(options = {}) {
    const state = await this.loadState();
    const accountName = requireString(options.accountName || process.env.BITSHARES_ACCOUNT, 'accountName');
    const mpaInput = requireString(options.mpaAsset, 'mpaAsset');
    const debtAmount = requirePositiveNumber(options.debtAmount, 'debtAmount');
    const collateralAmount = requirePositiveNumber(options.collateralAmount, 'collateralAmount');
    const sellPriceInBts = requirePositiveNumber(options.sellPriceInBts, 'sellPriceInBts');
    const targetCollateralRatio = options.targetCollateralRatio ?? null;
    const timestamp = nowIso();
    const { backingAsset, mpaAsset } = await requireBtsBackedMpa(mpaInput);

    const position = {
      accountName,
      assets: {
        collateral: toTrackedAsset(backingAsset),
        mpa: toTrackedAsset(mpaAsset)
      },
      collateral: {
        amount: collateralAmount,
        asset: 'BTS',
        targetCollateralRatio
      },
      createdAt: timestamp,
      debt: {
        amount: debtAmount,
        asset: mpaAsset.symbol
      },
      entry: {
        expectedBtsProceeds: debtAmount * sellPriceInBts,
        sellPriceInBts,
        ...createOrderTracking({
          priceInBts: sellPriceInBts,
          receiveAsset: toTrackedAsset(backingAsset),
          sellAsset: toTrackedAsset(mpaAsset),
          targetReceiveAmount: debtAmount * sellPriceInBts,
          targetSellAmount: debtAmount
        })
      },
      events: [
        {
          at: timestamp,
          details: {
            collateralAmount,
            debtAmount,
            mpaAsset: mpaAsset.symbol,
            sellPriceInBts
          },
          type: 'position-created'
        }
      ],
      exit: {
        ...createOrderTracking({
          receiveAsset: toTrackedAsset(mpaAsset),
          sellAsset: toTrackedAsset(backingAsset),
          targetReceiveAmount: 0,
          targetSellAmount: 0
        }),
        amountToCover: null,
        buyPriceInBts: null,
        estimatedGrossPnlInBts: null,
        maxBtsToSpend: null
      },
      id: createPositionId(),
      market: `${mpaAsset.symbol}/BTS`,
      onChain: null,
      pnl: createPositionPnl(),
      strategy: STRATEGY_NAME,
      status: 'planned',
      updatedAt: timestamp
    };

    state.positions.push(position);
    await this.saveState();
    return clone(position);
  }

  async openShort(positionId, options = {}) {
    const state = await this.loadState();
    const position = this.#findMutablePosition(state, positionId);
    if (position.status !== 'planned') {
      throw new Error(`Position ${positionId} is not in planned status`);
    }

    const result = await openShortOnBts({
      accountName: position.accountName,
      collateralAmount: position.collateral.amount,
      debtAmount: position.debt.amount,
      expiration: options.expiration,
      fillOrKill: options.fillOrKill,
      mpaAsset: position.debt.asset,
      privateKey: options.privateKey,
      sellPriceInBts: position.entry.sellPriceInBts,
      targetCollateralRatio: position.collateral.targetCollateralRatio
    });

    const orderIds = extractOrderIds(result?.sellOrderResult?.operation_results);
    position.entry.orderId = orderIds[0] || null;
    position.entry.placedAt = nowIso();
    position.entry.orderOpen = Boolean(position.entry.orderId);
    position.entry.tx = result?.sellOrderResult?.raw || null;
    position.status = position.entry.orderId ? 'entry_order_open' : 'debt_open';
    position.updatedAt = nowIso();
    position.events.push({
      at: position.updatedAt,
      details: {
        orderId: position.entry.orderId,
        operationResults: result?.sellOrderResult?.operation_results || []
      },
      type: 'entry-opened'
    });

    await this.syncPosition(positionId);
    return this.getPosition(positionId);
  }

  async placeTakeProfit(positionId, options = {}) {
    const state = await this.loadState();
    const position = this.#findMutablePosition(state, positionId);
    const amountToCover = requirePositiveNumber(options.amountToCover ?? position.debt.amount, 'amountToCover');
    const buyPriceInBts = requirePositiveNumber(options.buyPriceInBts, 'buyPriceInBts');

    const result = await placeTakeProfitBuyOrderOnBts({
      accountName: position.accountName,
      amountToCover,
      buyPriceInBts,
      expiration: options.expiration,
      fillOrKill: options.fillOrKill,
      mpaAsset: position.debt.asset,
      privateKey: options.privateKey
    });

    const orderIds = extractOrderIds(result?.rebuyOrderResult?.operation_results);
    position.exit.amountToCover = amountToCover;
    position.exit.buyPriceInBts = buyPriceInBts;
    position.exit.estimatedGrossPnlInBts = this.#estimateGrossPnl(position, amountToCover, buyPriceInBts);
    position.exit.maxBtsToSpend = amountToCover * buyPriceInBts;
    position.exit.targetReceiveAmount = amountToCover;
    position.exit.targetSellAmount = amountToCover * buyPriceInBts;
    position.exit.receiveAmountRemaining = amountToCover;
    position.exit.sellAmountRemaining = amountToCover * buyPriceInBts;
    position.exit.priceInBts = buyPriceInBts;
    position.exit.orderId = orderIds[0] || null;
    position.exit.orderOpen = Boolean(position.exit.orderId);
    position.exit.placedAt = nowIso();
    position.exit.tx = result?.rebuyOrderResult?.raw || null;
    position.status = position.exit.orderId ? 'take_profit_order_open' : 'debt_open';
    position.updatedAt = nowIso();
    position.events.push({
      at: position.updatedAt,
      details: {
        amountToCover,
        buyPriceInBts,
        estimatedGrossPnlInBts: position.exit.estimatedGrossPnlInBts,
        orderId: position.exit.orderId
      },
      type: 'take-profit-opened'
    });

    await this.saveState();
    return clone(position);
  }

  async closePosition(positionId, options = {}) {
    const state = await this.loadState();
    const position = this.#findMutablePosition(state, positionId);
    const amountToRepay = requirePositiveNumber(options.amountToRepay ?? position.debt.amount, 'amountToRepay');
    const releaseCollateralDelta = toNumberOrNull(options.releaseCollateralDelta) ?? 0;

    const result = await closeShortOnBts({
      accountName: position.accountName,
      amountToRepay,
      mpaAsset: position.debt.asset,
      privateKey: options.privateKey,
      releaseCollateralDelta,
      targetCollateralRatio: options.targetCollateralRatio ?? position.collateral.targetCollateralRatio
    });

    position.updatedAt = nowIso();
    position.events.push({
      at: position.updatedAt,
      details: {
        amountToRepay,
        releaseCollateralDelta
      },
      type: 'debt-close-submitted'
    });
    position.lastCloseTx = result?.repayResult?.raw || null;

    await this.syncPosition(positionId);
    return this.getPosition(positionId);
  }

  async syncPosition(positionId) {
    const state = await this.loadState();
    const position = this.#findMutablePosition(state, positionId);
    const fullAccount = await getFullAccount(position.accountName);
    const balances = await getBalances(position.accountName).catch(() => ({}));
    const openOrders = Array.isArray(fullAccount?.limit_orders) ? fullAccount.limit_orders : [];
    const callOrders = Array.isArray(fullAccount?.call_orders) ? fullAccount.call_orders : [];
    const mpaAsset = await getAsset(position.debt.asset);
    const backingAsset = await getBackingAsset(position.debt.asset);
    const bitassetData = await getBitassetData(position.debt.asset);
    const callOrder = callOrders.find((entry) => entry?.call_price?.quote?.asset_id === mpaAsset?.id) || null;
    const debtState = normalizeCallPosition(callOrder, mpaAsset, backingAsset, bitassetData);
    const openOrderIds = openOrders.map((entry) => entry?.id).filter(Boolean);
    const entryOrderOpen = position.entry.orderId ? openOrderIds.includes(position.entry.orderId) : false;
    const exitOrderOpen = position.exit.orderId ? openOrderIds.includes(position.exit.orderId) : false;
    const entryOpenOrder = position.entry.orderId ? openOrders.find((entry) => entry?.id === position.entry.orderId) || null : null;
    const exitOpenOrder = position.exit.orderId ? openOrders.find((entry) => entry?.id === position.exit.orderId) || null : null;

    updateOrderTrackingFromOpenOrder(position.entry, entryOpenOrder);
    updateOrderTrackingFromOpenOrder(position.exit, exitOpenOrder);
    refreshPositionPnl(position);

    position.onChain = {
      balances,
      collateralAmount: debtState.collateralAmount,
      collateralRatio: debtState.collateralRatio,
      debtAmount: debtState.debtAmount,
      debtValueInBts: debtState.debtValueInBts,
      feedPublicationTime: debtState.feedPublicationTime,
      openOrderIds,
      trackedOrders: {
        entry: {
          averageExecutionPriceInBts: position.entry.averageExecutionPriceInBts,
          fillStatus: position.entry.fillStatus,
          filledReceiveAmount: position.entry.filledReceiveAmount,
          filledSellAmount: position.entry.filledSellAmount,
          isFullyFilled: position.entry.isFullyFilled,
          orderId: position.entry.orderId,
          receiveAmountRemaining: position.entry.receiveAmountRemaining,
          sellAmountRemaining: position.entry.sellAmountRemaining
        },
        exit: {
          averageExecutionPriceInBts: position.exit.averageExecutionPriceInBts,
          fillStatus: position.exit.fillStatus,
          filledReceiveAmount: position.exit.filledReceiveAmount,
          filledSellAmount: position.exit.filledSellAmount,
          isFullyFilled: position.exit.isFullyFilled,
          orderId: position.exit.orderId,
          receiveAmountRemaining: position.exit.receiveAmountRemaining,
          sellAmountRemaining: position.exit.sellAmountRemaining
        }
      },
      syncedAt: nowIso()
    };

    if (!debtState.exists || debtState.debtAmount <= 0) {
      position.status = entryOrderOpen || exitOrderOpen ? 'orders_open_without_debt' : 'closed';
    } else if (exitOrderOpen) {
      position.status = 'take_profit_order_open';
    } else if (entryOrderOpen) {
      position.status = 'entry_order_open';
    } else {
      position.status = 'debt_open';
    }

    position.updatedAt = nowIso();
    await this.saveState();
    return clone(position);
  }

  async syncAllPositions() {
    const positions = await this.listPositions();
    const synced = [];

    for (const position of positions) {
      synced.push(await this.syncPosition(position.id));
    }

    return synced;
  }

  async watchAccount(accountName, onFill) {
    requireString(accountName, 'accountName');

      return listenForFills(accountName, async (fills = []) => {
      const state = await this.loadState();
      const relatedPositions = state.positions.filter((position) => position.accountName === accountName);
      let changed = false;
      const matchedPositionIds = new Set();

      for (const fill of fills) {
        const payload = Array.isArray(fill?.op) ? fill.op[1] : null;
        const orderId = payload?.order_id || null;
        if (!orderId) {
          continue;
        }

        for (const position of relatedPositions) {
          let matched = false;
          if (position.entry.orderId === orderId) {
            matched = updateOrderTrackingFromFill(position.entry, fill) || matched;
          }
          if (position.exit.orderId === orderId) {
            matched = updateOrderTrackingFromFill(position.exit, fill) || matched;
          }

          if (!matched) {
            continue;
          }

          refreshPositionPnl(position);
          position.updatedAt = nowIso();
          matchedPositionIds.add(position.id);
          position.events.push({
            at: position.updatedAt,
            details: {
              averageExecutionPriceInBts: position.entry.orderId === orderId
                ? position.entry.averageExecutionPriceInBts
                : position.exit.averageExecutionPriceInBts,
              fill
            },
            type: 'fill-observed'
          });
          changed = true;

          if (typeof onFill === 'function') {
            await onFill(clone(position), fill);
          }
        }
      }

      if (changed) {
        await this.saveState();

        for (const positionId of Array.from(matchedPositionIds)) {
          await this.syncPosition(positionId).catch(() => null);
        }
      }
    });
  }

  #estimateGrossPnl(position, amountToCover, buyPriceInBts) {
    const entryPrice = position?.entry?.sellPriceInBts;
    if (!Number.isFinite(entryPrice)) {
      return null;
    }
    return (entryPrice - buyPriceInBts) * amountToCover;
  }

  #findMutablePosition(state, positionId) {
    const position = state.positions.find((entry) => entry.id === positionId);
    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }
    return position;
  }
}

module.exports = {
  DEFAULT_STATE_PATH,
  PositionManager
};
