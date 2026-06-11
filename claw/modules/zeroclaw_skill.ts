const path = require('path');
const { getZeroClawSkillTools } = require('./zeroclaw_catalog');
const { normalizeRepoRoot, normalizeProfileRoot, createTool, buildBridgeCommand, buildSkillTomlLines, writeSkillFile } = require('./skill_utils');

function buildZeroClawSkillToml(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot('zeroclaw', options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'zeroclaw_bridge.js').replace(/\\/g, '/');

  const tools = getZeroClawSkillTools().map((tool: any) => createTool(
    tool.toolName,
    tool.description,
    buildBridgeCommand(bridgeScript, profileRoot, tool.command, tool.extraArgs),
    tool.args
  ));

  return buildSkillTomlLines(
    'ai-bots',
    'ZeroClaw bridge to the AI-Bot / DEXBot2 BitShares layer',
    ['bitshares', 'bridge', 'local'],
    tools
  );
}

async function writeZeroClawSkillFile(outputPath: string, options: Record<string, any> = {}) {
  const content = buildZeroClawSkillToml(options);
  return writeSkillFile(outputPath, content);
}

function describeZeroClawSkill(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot('zeroclaw', options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'zeroclaw_bridge.js').replace(/\\/g, '/');

  return {
    bridgeScript,
    name: 'ai-bots',
    output: buildZeroClawSkillToml(options),
    profileRoot,
    repositoryRoot: repoRoot
  };
}

export = {
  buildZeroClawSkillToml,
  describeZeroClawSkill,
  writeZeroClawSkillFile
};
