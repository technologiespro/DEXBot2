const assert = require('assert');

const {
    buildMarketAdapterWhitelistNpmArgs,
} = require('../modules/cli_whitelist_args');

console.log('Running CLI whitelist argument tests');

assert.deepStrictEqual(
    buildMarketAdapterWhitelistNpmArgs([]),
    ['run', 'market-adapter:whitelist'],
    'plain whitelist command should not add an npm argument separator'
);

assert.deepStrictEqual(
    buildMarketAdapterWhitelistNpmArgs(['--dynamic-weight']),
    ['run', 'market-adapter:whitelist', '--', '--dynamic-weight'],
    'dynamic-weight flag must be forwarded after npm separator'
);

assert.deepStrictEqual(
    buildMarketAdapterWhitelistNpmArgs(['--dynamic-weight', '--no-asymmetric-bounds']),
    ['run', 'market-adapter:whitelist', '--', '--dynamic-weight', '--no-asymmetric-bounds'],
    'multiple whitelist flags should be forwarded in order'
);

console.log('CLI whitelist argument tests passed');
