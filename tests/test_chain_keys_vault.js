const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running chain_keys vault tests');

const chainKeys = require('../modules/chain_keys');

function writeModernVault(keysFile, password, accounts = {}) {
    const vaultSalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const secret = chainKeys.createVaultSecret(chainKeys.deriveVaultKey(password, vaultSalt));
    const data = {
        vaultVersion: 2,
        vaultSalt: vaultSalt.toString('hex'),
        vaultVerifier: '',
        accounts: {},
    };

    data.vaultVerifier = require('crypto')
        .createHmac('sha256', Buffer.from(secret.vaultKeyHex, 'hex'))
        .update('dexbot2:v2:verifier')
        .digest('hex');

    for (const [name, privateKey] of Object.entries(accounts)) {
        data.accounts[name] = {
            encryptedKey: chainKeys.encrypt(privateKey, secret),
        };
    }

    fs.writeFileSync(keysFile, JSON.stringify(data, null, 2));
    return secret;
}

function writeLegacyVault(keysFile, password, accounts = {}) {
    const data = {
        masterPasswordHash: chainKeys.hashPassword(password),
        accounts: {},
    };

    for (const [name, privateKey] of Object.entries(accounts)) {
        const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
        const iv = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
        const key = require('crypto').scryptSync(password, salt, 32);
        const cipher = require('crypto').createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(privateKey, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        data.accounts[name] = {
            encryptedKey: [
                salt.toString('hex'),
                iv.toString('hex'),
                authTag.toString('hex'),
                encrypted,
            ].join(':'),
        };
    }

    fs.writeFileSync(keysFile, JSON.stringify(data, null, 2));
}

async function withTempKeysFile(runTest) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-chain-keys-'));
    const keysFile = path.join(tempDir, 'keys.json');
    const originalKeysFile = process.env.DEXBOT_KEYS_FILE;

    process.env.DEXBOT_KEYS_FILE = keysFile;

    try {
        await runTest(keysFile);
    } finally {
        if (typeof originalKeysFile === 'string') {
            process.env.DEXBOT_KEYS_FILE = originalKeysFile;
        } else {
            delete process.env.DEXBOT_KEYS_FILE;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function loadIsolatedChainKeys({ readInput, readPassword }) {
    const chainKeysPath = require.resolve('../modules/chain_keys');
    const systemPath = require.resolve('../modules/order/utils/system');
    const originalChainKeys = require.cache[chainKeysPath];
    const originalSystem = setCachedModule(systemPath, {
        readInput,
        readPassword,
    });

    delete require.cache[chainKeysPath];

    try {
        const isolatedChainKeys = require('../modules/chain_keys');
        return {
            chainKeys: isolatedChainKeys,
            restore() {
                restoreCachedModule(chainKeysPath, originalChainKeys);
                restoreCachedModule(systemPath, originalSystem);
            },
        };
    } catch (error) {
        restoreCachedModule(chainKeysPath, originalChainKeys);
        restoreCachedModule(systemPath, originalSystem);
        throw error;
    }
}

function testDerivedVaultRoundtrip() {
    const password = 'correct horse battery staple';
    const vaultSalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const vaultKey1 = chainKeys.deriveVaultKey(password, vaultSalt);
    const vaultKey2 = chainKeys.deriveVaultKey(password, vaultSalt);

    assert.strictEqual(vaultKey1.length, 32, 'derived vault key should be 32 bytes');
    assert.strictEqual(vaultKey1.toString('hex'), vaultKey2.toString('hex'), 'scrypt derivation should be deterministic for the same password and salt');

    const secret = chainKeys.createVaultSecret(vaultKey1);
    assert.strictEqual(chainKeys.isVaultSecret(secret), true, 'derived secret should be recognized');
    assert.strictEqual(typeof secret.vaultKeyHex, 'string', 'secret should carry a hex-encoded vault key');

    const ciphertext = chainKeys.encrypt('5K-example-private-key', secret);
    assert.ok(ciphertext.startsWith('v2:'), 'vault encryption should emit a versioned payload');
    assert.strictEqual(
        chainKeys.decrypt(ciphertext, secret),
        '5K-example-private-key',
        'vault secret should decrypt its own ciphertext'
    );

    const sessionSaltA = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    const sessionSaltB = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const sessionSecretA = chainKeys.createSessionSecret(secret, sessionSaltA);
    const sessionSecretB = chainKeys.createSessionSecret(secret, sessionSaltB);

    assert.strictEqual(sessionSecretA.kind, 'dexbot-session-secret', 'session secret should be tagged as session-only');
    assert.strictEqual(sessionSecretA.sessionSaltHex, sessionSaltA.toString('hex'), 'session secret should expose the salt used for derivation');
    assert.notStrictEqual(sessionSecretA.vaultKeyHex, secret.vaultKeyHex, 'session secret should not reuse the master-derived vault key');
    assert.notStrictEqual(sessionSecretA.vaultKeyHex, sessionSecretB.vaultKeyHex, 'different session salts should produce different session keys');

    const sessionCiphertext = chainKeys.encrypt('5K-session-private-key', sessionSecretA);
    assert.strictEqual(
        chainKeys.decrypt(sessionCiphertext, sessionSecretA),
        '5K-session-private-key',
        'session secret should encrypt and decrypt its own ciphertext'
    );
}

function testLegacyPayloadRejected() {
    assert.throws(
        () => chainKeys.decrypt('abcd:abcd:abcd:abcd', { kind: 'dexbot-vault-secret', vaultKeyHex: '00' }),
        /Legacy encrypted data requires migration before decrypt/,
        'legacy ciphertext format should be rejected'
    );
}

async function testAuthenticateRetriesAndMigratesLegacyVault() {
    await withTempKeysFile(async (keysFile) => {
        const password = 'modern-password';
        const privateKey = 'd'.repeat(64);
        writeLegacyVault(keysFile, password, { alice: privateKey });

        const readPasswordResponses = ['wrong-password', password];
        const prompts = [];
        const logs = [];
        const originalLog = console.log;
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async () => '',
            readPassword: async (prompt) => {
                prompts.push(prompt);
                return readPasswordResponses.shift() ?? '';
            },
        });

        try {
            console.log = (...args) => logs.push(args.join(' '));
            const secret = await isolatedChainKeys.authenticate();

            assert.strictEqual(
                prompts.filter((prompt) => prompt === 'Enter master password: ').length,
                2,
                'legacy vault unlock should reprompt after a wrong password'
            );
            assert.ok(
                logs.includes('Master password not correct. Please try again.'),
                'wrong legacy password should emit the normal retry message'
            );
            assert.strictEqual(
                isolatedChainKeys.getPrivateKey('alice', secret),
                privateKey,
                'successful legacy unlock should migrate and decrypt stored keys'
            );

            const persisted = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
            assert.strictEqual(persisted.masterPasswordHash, undefined, 'legacy hash should be removed after migration');
            assert.strictEqual(persisted.vaultVersion, 2, 'legacy vault should be upgraded in place');
            assert.ok(persisted.accounts.alice.encryptedKey.startsWith('v2:'), 'migrated records should use v2 encryption');
        } finally {
            console.log = originalLog;
            restore();
        }
    });
}

async function testUnlockWithPasswordOnModernVault() {
    await withTempKeysFile(async (keysFile) => {
        writeModernVault(keysFile, 'modern-password', { alice: 'a'.repeat(64) });
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async () => '',
            readPassword: async () => '',
        });

        try {
            const secret = isolatedChainKeys.unlockWithPassword('modern-password');

            assert.strictEqual(
                isolatedChainKeys.getPrivateKey('alice', secret),
                'a'.repeat(64),
                'raw password unlock helper should return a usable derived secret'
            );
        } finally {
            restore();
        }
    });
}

async function testInteractiveSessionPersistsModernState() {
    await withTempKeysFile(async (keysFile) => {
        const password = 'modern-password';
        const initialPrivateKey = 'b'.repeat(64);
        const addedPrivateKey = 'a'.repeat(64);
        writeModernVault(keysFile, password, { alice: initialPrivateKey });

        const readInputResponses = ['1', 'bob', ''];
        const readPasswordResponses = [password, addedPrivateKey];
        const prompts = [];
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async (prompt) => {
                prompts.push(prompt);
                return readInputResponses.shift() ?? '';
            },
            readPassword: async (prompt) => {
                prompts.push(prompt);
                return readPasswordResponses.shift() ?? '';
            },
        });

        try {
            await isolatedChainKeys.main();

            const persisted = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
            assert.strictEqual(persisted.vaultVersion, 2, 'interactive session should keep modern vault metadata');
            assert.ok(persisted.accounts.alice.encryptedKey.startsWith('v2:'), 'existing records should stay in v2 format');
            assert.ok(persisted.accounts.bob.encryptedKey.startsWith('v2:'), 'new records should use v2 encryption');

            const secret = isolatedChainKeys.unlockWithPassword(password);
            assert.strictEqual(isolatedChainKeys.getPrivateKey('alice', secret), initialPrivateKey, 'existing keys should remain decryptable');
            assert.strictEqual(isolatedChainKeys.getPrivateKey('bob', secret), addedPrivateKey, 'new keys should remain decryptable');
            assert.ok(prompts.includes('Enter account name: '), 'test should drive the add-key flow after authentication');
        } finally {
            restore();
        }
    });
}

async function testChangePasswordRequiresCurrentPasswordPrompt() {
    await withTempKeysFile(async (keysFile) => {
        const password = 'modern-password';
        const privateKey = 'c'.repeat(64);
        writeModernVault(keysFile, password, { alice: privateKey });

        const readInputResponses = ['6', ''];
        const readPasswordResponses = [password, 'wrong-current-password', 'new-password', 'new-password'];
        const prompts = [];
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async (prompt) => {
                prompts.push(prompt);
                return readInputResponses.shift() ?? '';
            },
            readPassword: async (prompt) => {
                prompts.push(prompt);
                return readPasswordResponses.shift() ?? '';
            },
        });

        try {
            await isolatedChainKeys.main();

            assert.strictEqual(
                prompts.filter((prompt) => prompt === 'Enter current master password: ').length,
                1,
                'changing the master password should always require the current password'
            );

            const secret = isolatedChainKeys.unlockWithPassword(password);
            assert.strictEqual(
                isolatedChainKeys.getPrivateKey('alice', secret),
                privateKey,
                'failed password change should leave the stored key readable with the original password'
            );
        } finally {
            restore();
        }
    });
}

testDerivedVaultRoundtrip();
testLegacyPayloadRejected();
Promise.resolve()
    .then(testAuthenticateRetriesAndMigratesLegacyVault)
    .then(testUnlockWithPasswordOnModernVault)
    .then(testInteractiveSessionPersistsModernState)
    .then(testChangePasswordRequiresCurrentPasswordPrompt)
    .then(() => {
        console.log('chain_keys vault tests passed');
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
