function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

const ZEROCLAW_SKILL_TOOLS = Object.freeze([
  {
    command: 'manifest',
    description: 'Inspect the AI-Bot bridge surface',
    exampleArgs: [],
    toolName: 'manifest'
  },
  {
    command: 'runtime',
    description: 'Inspect the runtime context',
    toolName: 'runtime'
  },
  {
    command: 'profile-context',
    description: 'Load the default Claw profile context',
    exampleArgs: ['--payload', '{"botRef":"default"}'],
    extraArgs: ['--bot-ref', 'default'],
    toolName: 'profile_context_default'
  },
  {
    command: 'market-snapshot',
    description: 'Fetch a BTS/USD market snapshot',
    exampleArgs: ['--payload', '{"baseSymbol":"BTS","quoteSymbol":"USD"}'],
    extraArgs: ['--base', 'BTS', '--quote', 'USD'],
    toolName: 'market_snapshot_bts_usd'
  },
  {
    command: 'account-snapshot',
    description: 'Read an account snapshot with balances and open orders',
    args: {
      account_name: 'BitShares account name or id'
    },
    extraArgs: ['--account', '{{account_name}}'],
    toolName: 'account_snapshot'
  },
  {
    command: 'open-orders',
    description: 'Read open orders for an account',
    args: {
      account_name: 'BitShares account name or id'
    },
    extraArgs: ['--account', '{{account_name}}'],
    toolName: 'open_orders'
  },
  {
    command: 'honest-context',
    description: 'Inspect HONEST asset and pair context',
    args: {
      payload_json: 'JSON object with optional prefix, batchSize, discoverPairs, maxPages, startSymbol'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'honest_context'
  },
  {
    command: 'honest-pair',
    description: 'Resolve HONEST pair context',
    args: {
      payload_json: 'JSON object with assetA and assetB, or pair'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'honest_pair'
  },
  {
    command: 'honest-price',
    description: 'Resolve HONEST pair price',
    args: {
      payload_json: 'JSON object with assetA and assetB, or pair'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'honest_price'
  },
  {
    command: 'create-limit-order',
    description: 'Create a BitShares limit order',
    exampleArgs: ['--payload', '{"accountName":"alice","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'],
    args: {
      payload_json:
        'JSON object with accountName, sellAsset, receiveAsset, amountToSell, minToReceive, optional expiration, optional fillOrKill'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'create_limit_order'
  },
  {
    command: 'cancel-limit-order',
    description: 'Cancel a BitShares limit order',
    args: {
      payload_json: 'JSON object with accountName and orderId'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'cancel_limit_order'
  },
  {
    command: 'build-update-limit-order-op',
    description: 'Build a BitShares limit order update operation',
    args: {
      payload_json:
        'JSON object with accountName, orderId, and newParams or direct amountToSell/minToReceive/newPrice fields'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'build_update_limit_order_op'
  },
  {
    command: 'update-limit-order',
    description: 'Update a BitShares limit order',
    exampleArgs: ['--payload', '{"accountName":"alice","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'],
    args: {
      payload_json:
        'JSON object with accountName, orderId, and newParams or direct amountToSell/minToReceive/newPrice fields'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'update_limit_order'
  },
  {
    command: 'execute-batch',
    description: 'Execute a batch of BitShares operations',
    args: {
      payload_json: 'JSON object with operations array and optional accountName'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'execute_batch'
  },
  {
    command: 'borrow-mpa',
    description: 'Borrow against an MPA position',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, debtDelta, collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'borrow_mpa'
  },
  {
    command: 'repay-mpa',
    description: 'Repay MPA debt',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'repay_mpa'
  },
  {
    command: 'adjust-mpa-collateral',
    description: 'Adjust MPA collateral',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, collateralDelta, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'adjust_mpa_collateral'
  },
  {
    command: 'settle-mpa',
    description: 'Settle an MPA position',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amount'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'settle_mpa'
  },
  {
    command: 'open-short-bts',
    description: 'Build and execute the open leg of a BTS-backed short',
    args: {
      payload_json:
        'JSON object with accountName, mpaAsset, debtAmount, collateralAmount, sellPriceInBts, optional targetCollateralRatio'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'open_short_bts'
  },
  {
    command: 'take-profit-bts',
    description: 'Place the take-profit leg for a BTS-backed short',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToCover, buyPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'take_profit_bts'
  },
  {
    command: 'close-short-bts',
    description: 'Close a BTS-backed short',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional releaseCollateralDelta'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'close_short_bts'
  },
  {
    command: 'build-open-short-plan',
    description: 'Build the open-short plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, debtAmount, collateralAmount, sellPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'build_open_short_plan'
  },
  {
    command: 'build-take-profit-plan',
    description: 'Build the take-profit plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToCover, buyPriceInBts'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'build_take_profit_plan'
  },
  {
    command: 'build-close-short-plan',
    description: 'Build the close-short plan without broadcasting',
    args: {
      payload_json: 'JSON object with accountName, mpaAsset, amountToRepay, optional releaseCollateralDelta'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'build_close_short_plan'
  },
  {
    command: 'mpa-position',
    description: 'Read the on-chain MPA position for an account',
    args: {
      payload_json: 'JSON object with accountName and mpaAsset'
    },
    extraArgs: ['--payload', '{{payload_json}}'],
    toolName: 'mpa_position'
  }
]);

function cloneTool(tool) {
  return {
    ...tool,
    args: tool.args ? { ...tool.args } : null,
    exampleArgs: Array.isArray(tool.exampleArgs) ? [...tool.exampleArgs] : [],
    extraArgs: Array.isArray(tool.extraArgs) ? [...tool.extraArgs] : []
  };
}

function listZeroClawCommandNames() {
  return [...new Set(ZEROCLAW_SKILL_TOOLS.map((tool) => tool.command))];
}

function getZeroClawSkillTools() {
  return ZEROCLAW_SKILL_TOOLS.map(cloneTool);
}

function buildZeroClawCommandExamples(scriptPath = 'node scripts/zeroclaw_bridge.js') {
  return ZEROCLAW_SKILL_TOOLS
    .filter((tool) => Array.isArray(tool.exampleArgs))
    .map((tool) => [
      scriptPath,
      tool.command,
      ...tool.exampleArgs.map((arg) => (String(arg).startsWith('--') ? String(arg) : shellQuote(arg)))
    ].join(' '));
}

module.exports = {
  buildZeroClawCommandExamples,
  getZeroClawSkillTools,
  listZeroClawCommandNames
};
