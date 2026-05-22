const { createVariantBridgeModule } = require('./claw_bridge');

module.exports = createVariantBridgeModule(
  'zeroclaw',
  'ZeroClaw',
  'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);
