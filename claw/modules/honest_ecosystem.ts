// @ts-nocheck
const { getAsset, getBackingAsset, getBitassetData, getCallOrders, listAssets } = require('./chain_queries');
const { derivePoolPrice } = require('./liquidity_pools');

const REFERENCE_SYMBOL = 'HONEST.MONEY';
const CORE_SYMBOL = 'BTS';
const DEFAULT_PREFIX = 'HONEST.';
const HARDCODED_HONEST_MONEY_BTS_POOL = {
  assetA: {
    amount: 29854.8782,
    symbol: CORE_SYMBOL
  },
  assetB: {
    amount: 70846.22383703,
    symbol: REFERENCE_SYMBOL
  },
  id: '1.19.305',
  poolSymbol: 'honest.BTSMONEY',
  takerFeePercent: 0.4,
  withdrawalFeePercent: 0
};

const { clone } = require('./utils');

function isMpa(asset) {
  return Boolean(asset && asset.bitasset_data_id);
}

function isHonestAsset(asset) {
  return typeof asset?.symbol === 'string' && asset.symbol.startsWith(DEFAULT_PREFIX);
}

function getHardcodedHonestMoneyBridge() {
  const core = HARDCODED_HONEST_MONEY_BTS_POOL.assetA;
  const honestMoney = HARDCODED_HONEST_MONEY_BTS_POOL.assetB;
  const latestHonestMoneyPerBts = Number(core.amount) > 0 ? honestMoney.amount / core.amount : null;

  return {
    liquidityPool: {
      id: HARDCODED_HONEST_MONEY_BTS_POOL.id,
      poolSymbol: HARDCODED_HONEST_MONEY_BTS_POOL.poolSymbol,
      reserves: [
        clone(HARDCODED_HONEST_MONEY_BTS_POOL.assetA),
        clone(HARDCODED_HONEST_MONEY_BTS_POOL.assetB)
      ],
      source: 'hardcoded-liquidity-pool',
      takerFeePercent: HARDCODED_HONEST_MONEY_BTS_POOL.takerFeePercent,
      withdrawalFeePercent: HARDCODED_HONEST_MONEY_BTS_POOL.withdrawalFeePercent
    },
    latestHonestMoneyPerBts,
    market: `${REFERENCE_SYMBOL}/${CORE_SYMBOL}`,
    source: 'hardcoded-liquidity-pool'
  };
}

function isHardcodedHonestMoneyBtsPair(assetA, assetB) {
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;

  return (
    (assetASymbol === REFERENCE_SYMBOL && assetBSymbol === CORE_SYMBOL) ||
    (assetASymbol === CORE_SYMBOL && assetBSymbol === REFERENCE_SYMBOL)
  );
}

function resolveHardcodedHonestMoneyPrice(assetA, assetB) {
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;
  const bridge = getHardcodedHonestMoneyBridge();
  const bridgePrice = bridge.latestHonestMoneyPerBts;

  if (!Number.isFinite(bridgePrice) || bridgePrice <= 0) {
    return null;
  }

  if (assetASymbol === REFERENCE_SYMBOL && assetBSymbol === CORE_SYMBOL) {
    return bridgePrice;
  }

  if (assetASymbol === CORE_SYMBOL && assetBSymbol === REFERENCE_SYMBOL) {
    return 1 / bridgePrice;
  }

  return null;
}

async function resolveHonestPairPrice(assetA, assetB, options = {}) {
  const hardcoded = resolveHardcodedHonestMoneyPrice(assetA, assetB);
  if (hardcoded !== null) {
    return hardcoded;
  }

  return derivePoolPrice(assetA, assetB, options);
}

async function resolveHonestPairContext(assetA, assetB, options = {}) {
  const pairPrice = await resolveHonestPairPrice(assetA, assetB, options).catch(() => null);
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;

  if (!isHardcodedHonestMoneyBtsPair(assetA, assetB)) {
    return {
      assetA: {
        symbol: assetASymbol
      },
      assetB: {
        symbol: assetBSymbol
      },
      priceBPerA: pairPrice,
      source: pairPrice === null ? 'unresolved' : 'dexbot2-derivePoolPrice'
    };
  }

  const bridge = getHardcodedHonestMoneyBridge();
  const assetAEntry = bridge.liquidityPool.reserves.find((entry) => entry.symbol === assetASymbol) || null;
  const assetBEntry = bridge.liquidityPool.reserves.find((entry) => entry.symbol === assetBSymbol) || null;

  return {
    assetA: {
      id: assetASymbol === CORE_SYMBOL ? '1.3.0' : null,
      precision: null,
      symbol: assetASymbol
    },
    assetB: {
      id: assetBSymbol === CORE_SYMBOL ? '1.3.0' : null,
      precision: null,
      symbol: assetBSymbol
    },
    pool: {
      ...bridge.liquidityPool,
      source: 'hardcoded-liquidity-pool'
    },
    priceBPerA: pairPrice,
    reserveA: assetAEntry ? assetAEntry.amount : null,
    reserveB: assetBEntry ? assetBEntry.amount : null,
    source: 'hardcoded-liquidity-pool'
  };
}

async function loadHonestAssets({ prefix = DEFAULT_PREFIX, batchSize = 100, maxPages = 100, startSymbol = DEFAULT_PREFIX } = {}) {
  const all = [];
  let lowerBound = startSymbol;
  let previousLastSymbol = null;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await listAssets(lowerBound, batchSize);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    let pageItems = batch.filter(Boolean);
    if (previousLastSymbol && pageItems[0]?.symbol === previousLastSymbol) {
      pageItems = pageItems.slice(1);
    }

    if (pageItems.length === 0) {
      break;
    }

    const matching = pageItems.filter((asset) => isHonestAsset(asset) && asset.symbol.startsWith(prefix));
    all.push(...matching);

    previousLastSymbol = pageItems[pageItems.length - 1].symbol;
    lowerBound = previousLastSymbol;

    if (batch.length < batchSize) {
      break;
    }
  }

  const mpas = [];
  for (const asset of all) {
    if (!isMpa(asset)) {
      continue;
    }

    const backingAsset = await getBackingAsset(asset.id).catch(() => null);
    const callOrders = await getCallOrders(asset.id, 20).catch(() => []);
    const bitassetData = await getBitassetData(asset.id).catch(() => null);
    mpas.push({
      backingAsset: backingAsset ? {
        id: backingAsset.id,
        precision: backingAsset.precision,
        symbol: backingAsset.symbol
      } : null,
      callOrdersCount: Array.isArray(callOrders) ? callOrders.length : 0,
      currentFeedPublicationTime: bitassetData?.current_feed_publication_time || null,
      id: asset.id,
      precision: asset.precision,
      symbol: asset.symbol
    });
  }

  return {
    assets: all,
    mpas
  };
}

async function buildHonestEcosystemContext(options = {}) {
  const prefix = options.prefix || DEFAULT_PREFIX;
  const [coreAsset, referenceAsset] = await Promise.all([
    getAsset(CORE_SYMBOL),
    getAsset(REFERENCE_SYMBOL)
  ]);

  if (!coreAsset || !referenceAsset) {
    throw new Error(`Could not resolve ${CORE_SYMBOL} or ${REFERENCE_SYMBOL}`);
  }

  const honestAssets = await loadHonestAssets({
    batchSize: options.batchSize,
    maxPages: options.maxPages,
    prefix,
    startSymbol: options.startSymbol || prefix
  });

  const requestedPairs = Array.isArray(options.discoverPairs) ? options.discoverPairs : [];
  const pairContexts = [];
  for (const pair of requestedPairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      continue;
    }

    const context = await resolveHonestPairContext(pair[0], pair[1], options).catch(() => null);
    if (context) {
      pairContexts.push(context);
    }
  }

  return {
    assets: honestAssets.assets.map((asset) => ({
      id: asset.id,
      precision: asset.precision,
      symbol: asset.symbol,
      type: isMpa(asset) ? 'MPA' : 'ASSET'
    })),
    bridge: getHardcodedHonestMoneyBridge(),
    pairContexts,
    mpas: honestAssets.mpas,
    referenceAsset: {
      id: referenceAsset.id,
      precision: referenceAsset.precision,
      symbol: referenceAsset.symbol
    },
    scope: {
      prefix
    },
    summary: {
      assetCount: honestAssets.assets.length,
      pairContextCount: pairContexts.length,
      mpaCount: honestAssets.mpas.length
    }
  };
}

function createHonestEcosystemAdapter(options = {}) {
  return {
    buildContext: (contextOptions = {}) => buildHonestEcosystemContext({
      ...options,
      ...contextOptions
    }),
    getHardcodedHonestMoneyBridge,
    loadAssets: (assetOptions = {}) => loadHonestAssets({
      ...options,
      ...assetOptions
    }),
    resolvePairContext: (assetA, assetB, contextOptions = {}) => resolveHonestPairContext(assetA, assetB, {
      ...options,
      ...contextOptions
    }),
    resolvePairPrice: (assetA, assetB, priceOptions = {}) => resolveHonestPairPrice(assetA, assetB, {
      ...options,
      ...priceOptions
    }),
    resolveHardcodedHonestMoneyPrice
  };
}

export = {
  CORE_SYMBOL,
  DEFAULT_PREFIX,
  REFERENCE_SYMBOL,
  buildHonestEcosystemContext,
  createHonestEcosystemAdapter,
  getHardcodedHonestMoneyBridge,
  loadHonestAssets,
  isHardcodedHonestMoneyBtsPair,
  resolveHardcodedHonestMoneyPrice,
  resolveHonestPairContext,
  resolveHonestPairPrice
};
