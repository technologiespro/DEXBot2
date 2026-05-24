// @ts-nocheck
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
const { describeClawBridge, createVariantDescribeFn } = require('./claw_manifest');
const {
  launcherRun,
  launcherDrystart,
  launcherReset,
  launcherDisable,
  launcherPm2Start,
  launcherPm2Stop,
  launcherPm2Delete,
  launcherPm2Restart,
  launcherPm2Reload,
} = require('./claw_launcher');
const { runMemuCommand } = require('./memu_bridge');

const { clone } = require('./utils');

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
    case 'nanobot':
      return require('./claw_manifest').describeClawBridge(options);
    case 'picoclaw':
      return require('./claw_manifest').describeClawBridge(options);
    case 'nanoclaw':
      return require('./nanoclaw_bridge').describeNanoClawBridge(options);
    case 'nullclaw':
      return require('./nullclaw_bridge').describeNullClawBridge(options);
    case 'zeroclaw':
      return require('./zeroclaw_manifest').describeZeroClawBridge(options);
    case 'memu':
      return require('./memu_bridge').describeMemuBridge(options);
    default:
      return describeClawBridge(options);
  }
}

function describeCommandManifest(options = {}) {
  const effectiveRuntimeName = options.runtimeName || options.runtime?.name || options.runtime || null;
  const normalizedRuntimeName = effectiveRuntimeName
    ? String(effectiveRuntimeName).trim().toLowerCase()
    : null;

  switch (normalizedRuntimeName) {
    case 'hermes':
      return require('./hermes_manifest').describeHermesBridge(options);
    case 'memu':
      return require('./memu_bridge').describeMemuBridge(options);
    default:
      return describeClawBridge(options);
  }
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

    case 'launcher-run':
      return launcherRun(safeOptions.botName || null, safeOptions);

    case 'launcher-drystart':
      return launcherDrystart(safeOptions.botName || null, safeOptions);

    case 'launcher-reset':
      return launcherReset(safeOptions.botName || null, safeOptions);

    case 'launcher-disable':
      return launcherDisable(safeOptions.botName || null, safeOptions);

    case 'launcher-pm2-start':
      return launcherPm2Start(safeOptions.botName || null, safeOptions);

    case 'launcher-pm2-stop':
      return launcherPm2Stop(safeOptions.botName || 'all', safeOptions);

    case 'launcher-pm2-delete':
      return launcherPm2Delete(safeOptions.botName || 'all', safeOptions);

    case 'launcher-pm2-restart':
      return launcherPm2Restart(safeOptions.botName || 'all', safeOptions);

    case 'launcher-pm2-reload':
      return launcherPm2Reload(safeOptions.botName || 'all', safeOptions);

    case 'memu-manifest':
      return require('./memu_bridge').describeMemuBridge(safeOptions);

    case 'memu-memorize': {
      if (!safeOptions.resourceUrl || !safeOptions.modality) {
        throw new Error('memu-memorize requires resourceUrl and modality');
      }
      return runMemuCommand('memorize', safeOptions);
    }

    case 'memu-retrieve': {
      if (!safeOptions.queries) {
        throw new Error('memu-retrieve requires queries');
      }
      return runMemuCommand('retrieve', safeOptions);
    }

    case 'memu-list-categories':
      return runMemuCommand('list-categories', safeOptions);

    case 'memu-list-items':
      return runMemuCommand('list-items', safeOptions);

    case 'memu-create-item': {
      if (!(safeOptions.categoryId || safeOptions.categoryName || safeOptions.category) || !safeOptions.summary) {
        throw new Error('memu-create-item requires categoryId or categoryName, plus summary');
      }
      return runMemuCommand('create-item', safeOptions);
    }

    case 'memu-update-item': {
      if (!safeOptions.itemId || !safeOptions.updates) {
        throw new Error('memu-update-item requires itemId and updates');
      }
      return runMemuCommand('update-item', safeOptions);
    }

    case 'memu-delete-item': {
      if (!safeOptions.itemId) {
        throw new Error('memu-delete-item requires itemId');
      }
      return runMemuCommand('delete-item', safeOptions);
    }

    case 'memu-clear':
      return runMemuCommand('clear', safeOptions);

    case 'memu-status':
      return runMemuCommand('status', safeOptions);

    case 'memu-memorize-conversation': {
      if (!safeOptions.messages) {
        throw new Error('memu-memorize-conversation requires messages');
      }
      return runMemuCommand('memorize-conversation', safeOptions);
    }

    case 'memu-memorize-trading-context': {
      if (!safeOptions.context) {
        throw new Error('memu-memorize-trading-context requires context');
      }
      return runMemuCommand('memorize-trading-context', safeOptions);
    }

    case 'memu-retrieve-trading-context': {
      if (!safeOptions.query) {
        throw new Error('memu-retrieve-trading-context requires query');
      }
      return runMemuCommand('retrieve-trading-context', safeOptions);
    }

    default:
      throw new Error(`Unsupported Claw command: ${command}`);
  }
}

export = {
  createClawBridge,
  describeClawBridge,
  describeRuntimeManifest,
  runClawCommand,
  createVariantBridgeModule(runtimeName, displayName, trustModel) {
    const scriptPath = `node scripts/${runtimeName}_bridge.js`;
    const describeFn = createVariantDescribeFn(runtimeName, displayName, scriptPath, trustModel);

    return {
      [`create${displayName}Bridge`]: function (options = {}) {
        return createClawBridge({
          ...options,
          runtime: {
            ...(options.runtime || {}),
            name: options.runtime?.name || `${runtimeName}-bridge`
          }
        });
      },
      [`describe${displayName}Bridge`]: describeFn,
      [`run${displayName}Command`]: function (command, options = {}) {
        if (command === 'manifest') {
          return describeFn(options);
        }
        return runClawCommand(command, {
          ...options,
          runtimeName: options.runtimeName || runtimeName
        });
      }
    };
  }
};
