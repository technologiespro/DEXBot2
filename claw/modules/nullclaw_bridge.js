const { createVariantBridgeModule } = require('./claw_bridge');

module.exports = createVariantBridgeModule(
  'nullclaw',
  'NullClaw',
  'NullClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
);
