const { createVariantDescribeFn } = require('./claw_manifest');

const describeZeroClawBridge = createVariantDescribeFn(
  'zeroclaw',
  'ZeroClaw',
  'node scripts/zeroclaw_bridge.js',
  'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);

module.exports = { describeZeroClawBridge };
