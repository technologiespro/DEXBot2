const { createVariantDescribeFn } = require('./claw_manifest');

const describeOpenClawBridge = createVariantDescribeFn(
  'openclaw',
  'OpenClaw',
  'tsx scripts/claw_bridge.ts',
  'OpenClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

export = { describeOpenClawBridge };
