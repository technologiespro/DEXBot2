'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');

const {
  loadAmaCenterPrice,
  loadAmaCenterSnapshot
} = require('../modules/order/utils/system');

async function testSnapshotReaderExposesCenterOnly() {
  const botKey = `snapshot-${Date.now()}`;
  const filePath = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    amaCenterPrice: 100,
    centerPrice: 101.5,
    source: 'market_adapter/market_adapter.js',
    updatedAt: '2026-01-01T00:00:00Z'
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert(snapshot, 'snapshot should be returned for a valid file');
    assert.strictEqual(snapshot.amaCenterPrice, 100);
    assert.strictEqual(snapshot.centerPrice, 101.5);
    assert.strictEqual(loadAmaCenterPrice(botKey), 101.5);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function testSnapshotReaderRejectsLegacyEffectiveCenterOnly() {
  const botKey = `snapshot-legacy-${Date.now()}`;
  const filePath = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    amaCenterPrice: 100,
    effectiveCenterPrice: 101.5,
    source: 'market_adapter/market_adapter.js',
    updatedAt: '2026-01-01T00:00:00Z'
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert.strictEqual(snapshot, null, 'legacy snapshot without centerPrice should be rejected');
    assert.strictEqual(loadAmaCenterPrice(botKey), null);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function main() {
  await testSnapshotReaderExposesCenterOnly();
  await testSnapshotReaderRejectsLegacyEffectiveCenterOnly();
  console.log('ama center snapshot tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
