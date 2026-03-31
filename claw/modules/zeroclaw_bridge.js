const {
  createClawBridge,
  describeClawBridge,
  runClawCommand
} = require('./claw_bridge');

function createZeroClawBridge(options = {}) {
  return createClawBridge({
    ...options,
    runtime: {
      ...(options.runtime || {}),
      name: options.runtime?.name || 'zeroclaw-bridge'
    }
  });
}

function describeZeroClawBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'zeroclaw'
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

function runZeroClawCommand(command, options = {}) {
  return runClawCommand(command, {
    ...options,
    runtimeName: options.runtimeName || 'zeroclaw'
  });
}

module.exports = {
  createZeroClawBridge,
  describeZeroClawBridge,
  runZeroClawCommand
};
