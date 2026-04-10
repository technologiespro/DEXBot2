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
    incrementPercent: 0.4
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.strictEqual(updated.incrementPercent, 0.4);
  assert.strictEqual(written.incrementPercent, 0.4);
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
    adapter.updateBotSettings('alpha', { incrementPercent: 0.1 }),
    adapter.updateBotSettings('beta', { incrementPercent: 0.2 })
  ]);

  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  assert.strictEqual(written.bots[0].incrementPercent, 0.1, 'first concurrent patch should persist');
  assert.strictEqual(written.bots[1].incrementPercent, 0.2, 'second concurrent patch should persist');
}

async function testApplyBotSettingsPatchAcceptsNumericStringBounds() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-legacy-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'legacy',
        assetA: 'HONEST.MONEY',
        assetB: 'BTS',
        active: true,
        dryRun: false,
        startPrice: 'pool',
        minPrice: '0.55',
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        activeOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('legacy', true);
  const result = await adapter.applyBotSettingsPatch('legacy', {
    incrementPercent: 0.4
  }, {
    trigger: false
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.deepStrictEqual(view.validation.errors, []);
  assert.strictEqual(view.validation.valid, true);
  assert.strictEqual(result.updatedBot.incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].minPrice, '0.55', 'numeric-string bounds must remain valid during unrelated updates');
}

async function testApplyBotSettingsPatchRejectsUnknownNestedPatchKeys() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-nested-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'strict',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        activeOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('strict', {
    weightDistribution: { buy: 0.7, typo: 123 }
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false);
  assert.match(preview.errors.join('\n'), /weightDistribution contains unrecognized keys: typo/);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('strict', {
      weightDistribution: { buy: 0.7, typo: 123 }
    }, {
      trigger: false
    }),
    /weightDistribution contains unrecognized keys: typo/
  );
}

async function testApplyBotSettingsPatchWritesTriggerAtomically() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-apply-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');
  const triggerFile = path.join(profilesDir, 'recalculate.solo-0.trigger');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS',
        activeOrders: { sell: 20, buy: 20 },
        botFunds: { sell: '100%', buy: '100%' },
        weightDistribution: { sell: 0.5, buy: 0.5 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const result = await adapter.applyBotSettingsPatch('solo', {
    incrementPercent: 0.4,
    weightDistribution: { buy: 0.7 }
  }, {
    trigger: true,
    triggerPayload: { reason: 'manual_test', changedKeys: ["incrementPercent"] }
  });

  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  const trigger = JSON.parse(await fs.readFile(triggerFile, 'utf8'));

  assert.strictEqual(result.updatedBot.incrementPercent, 0.4);
  assert.strictEqual(result.updatedBot.weightDistribution.buy, 0.7);
  assert.strictEqual(result.updatedBot.weightDistribution.sell, 0.5, 'partial nested patch must preserve existing fields');
  assert.strictEqual(written.bots[0].incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].weightDistribution.buy, 0.7);
  assert.strictEqual(written.bots[0].weightDistribution.sell, 0.5);
  assert.strictEqual(result.triggerPath, triggerFile);
  assert.strictEqual(trigger.reason, 'manual_test');
}

async function testSparseBotPatchRespectsDefaultBackedValidation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-defaults-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('solo', {
    targetSpreadPercent: 0.1
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false, 'preview must reject patches that are invalid after defaults are applied');
  assert.match(preview.errors.join('\n'), /targetSpreadPercent must be >= 2x incrementPercent/);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('solo', {
      targetSpreadPercent: 0.1
    }, {
      trigger: false
    }),
    /targetSpreadPercent must be >= 2x incrementPercent/
  );
}

async function testInvalidPersistedOffsetPolicyBlocksUnrelatedPatch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-policy-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS',
        incrementPercent: -1,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        activeOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('solo', true);

  assert.strictEqual(view.validation.valid, false, 'effective view must expose invalid persisted field');
  assert.match(view.validation.errors.join('\n'), /incrementPercent must be a positive number/);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('solo', {
      targetSpreadPercent: 1.6
    }, {
      trigger: false
    }),
    /incrementPercent must be a positive number/
  );
}

async function testApplyBotSettingsPatchWithoutIdentifierReturnsResolvedBotMetadata() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-default-target-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const result = await adapter.applyBotSettingsPatch(null, {
    incrementPercent: 0.4
  }, {
    trigger: false
  });

  assert.strictEqual(result.updatedBot.botKey, 'solo-0');
  assert.strictEqual(result.updatedBot.botIndex, 0);
  assert.strictEqual(result.next.files.orderSnapshot, path.join(profilesDir, 'orders', 'solo-0.json'));
  assert.strictEqual(result.next.files.gridPriceSnapshot, path.join(profilesDir, 'orders', 'solo-0.gridprice.json'));
  assert.strictEqual(result.next.files.trigger, path.join(profilesDir, 'recalculate.solo-0.trigger'));
}

async function testUpdateBotSettingsRetainsLegacyWriteBehaviorWithInvalidPersistedFields() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-legacy-update-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'legacy-update',
        assetA: 'USD',
        assetB: 'BTS',
        incrementPercent: -1
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings('legacy-update', {
    targetSpreadPercent: 1.6
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.strictEqual(updated.targetSpreadPercent, 1.6);
  assert.strictEqual(written.bots[0].targetSpreadPercent, 1.6);
  assert.strictEqual(written.bots[0].incrementPercent, -1, 'legacy updateBotSettings should still permit unrelated writes against invalid persisted fields');
}

async function testWeightDistributionRejectsNullAndFalseValues() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-weight-types-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'strict-weight',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        activeOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('strict-weight', {
    weightDistribution: { sell: null, buy: false }
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false);
  assert.match(preview.errors.join('\n'), /weightDistribution\.sell must be a finite number/);
  assert.match(preview.errors.join('\n'), /weightDistribution\.buy must be a finite number/);
}

async function testNestedPatchValidationDoesNotDuplicateErrors() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-no-dupes-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'no-dupes',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        activeOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('no-dupes', {
    weightDistribution: { sell: null }
  }, {
    forceReload: true
  });

  const sellErrors = preview.errors.filter((entry) => entry === 'weightDistribution.sell must be a finite number');
  assert.strictEqual(sellErrors.length, 1, 'nested patch validation should not duplicate the same field error');
}

async function testNestedStateValidationRejectsWrongContainerTypes() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-bad-nested-state-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'bad-nested-state',
        assetA: 'USD',
        assetB: 'BTS',
        weightDistribution: 'oops',
        activeOrders: 0,
        botFunds: true
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('bad-nested-state', true);

  assert.strictEqual(view.rawValidation.valid, false);
  assert.match(view.rawValidation.errors.join('\n'), /weightDistribution must be an object with sell and buy/);
  assert.match(view.rawValidation.errors.join('\n'), /activeOrders must be an object with sell and buy/);
  assert.match(view.rawValidation.errors.join('\n'), /botFunds must be an object with sell and buy/);
}

async function testUpdateBotSettingsWithoutIdentifierReturnsResolvedBot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-default-update-return-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings(null, {
    incrementPercent: 0.4
  });

  assert.ok(updated, 'updateBotSettings(null, patch) should return the resolved bot');
  assert.strictEqual(updated.botKey, 'solo-0');
  assert.strictEqual(updated.botIndex, 0);
  assert.strictEqual(updated.incrementPercent, 0.4);
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
  await testApplyBotSettingsPatchAcceptsNumericStringBounds();
  await testApplyBotSettingsPatchRejectsUnknownNestedPatchKeys();
  await testApplyBotSettingsPatchWritesTriggerAtomically();
  await testSparseBotPatchRespectsDefaultBackedValidation();
  await testInvalidPersistedOffsetPolicyBlocksUnrelatedPatch();
  await testApplyBotSettingsPatchWithoutIdentifierReturnsResolvedBotMetadata();
  await testUpdateBotSettingsRetainsLegacyWriteBehaviorWithInvalidPersistedFields();
  await testWeightDistributionRejectsNullAndFalseValues();
  await testNestedPatchValidationDoesNotDuplicateErrors();
  await testNestedStateValidationRejectsWrongContainerTypes();
  await testUpdateBotSettingsWithoutIdentifierReturnsResolvedBot();
  console.log('dexbot profile tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
