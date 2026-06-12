const {
  buildClawCommandExamples,
  getClawToolCatalog,
  listClawCommandNames
} = require('./claw_catalog');

function getZeroClawSkillTools() {
  return getClawToolCatalog().filter((tool: any) => Array.isArray(tool.runtimes) && tool.runtimes.includes('zeroclaw'));
}

function listZeroClawCommandNames() {
  return listClawCommandNames();
}

function buildZeroClawCommandExamples(scriptPath = 'tsx scripts/zeroclaw_bridge.ts') {
  return buildClawCommandExamples(scriptPath);
}

export = {
  buildZeroClawCommandExamples,
  getZeroClawSkillTools,
  listZeroClawCommandNames
};
