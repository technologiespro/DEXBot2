const {
  createClawBridge,
  describeClawBridge,
  runClawCommand
} = require('./claw_bridge');

function createNanoClawBridge(options = {}) {
  return createClawBridge({
    ...options,
    runtime: {
      ...(options.runtime || {}),
      name: options.runtime?.name || 'nanoclaw-bridge'
    }
  });
}

function describeNanoClawBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'nanoclaw',
    scriptPath: 'node scripts/nanoclaw_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'NanoClaw',
      trustModel: 'NanoClaw sends intents and reads context; AI-Bot handles signing through DEXBot2'
    }
  };
}

function runNanoClawCommand(command, options = {}) {
  if (command === 'manifest') {
    return describeNanoClawBridge(options);
  }

  return runClawCommand(command, {
    ...options,
    runtimeName: options.runtimeName || 'nanoclaw'
  });
}

module.exports = {
  createNanoClawBridge,
  describeNanoClawBridge,
  runNanoClawCommand
};
