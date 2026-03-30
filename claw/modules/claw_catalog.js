function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

const SUPPORTED_RUNTIMES = ['zeroclaw', 'openclaw', 'nanobot', 'picoclaw'];

function stringSchema(description) {
  return {
    type: 'string',
    ...(description ? { description } : {})
  };
}

function numberSchema(description) {
  return {
    type: 'number',
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

function dynamicWeightPolicySchema(description = null) {
  return objectSchema({
    allowNeutralUpdate: booleanSchema('Allow NEUTRAL trend updates to reshape weightDistribution'),
    cooldownMs: integerSchema('Minimum time between updates for the same bot'),
    enabled: booleanSchema('Enable dynamic weight evaluation and config updates'),
    gridPriceOffsetAllowNeutralReset: booleanSchema('Allow neutral trend updates to reset gridPriceOffsetPct back toward zero'),
    gridPriceOffsetEnabled: booleanSchema('Enable trend-biased gridPrice offset updates'),
    gridPriceOffsetCooldownMs: integerSchema('Minimum time between gridPrice offset updates'),
    gridPriceOffsetMaxPct: numberSchema('Maximum signed gridPrice offset percentage'),
    gridPriceOffsetMinConfidence: numberSchema('Minimum confidence needed to adjust gridPrice offset'),
    gridPriceOffsetMinDeltaPct: numberSchema('Minimum offset delta needed to persist an update'),
    gridPriceOffsetRequireAmaGridPrice: booleanSchema('Only apply gridPrice offsets to AMA-based bots'),
    gridPriceOffsetRequireConfirmedTrend: booleanSchema('Require confirmed trend before adjusting gridPrice offset'),
    gridPriceOffsetScale: numberSchema('Scale factor applied to the confidence-based offset'),
    minConfidence: numberSchema('Minimum trend confidence needed for an update'),
    minWeightDelta: numberSchema('Minimum absolute weight change needed to write a new config'),
    requireBtsQuote: booleanSchema('Require the bot quote asset to resolve to BTS'),
    requireConfirmedTrend: booleanSchema('Require TrendAnalyzer confirmation before updating'),
    requireTrendReady: booleanSchema('Require TrendAnalyzer warmup completion before updating'),
    triggerOnApply: booleanSchema('Write recalculate.<botKey>.trigger after persisting updated weights'),
    triggerReason: stringSchema('Reason string written into the trigger payload'),
    writeTriggerPayload: booleanSchema('Persist a JSON trigger payload instead of an empty trigger file')
  }, [], description);
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
    command: 'dynamic-weight-policy',
    description: 'Inspect the default dynamic-weight policy',
    inputSchema: objectSchema({}),
    toolName: 'claw_dynamic_weight_policy'
  }),
  createToolDefinition({
    command: 'dynamic-weight-preview',
    description: 'Preview a dynamic-weight update for a resolved bot profile',
    exampleArgs: ['--payload', '{"botRef":"default","policy":{"enabled":true}}'],
    args: {
      payload_json: 'JSON object with botRef, identifier, botId, or pair, plus optional policy and priceContext'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botRef: stringSchema('Bot reference in DEXBot2 profiles'),
      identifier: stringSchema('Generic profile identifier'),
      botId: stringSchema('Explicit bot id'),
      pair: stringSchema('Trading pair such as BTS/USD'),
      profileRoot: stringSchema('Optional DEXBot2 profile root'),
      policy: dynamicWeightPolicySchema('Dynamic-weight policy overrides'),
      priceContext: objectSchema({
        pricePositionInRange: numberSchema('Price position inside the observed range'),
        oscillationRatio: numberSchema('Oscillation ratio override')
      }, [], 'Optional price context override')
    }),
    toolName: 'claw_dynamic_weight_preview'
  }),
  createToolDefinition({
    command: 'dynamic-weight-apply',
    description: 'Apply a dynamic-weight update and write the recalc trigger',
    exampleArgs: ['--payload', '{"botRef":"default","policy":{"enabled":true}}'],
    args: {
      payload_json: 'JSON object with botRef, identifier, botId, or pair, plus optional policy and priceContext'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    inputSchema: objectSchema({
      botRef: stringSchema('Bot reference in DEXBot2 profiles'),
      identifier: stringSchema('Generic profile identifier'),
      botId: stringSchema('Explicit bot id'),
      pair: stringSchema('Trading pair such as BTS/USD'),
      profileRoot: stringSchema('Optional DEXBot2 profile root'),
      policy: dynamicWeightPolicySchema('Dynamic-weight policy overrides'),
      priceContext: objectSchema({
        pricePositionInRange: numberSchema('Price position inside the observed range'),
        oscillationRatio: numberSchema('Oscillation ratio override')
      }, [], 'Optional price context override')
    }),
    risk: 'execute',
    toolName: 'claw_dynamic_weight_apply'
  })
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

module.exports = {
  buildClawCommandExamples,
  getClawToolByCommand,
  getClawToolByName,
  getClawToolCatalog,
  listClawCommandNames,
  objectSchema
};
