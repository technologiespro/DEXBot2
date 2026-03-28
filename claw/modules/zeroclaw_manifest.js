const {
  buildZeroClawCommandExamples,
  listZeroClawCommandNames
} = require('./zeroclaw_catalog');

function describeZeroClawBridge(options = {}) {
  return {
    compatibility: {
      credentialBoundary: 'AI-Bot and DEXBot2 own signing and credentials',
      name: 'ZeroClaw',
      recommendedTransport: 'local-cli-json',
      trustModel: 'ZeroClaw sends intents and reads context; AI-Bot handles signing through DEXBot2',
      version: 1
    },
    commandExamples: buildZeroClawCommandExamples(),
    commands: listZeroClawCommandNames(),
    options: {
      accountName: options.accountName || null,
      profileRoot: options.profileRoot || process.env.DEXBOT_PROFILE_ROOT || null,
      socketPath: options.socketPath || null
    },
    surfaces: {
      credentialClient: 'internal only',
      honest: 'read-only context + pair pricing',
      market: 'read-only snapshots',
      order: 'DEXBot2 order utilities',
      profiles: 'DEXBot2 profile-folder adapter',
      stateStore: 'filesystem-backed AI-Bot state'
    }
  };
}

module.exports = {
  describeZeroClawBridge
};
