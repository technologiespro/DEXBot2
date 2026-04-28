const assert = require('assert');

console.log('Running bot settings tests');

const {
    normalizeBotEntries,
    resolveRawBotEntries,
    selectActiveBotEntries,
    selectBotEntry,
    validateBotEntry,
} = require('../modules/bot_settings');

const raw = {
    bots: [
        { name: 'A', active: false, debtPolicy: { lending: [{ asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', maxCollateralRatio: 2.0 }] } },
        { name: 'B', assetA: 'BTS', assetB: 'USD' },
    ],
};

assert.deepStrictEqual(
    resolveRawBotEntries(raw).map((bot) => bot.name),
    ['A', 'B'],
    'resolveRawBotEntries should return the bots array'
);

assert.strictEqual(
    resolveRawBotEntries(raw)[0].debtPolicy.lending[0].asset,
    'USD',
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

// Test: collateralAsset is required
const missingCollateralAsset = {
    name: 'C',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD', type: 'mpa', targetCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(missingCollateralAsset, 0, 'test').includes('collateralAsset'),
    'validateBotEntry should require collateralAsset'
);

// Test: lending array is required
const missingLending = {
    name: 'D',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
    },
};

assert(
    validateBotEntry(missingLending, 0, 'test').includes('lending'),
    'validateBotEntry should require lending array'
);

// Test: creditOffer maxCollateralRatio is required
const invalidCreditOfferRatio = {
    name: 'E',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: 1000,
                maxCollateralAmount: 25000,
                maxFeeRatePerDay: 0.001,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferRatio, 0, 'test').includes('maxCollateralRatio'),
    'validateBotEntry should require creditOffer.maxCollateralRatio'
);

// Test: valid creditOffer config passes
const validCreditOffer = {
    name: 'F',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                ratio: 1,
                maxBorrowAmount: 1000,
                maxCollateralAmount: '25%',
                maxFeeRatePerDay: 0.001,
                maxCollateralRatio: 2.5,
                autoReborrow: true,
            },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validCreditOffer, 0, 'test'),
    null,
    'validateBotEntry should accept valid creditOffer lending item'
);

// Test: non-positive maxBorrowAmount is rejected
const invalidCreditOfferBorrowCap = {
    name: 'G',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: 0,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferBorrowCap, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject non-positive maxBorrowAmount'
);

// Test: percentage maxBorrowAmount is rejected
const invalidCreditOfferBorrowPercent = {
    name: 'H',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxBorrowAmount: '25%',
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferBorrowPercent, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject percentage maxBorrowAmount'
);

// Test: negative maxFeeRatePerDay is rejected
const invalidCreditOfferPerDay = {
    name: 'I',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'creditOffer',
                maxFeeRatePerDay: -0.001,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidCreditOfferPerDay, 0, 'test').includes('maxFeeRatePerDay'),
    'validateBotEntry should reject negative maxFeeRatePerDay'
);

// Test: MPA non-positive maxBorrowAmount is rejected
const invalidMpaBorrowCap = {
    name: 'J',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                maxBorrowAmount: 0,
                maxCollateralRatio: 2.5,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaBorrowCap, 0, 'test').includes('maxBorrowAmount'),
    'validateBotEntry should reject non-positive MPA maxBorrowAmount'
);

// Test: MPA minCollateralRatio > maxCollateralRatio is rejected
const invalidMpaCrRange = {
    name: 'J',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                minCollateralRatio: 3.0,
                maxCollateralRatio: 2.0,
            },
        ],
    },
};

assert(
    validateBotEntry(invalidMpaCrRange, 0, 'test').includes('minCollateralRatio'),
    'validateBotEntry should reject minCollateralRatio > maxCollateralRatio'
);

// Test: valid MPA config passes
const validMpa = {
    name: 'K',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        maxCollateralAmount: 10000,
        lending: [
            {
                asset: 'USD',
                    collateralAsset: 'BTS',
                type: 'mpa',
                ratio: 1,
                maxBorrowAmount: 1000,
                maxCollateralAmount: 5000,
                minCollateralRatio: 2.0,
                maxCollateralRatio: 2.5,
                targetCollateralRatio: 2.2,
            },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(validMpa, 0, 'test'),
    null,
    'validateBotEntry should accept valid MPA lending item'
);

// Test: invalid type is rejected
const invalidType = {
    name: 'L',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'invalid', maxCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(invalidType, 0, 'test').includes("type must be 'mpa' or 'creditOffer'"),
    'validateBotEntry should reject invalid lending type'
);

// Test: negative ratio is rejected
const negativeRatio = {
    name: 'M',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', ratio: -1, maxCollateralRatio: 2.0 },
        ],
    },
};

assert(
    validateBotEntry(negativeRatio, 0, 'test').includes('ratio'),
    'validateBotEntry should reject negative ratio'
);

// Test: global maxCollateralAmount percentage is accepted
const globalMaxCollateralPercent = {
    name: 'N',
    assetA: 'BTS',
    assetB: 'USD',
    activeOrders: { sell: 20, buy: 20 },
    botFunds: { sell: '100%', buy: '100%' },
    debtPolicy: {
        maxCollateralAmount: '80%',
        lending: [
            { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', maxCollateralRatio: 2.0 },
        ],
    },
};

assert.strictEqual(
    validateBotEntry(globalMaxCollateralPercent, 0, 'test'),
    null,
    'validateBotEntry should accept percentage global maxCollateralAmount'
);

console.log('bot settings tests passed');
process.exit(0);
