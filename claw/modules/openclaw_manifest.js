const { describeClawBridge } = require('./claw_manifest');

function describeOpenClawBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'openclaw',
    scriptPath: 'node scripts/claw_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'OpenClaw',
      trustModel: 'OpenClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
    }
  };
}

module.exports = {
  describeOpenClawBridge
};
