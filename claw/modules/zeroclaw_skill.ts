const fs = require('fs/promises');
const path = require('path');
const { getZeroClawSkillTools } = require('./zeroclaw_catalog');

function tomlString(value: any) {
  return JSON.stringify(String(value));
}

function normalizeRepoRoot(repoRoot?: string) {
  const ZC_PARENT_DIR = path.dirname(path.dirname(__dirname));
  const ZC_PROJECT_ROOT = path.basename(ZC_PARENT_DIR) === 'dist' ? path.dirname(ZC_PARENT_DIR) : ZC_PARENT_DIR;
  return path.resolve(repoRoot || path.join(ZC_PROJECT_ROOT, 'claw'));
}

function normalizeProfileRoot(options: Record<string, any> = {}, repoRoot: string) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }

  if (options.dexbotRoot) {
    return path.resolve(options.dexbotRoot);
  }

  return path.resolve(repoRoot, '..');
}

function shellQuote(value: any) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildBridgeCommand(bridgeScript: string, profileRoot: string, command: string, extraArgs: any[] = []) {
  return ['node', bridgeScript, command, '--profile-root', profileRoot, ...extraArgs]
    .map((part, index) => (index === 0 ? String(part) : shellQuote(part)))
    .join(' ');
}

function createTool(name: string, description: string, command: string, args: any = null) {
  return {
    name,
    description,
    kind: 'shell',
    command,
    ...(args ? { args } : {})
  };
}

function buildZeroClawSkillToml(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);
  const bridgeScript = path.join(repoRoot, 'scripts', 'zeroclaw_bridge.js').replace(/\\/g, '/');

  const tools = getZeroClawSkillTools().map((tool: any) => createTool(
    tool.toolName,
    tool.description,
    buildBridgeCommand(bridgeScript, profileRoot, tool.command, tool.extraArgs),
    tool.args
  ));

  const lines = [
    '[skill]',
    'name = "ai-bots"',
    'description = "ZeroClaw bridge to the AI-Bot / DEXBot2 BitShares layer"',
    'version = "1.0.0"',
    'tags = ["bitshares", "bridge", "local"]'
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

async function writeZeroClawSkillFile(outputPath: string, options: Record<string, any> = {}) {
  if (!outputPath) {
    throw new Error('outputPath is required');
  }

  const content = buildZeroClawSkillToml(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');
  return content;
}

function describeZeroClawSkill(options: Record<string, any> = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
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
