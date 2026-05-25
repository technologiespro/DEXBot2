function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

const SUPPORTED_RUNTIMES = ['openclaw', 'hermes', 'openfang', 'nanobot', 'picoclaw', 'nanoclaw', 'zeroclaw', 'nullclaw', 'memu'];

function stringSchema(description?: string) {
  return {
    type: 'string',
    ...(description ? { description } : {})
  };
}

function numberSchema(description?: string) {
  return {
    type: 'number',
    ...(description ? { description } : {})
  };
}

function numberOrStringSchema(description = null) {
  return {
    oneOf: [
      numberSchema(),
      stringSchema()
    ],
    ...(description ? { description } : {})
  };
}

function numberOrStringOrNullSchema(description = null) {
  return {
    oneOf: [
      { type: 'null' },
      numberSchema(),
      stringSchema()
    ],
    ...(description ? { description } : {})
  };
}

function integerSchema(description) {
  return {
    type: 'integer',
    ...(description ? { description } : {})
  };
}

function booleanSchema(description) {
  return {
    type: 'boolean',
    ...(description ? { description } : {})
  };
}

function stringArraySchema(description) {
  return {
    type: 'array',
    items: { type: 'string' },
    ...(description ? { description } : {})
  };
}

function pairArraySchema(description) {
  return {
    type: 'array',
    items: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2
    },
    ...(description ? { description } : {})
  };
}

function objectSchema(properties = {}, required = [], description = null) {
  return {
    type: 'object',
    additionalProperties: true,
    properties,
    required,
    ...(description ? { description } : {})
  };
}

function strictObjectSchema(properties = {}, required = [], description = null) {
  return {
    ...objectSchema(properties, required, description),
    additionalProperties: false
  };
}

function memuScopeSchema(description = null) {
  return objectSchema({
    user_id: stringSchema('Optional memU user scope id')
  }, [], description || 'Optional memU scope filter');
}


function botSettingsSelectorSchema(description = null) {
  return objectSchema({
    botId: stringSchema('Explicit bot id'),
    botRef: stringSchema('Bot reference in DEXBot2 profiles'),
    forceReload: booleanSchema('Force a fresh profile reload'),
    identifier: stringSchema('Generic profile identifier'),
    pair: stringSchema('Trading pair such as BTS/USD'),
    profileRoot: stringSchema('Optional DEXBot2 profile root')
  }, [], description);
}

function botSettingsPatchSchema(description = null) {
  return objectSchema({
    patch: strictObjectSchema({
      active: booleanSchema('Whether the bot is active'),
      activeOrders: strictObjectSchema({
        buy: integerSchema('Buy-side active order count'),
        sell: integerSchema('Sell-side active order count')
      }, [], 'Per-side active order counts'),
      assetA: stringSchema('Base asset symbol'),
      assetAId: stringSchema('Base asset id'),
      assetB: stringSchema('Quote asset symbol'),
      assetBId: stringSchema('Quote asset id'),
      botFunds: strictObjectSchema({
        buy: numberOrStringSchema('Buy-side fund allocation as a number or percentage string'),
        sell: numberOrStringSchema('Sell-side fund allocation as a number or percentage string')
      }, [], 'Per-side fund allocation'),
      dryRun: booleanSchema('Simulate instead of broadcasting'),
      gridPrice: numberOrStringOrNullSchema('Grid reference price mode or numeric value'),
      incrementPercent: numberSchema('Geometric step between grid levels'),
      maxPrice: numberOrStringSchema('Maximum grid bound'),
      minPrice: numberOrStringSchema('Minimum grid bound'),
      name: stringSchema('Friendly bot name'),
      preferredAccount: stringSchema('Preferred BitShares account'),
      startPrice: numberOrStringSchema('Initial grid reference price'),
      strategy: stringSchema('Strategy label'),
      targetSpreadPercent: numberSchema('Width of the empty spread zone'),
      weightDistribution: strictObjectSchema({
        buy: numberSchema('Buy-side weight'),
        sell: numberSchema('Sell-side weight')
      }, [], 'Per-side weight distribution'),
    }, [], 'Partial bot settings patch'),
    trigger: booleanSchema('Write a recalc trigger after applying the patch'),
    triggerPayload: objectSchema({}, [], 'Optional trigger payload'),
    triggerReason: stringSchema('Optional trigger reason'),
    botId: stringSchema('Explicit bot id'),
    botRef: stringSchema('Bot reference in DEXBot2 profiles'),
    forceReload: booleanSchema('Force a fresh profile reload'),
    identifier: stringSchema('Generic profile identifier'),
    pair: stringSchema('Trading pair such as BTS/USD'),
    profileRoot: stringSchema('Optional DEXBot2 profile root')
  }, ['patch'], description);
}

function createToolDefinition(definition) {
  return Object.freeze({
    risk: 'read',
    runtimes: SUPPORTED_RUNTIMES,
    surface: 'bridge',
    inputSchema: objectSchema(),
    ...definition
  });
}

const CLAW_TOOL_CATALOG = Object.freeze([
  createToolDefinition({
    command: 'manifest',
    description: 'Inspect the Claw bridge surface',
    exampleArgs: [],
    inputSchema: objectSchema({
      accountName: stringSchema('Optional default BitShares account name'),
      profileRoot: stringSchema('Optional DEXBot2 profile root'),
      runtimeName: stringSchema('Optional target runtime name'),
      socketPath: stringSchema('Optional DEXBot2 credential daemon socket path')
    }),
    toolName: 'claw_manifest'
  }),
  createToolDefinition({
    command: 'runtime',
    description: 'Inspect the runtime context',
    inputSchema: objectSchema({
      accountName: stringSchema('Optional default BitShares account name'),
      profileRoot: stringSchema('Optional DEXBot2 profile root'),
      socketPath: stringSchema('Optional DEXBot2 credential daemon socket path')
    }),
    toolName: 'claw_runtime'
  }),
  createToolDefinition({
    command: 'profile-context',
    description: 'Load Claw profile context',
    args: {
      payload_json: 'JSON object with optional botRef, identifier, botId, or pair'
    },
    exampleArgs: ['--payload', '{"botRef":"default"}'],
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botRef: stringSchema('Bot reference in DEXBot2 profiles'),
      identifier: stringSchema('Generic profile identifier'),
      botId: stringSchema('Explicit bot id'),
      pair: stringSchema('Trading pair such as BTS/USD'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }),
    toolName: 'claw_profile_context'
  }),
  createToolDefinition({
    command: 'market-snapshot',
    description: 'Fetch a market snapshot',
    args: {
      payload_json: 'JSON object with baseSymbol and quoteSymbol, or pair, and optional limit'
    },
    exampleArgs: ['--payload', '{"baseSymbol":"BTS","quoteSymbol":"USD"}'],
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      baseSymbol: stringSchema('Base asset symbol'),
      quoteSymbol: stringSchema('Quote asset symbol'),
      pair: stringSchema('Trading pair such as BTS/USD'),
      limit: integerSchema('Optional orderbook depth limit')
    }),
    toolName: 'claw_market_snapshot'
  }),
  createToolDefinition({
    command: 'account-snapshot',
    description: 'Read an account snapshot with balances and open orders',
    args: {
      account_name: 'BitShares account name or id'
    },
    extraArgs: ['--account', '{{account_name}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name or id'),
      accountRef: stringSchema('Alternate account reference')
    }),
    toolName: 'claw_account_snapshot'
  }),
  createToolDefinition({
    command: 'open-orders',
    description: 'Read open orders for an account',
    args: {
      account_name: 'BitShares account name or id'
    },
    extraArgs: ['--account', '{{account_name}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name or id'),
      accountRef: stringSchema('Alternate account reference')
    }),
    toolName: 'claw_open_orders'
  }),
  createToolDefinition({
    command: 'bot-settings',
    description: 'Read a normalized DEXBot2 bot settings view',
    exampleArgs: ['--payload', '{"botRef":"default"}'],
    args: {
      payload_json: 'JSON object with botRef, identifier, botId, or pair'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: botSettingsSelectorSchema('Selector for a DEXBot2 bot'),
    toolName: 'claw_bot_settings'
  }),
  createToolDefinition({
    command: 'bot-settings-preview',
    description: 'Preview a DEXBot2 bot settings patch without writing it',
    exampleArgs: ['--payload', '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'],
    args: {
      payload_json: 'JSON object with botRef, identifier, botId, or pair, plus a patch object'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: botSettingsPatchSchema('Selector plus a partial bot settings patch'),
    risk: 'plan',
    toolName: 'claw_bot_settings_preview'
  }),
  createToolDefinition({
    command: 'bot-settings-apply',
    description: 'Apply a DEXBot2 bot settings patch and optionally write a trigger',
    exampleArgs: ['--payload', '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'],
    args: {
      payload_json: 'JSON object with botRef, identifier, botId, or pair, plus a patch object'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: botSettingsPatchSchema('Selector plus a partial bot settings patch'),
    risk: 'execute',
    toolName: 'claw_bot_settings_apply'
  }),
  createToolDefinition({
    command: 'honest-context',
    description: 'Inspect HONEST asset and pair context',
    args: {
      payload_json: 'JSON object with optional prefix, batchSize, discoverPairs, maxPages, startSymbol'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      prefix: stringSchema('Optional HONEST prefix filter'),
      batchSize: integerSchema('Optional page size'),
      discoverPairs: pairArraySchema('Optional pairs to resolve in context'),
      maxPages: integerSchema('Optional maximum pagination pages'),
      startSymbol: stringSchema('Optional starting symbol for scanning')
    }),
    toolName: 'claw_honest_context'
  }),
  createToolDefinition({
    command: 'honest-pair',
    description: 'Resolve HONEST pair context',
    args: {
      payload_json: 'JSON object with assetA and assetB, or pair'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      assetA: stringSchema('First asset symbol'),
      assetB: stringSchema('Second asset symbol'),
      pair: stringSchema('Pair such as HONEST.USD/BTS')
    }),
    toolName: 'claw_honest_pair'
  }),
  createToolDefinition({
    command: 'honest-price',
    description: 'Resolve HONEST pair price',
    args: {
      payload_json: 'JSON object with assetA and assetB, or pair'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      assetA: stringSchema('First asset symbol'),
      assetB: stringSchema('Second asset symbol'),
      pair: stringSchema('Pair such as HONEST.USD/BTS')
    }),
    toolName: 'claw_honest_price'
  }),
  createToolDefinition({
    command: 'create-limit-order',
    description: 'Create a BitShares limit order',
    exampleArgs: ['--payload', '{"accountName":"alice","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'],
    args: {
      payload_json:
        'JSON object with accountName, sellAsset, receiveAsset, amountToSell, minToReceive, optional expiration, optional fillOrKill'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      sellAsset: stringSchema('Asset being sold'),
      receiveAsset: stringSchema('Asset to receive'),
      amountToSell: numberSchema('Amount to sell'),
      minToReceive: numberSchema('Minimum amount to receive'),
      expiration: stringSchema('Optional expiration timestamp'),
      fillOrKill: booleanSchema('Whether the order should fill-or-kill')
    }, ['sellAsset', 'receiveAsset', 'amountToSell', 'minToReceive']),
    risk: 'execute',
    toolName: 'claw_create_limit_order'
  }),
  createToolDefinition({
    command: 'cancel-limit-order',
    description: 'Cancel a BitShares limit order',
    args: {
      payload_json: 'JSON object with accountName and orderId'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      orderId: stringSchema('Order id such as 1.7.123')
    }, ['orderId']),
    risk: 'execute',
    toolName: 'claw_cancel_limit_order'
  }),
  createToolDefinition({
    command: 'build-update-limit-order-op',
    description: 'Build a BitShares limit order update operation',
    args: {
      payload_json:
        'JSON object with accountName, orderId, and newParams or direct amountToSell/minToReceive/newPrice fields'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      orderId: stringSchema('Order id such as 1.7.123'),
      amountToSell: numberSchema('Optional replacement sell amount'),
      minToReceive: numberSchema('Optional replacement minimum receive amount'),
      newPrice: numberSchema('Optional replacement price'),
      newParams: objectSchema({}, [], 'Optional parameter object for advanced updates')
    }, ['orderId']),
    risk: 'plan',
    toolName: 'claw_build_update_limit_order_op'
  }),
  createToolDefinition({
    command: 'update-limit-order',
    description: 'Update a BitShares limit order',
    exampleArgs: ['--payload', '{"accountName":"alice","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'],
    args: {
      payload_json:
        'JSON object with accountName, orderId, and newParams or direct amountToSell/minToReceive/newPrice fields'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      orderId: stringSchema('Order id such as 1.7.123'),
      amountToSell: numberSchema('Optional replacement sell amount'),
      minToReceive: numberSchema('Optional replacement minimum receive amount'),
      newPrice: numberSchema('Optional replacement price'),
      newParams: objectSchema({}, [], 'Optional parameter object for advanced updates')
    }, ['orderId']),
    risk: 'execute',
    toolName: 'claw_update_limit_order'
  }),
  createToolDefinition({
    command: 'execute-batch',
    description: 'Execute a batch of BitShares operations',
    args: {
      payload_json: 'JSON object with operations array and optional accountName'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      operations: {
        type: 'array',
        description: 'BitShares operation objects',
        items: objectSchema()
      }
    }, ['operations']),
    risk: 'execute',
    toolName: 'claw_execute_batch'
  }),
  createToolDefinition({
    command: 'borrow-mpa',
    description: 'Borrow against an MPA position',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, debtDelta, collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      debtDelta: numberSchema('Debt amount change'),
      collateralDelta: numberSchema('Collateral amount change'),
      targetCollateralRatio: numberSchema('Optional target collateral ratio')
    }, ['mpaAsset', 'debtDelta', 'collateralDelta']),
    risk: 'execute',
    toolName: 'claw_borrow_mpa'
  }),
  createToolDefinition({
    command: 'repay-mpa',
    description: 'Repay MPA debt',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amountToRepay: numberSchema('Amount of debt to repay'),
      collateralDelta: numberSchema('Optional collateral adjustment'),
      targetCollateralRatio: numberSchema('Optional target collateral ratio')
    }, ['mpaAsset', 'amountToRepay']),
    risk: 'execute',
    toolName: 'claw_repay_mpa'
  }),
  createToolDefinition({
    command: 'adjust-mpa-collateral',
    description: 'Adjust MPA collateral',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      collateralDelta: numberSchema('Collateral amount change'),
      targetCollateralRatio: numberSchema('Optional target collateral ratio')
    }, ['mpaAsset', 'collateralDelta']),
    risk: 'execute',
    toolName: 'claw_adjust_mpa_collateral'
  }),
  createToolDefinition({
    command: 'settle-mpa',
    description: 'Settle an MPA position',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amount'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amount: numberSchema('Amount to settle')
    }, ['mpaAsset', 'amount']),
    risk: 'execute',
    toolName: 'claw_settle_mpa'
  }),
  createToolDefinition({
    command: 'open-short-bts',
    description: 'Build and execute the open leg of a BTS-backed short',
    args: {
      payload_json:
        'JSON object with accountName, mpaAsset, debtAmount, collateralAmount, sellPriceInBts, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      debtAmount: numberSchema('Debt amount to borrow'),
      collateralAmount: numberSchema('Collateral to lock'),
      sellPriceInBts: numberSchema('Sell price in BTS'),
      targetCollateralRatio: numberSchema('Optional target collateral ratio')
    }, ['mpaAsset', 'debtAmount', 'collateralAmount', 'sellPriceInBts']),
    risk: 'execute',
    toolName: 'claw_open_short_bts'
  }),
  createToolDefinition({
    command: 'take-profit-bts',
    description: 'Place the take-profit leg for a BTS-backed short',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToCover, buyPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amountToCover: numberSchema('Amount to cover'),
      buyPriceInBts: numberSchema('Buy price in BTS')
    }, ['mpaAsset', 'amountToCover', 'buyPriceInBts']),
    risk: 'execute',
    toolName: 'claw_take_profit_bts'
  }),
  createToolDefinition({
    command: 'close-short-bts',
    description: 'Close a BTS-backed short',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional releaseCollateralDelta'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amountToRepay: numberSchema('Debt amount to repay'),
      releaseCollateralDelta: numberSchema('Optional collateral release amount')
    }, ['mpaAsset', 'amountToRepay']),
    risk: 'execute',
    toolName: 'claw_close_short_bts'
  }),
  createToolDefinition({
    command: 'build-open-short-plan',
    description: 'Build the open-short plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, debtAmount, collateralAmount, sellPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      debtAmount: numberSchema('Debt amount to borrow'),
      collateralAmount: numberSchema('Collateral to lock'),
      sellPriceInBts: numberSchema('Sell price in BTS')
    }, ['mpaAsset', 'debtAmount', 'collateralAmount', 'sellPriceInBts']),
    risk: 'plan',
    toolName: 'claw_build_open_short_plan'
  }),
  createToolDefinition({
    command: 'build-take-profit-plan',
    description: 'Build the take-profit plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToCover, buyPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amountToCover: numberSchema('Amount to cover'),
      buyPriceInBts: numberSchema('Buy price in BTS')
    }, ['mpaAsset', 'amountToCover', 'buyPriceInBts']),
    risk: 'plan',
    toolName: 'claw_build_take_profit_plan'
  }),
  createToolDefinition({
    command: 'build-close-short-plan',
    description: 'Build the close-short plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional releaseCollateralDelta'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      mpaAsset: stringSchema('MPA asset symbol'),
      amountToRepay: numberSchema('Debt amount to repay'),
      releaseCollateralDelta: numberSchema('Optional collateral release amount')
    }, ['mpaAsset', 'amountToRepay']),
    risk: 'plan',
    toolName: 'claw_build_close_short_plan'
  }),
  createToolDefinition({
    command: 'mpa-position',
    description: 'Read the on-chain MPA position for an account',
    args: {
      payload_json: 'JSON object with accountName and mpaAsset'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      accountName: stringSchema('BitShares account name'),
      accountRef: stringSchema('Alternate account reference'),
      mpaAsset: stringSchema('MPA asset symbol')
    }, ['mpaAsset']),
    toolName: 'claw_mpa_position'
  }),
  createToolDefinition({
    command: 'launcher-run',
    description: 'Start/run bots with auto-detected deployment mode. Modes: claw-only (daemon only), dexbot-direct (foreground testing), pm2 (production service), unlock-start (single-prompt, no PM2). Auto-detects mode from config or asks user on first call.',
    args: {
      payload_json: 'JSON object with botName (optional), deploymentMode (optional), setPreference (optional), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name as defined in profiles/bots.json. Omit for default/all.'),
      deploymentMode: stringSchema('Optional override: claw-only, dexbot-direct, pm2, unlock-start. Omit to auto-detect or use stored preference.'),
      setPreference: booleanSchema('If true, save deploymentMode as user preference for future calls.'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_run'
  }),
  createToolDefinition({
    command: 'launcher-drystart',
    description: 'Run a bot in dry-run mode (test/simulate without broadcasting to blockchain). Synonyms: dry run, simulate, test mode, paper trade, trial run, simulation',
    args: {
      payload_json: 'JSON object with botName (optional), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name as defined in profiles/bots.json. Omit for default.'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_drystart'
  }),
  createToolDefinition({
    command: 'launcher-reset',
    description: 'Reset a bot grid (triggers recalculation on next start or if running). Synonyms: reset grid, regenerate, recalculate, rebuild orders, refresh grid',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all active), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name as defined in profiles/bots.json. Omit or "all" for all active bots.'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_reset'
  }),
  createToolDefinition({
    command: 'launcher-disable',
    description: 'Disable a bot in config (set active: false). Synonyms: disable, deactivate, turn off, mark inactive, deregister',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name as defined in profiles/bots.json. Omit or "all" to disable all.'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_disable'
  }),
  createToolDefinition({
    command: 'launcher-pm2-start',
    description: 'Start bots via PM2 (production-grade, managed). Requires credential daemon running. Synonyms: pm2 start, deploy, launch pm2, production start',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all active), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name as defined in profiles/bots.json. Omit for all active bots.'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_pm2_start'
  }),
  createToolDefinition({
    command: 'launcher-pm2-stop',
    description: 'Stop a bot process via PM2. Synonyms: pause, stop, halt, freeze, suspend, shut down, quiet',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name or "all". Omit defaults to "all".'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_pm2_stop'
  }),
  createToolDefinition({
    command: 'launcher-pm2-delete',
    description: 'Delete a bot from PM2 process list. Synonyms: delete, remove, deregister, unregister, purge',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name or "all". Omit defaults to "all".'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_pm2_delete'
  }),
  createToolDefinition({
    command: 'launcher-pm2-restart',
    description: 'Restart a bot process via PM2. Synonyms: restart, reboot, cycle, bounce, reset, recycle',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name or "all". Omit defaults to "all".'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_pm2_restart'
  }),
  createToolDefinition({
    command: 'launcher-pm2-reload',
    description: 'Reload a bot process via PM2 (zero-downtime). Synonyms: reload, hot-reload, refresh, apply changes, refresh config',
    args: {
      payload_json: 'JSON object with botName (optional, defaults to all), profileRoot (optional)'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botName: stringSchema('Bot name or "all". Omit defaults to "all".'),
      profileRoot: stringSchema('Optional DEXBot2 profile root')
    }, []),
    risk: 'execute',
    toolName: 'claw_launcher_pm2_reload'
  }),
  createToolDefinition({
    command: 'memu-manifest',
    description: 'Inspect the memU memory bridge surface',
    inputSchema: objectSchema({
      memuDir: stringSchema('Optional memU state directory')
    }),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_manifest'
  }),
  createToolDefinition({
    command: 'memu-memorize',
    description: 'Store a resource as memU memory',
    args: {
      payload_json: 'JSON object with resourceUrl, modality, and optional user'
    },
    exampleArgs: ['--payload', '{"resourceUrl":"/tmp/conversation.txt","modality":"conversation"}'],
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      resourceUrl: stringSchema('Path or URL to the resource to memorize'),
      modality: stringSchema('conversation, document, image, video, or audio'),
      user: memuScopeSchema('Optional user scope for memory ownership')
    }, ['resourceUrl', 'modality']),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_memorize'
  }),
  createToolDefinition({
    command: 'memu-retrieve',
    description: 'Query memU memories',
    args: {
      payload_json: 'JSON object with queries plus optional where and method'
    },
    exampleArgs: ['--payload', '{"queries":[{"role":"user","content":{"text":"What do I prefer for BTS/USD bots?"}}],"where":{"user_id":"trader-123"}}'],
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      queries: {
        type: 'array',
        items: objectSchema(),
        description: 'memU query messages'
      },
      where: memuScopeSchema('Optional memU retrieval scope'),
      method: stringSchema('Optional retrieval method: rag or llm')
    }, ['queries']),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_retrieve'
  }),
  createToolDefinition({
    command: 'memu-list-categories',
    description: 'List memU categories',
    args: {
      payload_json: 'JSON object with optional where filter'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      where: memuScopeSchema('Optional memU category scope')
    }),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_list_categories'
  }),
  createToolDefinition({
    command: 'memu-list-items',
    description: 'List memU memory items',
    args: {
      payload_json: 'JSON object with optional where filter'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      where: memuScopeSchema('Optional memU item scope')
    }),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_list_items'
  }),
  createToolDefinition({
    command: 'memu-create-item',
    description: 'Create a memU item in a category by category id or category name',
    args: {
      payload_json: 'JSON object with categoryId or categoryName, summary, optional memoryType, and optional user'
    },
    exampleArgs: ['--payload', '{"categoryName":"preferences","summary":"Prefers 2% BTS/USD grid spacing","user":{"user_id":"trader-123"}}'],
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        categoryId: stringSchema('memU category id or name'),
        categoryName: stringSchema('memU category name alias'),
        summary: stringSchema('Memory content summary'),
        memoryType: stringSchema('Optional memory type'),
        user: memuScopeSchema('Optional user scope for memory ownership')
      },
      required: ['summary'],
      anyOf: [
        { required: ['categoryId'] },
        { required: ['categoryName'] }
      ]
    },
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_create_item'
  }),
  createToolDefinition({
    command: 'memu-update-item',
    description: 'Update a memU item',
    args: {
      payload_json: 'JSON object with itemId and updates'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      itemId: stringSchema('memU item id'),
      updates: objectSchema({}, [], 'Update payload for the memory item')
    }, ['itemId', 'updates']),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_update_item'
  }),
  createToolDefinition({
    command: 'memu-delete-item',
    description: 'Delete a memU item',
    args: {
      payload_json: 'JSON object with itemId'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      itemId: stringSchema('memU item id')
    }, ['itemId']),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_delete_item'
  }),
  createToolDefinition({
    command: 'memu-clear',
    description: 'Clear memU memory, optionally limited by a where scope',
    args: {
      payload_json: 'JSON object with optional where filter'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      where: memuScopeSchema('Optional memU clear scope')
    }),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_clear'
  }),
  createToolDefinition({
    command: 'memu-status',
    description: 'Inspect memU status and counts',
    args: {
      payload_json: 'JSON object with optional where filter'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      where: memuScopeSchema('Optional memU status scope')
    }),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_status'
  }),
  createToolDefinition({
    command: 'memu-memorize-conversation',
    description: 'Store a conversation transcript in memU',
    args: {
      payload_json: 'JSON object with messages array and optional user'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      messages: {
        type: 'array',
        items: objectSchema(),
        description: 'Conversation messages'
      },
      user: memuScopeSchema('Optional user scope for memory ownership')
    }, ['messages']),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_memorize_conversation'
  }),
  createToolDefinition({
    command: 'memu-memorize-trading-context',
    description: 'Store trading context in memU',
    args: {
      payload_json: 'JSON object with context and optional user'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      context: {
        oneOf: [
          { type: 'string' },
          objectSchema()
        ],
        description: 'Trading context content'
      },
      user: memuScopeSchema('Optional user scope for memory ownership')
    }, ['context']),
    risk: 'execute',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_memorize_trading_context'
  }),
  createToolDefinition({
    command: 'memu-retrieve-trading-context',
    description: 'Retrieve trading-related memU memories',
    args: {
      payload_json: 'JSON object with query and optional user'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      query: stringSchema('Trading context query'),
      user: memuScopeSchema('Optional user scope for retrieval')
    }, ['query']),
    risk: 'read',
    runtimes: ['memu'],
    surface: 'memory',
    toolName: 'claw_memu_retrieve_trading_context'
  }),
]);

function cloneTool(tool) {
  return {
    ...tool,
    args: tool.args ? { ...tool.args } : null,
    exampleArgs: Array.isArray(tool.exampleArgs) ? [...tool.exampleArgs] : [],
    extraArgs: Array.isArray(tool.extraArgs) ? [...tool.extraArgs] : [],
    inputSchema: tool.inputSchema ? JSON.parse(JSON.stringify(tool.inputSchema)) : objectSchema(),
    runtimes: Array.isArray(tool.runtimes) ? [...tool.runtimes] : []
  };
}

function listClawCommandNames() {
  return [...new Set(CLAW_TOOL_CATALOG.map((tool) => tool.command))];
}

function getClawToolCatalog() {
  return CLAW_TOOL_CATALOG.map(cloneTool);
}

function buildClawCommandExamples(scriptPath = 'node scripts/claw_bridge.js') {
  return CLAW_TOOL_CATALOG
    .filter((tool) => Array.isArray(tool.exampleArgs))
    .map((tool) => [
      scriptPath,
      tool.command,
      ...tool.exampleArgs.map((arg) => (String(arg).startsWith('--') ? String(arg) : shellQuote(arg)))
    ].join(' '));
}

function getClawToolByCommand(command) {
  const match = CLAW_TOOL_CATALOG.find((tool) => tool.command === command);
  return match ? cloneTool(match) : null;
}

function getClawToolByName(toolName) {
  const match = CLAW_TOOL_CATALOG.find((tool) => tool.toolName === toolName);
  return match ? cloneTool(match) : null;
}

export = {
  buildClawCommandExamples,
  getClawToolByCommand,
  getClawToolByName,
  getClawToolCatalog,
  listClawCommandNames,
  objectSchema
};
