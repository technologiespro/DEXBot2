const assert = require('assert');

console.log('Running PM2 logic tests');

const {
    countManagedBots,
    isServiceApp,
} = require('../pm2');

assert.strictEqual(isServiceApp({ name: 'dexbot-cred' }), true, 'credential daemon should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-update' }), true, 'updater should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-price-adapter' }), true, 'price adapter should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'XRP-BTS' }), false, 'bot processes should not be treated as service apps');

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
