const fs = require('fs/promises');
const path = require('path');
const { getNullClawSkillTools } = require('./nullclaw_catalog');

function tomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeRepoRoot(repoRoot) {
  return path.resolve(repoRoot || path.resolve(__dirname, '..'));
}

function normalizeProfileRoot(options = {}, repoRoot) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }

  if (options.dexbotRoot) {
    return path.resolve(options.dexbotRoot);
  }

  return path.resolve(repoRoot, '..');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildBridgeCommand(bridgeScript, profileRoot, command, extraArgs = []) {
  return ['node', bridgeScript, command, '--profile-root', profileRoot, ...extraArgs]
    .map((part, index) => (index === 0 ? String(part) : shellQuote(part)))
    .join(' ');
}

function createTool(name, description, command, args = null) {
  return {
    name,
    description,
    kind: 'shell',
    command,
    ...(args ? { args } : {})
  };
}

function buildNullClawSkillToml(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'nullclaw_bridge.js').replace(/\\/g, '/');

  const tools = getNullClawSkillTools().map((tool) => createTool(
    tool.toolName,
    tool.description,
    buildBridgeCommand(bridgeScript, profileRoot, tool.command, tool.extraArgs),
    tool.args
  ));

  const lines = [
    '[skill]',
    'name = "bitshares-claw"',
    'description = "NullClaw bridge to the AI-Bot / DEXBot2 BitShares layer"',
    'version = "1.0.0"',
    'tags = ["bitshares", "bridge", "local", "nullclaw"]'
  ];

  for (const tool of tools) {
    lines.push('', '[[tools]]');
    lines.push(`name = ${tomlString(tool.name)}`);
    lines.push(`description = ${tomlString(tool.description)}`);
    lines.push(`kind = ${tomlString(tool.kind)}`);
    lines.push(`command = ${tomlString(tool.command)}`);

    if (tool.args && Object.keys(tool.args).length > 0) {
      const argEntries = Object.entries(tool.args)
        .map(([key, value]) => `${key} = ${tomlString(value)}`)
        .join(', ');
      lines.push(`args = { ${argEntries} }`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function writeNullClawSkillFile(outputPath, options = {}) {
  if (!outputPath) {
    throw new Error('outputPath is required');
  }

  const content = buildNullClawSkillToml(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');
  return content;
}

function describeNullClawSkill(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
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

module.exports = {
  buildNullClawSkillToml,
  describeNullClawSkill,
  writeNullClawSkillFile
};
