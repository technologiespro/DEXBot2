const {
  createClawBridge,
  describeClawBridge,
  runClawCommand
} = require('./claw_bridge');

function createOpenFangBridge(options = {}) {
  return createClawBridge({
    ...options,
    runtime: {
      ...(options.runtime || {}),
      name: options.runtime?.name || 'openfang-bridge'
    }
  });
}

function describeOpenFangBridge(options = {}) {
  const manifest = describeClawBridge({
    ...options,
    runtimeName: 'openfang',
    scriptPath: 'node scripts/openfang_bridge.js'
  });

  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      name: 'OpenFang',
      trustModel: 'OpenFang sends intents and reads context; AI-Bot handles signing through DEXBot2'
    }
  };
}

function runOpenFangCommand(command, options = {}) {
  if (command === 'manifest') {
    return describeOpenFangBridge(options);
  }

  return runClawCommand(command, {
    ...options,
    runtimeName: options.runtimeName || 'openfang'
  });
}

module.exports = {
  createOpenFangBridge,
  describeOpenFangBridge,
  runOpenFangCommand
};
