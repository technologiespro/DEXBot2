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

const invalidCreditOfferRatio = {
    bots: [
        {
            name: 'D',
            assetA: 'BTS',
            assetB: 'USD',
            activeOrders: { sell: 20, buy: 20 },
            botFunds: { sell: '100%', buy: '100%' },
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxBorrowAmount: 1000,
                    maxCollateralAmount: 25000,
                    maxFeeRatePerDay: 0.001,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOfferRatio.bots[0], 0, 'test').includes('maxCollateralRatio'),
    'validateBotEntry should require creditOffer.maxCollateralRatio'
);

const validCreditOfferPerDay = {
    bots: [
        {
            name: 'E',
            assetA: 'BTS',
            assetB: 'USD',
            activeOrders: { sell: 20, buy: 20 },
            botFunds: { sell: '100%', buy: '100%' },
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxBorrowAmount: 1000,
                    maxCollateralAmount: '25%',
                    maxFeeRatePerDay: 0.001,
                    maxCollateralRatio: 2.5,
                },
            },
        },
    ],
};

assert.strictEqual(
    require('../modules/bot_settings').validateBotEntry(validCreditOfferPerDay.bots[0], 0, 'test'),
    null,
    'validateBotEntry should accept maxFeeRatePerDay instead of maxFeeRate'
);

const invalidCreditOfferBorrowCap = {
    bots: [
        {
            name: 'G',
            assetA: 'BTS',
            assetB: 'USD',
            activeOrders: { sell: 20, buy: 20 },
            botFunds: { sell: '100%', buy: '100%' },
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxBorrowAmount: 0,
                    maxCollateralRatio: 2.5,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOfferBorrowCap.bots[0], 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject non-positive maxBorrowAmount'
);

const invalidCreditOfferBorrowPercent = {
    bots: [
        {
            name: 'H',
            assetA: 'BTS',
            assetB: 'USD',
            activeOrders: { sell: 20, buy: 20 },
            botFunds: { sell: '100%', buy: '100%' },
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxBorrowAmount: '25%',
                    maxCollateralRatio: 2.5,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOfferBorrowPercent.bots[0], 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject percentage maxBorrowAmount'
);

const invalidCreditOfferPerDay = {
    bots: [
        {
            name: 'F',
            assetA: 'BTS',
            assetB: 'USD',
            activeOrders: { sell: 20, buy: 20 },
            botFunds: { sell: '100%', buy: '100%' },
            debtPolicy: {
                creditOffer: {
                    allowedOfferIds: ['1.18.42'],
                    maxFeeRatePerDay: -0.001,
                    maxCollateralRatio: 2.5,
                },
            },
        },
    ],
};

assert(
    require('../modules/bot_settings').validateBotEntry(invalidCreditOfferPerDay.bots[0], 0, 'test').includes('maxFeeRatePerDay'),
    'validateBotEntry should reject negative maxFeeRatePerDay'
);

console.log('bot settings tests passed');
process.exit(0);
