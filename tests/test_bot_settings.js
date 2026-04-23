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
        { name: 'A', active: false, debtPolicy: { mpa: { minCollateralRatio: 2 } } },
        { name: 'B', assetA: 'BTS', assetB: 'USD' },
    ],
};

assert.deepStrictEqual(
    resolveRawBotEntries(raw).map((bot) => bot.name),
    ['A', 'B'],
    'resolveRawBotEntries should return the bots array'
);

assert.strictEqual(
    resolveRawBotEntries(raw)[0].debtPolicy.mpa.minCollateralRatio,
    2,
    'resolveRawBotEntries should preserve debtPolicy fields'
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

const invalidCreditOffer = {
    bots: [
        {
            name: 'C',
            assetA: 'BTS',
            assetB: 'USD',
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxCollateralRatio: 2.5,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOffer.bots[0], 0, 'test').includes('maxFeeRate'),
    'validateBotEntry should require creditOffer.maxFeeRate'
);

const invalidCreditOfferRatio = {
    bots: [
        {
            name: 'D',
            assetA: 'BTS',
            assetB: 'USD',
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxFeeRate: 30000,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOfferRatio.bots[0], 0, 'test').includes('maxCollateralRatio'),
    'validateBotEntry should require creditOffer.maxCollateralRatio'
);

console.log('bot settings tests passed');
process.exit(0);
