const {
  buildClawCommandExamples,
  getClawToolCatalog,
  listClawCommandNames
} = require('./claw_catalog');

function getZeroClawSkillTools() {
  return getClawToolCatalog().filter((tool) => Array.isArray(tool.runtimes) && tool.runtimes.includes('zeroclaw'));
}

function listZeroClawCommandNames() {
  return listClawCommandNames();
}

function buildZeroClawCommandExamples(scriptPath = 'node scripts/zeroclaw_bridge.js') {
  return buildClawCommandExamples(scriptPath);
}

export = {
  buildZeroClawCommandExamples,
  getZeroClawSkillTools,
  listZeroClawCommandNames
};
