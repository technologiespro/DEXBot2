const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readHeadlessPassword } = require('../modules/launcher/headless_password');

console.log('Running headless password helper tests');

const originalEnv = process.env.DEXBOT_MASTER_PASSWORD;

// Test 1: reads from env var
process.env.DEXBOT_MASTER_PASSWORD = 'secret-from-env';
assert.strictEqual(
    readHeadlessPassword({}),
    'secret-from-env',
    'should read password from DEXBOT_MASTER_PASSWORD env var'
);

// Test 2: env var takes effect when no passwordFile given
assert.strictEqual(
    readHeadlessPassword({ passwordFile: null }),
    'secret-from-env',
    'should read from env when passwordFile is null'
);

// Test 3: throws when no source available
delete process.env.DEXBOT_MASTER_PASSWORD;
assert.throws(
    () => readHeadlessPassword({}),
    /Headless mode requires either --password-file <path> or DEXBOT_MASTER_PASSWORD env var/,
    'should throw when no password source available'
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-headless-test-'));
try {
    process.env.DEXBOT_MASTER_PASSWORD = originalEnv;

    // Test 4: reads from password file
    const pwFile = path.join(tmpDir, 'password.txt');
    fs.writeFileSync(pwFile, 'secret-from-file\n', { mode: 0o400 });
    fs.chmodSync(pwFile, 0o400);

    assert.strictEqual(
        readHeadlessPassword({ passwordFile: pwFile }),
        'secret-from-file',
        'should read password from file (first line)'
    );

    // Test 5: passwordFile takes precedence over env var
    process.env.DEXBOT_MASTER_PASSWORD = 'env-secret';
    assert.strictEqual(
        readHeadlessPassword({ passwordFile: pwFile }),
        'secret-from-file',
        'password-file should take precedence over env var'
    );

    // Test 6: strips trailing whitespace from file content
    const pwFile2 = path.join(tmpDir, 'password2.txt');
    fs.writeFileSync(pwFile2, '  secret-with-spaces  \n', { mode: 0o400 });
    fs.chmodSync(pwFile2, 0o400);
    assert.strictEqual(
        readHeadlessPassword({ passwordFile: pwFile2 }),
        'secret-with-spaces',
        'should trim whitespace from file content'
    );

    // Test 7: uses only first line
    const pwFile3 = path.join(tmpDir, 'password3.txt');
    fs.writeFileSync(pwFile3, 'first-line\nsecond-line\n', { mode: 0o400 });
    fs.chmodSync(pwFile3, 0o400);
    assert.strictEqual(
        readHeadlessPassword({ passwordFile: pwFile3 }),
        'first-line',
        'should use only the first line of the password file'
    );

    // Test 8: throws on empty file
    const pwFile4 = path.join(tmpDir, 'password4.txt');
    fs.writeFileSync(pwFile4, '', { mode: 0o400 });
    fs.chmodSync(pwFile4, 0o400);
    assert.throws(
        () => readHeadlessPassword({ passwordFile: pwFile4 }),
        /is empty/,
        'should throw when password file is empty'
    );

    // Test 9: throws on missing file
    assert.throws(
        () => readHeadlessPassword({ passwordFile: path.join(tmpDir, 'does-not-exist.txt') }),
        /Cannot read master password/,
        'should throw when password file does not exist'
    );
} finally {
    // Cleanup
    for (const file of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, file));
    }
    fs.rmdirSync(tmpDir);
    if (originalEnv === undefined) {
        delete process.env.DEXBOT_MASTER_PASSWORD;
    } else {
        process.env.DEXBOT_MASTER_PASSWORD = originalEnv;
    }
}

console.log('headless password helper tests passed');
process.exit(0);
