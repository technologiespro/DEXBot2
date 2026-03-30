'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');

const {
  loadAmaCenterPrice,
  loadAmaCenterSnapshot
} = require('../modules/order/utils/system');

async function testSnapshotReaderExposesRawAndEffectiveCenter() {
  const botKey = `snapshot-${Date.now()}`;
  const filePath = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.gridprice.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    amaCenterPrice: 100,
    centerPrice: 101.5,
    effectiveCenterPrice: 101.5,
    gridPriceOffsetEnabled: true,
    gridPriceOffsetPct: 1.5,
    source: 'market_adapter/price_adapter.js',
    updatedAt: '2026-01-01T00:00:00Z'
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert(snapshot, 'snapshot should be returned for a valid file');
    assert.strictEqual(snapshot.amaCenterPrice, 100);
    assert.strictEqual(snapshot.centerPrice, 101.5);
    assert.strictEqual(snapshot.effectiveCenterPrice, 101.5);
    assert.strictEqual(snapshot.gridPriceOffsetPct, 1.5);
    assert.strictEqual(snapshot.gridPriceOffsetClampToBounds, undefined);
    assert.strictEqual(loadAmaCenterPrice(botKey), 101.5);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function main() {
  await testSnapshotReaderExposesRawAndEffectiveCenter();
  console.log('ama center snapshot tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
