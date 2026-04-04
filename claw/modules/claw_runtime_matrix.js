const SUPPORTED_CLAW_RUNTIMES = Object.freeze([
  {
    runtime: 'openclaw',
    nativeIntegration: 'plugin',
    preferredTransport: 'plugin-or-mcp',
    skillFile: 'SKILL.md',
    notes: 'Native plugin registration is preferred; SKILL.md remains the native workflow layer.'
  },
  {
    runtime: 'openfang',
    nativeIntegration: 'skill-md',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.md',
    notes: 'OpenFang can load prompt-only SKILL.md skills and shell out to the shared CLI bridge from a local workspace skill.'
  },
  {
    runtime: 'nanobot',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp-stdio-jsonl',
    skillFile: 'SKILL.md',
    notes: 'Native external tool surface is MCP over stdio with newline-delimited JSON-RPC, with SKILL.md used for workflow guidance.'
  },
  {
    runtime: 'picoclaw',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp-stdio-jsonl',
    skillFile: 'SKILL.md',
    notes: 'PicoClaw mirrors NanoBot on native SKILL.md loading and MCP stdio integration with newline-delimited JSON-RPC.'
  },
  {
    runtime: 'nanoclaw',
    nativeIntegration: 'skill-md',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.md',
    notes: 'NanoClaw uses Claude Code skill files with a local JSON CLI bridge and workspace-level skill loading.'
  },
  {
    runtime: 'zeroclaw',
    nativeIntegration: 'skill-manifest',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.toml',
    notes: 'Native shell-tool manifests with prompts and tool declarations.'
  },
  {
    runtime: 'nullclaw',
    nativeIntegration: 'skill-manifest',
    preferredTransport: 'skill-toml-or-mcp',
    skillFile: 'SKILL.toml',
    notes: 'NullClaw prefers SKILL.toml in ~/.nullclaw/workspace/skills and can also load Claw through mcp_servers.'
  }
]);

function cloneRuntime(runtime) {
  return { ...runtime };
}

function listSupportedClawRuntimes() {
  return SUPPORTED_CLAW_RUNTIMES.map(cloneRuntime);
}

function getSupportedClawRuntime(runtimeName) {
  if (!runtimeName) {
    return null;
  }

  const normalized = String(runtimeName).trim().toLowerCase();
  const match = SUPPORTED_CLAW_RUNTIMES.find((runtime) => runtime.runtime === normalized);
  return match ? cloneRuntime(match) : null;
}

module.exports = {
  getSupportedClawRuntime,
  listSupportedClawRuntimes
};
