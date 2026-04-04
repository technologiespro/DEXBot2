const {
  createClawBridge,
  runClawCommand
} = require('./claw_bridge');
const { describeZeroClawBridge } = require('./zeroclaw_manifest');

function createZeroClawBridge(options = {}) {
  return createClawBridge({
    ...options,
    runtime: {
      ...(options.runtime || {}),
      name: options.runtime?.name || 'zeroclaw-bridge'
    }
  });
}

function runZeroClawCommand(command, options = {}) {
  if (command === 'manifest') {
    return describeZeroClawBridge(options);
  }

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
