const assert = require('assert');
const chainKeys = require('../modules/chain_keys');

console.log('Running chain_keys master password failure tests');

const masterPasswordError = new chainKeys.MasterPasswordError('Incorrect master password after 3 attempts.');
assert.strictEqual(chainKeys.isMasterPasswordFailure(masterPasswordError), true, 'MasterPasswordError instances should be recognized');
assert.strictEqual(
    chainKeys.isMasterPasswordFailure({ code: chainKeys.MasterPasswordError.code, message: 'Incorrect master password after 3 attempts.' }),
    true,
    'plain errors carrying MASTER_PASSWORD_FAILED should be recognized'
);
assert.strictEqual(chainKeys.isMasterPasswordFailure(new Error('wrong password')), false, 'generic errors should not be treated as master password failures');
assert.strictEqual(chainKeys.isMasterPasswordFailure(null), false, 'null should not be treated as a master password failure');

console.log('chain_keys master password failure tests passed');
process.exit(0);
