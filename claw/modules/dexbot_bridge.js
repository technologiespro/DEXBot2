const path = require('path');
const fs = require('fs');

function getDexbot2Root() {
  if (process.env.DEXBOT2_ROOT) {
    return path.resolve(process.env.DEXBOT2_ROOT);
  }

  const repoRoot = path.resolve(__dirname, '../..');
  const orderIndexPath = path.join(repoRoot, 'modules', 'order', 'index.js');
  if (fs.existsSync(orderIndexPath)) {
    return repoRoot;
  }

  throw new Error('Unable to resolve DEXBot2 root. Set DEXBOT2_ROOT or run from a DEXBot2 checkout.');
}

function requireDexbot2Module(relativePath) {
  return require(path.join(getDexbot2Root(), relativePath));
}

function loadDexbotOrderSubsystem() {
  return requireDexbot2Module('modules/order/index.js');
}

function loadDexbotOrderUtils() {
  return loadDexbotOrderSubsystem().utils;
}

function loadDexbotOrderConstants() {
  return loadDexbotOrderSubsystem().constants;
}

function loadDexbotOrderSystemUtils() {
  return requireDexbot2Module('modules/order/utils/system');
}

module.exports = {
  getDexbot2Root,
  loadDexbotOrderConstants,
  loadDexbotOrderSubsystem,
  loadDexbotOrderSystemUtils,
  loadDexbotOrderUtils,
  requireDexbot2Module
};
