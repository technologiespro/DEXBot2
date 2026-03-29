'use strict';

const assert = require('assert');

const { normalizeBotDraft } = require('../modules/account_bots');

function testNormalizeBotDraftPreservesOffsetControls() {
  const draft = normalizeBotDraft({
    name: 'test-bot',
    gridPriceOffsetClampToBounds: false,
    gridPriceOffsetEnabled: false,
    gridPriceOffsetPct: 0.35
  });

  assert.strictEqual(draft.gridPriceOffsetPct, 0.35);
  assert.strictEqual(draft.gridPriceOffsetEnabled, false);
  assert.strictEqual(draft.gridPriceOffsetClampToBounds, false);
  assert.ok(draft.weightDistribution, 'defaults should still seed nested objects');
}

function testNormalizeBotDraftSeedsDefaultOffsetControls() {
  const draft = normalizeBotDraft({ name: 'test-bot' });

  assert.strictEqual(draft.gridPriceOffsetPct, 0);
  assert.strictEqual(draft.gridPriceOffsetEnabled, true);
  assert.strictEqual(draft.gridPriceOffsetClampToBounds, true);
}

function main() {
  testNormalizeBotDraftPreservesOffsetControls();
  testNormalizeBotDraftSeedsDefaultOffsetControls();
  console.log('account bots draft tests passed');
}

main();
