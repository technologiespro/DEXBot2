const { BitShares } = require('./bitshares_client');
const { getDexbot2Root, loadDexbotOrderSystemUtils, requireDexbot2Module } = require('./dexbot_bridge');

function getDexbotSystem() {
  return loadDexbotOrderSystemUtils();
}

function createDexbotPoolHelper() {
  const system = getDexbotSystem();
  return {
    cloneMap: system.cloneMap,
    derivePoolPrice: (assetA, assetB) => system.derivePoolPrice(BitShares, assetA, assetB),
    derivePrice: (assetA, assetB, mode) => system.derivePrice(BitShares, assetA, assetB, mode),
    deepFreeze: system.deepFreeze,
    loadAmaCenterPrice: system.loadAmaCenterPrice,
    lookupAsset: system.lookupAsset
  };
}

module.exports = {
  createDexbotPoolHelper,
  derivePoolPrice: (assetA, assetB) => getDexbotSystem().derivePoolPrice(BitShares, assetA, assetB),
  derivePrice: (assetA, assetB, mode) => getDexbotSystem().derivePrice(BitShares, assetA, assetB, mode),
  deepFreeze: (...args) => getDexbotSystem().deepFreeze(...args),
  getDexbot2Root,
  loadAmaCenterPrice: (...args) => getDexbotSystem().loadAmaCenterPrice(...args),
  lookupAsset: (...args) => getDexbotSystem().lookupAsset(...args),
  requireDexbot2Module
};
