'use strict';

const assert = require('assert');

const { normalizeBotDraft } = require('../modules/account_bots');

function testNormalizeBotDraftStripsOffsetControls() {
  // gridPriceOffsetPct is now fully dynamic (deviation-based) — no static config.
  // normalizeBotDraft should strip any legacy value and never expose the field.
  const draftWithLegacy = normalizeBotDraft({ name: 'test-bot', gridPriceOffsetPct: 0.35 });
  assert.strictEqual(draftWithLegacy.gridPriceOffsetPct, undefined);
  assert.strictEqual(draftWithLegacy.gridPriceOffsetClampToBounds, undefined);
  assert.ok(draftWithLegacy.weightDistribution, 'defaults should still seed nested objects');

  const draftFresh = normalizeBotDraft({ name: 'test-bot' });
  assert.strictEqual(draftFresh.gridPriceOffsetPct, undefined);
  assert.strictEqual(draftFresh.gridPriceOffsetClampToBounds, undefined);
}

function main() {
  testNormalizeBotDraftStripsOffsetControls();
  console.log('account bots draft tests passed');
}

main();
