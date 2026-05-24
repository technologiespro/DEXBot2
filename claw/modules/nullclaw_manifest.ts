const { createVariantDescribeFn } = require('./claw_manifest');

const describeNullClawBridge = createVariantDescribeFn(
  'nullclaw',
  'NullClaw',
  'node scripts/nullclaw_bridge.js',
  'NullClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

export = { describeNullClawBridge };
