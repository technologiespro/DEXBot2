const assert = require('assert');

console.log('Running bot settings tests');

const {
    normalizeBotEntries,
    resolveRawBotEntries,
    selectActiveBotEntries,
    selectBotEntry,
} = require('../modules/bot_settings');

const raw = {
    bots: [
        { name: 'A', active: false },
        { name: 'B', assetA: 'BTS', assetB: 'USD' },
    ],
};

assert.deepStrictEqual(
    resolveRawBotEntries(raw).map((bot) => bot.name),
    ['A', 'B'],
    'resolveRawBotEntries should return the bots array'
);

assert.deepStrictEqual(
    selectActiveBotEntries(raw).map((bot) => bot.name),
    ['B'],
    'selectActiveBotEntries should filter inactive bots'
);

assert.strictEqual(selectBotEntry(raw, 'B').name, 'B', 'selectBotEntry should find the named bot');

const normalized = normalizeBotEntries([{ name: 'B', assetA: 'BTS', assetB: 'USD' }]);
assert.strictEqual(normalized[0].botIndex, 0, 'normalizeBotEntries should add the bot index');
assert.ok(normalized[0].botKey, 'normalizeBotEntries should create a bot key');

console.log('bot settings tests passed');
process.exit(0);
