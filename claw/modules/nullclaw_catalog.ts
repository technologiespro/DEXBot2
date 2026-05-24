// @ts-nocheck
const {
  buildClawCommandExamples,
  getClawToolCatalog,
  listClawCommandNames
} = require('./claw_catalog');

function getNullClawSkillTools() {
  return getClawToolCatalog().filter((tool) => Array.isArray(tool.runtimes) && tool.runtimes.includes('nullclaw'));
}

function listNullClawCommandNames() {
  return listClawCommandNames();
}

function buildNullClawCommandExamples(scriptPath = 'node scripts/nullclaw_bridge.js') {
  return buildClawCommandExamples(scriptPath);
}

export = {
  buildNullClawCommandExamples,
  getNullClawSkillTools,
  listNullClawCommandNames
};
