'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  createBotKey,
  createDexbotProfileAdapter,
  matchBotIdentifier,
  normalizeBotEntries,
  writeJsonFileAtomic,
} = require('../modules/dexbot_profiles');

function createCaptureLogger() {
  const messages = [];
  return {
    logger: {
      log: (msg) => messages.push(String(msg)),
      warn: (msg) => messages.push(String(msg))
    },
    messages
  };
}

function testNormalizeAcceptsAssetIdAliases() {
  const { logger, messages } = createCaptureLogger();
  const bots = normalizeBotEntries([
    {
      assetAId: '1.3.111',
      assetBId: '1.3.222',
      name: 'id-only'
    }
  ], { logger });

  assert.strictEqual(messages.length, 0, 'asset ID-only bots should not produce missing-key warnings');
  assert.strictEqual(bots[0].botKey, 'id-only-0');
}

async function testAtomicWriteFailsFastWhenLockCannotBeAcquired() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-'));
  const filePath = path.join(dir, 'bots.json');

  const originalWriteFile = fs.writeFile;
  const originalStat = fs.stat;
  const originalUnlink = fs.unlink;
  const originalRename = fs.rename;
  const originalDateNow = Date.now;

  let renameCalled = false;
  let now = 0;

  Date.now = () => {
    now += 2500;
    return now;
  };

  fs.writeFile = async (targetPath, data, options) => {
    if (String(targetPath).endsWith('.lock')) {
      const err = new Error('lock busy');
      err.code = 'EEXIST';
      throw err;
    }
    return originalWriteFile.call(fs, targetPath, data, options);
  };
  fs.stat = async () => ({ mtimeMs: 0 });
  fs.unlink = async () => {};
  fs.rename = async () => {
    renameCalled = true;
  };

  try {
    await assert.rejects(
      () => writeJsonFileAtomic(filePath, { bots: [] }),
      /Could not acquire lock/,
      'writeJsonFileAtomic should abort instead of writing without a lock'
    );
    assert.strictEqual(renameCalled, false, 'writeJsonFileAtomic must not rename when lock acquisition fails');
  } finally {
    fs.writeFile = originalWriteFile;
    fs.stat = originalStat;
    fs.unlink = originalUnlink;
    fs.rename = originalRename;
    Date.now = originalDateNow;
  }
}

async function testUpdateBotSettingsPreservesSingleObjectFormat() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-single-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    name: 'solo',
    assetA: 'USD',
    assetB: 'BTS'
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings('solo', {
    gridPriceOffsetPct: 0.4
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.strictEqual(updated.gridPriceOffsetPct, 0.4);
  assert.strictEqual(written.gridPriceOffsetPct, 0.4);
  assert.strictEqual(written.name, 'solo');
  assert.strictEqual(Array.isArray(written.bots), false, 'single-object format must not gain a wrapper array');
}

async function testConcurrentUpdateBotSettingsPreservesBothPatches() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-race-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'alpha',
        assetA: 'USD',
        assetB: 'BTS'
      },
      {
        name: 'beta',
        assetA: 'CNY',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  await Promise.all([
    adapter.updateBotSettings('alpha', { gridPriceOffsetPct: 0.1 }),
    adapter.updateBotSettings('beta', { gridPriceOffsetPct: 0.2 })
  ]);

  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  assert.strictEqual(written.bots[0].gridPriceOffsetPct, 0.1, 'first concurrent patch should persist');
  assert.strictEqual(written.bots[1].gridPriceOffsetPct, 0.2, 'second concurrent patch should persist');
}

function testCreateBotKeyFallsBackToAssetIds() {
  const key = createBotKey({ assetAId: '1.3.1', assetBId: '1.3.0' }, 0);
  assert.ok(key.includes('1-3-1'), `botKey should contain sanitized assetAId, got: ${key}`);
  assert.ok(key.includes('1-3-0'), `botKey should contain sanitized assetBId, got: ${key}`);

  // Symbol fields still take precedence
  const symKey = createBotKey({ assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' }, 0);
  assert.ok(symKey.includes('iob'), `symbol-based key should take precedence, got: ${symKey}`);
}

function testMatchBotIdentifierHandlesIdOnlyBots() {
  const bot = normalizeBotEntries([{ assetAId: '1.3.1', assetBId: '1.3.0' }])[0];

  // String pair match with IDs
  assert.strictEqual(matchBotIdentifier(bot, '1.3.1/1.3.0'), true, 'should match ID pair string');
  assert.strictEqual(matchBotIdentifier(bot, '1.3.1/1.3.999'), false, 'should not match wrong ID');

  // Object match with IDs
  assert.strictEqual(matchBotIdentifier(bot, { assetAId: '1.3.1', assetBId: '1.3.0' }), true, 'should match ID object');
  assert.strictEqual(matchBotIdentifier(bot, { assetAId: '1.3.1', assetBId: '1.3.999' }), false, 'should not match wrong ID object');

  // Mixed bot with both symbols and IDs
  const mixedBot = normalizeBotEntries([{ assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' }])[0];
  assert.strictEqual(matchBotIdentifier(mixedBot, 'IOB.XRP/BTS'), true, 'symbol pair should still work');
  assert.strictEqual(matchBotIdentifier(mixedBot, '1.3.1/1.3.0'), true, 'ID pair should also work for mixed bot');
}

async function main() {
  testNormalizeAcceptsAssetIdAliases();
  testCreateBotKeyFallsBackToAssetIds();
  testMatchBotIdentifierHandlesIdOnlyBots();
  await testAtomicWriteFailsFastWhenLockCannotBeAcquired();
  await testUpdateBotSettingsPreservesSingleObjectFormat();
  await testConcurrentUpdateBotSettingsPreservesBothPatches();
  console.log('dexbot profile tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
