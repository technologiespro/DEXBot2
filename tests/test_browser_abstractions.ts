const assert = require('assert');

console.log('Running browser abstraction tests');

// ── helpers ──────────────────────────────────────────────────────────────────
const MODULE_CACHE = require.cache;

function mockBrowserEnv() {
    const origWindow = (globalThis as any).window;
    (globalThis as any).window = { document: {} };
    return () => { (globalThis as any).window = origWindow; };
}

// ── 1. BrowserStorageAdapter ─────────────────────────────────────────────────
async function testBrowserStorage() {
    const { setAdapter } = require('../modules/storage');
    const createBrowserStorageAdapter = require('../modules/storage/browser_adapter');

    const adapter = createBrowserStorageAdapter();

    // writeJSON -> readJSON round-trip
    const data = { hello: 'world', num: 42 };
    adapter.writeJSON('/test/foo.json', data);
    const loaded = adapter.readJSON('/test/foo.json');
    assert.deepStrictEqual(loaded, data, 'writeJSON/readJSON round-trip');

    // exists
    assert.ok(adapter.exists('/test/foo.json'), 'exists returns true after write');
    assert.ok(!adapter.exists('/test/nonexist.json'), 'exists returns false for missing');

    // readdir
    adapter.writeJSON('/test/dir/a.json', { x: 1 });
    adapter.writeJSON('/test/dir/sub/b.json', { y: 2 });
    const entries = adapter.readdir('/test/dir');
    assert.ok(entries.includes('a.json'), 'readdir includes a.json');
    assert.ok(entries.includes('sub'), 'readdir includes sub dir');
    assert.strictEqual(entries.length, 2, 'readdir returns exactly 2 entries');

    // readdir on root
    const rootEntries = adapter.readdir('/test');
    assert.ok(rootEntries.includes('foo.json'), 'readdir root includes foo.json');
    assert.ok(rootEntries.includes('dir'), 'readdir root includes dir');

    // mkdtemp uniqueness
    const t1 = adapter.mkdtemp('/tmp/test-');
    const t2 = adapter.mkdtemp('/tmp/test-');
    assert.notStrictEqual(t1, t2, 'mkdtemp produces unique paths');

    // realpath/readlink consistency
    assert.strictEqual(adapter.realpath('/foo/bar'), '/foo/bar', 'realpath identity');
    assert.strictEqual(adapter.readlink('/foo/bar'), '/foo/bar', 'readlink identity');

    // unlink
    adapter.unlink('/test/foo.json');
    assert.ok(!adapter.exists('/test/foo.json'), 'exists false after unlink');

    setAdapter(null);
    console.log('  ✓ BrowserStorageAdapter');
}

// ── 2. Runtime interface contract ────────────────────────────────────────────
async function testRuntime() {
    const { getRuntime } = require('../modules/runtime');
    const rt = getRuntime();

    assert.strictEqual(typeof rt.exit, 'function', 'runtime.exit is function');
    assert.strictEqual(typeof rt.kill, 'function', 'runtime.kill is function');
    assert.strictEqual(typeof rt.onSignal, 'function', 'runtime.onSignal is function');
    assert.strictEqual(typeof rt.offSignal, 'function', 'runtime.offSignal is function');
    assert.strictEqual(typeof rt.cwd, 'function', 'runtime.cwd is function');
    assert.strictEqual(typeof rt.pid, 'number', 'runtime.pid is a number');
    assert.ok(rt.pid > 0, 'Node runtime pid > 0');
    assert.strictEqual(typeof rt.platform, 'string', 'runtime.platform is string');
    assert.strictEqual(typeof rt.env, 'object', 'runtime.env is object');
    assert.strictEqual(typeof rt.stdout, 'object', 'runtime.stdout is object');
    assert.strictEqual(typeof rt.stderr, 'object', 'runtime.stderr is object');

    // kill returns false for non-existent pid (both Node and Browser)
    const result = rt.kill(999999999, 'SIGINT');
    assert.strictEqual(result, false, 'runtime.kill invalid pid returns false');

    console.log('  ✓ Runtime interface');
}

// ── 3. Path API ──────────────────────────────────────────────────────────────
async function testPathApi() {
    const { path } = require('../modules/path_api');

    assert.strictEqual(path.join('a', 'b', 'c'), 'a/b/c', 'path.join POSIX');
    assert.strictEqual(path.join('/a', 'b', 'c'), '/a/b/c', 'path.join absolute');
    assert.strictEqual(path.basename('/foo/bar/baz.txt'), 'baz.txt', 'path.basename');
    assert.strictEqual(path.dirname('/foo/bar/baz.txt'), '/foo/bar', 'path.dirname');
    assert.strictEqual(path.extname('/foo/bar/baz.txt'), '.txt', 'path.extname');
    assert.strictEqual(path.isAbsolute('/foo'), true, 'path.isAbsolute true');
    assert.strictEqual(path.isAbsolute('foo'), false, 'path.isAbsolute false');
    assert.strictEqual(path.normalize('/foo/../bar/baz/./qux'), '/bar/baz/qux', 'path.normalize');
    assert.strictEqual(path.sep, '/', 'path.sep is /');

    console.log('  ✓ PathApi');
}

// ── 4. Config defaults ───────────────────────────────────────────────────────
async function testConfigDefaults() {
    const { Config } = require('../modules/config');

    assert.ok(Config, 'Config object exists');
    assert.ok(Array.isArray(Config.ARGS), 'Config.ARGS is array');
    assert.strictEqual(typeof Config.PLATFORM, 'string', 'Config.PLATFORM is string');

    console.log('  ✓ Config defaults');
}

// ── 5. Crypto sync operations ────────────────────────────────────────────────
async function testBrowserCrypto() {
    const { createHash, createHmac, randomBytes } = require('../modules/crypto/sync');

    // SHA-256
    const hash = createHash('sha256');
    hash.update('hello');
    const digest = hash.digest('hex');
    assert.strictEqual(digest.length, 64, 'SHA-256 digest is 64 hex chars');
    assert.strictEqual(digest,
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        'SHA-256 hello');

    // HMAC
    const hmac = createHmac('sha256', 'key');
    hmac.update('message');
    const hmacDigest = hmac.digest('hex');
    assert.strictEqual(hmacDigest.length, 64, 'HMAC-SHA256 digest is 64 hex chars');

    // randomBytes uniqueness
    const buf1 = randomBytes(16);
    const buf2 = randomBytes(16);
    assert.strictEqual(buf1.length, 16, 'randomBytes(16) length');
    assert.strictEqual(buf2.length, 16, 'randomBytes(16) length');
    assert.notStrictEqual(buf1.toString('hex'), buf2.toString('hex'), 'randomBytes unique');

    console.log('  ✓ BrowserCrypto');
}

// ── 6. ECC selector ──────────────────────────────────────────────────────────
async function testEccSelector() {
    const getEcc = require('../modules/bitshares-native/crypto/ecc_selector');

    const ecc = getEcc();
    assert.ok(ecc, 'getEcc() returns something');
    assert.strictEqual(typeof ecc.wifEncode, 'function', 'ecc.wifEncode is function');
    assert.strictEqual(typeof ecc.wifDecode, 'function', 'ecc.wifDecode is function');

    console.log('  ✓ ECC selector');
}

// ── 7. Integration: claw/index.ts loads without crash ────────────────────────
async function testClawIndexLoad() {
    let claw: any;
    try {
        claw = require('../claw/index');
        assert.ok(claw, 'claw/index loaded successfully');
    } catch (err: any) {
        assert.ok(
            err.message?.includes('ws') || err.message?.includes('Cannot find module'),
            `claw/index load error: ${err.message}`
        );
        console.log('  ~ claw/index: blocked by ws dependency (expected without npm install)');
        return;
    }

    assert.ok(claw.broadcastOperationViaCredentialDaemon,
        'claw has broadcastOperationViaCredentialDaemon');
    assert.ok(claw.describeMemuBridge, 'claw has describeMemuBridge');
    console.log('  ✓ claw/index loads cleanly');
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    try {
        await testBrowserStorage();
        await testRuntime();
        await testPathApi();
        await testConfigDefaults();
        await testBrowserCrypto();
        await testEccSelector();
        await testClawIndexLoad();
        console.log('\n✓ All browser abstraction tests passed');
    } catch (err: any) {
        console.error(`\n✗ FAILED: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
})();
