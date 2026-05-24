// @ts-nocheck
const { definePluginEntry } = require("openclaw/plugin-sdk/plugin-entry");
const { getClawToolCatalog } = require("../../modules/claw_catalog.js");
const { runClawCommand } = require("../../modules/claw_bridge.js");

function formatResult(result) {
  return JSON.stringify(result, null, 2);
}

const plugin = definePluginEntry({
  id: "bitshares-claw",
  name: "BitShares Claw",
  description: "Native BitShares tools from DEXBot2/claw",
  register(api) {
    for (const tool of getClawToolCatalog().filter((entry) => entry.runtimes.includes("openclaw"))) {
      api.registerTool({
        name: tool.toolName,
        description: `[${tool.risk}] ${tool.description}`,
        parameters: tool.inputSchema,
        async execute(_id, params) {
          const result = await runClawCommand(tool.command, { ...params, runtimeName: 'openclaw' });
          return {
            content: [
              {
                type: "text",
                text: formatResult(result)
              }
            ],
            structuredContent: result
          };
        }
      });
    }
  }
});

export = plugin;
