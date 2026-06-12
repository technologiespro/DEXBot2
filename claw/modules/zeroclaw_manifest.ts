const { createVariantDescribeFn } = require('./claw_manifest');

const describeZeroClawBridge = createVariantDescribeFn(
  'zeroclaw',
  'ZeroClaw',
  'tsx scripts/zeroclaw_bridge.ts',
  'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

export = { describeZeroClawBridge };
