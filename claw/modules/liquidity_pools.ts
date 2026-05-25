const { BitShares } = require('./bitshares_client');
const { getDexbot2Root, loadDexbotOrderSystemUtils, requireDexbot2Module } = require('./dexbot_bridge');

function getDexbotSystem() {
  return loadDexbotOrderSystemUtils();
}

function createDexbotPoolHelper() {
  const system = getDexbotSystem();
  return {
    cloneMap: system.cloneMap,
    derivePoolPrice: (assetA: any, assetB: any) => system.derivePoolPrice(BitShares, assetA, assetB),
    derivePrice: (assetA: any, assetB: any, mode: any) => system.derivePrice(BitShares, assetA, assetB, mode),
    deepFreeze: system.deepFreeze,
    loadAmaCenterSnapshot: system.loadAmaCenterSnapshot,
    loadAmaCenterPrice: system.loadAmaCenterPrice,
    lookupAsset: system.lookupAsset
  };
}

export = {
  createDexbotPoolHelper,
  derivePoolPrice: (assetA: any, assetB: any) => getDexbotSystem().derivePoolPrice(BitShares, assetA, assetB),
  derivePrice: (assetA: any, assetB: any, mode: any) => getDexbotSystem().derivePrice(BitShares, assetA, assetB, mode),
  deepFreeze: (...args: any[]) => getDexbotSystem().deepFreeze(...args),
  getDexbot2Root,
  loadAmaCenterSnapshot: (...args: any[]) => getDexbotSystem().loadAmaCenterSnapshot(...args),
  loadAmaCenterPrice: (...args: any[]) => getDexbotSystem().loadAmaCenterPrice(...args),
  lookupAsset: (...args: any[]) => getDexbotSystem().lookupAsset(...args),
  requireDexbot2Module
};
