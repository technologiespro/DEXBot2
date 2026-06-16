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
const creditRuntimeAdapter = require('./modules/credit_runtime_adapter');

const decisionLoop = require('./modules/decision_loop');
const dexbotBridge = require('./modules/dexbot_bridge');
const dexbotCredentialClient = require('./modules/dexbot_credential_client');
const dexbotProfiles = require('./modules/dexbot_profiles');
const feedPriceSource = require('./modules/feed_price_source');
const honestEcosystem = require('./modules/honest_ecosystem');
const kibanaPriceSource = require('./modules/kibana_price_source');
const liquidityPools = require('./modules/liquidity_pools');
const memuBridge = require('./modules/memu_bridge');
const positionDiscovery = require('./modules/position_discovery');
const positionHealth = require('./modules/position_health');
const positionManager = require('./modules/position_manager');
const positionManagerWatch = require('./modules/position_manager_watch');
const shortMpaStrategy = require('./modules/short_mpa_strategy');
export = {
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
  ...creditRuntimeAdapter,
  ...decisionLoop,
  ...dexbotBridge,
  ...dexbotCredentialClient,
  ...dexbotProfiles,
  ...feedPriceSource,
  ...honestEcosystem,
  ...kibanaPriceSource,
  ...liquidityPools,
  ...memuBridge,
  ...positionDiscovery,
  ...positionHealth,
  ...positionManager,
  ...positionManagerWatch,
  ...shortMpaStrategy,

  // Disambiguate root exports that would otherwise be overwritten by spread order.
  describeMemuBridge: memuBridge.describeMemuBridge,
  resolveAccountName: chainQueries.resolveAccountName,
  resolveSigningAccountName: chainBroadcast.resolveAccountName
};
