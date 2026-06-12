const { createVariantDescribeFn } = require('./claw_manifest');

const describeNullClawBridge = createVariantDescribeFn(
  'nullclaw',
  'NullClaw',
  'tsx scripts/nullclaw_bridge.ts',
  'NullClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

export = { describeNullClawBridge };
