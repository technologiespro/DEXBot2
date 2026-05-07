'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const fsSync = require('fs');
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
	    amaSlopePercentMode: 'perBar',
	    amaSlope: {
	      trend: 'DOWN',
	      slopePct: -0.28,
      slopeOffset: -0.14,
    },
    gridRangeScalingAmaSlope: {
      trend: 'UP',
      slopePct: 0.42,
      slopeOffset: 0.21,
    },
    amaSlopeDeltaPercent: 0.18,
    amaSlopeThresholdPercent: 0.1,
    source: 'market_adapter/market_adapter.js',
    updatedAt: '2026-01-01T00:00:00Z'
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert(snapshot, 'snapshot should be returned for a valid file');
	    assert.strictEqual(snapshot.amaCenterPrice, 100);
	    assert.strictEqual(snapshot.centerPrice, 101.5);
	    assert.strictEqual(snapshot.amaSlopePercentMode, 'perBar');
	    assert.deepStrictEqual(snapshot.amaSlope, {
	      trend: 'DOWN',
      slopePct: -0.28,
      slopeOffset: -0.14,
    });
    assert.deepStrictEqual(snapshot.gridRangeScalingAmaSlope, {
      trend: 'UP',
      slopePct: 0.42,
      slopeOffset: 0.21,
    });
    assert.strictEqual(snapshot.amaSlopeDeltaPercent, 0.18);
    assert.strictEqual(snapshot.amaSlopeThresholdPercent, 0.1);
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

async function testCenterSnapshotWriterUsesOnlyNewCollateralField() {
  const marketAdapterPath = require.resolve('../market_adapter/market_adapter.js');
  delete require.cache[marketAdapterPath];

  const originalWriteFileSync = fsSync.writeFileSync;
  const originalRenameSync = fsSync.renameSync;
  const capturedWrites = [];

  try {
    fsSync.writeFileSync = (filePath, data) => {
      capturedWrites.push({ filePath, data: String(data) });
    };
    fsSync.renameSync = (src, dst) => {
      capturedWrites.push({ rename: [src, dst] });
    };

    const { writeCenterSnapshot } = require('../market_adapter/test_helpers.js');
    writeCenterSnapshot({
      bots: {
        testBot: {
          botName: 'test-bot',
          gridCenterPrice: 123.45,
          amaCenterPrice: 120.5,
          lastGridResetAt: '2026-01-01T00:00:00Z',
          lastAmaPrice: 121.25,
          lastDeltaPercent: 1.5,
          amaSlopeDeltaPercent: 0.12,
          amaSlopeThresholdPercent: 0.1,
          weights: { buy: 0.6, sell: 0.4 },
          effectiveWeights: { buy: 0.55, sell: 0.45 },
          collateralRecommendation: 1.62,
          amaSlope: {
            trend: 'UP',
            slopePct: 0.28,
            slopeOffset: 0.14,
          },
          atr: 0.34,
        },
      },
    });

    const write = capturedWrites.find((entry) => entry.filePath && String(entry.filePath).endsWith('.tmp'));
    assert(write, 'snapshot writer should emit a JSON payload');
	    const parsed = JSON.parse(write.data);
	    assert.strictEqual(parsed.bots.testBot.gridCenterPrice, 123.45);
	    assert.strictEqual(parsed.bots.testBot.centerPrice, 123.45);
	    assert.strictEqual(parsed.bots.testBot.collateralRecommendation, 1.62);
	    assert.strictEqual(parsed.bots.testBot.amaSlopeDeltaPercent, 0.12);
	    assert.strictEqual(parsed.bots.testBot.amaSlopeThresholdPercent, 0.1);
	    assert.strictEqual(parsed.bots.testBot.amaSlopePercentMode, 'perBar');
	    assert.deepStrictEqual(parsed.bots.testBot.amaSlope, {
      trend: 'UP',
      slopePct: 0.28,
      slopeOffset: 0.14,
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.bots.testBot, 'collateral'), false, 'legacy collateral field should not be written');
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
    fsSync.renameSync = originalRenameSync;
    delete require.cache[marketAdapterPath];
  }
}

async function testCenterSnapshotWriterIgnoresLegacyCollateralInput() {
  const marketAdapterPath = require.resolve('../market_adapter/market_adapter.js');
  delete require.cache[marketAdapterPath];

  const originalWriteFileSync = fsSync.writeFileSync;
  const originalRenameSync = fsSync.renameSync;
  const capturedWrites = [];

  try {
    fsSync.writeFileSync = (filePath, data) => {
      capturedWrites.push({ filePath, data: String(data) });
    };
    fsSync.renameSync = (src, dst) => {
      capturedWrites.push({ rename: [src, dst] });
    };

    const { writeCenterSnapshot } = require('../market_adapter/test_helpers.js');
    writeCenterSnapshot({
      bots: {
        testBot: {
          botName: 'test-bot',
          centerPrice: 123.45,
          amaCenterPrice: 120.5,
          collateral: 1.62,
        },
      },
    });

    const write = capturedWrites.find((entry) => entry.filePath && String(entry.filePath).endsWith('.tmp'));
    assert(write, 'snapshot writer should emit a JSON payload');
    const parsed = JSON.parse(write.data);
    assert.strictEqual(parsed.bots.testBot.collateralRecommendation, null, 'legacy collateral input should not be upgraded implicitly');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.bots.testBot, 'collateral'), false, 'legacy collateral field should remain absent');
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
    fsSync.renameSync = originalRenameSync;
    delete require.cache[marketAdapterPath];
  }
}

async function main() {
  await testSnapshotReaderExposesCenterOnly();
  await testSnapshotReaderRejectsLegacyEffectiveCenterOnly();
  await testCenterSnapshotWriterUsesOnlyNewCollateralField();
  await testCenterSnapshotWriterIgnoresLegacyCollateralInput();
  console.log('ama center snapshot tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
