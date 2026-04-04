const { createClawInfrastructure } = require('./claw_infra');
const {
  adjustMpaCollateral,
  borrowMpa,
  cancelLimitOrder,
  createLimitOrder,
  executeBatch,
  getMpaPosition,
  getOpenOrders,
  repayMpaDebt,
  buildUpdateLimitOrderOperation,
  updateLimitOrder,
  settleMpa
} = require('./chain_actions');
const {
  buildCloseShortPlan,
  buildOpenShortPlan,
  buildTakeProfitPlan,
  closeShortOnBts,
  openShortOnBts,
  placeTakeProfitBuyOrderOnBts
} = require('./short_mpa_strategy');
const { describeClawBridge } = require('./claw_manifest');

function clone(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function stripPrivateKey(options = {}) {
  const sanitized = { ...options };
  delete sanitized.privateKey;
  return sanitized;
}

function splitPair(pairValue) {
  if (typeof pairValue !== 'string' || !pairValue.includes('/')) {
    throw new Error('pair must be provided as BASE/QUOTE');
  }

  const [baseSymbol, quoteSymbol] = pairValue.split('/');
  if (!baseSymbol || !quoteSymbol) {
    throw new Error('pair must be provided as BASE/QUOTE');
  }

  return {
    baseSymbol: baseSymbol.trim(),
    quoteSymbol: quoteSymbol.trim()
  };
}

function getProfileContextRef(options = {}) {
  return options.botRef || options.identifier || options.botId || options.pair || null;
}

function getBotSettingsPatch(options = {}) {
  if (!options.patch || typeof options.patch !== 'object' || Array.isArray(options.patch)) {
    throw new Error('bot-settings-preview and bot-settings-apply require a patch object');
  }

  return options.patch;
}

function createClawBridge(options = {}) {
  const sanitizedOptions = stripPrivateKey(options);
  const runtimeName = sanitizedOptions.runtimeName
    || sanitizedOptions.runtime?.name
    || 'claw-bridge';

  return createClawInfrastructure({
    ...sanitizedOptions,
    runtime: {
      ...(sanitizedOptions.runtime || {}),
      name: runtimeName
    }
  });
}

function describeRuntimeManifest(options = {}) {
  const effectiveRuntimeName = options.runtimeName || options.runtime?.name || options.runtime || null;
  const normalizedRuntimeName = effectiveRuntimeName
    ? String(effectiveRuntimeName).trim().toLowerCase()
    : null;

  switch (normalizedRuntimeName) {
    case 'hermes':
      return require('./hermes_manifest').describeHermesBridge(options);
    case 'openclaw':
      return require('./openclaw_manifest').describeOpenClawBridge(options);
    case 'openfang':
      return require('./openfang_bridge').describeOpenFangBridge(options);
    case 'nanoclaw':
      return require('./nanoclaw_bridge').describeNanoClawBridge(options);
    case 'nullclaw':
      return require('./nullclaw_bridge').describeNullClawBridge(options);
    case 'zeroclaw':
      return require('./zeroclaw_manifest').describeZeroClawBridge(options);
    default:
      return describeClawBridge(options);
  }
}

function describeCommandManifest(options = {}) {
  const effectiveRuntimeName = options.runtimeName || options.runtime?.name || options.runtime || null;
  const normalizedRuntimeName = effectiveRuntimeName
    ? String(effectiveRuntimeName).trim().toLowerCase()
    : null;

  if (normalizedRuntimeName === 'hermes') {
    return require('./hermes_manifest').describeHermesBridge(options);
  }

  return describeClawBridge(options);
}

async function runClawCommand(command, options = {}) {
  const safeOptions = stripPrivateKey(options);
  if (command === 'manifest') {
    return describeCommandManifest(safeOptions);
  }

  const bridge = createClawBridge(safeOptions);
  const accountName = safeOptions.accountName || bridge.runtime.accountName || null;

  switch (command) {
    case 'runtime':
      return clone(bridge.runtime);

    case 'profile-context':
      return bridge.profiles.getClawProfileContext(
        safeOptions.botRef || safeOptions.identifier || safeOptions.botId || safeOptions.pair || null,
        safeOptions
      );

    case 'market-snapshot': {
      const pair = safeOptions.pair ? splitPair(safeOptions.pair) : null;
      const baseSymbol = safeOptions.baseSymbol || pair?.baseSymbol;
      const quoteSymbol = safeOptions.quoteSymbol || pair?.quoteSymbol;

      if (!baseSymbol || !quoteSymbol) {
        throw new Error('market-snapshot requires baseSymbol/quoteSymbol or pair');
      }

      return bridge.market.readMarketSnapshot(baseSymbol, quoteSymbol, Number(safeOptions.limit) || 10);
    }

    case 'account-snapshot':
      return bridge.market.readAccountSnapshot(safeOptions.accountName || safeOptions.accountRef || accountName);

    case 'open-orders':
      return getOpenOrders(safeOptions.accountName || safeOptions.accountRef || accountName);

    case 'bot-settings':
      return bridge.profiles.getBotSettings(
        getProfileContextRef(safeOptions),
        Boolean(safeOptions.forceReload)
      );

    case 'bot-settings-preview':
      return bridge.profiles.previewBotSettingsUpdate(
        getProfileContextRef(safeOptions),
        getBotSettingsPatch(safeOptions),
        safeOptions
      );

    case 'bot-settings-apply':
      return bridge.profiles.applyBotSettingsPatch(
        getProfileContextRef(safeOptions),
        getBotSettingsPatch(safeOptions),
        safeOptions
      );

    case 'honest-context':
      return bridge.honest.buildContext({
        batchSize: Number(safeOptions.batchSize) || undefined,
        discoverPairs: Array.isArray(safeOptions.discoverPairs) ? safeOptions.discoverPairs : undefined,
        maxPages: Number(safeOptions.maxPages) || undefined,
        prefix: safeOptions.prefix,
        startSymbol: safeOptions.startSymbol
      });

    case 'honest-pair': {
      const pair = safeOptions.pair ? splitPair(safeOptions.pair) : null;
      const assetA = safeOptions.assetA || pair?.baseSymbol;
      const assetB = safeOptions.assetB || pair?.quoteSymbol;

      if (!assetA || !assetB) {
        throw new Error('honest-pair requires assetA/assetB or pair');
      }

      return bridge.honest.resolvePairContext(assetA, assetB, safeOptions);
    }

    case 'honest-price': {
      const pair = safeOptions.pair ? splitPair(safeOptions.pair) : null;
      const assetA = safeOptions.assetA || pair?.baseSymbol;
      const assetB = safeOptions.assetB || pair?.quoteSymbol;

      if (!assetA || !assetB) {
        throw new Error('honest-price requires assetA/assetB or pair');
      }

      return bridge.honest.resolvePairPrice(assetA, assetB, safeOptions);
    }

    case 'create-limit-order':
      return createLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'cancel-limit-order':
      return cancelLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'build-update-limit-order-op':
      return buildUpdateLimitOrderOperation({
        ...safeOptions,
        accountName
      });

    case 'update-limit-order':
      return updateLimitOrder({
        ...safeOptions,
        accountName
      });

    case 'execute-batch':
      return executeBatch({
        ...safeOptions,
        accountName
      });

    case 'borrow-mpa':
      return borrowMpa({
        ...safeOptions,
        accountName
      });

    case 'repay-mpa':
      return repayMpaDebt({
        ...safeOptions,
        accountName
      });

    case 'adjust-mpa-collateral':
      return adjustMpaCollateral({
        ...safeOptions,
        accountName
      });

    case 'settle-mpa':
      return settleMpa({
        ...safeOptions,
        accountName
      });

    case 'open-short-bts':
      return openShortOnBts({
        ...safeOptions,
        accountName
      });

    case 'take-profit-bts':
      return placeTakeProfitBuyOrderOnBts({
        ...safeOptions,
        accountName
      });

    case 'close-short-bts':
      return closeShortOnBts({
        ...safeOptions,
        accountName
      });

    case 'build-open-short-plan':
      return buildOpenShortPlan({
        ...safeOptions,
        accountName
      });

    case 'build-take-profit-plan':
      return buildTakeProfitPlan({
        ...safeOptions,
        accountName
      });

    case 'build-close-short-plan':
      return buildCloseShortPlan({
        ...safeOptions,
        accountName
      });

    case 'mpa-position':
      return getMpaPosition(safeOptions.accountName || safeOptions.accountRef || accountName, safeOptions.mpaAsset);

    default:
      throw new Error(`Unsupported Claw command: ${command}`);
  }
}

module.exports = {
  createClawBridge,
  describeClawBridge,
  describeRuntimeManifest,
  runClawCommand
};
