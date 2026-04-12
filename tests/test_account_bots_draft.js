'use strict';

const assert = require('assert');

const { normalizeBotDraft } = require('../modules/account_bots');

function testNormalizeBotDraftSeedsDefaults() {
  const draft = normalizeBotDraft({ name: 'test-bot' });
  assert.ok(draft.weightDistribution, 'defaults should still seed nested objects');
  assert.ok(draft.botFunds, 'defaults should still seed nested objects');
  assert.ok(draft.activeOrders, 'defaults should still seed nested objects');
}

function testNormalizeBotDraftStripsLegacyOffsetFields() {
  const draft = normalizeBotDraft({
    name: 'test-bot',
    gridPriceOffsetPct: 0.35,
    gridPriceOffsetClampToBounds: true,
  });
  assert.strictEqual(draft.gridPriceOffsetPct, undefined);
  assert.strictEqual(draft.gridPriceOffsetClampToBounds, undefined);
}

function main() {
  testNormalizeBotDraftSeedsDefaults();
  testNormalizeBotDraftStripsLegacyOffsetFields();
  console.log('account bots draft tests passed');
}

main();
