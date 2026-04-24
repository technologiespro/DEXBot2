const bitsharesClient = require('./modules/bitshares_client');
const chainActions = require('./modules/chain_actions');
const chainBroadcast = require('./modules/chain_broadcast');
const chainQueries = require('./modules/chain_queries');
const clawBridge = require('./modules/claw_bridge');
const clawCatalog = require('./modules/claw_catalog');
const clawInfra = require('./modules/claw_infra');
const clawManifest = require('./modules/claw_manifest');
const clawRuntimeMatrix = require('./modules/claw_runtime_matrix');
const clawSkillMd = require('./modules/claw_skill_md');
const hermesManifest = require('./modules/hermes_manifest');
const openclawManifest = require('./modules/openclaw_manifest');
const openfangBridge = require('./modules/openfang_bridge');
const nanoclawBridge = require('./modules/nanoclaw_bridge');
const nullclawBridge = require('./modules/nullclaw_bridge');
const nullclawCatalog = require('./modules/nullclaw_catalog');
const nullclawManifest = require('./modules/nullclaw_manifest');
const nullclawSkill = require('./modules/nullclaw_skill');
const decisionLoop = require('./modules/decision_loop');
const dexbotBridge = require('./modules/dexbot_bridge');
const dexbotCredentialClient = require('./modules/dexbot_credential_client');
const dexbotProfiles = require('./modules/dexbot_profiles');
const feedPriceSource = require('./modules/feed_price_source');
const honestEcosystem = require('./modules/honest_ecosystem');
const kibanaPriceSource = require('./modules/kibana_price_source');
const liquidityPools = require('./modules/liquidity_pools');
const positionDiscovery = require('./modules/position_discovery');
const positionHealth = require('./modules/position_health');
const positionManager = require('./modules/position_manager');
const positionManagerWatch = require('./modules/position_manager_watch');
const shortMpaStrategy = require('./modules/short_mpa_strategy');
const zeroclawBridge = require('./modules/zeroclaw_bridge');
const zeroclawCatalog = require('./modules/zeroclaw_catalog');
const zeroclawManifest = require('./modules/zeroclaw_manifest');
const zeroclawSkill = require('./modules/zeroclaw_skill');

module.exports = {
  ...bitsharesClient,
  ...chainActions,
  ...chainBroadcast,
  ...chainQueries,
  ...clawBridge,
  ...clawCatalog,
  ...clawInfra,
  ...clawManifest,
  ...clawRuntimeMatrix,
  ...clawSkillMd,
  ...hermesManifest,
  ...openclawManifest,
  ...openfangBridge,
  ...nanoclawBridge,
  ...nullclawBridge,
  ...nullclawCatalog,
  ...nullclawManifest,
  ...nullclawSkill,
  ...decisionLoop,
  ...dexbotBridge,
  ...dexbotCredentialClient,
  ...dexbotProfiles,
  ...feedPriceSource,
  ...honestEcosystem,
  ...kibanaPriceSource,
  ...liquidityPools,
  ...positionDiscovery,
  ...positionHealth,
  ...positionManager,
  ...positionManagerWatch,
  ...shortMpaStrategy,
  ...zeroclawBridge,
  ...zeroclawCatalog,
  ...zeroclawManifest,
  ...zeroclawSkill,

  // Disambiguate root exports that would otherwise be overwritten by spread order.
  describeHermesBridge: hermesManifest.describeHermesBridge,
  describeOpenClawBridge: openclawManifest.describeOpenClawBridge,
  describeOpenFangBridge: openfangBridge.describeOpenFangBridge,
  describeNanoClawBridge: nanoclawBridge.describeNanoClawBridge,
  describeNullClawBridge: nullclawManifest.describeNullClawBridge,
  describeZeroClawBridge: zeroclawManifest.describeZeroClawBridge,
  resolveAccountName: chainQueries.resolveAccountName,
  resolveSigningAccountName: chainBroadcast.resolveAccountName
};
