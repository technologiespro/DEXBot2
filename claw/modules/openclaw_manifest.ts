const { createVariantDescribeFn } = require('./claw_manifest');

const describeOpenClawBridge = createVariantDescribeFn(
  'openclaw',
  'OpenClaw',
  'node scripts/claw_bridge.js',
  'OpenClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

export = { describeOpenClawBridge };
