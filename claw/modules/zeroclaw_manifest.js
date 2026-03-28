const { describeClawBridge } = require('./claw_manifest');

function describeZeroClawBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'zeroclaw',
    scriptPath: 'node scripts/zeroclaw_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'ZeroClaw',
      trustModel: 'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
    }
  };
}

module.exports = {
  describeZeroClawBridge
};
