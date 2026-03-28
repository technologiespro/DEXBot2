const path = require('path');
const fs = require('fs');

function getDexbot2Root() {
  return process.env.DEXBOT2_ROOT
    ? path.resolve(process.env.DEXBOT2_ROOT)
    : fs.existsSync(path.resolve(__dirname, '../..', 'modules', 'order', 'index.js'))
      ? path.resolve(__dirname, '../..')
      : path.resolve(__dirname, '../../Git/DEXBot2');
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
