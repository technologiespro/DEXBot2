const {
  createClawBridge,
  describeClawBridge,
  runClawCommand
} = require('./claw_bridge');

function createNullClawBridge(options = {}) {
  return createClawBridge({
    ...options,
    runtime: {
      ...(options.runtime || {}),
      name: options.runtime?.name || 'nullclaw-bridge'
    }
  });
}

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

function runNullClawCommand(command, options = {}) {
  return runClawCommand(command, {
    ...options,
    runtimeName: options.runtimeName || 'nullclaw'
  });
}

module.exports = {
  createNullClawBridge,
  describeNullClawBridge,
  runNullClawCommand
};
