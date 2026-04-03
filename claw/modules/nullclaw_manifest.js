const { describeClawBridge } = require('./claw_manifest');

function describeNullClawBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'nullclaw',
    scriptPath: 'node scripts/nullclaw_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'NullClaw',
      trustModel: 'NullClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
    }
  };
}

module.exports = {
  describeNullClawBridge
};
