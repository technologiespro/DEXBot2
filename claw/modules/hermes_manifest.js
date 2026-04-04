const { describeClawBridge } = require('./claw_manifest');

function describeHermesBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'hermes',
    scriptPath: 'node scripts/claw_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'Hermes',
      trustModel: 'Hermes consumes Claw through the shared MCP server and optional skill guidance; AI-Bot handles signing through DEXBot2'
    }
  };
}

module.exports = {
  describeHermesBridge
};
