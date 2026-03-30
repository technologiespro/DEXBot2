const assert = require('assert');

console.log('Running PM2 logic tests');

const {
    countManagedBots,
    isServiceApp,
    needsPriceAdapter,
    usesAmaGridPrice,
} = require('../pm2');

assert.strictEqual(isServiceApp({ name: 'dexbot-cred' }), true, 'credential daemon should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-update' }), true, 'updater should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-price-adapter' }), true, 'price adapter should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'XRP-BTS' }), false, 'bot processes should not be treated as service apps');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should require the price adapter');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'market' }), false, 'market should not require the price adapter');
assert.strictEqual(usesAmaGridPrice({ gridPrice: '  AMA4  ' }), true, 'ama4 matching should be case-insensitive');
assert.strictEqual(needsPriceAdapter([{ gridPrice: 'market' }, { gridPrice: null }]), false, 'non-AMA bots should not require the price adapter');
assert.strictEqual(needsPriceAdapter([{ gridPrice: 'market' }, { gridPrice: 'ama2' }]), true, 'any AMA bot should require the price adapter');

assert.strictEqual(
    countManagedBots([
        { name: 'dexbot-cred' },
        { name: 'dexbot-price-adapter' },
        { name: 'dexbot-update' },
        { name: 'XRP-BTS' },
        { name: 'USD-BTS' },
    ]),
    2,
    'managed bot count should exclude service processes'
);

console.log('PM2 logic tests passed');
process.exit(0);
