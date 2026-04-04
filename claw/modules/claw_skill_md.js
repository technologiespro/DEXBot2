const fs = require('fs/promises');
const path = require('path');
const { getClawToolCatalog } = require('./claw_catalog');
const { getSupportedClawRuntime } = require('./claw_runtime_matrix');

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

function buildToolSummary(runtimeName) {
  const tools = getClawToolCatalog().filter((tool) => tool.runtimes.includes(runtimeName));
  const byRisk = tools.reduce((groups, tool) => {
    const risk = tool.risk || 'read';
    if (!groups[risk]) {
      groups[risk] = [];
    }
    groups[risk].push(`\`${tool.toolName}\``);
    return groups;
  }, {});

  const orderedRisks = ['read', 'plan', 'execute'];
  return orderedRisks
    .filter((risk) => Array.isArray(byRisk[risk]) && byRisk[risk].length > 0)
    .map((risk) => `- ${risk}: ${byRisk[risk].join(', ')}`)
    .join('\n');
}

function buildRuntimeSetup(runtime, repoRoot, profileRoot) {
  const mcpCommand = `node ${path.join(repoRoot, 'scripts', 'claw_mcp_server.js')}`;
  const mcpArgs = `["${path.join(repoRoot, 'scripts', 'claw_mcp_server.js')}", "--profile-root", "${profileRoot}"]`;

  switch (runtime.runtime) {
    case 'nanobot':
      return [
        '## NanoBot Setup',
        '',
        'Add the Claw MCP server to NanoBot `config.json`:',
        '',
        '```json',
        '{',
        '  "tools": {',
        '    "mcpServers": {',
        '      "claw": {',
        `        "command": "node",`,
        `        "args": ${mcpArgs}`,
        '      }',
        '    }',
        '  }',
        '}',
        '```',
        '',
        'The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'picoclaw':
      return [
        '## PicoClaw Setup',
        '',
        'Add the Claw MCP server to PicoClaw `config.json`:',
        '',
        '```json',
        '{',
        '  "tools": {',
        '    "mcp": {',
        '      "enabled": true,',
        '      "servers": {',
        '        "claw": {',
        '          "enabled": true,',
        '          "type": "stdio",',
        '          "command": "node",',
        `          "args": ${mcpArgs}`,
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
        '```',
        '',
        'The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`,
        '',
        'On a fresh PicoClaw install, make sure `agents.defaults.workspace` is configured before expecting workspace skills to appear.',
        'Running `picoclaw onboard` or writing an explicit workspace path in `config.json` is sufficient.'
      ].join('\n');

    case 'nanoclaw':
      return [
        '## NanoClaw Setup',
        '',
        'NanoClaw already ships its own `claw` skill, so keep this bridge skill named `bitshares-claw` to avoid a collision.',
        '',
        'Write the generated `SKILL.md` into NanoClaw\'s workspace skill tree, for example:',
        '',
        '```text',
        '.claude/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        'Use the local JSON bridge in `scripts/nanoclaw_bridge.js` when you want the NanoClaw runtime to talk to DEXBot2.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'openfang':
      return [
        '## OpenFang Setup',
        '',
        'OpenFang uses the same shared Claw bridge surface through a local CLI wrapper.',
        '',
        'Write the generated `SKILL.md` into OpenFang\'s workspace skill tree, for example:',
        '',
        '```text',
        '~/.openfang/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        'Use the local JSON bridge in `scripts/openfang_bridge.js` when you want the OpenFang runtime to talk to DEXBot2.',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` if you want a default profile root outside tool args.`
      ].join('\n');

    case 'openclaw':
      return [
        '## OpenClaw Setup',
        '',
        'Install the native plugin from this repository:',
        '',
        '```bash',
        `openclaw plugins install -l ${repoRoot}`,
        'openclaw plugins enable bitshares-claw',
        '```',
        '',
        'The plugin registers the same native BitShares tools directly inside OpenClaw.',
        '',
        'If you also want this skill visible in the OpenClaw workspace, write this file to:',
        '',
        '```text',
        '~/.openclaw/workspace/skills/bitshares-claw/SKILL.md',
        '```',
        '',
        `Set \`DEXBOT_PROFILE_ROOT=${profileRoot}\` for the plugin process if you want a default profile root.`
      ].join('\n');

    default:
      return [
        '## Setup',
        '',
        `Use the native ${runtime.nativeIntegration} path for ${runtime.runtime}.`,
        '',
        `Preferred bridge command: \`${mcpCommand} --profile-root ${profileRoot}\``
      ].join('\n');
  }
}

function buildRuntimeSkillMarkdown(runtimeName, options = {}) {
  const runtime = getSupportedClawRuntime(runtimeName);
  if (!runtime) {
    throw new Error(`Unsupported runtime: ${runtimeName}`);
  }

  if (runtime.runtime === 'zeroclaw') {
    throw new Error('ZeroClaw uses SKILL.toml via scripts/zeroclaw_skill.js, not claw_skill_md.js');
  }

  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const profileRoot = normalizeProfileRoot(options, repoRoot);

  return [
    '---',
    'name: bitshares-claw',
    `description: Use native DEXBot2 Claw BitShares tools in ${runtime.runtime} for market snapshots, HONEST context, MPA planning, and explicit order execution.`,
    '---',
    '',
    '# BitShares Claw',
    '',
    `Use the native Claw integration for ${runtime.runtime} when the user asks about BitShares automation, DEXBot2 profiles, HONEST assets, MPA borrowing, order management, or BTS-backed short workflows.`,
    '',
    '## Safety Rules',
    '',
    '- Prefer `read` and `plan` tools before `execute` tools.',
    '- Treat all order placement, cancellation, debt adjustment, and settlement tools as approval-required actions.',
    '- Keep signing and credentials inside DEXBot2; do not ask for raw private keys.',
    '',
    '## Native Tools',
    '',
    buildToolSummary(runtime.runtime),
    '',
    buildRuntimeSetup(runtime, repoRoot, profileRoot),
    '',
    '## Workflow',
    '',
    '- Start with `claw_manifest`, `claw_runtime`, `claw_profile_context`, `claw_market_snapshot`, `claw_account_snapshot`, or `claw_open_orders`.',
    '- For MPA and short workflows, use `claw_build_open_short_plan`, `claw_build_take_profit_plan`, or `claw_build_close_short_plan` before executing trades.',
    '- Use `claw_honest_context`, `claw_honest_pair`, and `claw_honest_price` when the task involves HONEST assets or discovery.',
    '',
    '## Repository Paths',
    '',
    `- Repo root: \`${repoRoot}\``,
    `- Default profile root: \`${profileRoot}\``
  ].join('\n');
}

async function writeRuntimeSkillMarkdown(outputPath, runtimeName, options = {}) {
  const content = buildRuntimeSkillMarkdown(runtimeName, options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');
  return content;
}

module.exports = {
  buildRuntimeSkillMarkdown,
  writeRuntimeSkillMarkdown
};
