const {
  buildClawCommandExamples,
  getClawToolCatalog,
  listClawCommandNames
} = require('./claw_catalog');
const { getSupportedClawRuntime, listSupportedClawRuntimes } = require('./claw_runtime_matrix');

function groupCommandsByRisk(tools) {
  return tools.reduce((groups, tool) => {
    const risk = tool.risk || 'read';
    if (!groups[risk]) {
      groups[risk] = [];
    }
    groups[risk].push(tool.command);
    return groups;
  }, {});
}

function describeClawBridge(options = {}) {
  const tools = getClawToolCatalog();
  const focusedRuntime = getSupportedClawRuntime(options.runtimeName || options.runtime);

  return {
    compatibility: {
      credentialBoundary: 'AI-Bot and DEXBot2 own signing and credentials',
      name: 'Claw',
      recommendedTransport: focusedRuntime ? focusedRuntime.preferredTransport : 'runtime-specific',
      runtimes: listSupportedClawRuntimes(),
      trustModel: 'Claw runtimes send intents and read context; AI-Bot handles signing through DEXBot2',
      version: 2
    },
    commandExamples: buildClawCommandExamples(options.scriptPath),
    commands: listClawCommandNames(),
    options: {
      accountName: options.accountName || null,
      profileRoot: options.profileRoot || process.env.DEXBOT_PROFILE_ROOT || null,
      runtimeName: focusedRuntime ? focusedRuntime.runtime : null,
      socketPath: options.socketPath || null
    },
    surfaces: {
      credentialClient: 'internal only',
      honest: 'read-only context + pair pricing',
      market: 'read-only snapshots',
      order: 'DEXBot2 order utilities',
      profiles: 'DEXBot2 profile-folder adapter, including bot settings read/preview/apply and read-only general.settings.json context',
      stateStore: 'filesystem-backed AI-Bot state'
    },
    tools: {
      byRisk: groupCommandsByRisk(tools),
      catalog: tools
    }
  };
}

module.exports = {
  describeClawBridge
};
