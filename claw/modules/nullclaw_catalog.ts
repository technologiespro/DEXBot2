const {
  buildClawCommandExamples,
  getClawToolCatalog,
  listClawCommandNames
} = require('./claw_catalog');

function getNullClawSkillTools() {
  return getClawToolCatalog().filter((tool: any) => Array.isArray(tool.runtimes) && tool.runtimes.includes('nullclaw'));
}

function listNullClawCommandNames() {
  return listClawCommandNames();
}

function buildNullClawCommandExamples(scriptPath = 'tsx scripts/nullclaw_bridge.ts') {
  return buildClawCommandExamples(scriptPath);
}

export = {
  buildNullClawCommandExamples,
  getNullClawSkillTools,
  listNullClawCommandNames
};
