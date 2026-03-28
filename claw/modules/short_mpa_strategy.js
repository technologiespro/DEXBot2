const {
  borrowMpa,
  createLimitOrder,
  repayMpaDebt
} = require('./chain_actions');
const {
  getAsset,
  getBackingAsset
} = require('./chain_queries');

const CORE_SYMBOL = 'BTS';

function requirePositiveNumber(value, fieldName) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }

  return numericValue;
}

function requireNonNegativeNumber(value, fieldName) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(`${fieldName} must be zero or a positive number`);
  }

  return numericValue;
}

async function requireBtsBackedMpa(mpaAsset) {
  const asset = await getAsset(mpaAsset);
  if (!asset) {
    throw new Error(`Asset not found: ${mpaAsset}`);
  }
  if (!asset.bitasset_data_id) {
    throw new Error(`${mpaAsset} is not a market-issued asset`);
  }

  const backingAsset = await getBackingAsset(asset.id);
  if (!backingAsset) {
    throw new Error(`Could not resolve backing asset for ${mpaAsset}`);
  }
  if (backingAsset.symbol !== CORE_SYMBOL) {
    throw new Error(`${mpaAsset} is backed by ${backingAsset.symbol}, not ${CORE_SYMBOL}`);
  }

  return {
    backingAsset,
    mpaMeta: asset
  };
}

function resolveAccountName(options = {}, { required = true } = {}) {
  const accountName = options.accountName || process.env.BITSHARES_ACCOUNT || null;
  if (required && !accountName) {
    throw new Error('accountName is required');
  }
  return accountName;
}

function withSigningOptions(options = {}) {
  const signingOptions = {
    accountName: resolveAccountName(options)
  };

  if (options.privateKey) {
    signingOptions.privateKey = options.privateKey;
  }

  return signingOptions;
}

async function buildOpenShortPlan(options = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const debtAmount = requirePositiveNumber(options.debtAmount, 'debtAmount');
  const collateralAmount = requirePositiveNumber(options.collateralAmount, 'collateralAmount');
  const sellPriceInBts = requirePositiveNumber(options.sellPriceInBts, 'sellPriceInBts');
  const { mpaMeta, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'open-short',
    collateralAsset: backingAsset.symbol,
    collateralAmount,
    debtAmount,
    expectedBtsProceeds: debtAmount * sellPriceInBts,
    market: `${mpaMeta.symbol}/${backingAsset.symbol}`,
    mpaAsset: mpaMeta.symbol,
    sellOrder: {
      amountToSell: debtAmount,
      minToReceive: debtAmount * sellPriceInBts,
      receiveAsset: backingAsset.symbol,
      sellAsset: mpaMeta.symbol
    },
    targetCollateralRatio: options.targetCollateralRatio ?? null
  };
}

async function openShortOnBts(options = {}) {
  const plan = await buildOpenShortPlan(options);
  const signingOptions = withSigningOptions(options);

  const borrowResult = await borrowMpa({
    ...signingOptions,
    collateralDelta: plan.collateralAmount,
    debtDelta: plan.debtAmount,
    mpaAsset: plan.mpaAsset,
    targetCollateralRatio: plan.targetCollateralRatio
  });

  const sellOrderResult = await createLimitOrder({
    ...signingOptions,
    amountToSell: plan.sellOrder.amountToSell,
    expiration: options.expiration,
    fillOrKill: options.fillOrKill,
    minToReceive: plan.sellOrder.minToReceive,
    receiveAsset: plan.sellOrder.receiveAsset,
    sellAsset: plan.sellOrder.sellAsset
  });

  return {
    borrowResult,
    market: plan.market,
    plan,
    sellOrderResult
  };
}

async function buildTakeProfitPlan(options = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const amountToCover = requirePositiveNumber(options.amountToCover, 'amountToCover');
  const buyPriceInBts = requirePositiveNumber(options.buyPriceInBts, 'buyPriceInBts');
  const { mpaMeta, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'place-take-profit',
    amountToCover,
    buyPriceInBts,
    market: `${mpaMeta.symbol}/${backingAsset.symbol}`,
    maxBtsToSpend: amountToCover * buyPriceInBts,
    mpaAsset: mpaMeta.symbol,
    rebuyOrder: {
      amountToSell: amountToCover * buyPriceInBts,
      minToReceive: amountToCover,
      receiveAsset: mpaMeta.symbol,
      sellAsset: backingAsset.symbol
    }
  };
}

async function placeTakeProfitBuyOrderOnBts(options = {}) {
  const plan = await buildTakeProfitPlan(options);
  const signingOptions = withSigningOptions(options);

  const rebuyOrderResult = await createLimitOrder({
    ...signingOptions,
    amountToSell: plan.rebuyOrder.amountToSell,
    expiration: options.expiration,
    fillOrKill: options.fillOrKill,
    minToReceive: plan.rebuyOrder.minToReceive,
    receiveAsset: plan.rebuyOrder.receiveAsset,
    sellAsset: plan.rebuyOrder.sellAsset
  });

  return {
    market: plan.market,
    plan,
    rebuyOrderResult
  };
}

async function buildCloseShortPlan(options = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const amountToRepay = requirePositiveNumber(options.amountToRepay, 'amountToRepay');
  const releaseCollateralDelta = options.releaseCollateralDelta === undefined
    ? 0
    : requireNonNegativeNumber(options.releaseCollateralDelta, 'releaseCollateralDelta');
  const { mpaMeta, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'close-short',
    collateralAsset: backingAsset.symbol,
    market: `${mpaMeta.symbol}/${backingAsset.symbol}`,
    mpaAsset: mpaMeta.symbol,
    releaseCollateralDelta,
    repayAmount: amountToRepay,
    targetCollateralRatio: options.targetCollateralRatio ?? null
  };
}

async function closeShortOnBts(options = {}) {
  const plan = await buildCloseShortPlan(options);
  const signingOptions = withSigningOptions(options);

  const repayResult = await repayMpaDebt({
    ...signingOptions,
    amountToRepay: plan.repayAmount,
    collateralDelta: -plan.releaseCollateralDelta,
    mpaAsset: plan.mpaAsset,
    targetCollateralRatio: plan.targetCollateralRatio
  });

  return {
    market: plan.market,
    plan,
    repayResult
  };
}

module.exports = {
  buildCloseShortPlan,
  buildOpenShortPlan,
  buildTakeProfitPlan,
  closeShortOnBts,
  openShortOnBts,
  placeTakeProfitBuyOrderOnBts
};
