const assert = require('assert');

const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function main() {
  const botConfig = { name: 'My Bot', assetA: 'ASSET.A', assetB: 'ASSET.B', active: true };
  const botKey = createBotKey(botConfig, 0);
  const db = new AccountOrders({ botKey });

  await db.ensureBotEntries([botConfig]);

  const orders = [
    { id: '1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 1, orderId: '' },
    { id: '2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 2, orderId: '1.7.1' },
    { id: '3', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 5, orderId: '' },
    { id: '4', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 3, orderId: '1.7.2' },
    { id: '5', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 10, orderId: '' }
  ];

  await db.storeMasterGrid(botKey, orders);

  const resByKey = db.getDBAssetBalances(botKey);
  assert(resByKey, 'Expected non-null result for botKey');
  assert.strictEqual(resByKey.assetA.virtual, 1, 'SELL virtual should be 1');
  assert.strictEqual(resByKey.assetA.active, 2, 'SELL active should be 2');
  assert.strictEqual(resByKey.assetB.virtual, 5, 'BUY virtual should be 5');
  assert.strictEqual(resByKey.assetB.active, 3, 'BUY active should be 3');

  const resByName = db.getDBAssetBalances('My Bot');
  assert(resByName, 'Expected non-null result for bot name');
  assert.deepStrictEqual(resByKey, resByName);

  console.log('AccountOrders getDBAssetBalances tests passed');
  process.exit(0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
