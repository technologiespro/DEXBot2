const { createVariantBridgeModule } = require('./claw_bridge');

module.exports = createVariantBridgeModule(
  'openfang',
  'OpenFang',
  'OpenFang sends intents and reads context; AI-Bot handles signing through DEXBot2'
);
