const SUPPORTED_CLAW_RUNTIMES = Object.freeze([
  {
    runtime: 'zeroclaw',
    nativeIntegration: 'skill-manifest',
    preferredTransport: 'local-cli-json',
    skillFile: 'SKILL.toml',
    notes: 'Native shell-tool manifests with prompts and tool declarations.'
  },
  {
    runtime: 'openclaw',
    nativeIntegration: 'plugin',
    preferredTransport: 'plugin-or-mcp',
    skillFile: 'SKILL.md',
    notes: 'Native plugin registration is preferred; SKILL.md remains the native workflow layer.'
  },
  {
    runtime: 'nanobot',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp',
    skillFile: 'SKILL.md',
    notes: 'Native external tool surface is MCP, with SKILL.md used for workflow guidance.'
  },
  {
    runtime: 'picoclaw',
    nativeIntegration: 'mcp',
    preferredTransport: 'mcp',
    skillFile: 'SKILL.md',
    notes: 'PicoClaw mirrors NanoBot on native SKILL.md loading and MCP tool integration.'
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
