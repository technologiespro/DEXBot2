const { createVariantBridgeModule } = require('./claw_bridge');

module.exports = createVariantBridgeModule(
  'nanoclaw',
  'NanoClaw',
  'NanoClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);
