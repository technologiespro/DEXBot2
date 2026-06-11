const path = require('path');
const { getNullClawSkillTools } = require('./nullclaw_catalog');
const { normalizeRepoRoot, normalizeProfileRoot, createTool, buildBridgeCommand, buildSkillTomlLines, writeSkillFile } = require('./skill_utils');

function buildNullClawSkillToml(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot('nullclaw', options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'nullclaw_bridge.js').replace(/\\/g, '/');

  const tools = getNullClawSkillTools().map((tool: any) => createTool(
    tool.toolName,
    tool.description,
    buildBridgeCommand(bridgeScript, profileRoot, tool.command, tool.extraArgs),
    tool.args
  ));

  return buildSkillTomlLines(
    'bitshares-claw',
    'NullClaw bridge to the AI-Bot / DEXBot2 BitShares layer',
    ['bitshares', 'bridge', 'local', 'nullclaw'],
    tools
  );
}

async function writeNullClawSkillFile(outputPath: string, options: Record<string, any> = {}) {
  const content = buildNullClawSkillToml(options);
  return writeSkillFile(outputPath, content);
}

function describeNullClawSkill(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot('nullclaw', options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'nullclaw_bridge.js').replace(/\\/g, '/');

  return {
    bridgeScript,
    name: 'bitshares-claw',
    output: buildNullClawSkillToml(options),
    profileRoot,
    repositoryRoot: repoRoot
  };
}

export = {
  buildNullClawSkillToml,
  describeNullClawSkill,
  writeNullClawSkillFile
};
