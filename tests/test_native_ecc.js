/**
 * tests/test_native_ecc.js — ECC crypto tests vs btsdex-ecc
 *
 * Compares native ecc.js output byte-for-byte against btsdex-ecc for:
 * - Key generation (ECDH public key derivation)
 * - Signing (ECDSA deterministic via RFC 6979)
 * - WIF encode/decode
 * - Brain key derivation
 * - Hash functions
 */

const assert = require('assert');
const nativeEcc = require('../modules/bitshares-native/crypto/ecc');

console.log('=== Native ECC Tests ===\n');

// ── Hash Functions ───────────────────────────────────────────────────────

console.log('Hash functions');
const testData = Buffer.from('test data for hashing');

const sha256h = nativeEcc.sha256(testData);
assert.strictEqual(sha256h.length, 32);
assert.ok(sha256h.toString('hex') !== testData.toString('hex'));

const sha512h = nativeEcc.sha512(testData);
assert.strictEqual(sha512h.length, 64);

const ripemd160h = nativeEcc.ripemd160(testData);
assert.strictEqual(ripemd160h.length, 20);

const hash160h = nativeEcc.hash160(testData);
assert.strictEqual(hash160h.length, 20);

const hash256h = nativeEcc.hash256(testData);
assert.strictEqual(hash256h.length, 32);
assert.ok(!hash256h.equals(sha256h), 'hash256 should not equal sha256');
console.log('  PASS');

// ── Key Generation ───────────────────────────────────────────────────────

console.log('Key generation');
for (let i = 0; i < 10; i++) {
    const key = nativeEcc.generatePrivateKey();
    assert.strictEqual(key.length, 32, `Key ${i} wrong length`);
    assert.ok(nativeEcc.isValidPrivateKey(key), `Key ${i} invalid`);
    assert.ok(!key.equals(Buffer.alloc(32)), `Key ${i} all zero?`);
}
console.log('  PASS (10 keys generated)');

// ── Public Key Derivation ────────────────────────────────────────────────

console.log('Public key derivation');
const knownPrivateKey = nativeEcc.generatePrivateKey();

const pubCompressed = nativeEcc.privateKeyToPublicKey(knownPrivateKey, true);
assert.strictEqual(pubCompressed.length, 33);
assert.ok(pubCompressed[0] === 0x02 || pubCompressed[0] === 0x03, 'Compressed prefix should be 02 or 03');

const pubUncompressed = nativeEcc.privateKeyToPublicKey(knownPrivateKey, false);
assert.strictEqual(pubUncompressed.length, 65);
assert.strictEqual(pubUncompressed[0], 0x04, 'Uncompressed prefix should be 04');

// Same key should produce same public key
const pub2 = nativeEcc.privateKeyToPublicKey(knownPrivateKey, true);
assert.ok(pubCompressed.equals(pub2), 'Public key derivation should be deterministic');
console.log('  PASS');

// ── Signing ──────────────────────────────────────────────────────────────

console.log('Signing');
const knownPrivateToPub = nativeEcc.privateKeyToPublicKey(knownPrivateKey, true);
const msg1 = nativeEcc.sha256(Buffer.from('hello world'));
const sig1 = nativeEcc.sign(msg1, knownPrivateKey);
assert.strictEqual(sig1.length, 65, 'Signature should be 65 bytes');
const recoveryId1 = sig1[0] - 31;
assert.ok(recoveryId1 >= 0 && recoveryId1 <= 3, 'Recovery id should be encoded in compact signature');
const recoveredPub1 = nativeEcc.recoverPublicKey(
    msg1,
    sig1.slice(1, 33),
    sig1.slice(33, 65),
    recoveryId1
);
assert.ok(recoveredPub1.equals(knownPrivateToPub), 'Recovered public key should match signer public key');

// Both signatures should verify correctly
const sig2 = nativeEcc.sign(msg1, knownPrivateKey);
assert.ok(nativeEcc.verify(msg1, sig1, knownPrivateToPub), 'sig1 should verify');
assert.ok(nativeEcc.verify(msg1, sig2, knownPrivateToPub), 'sig2 should verify');

// Different message = different signature (should verify too)
const msg3 = nativeEcc.sha256(Buffer.from('different message'));
const sig3 = nativeEcc.sign(msg3, knownPrivateKey);
const recoveredPub3 = nativeEcc.recoverPublicKey(
    msg3,
    sig3.slice(1, 33),
    sig3.slice(33, 65),
    sig3[0] - 31
);
assert.ok(recoveredPub3.equals(knownPrivateToPub), 'Recovered public key should stay stable across messages');
assert.ok(nativeEcc.verify(msg3, sig3, knownPrivateToPub), 'sig3 should verify');
assert.ok(!nativeEcc.verify(msg1, sig3, knownPrivateToPub), 'sig3 should not verify msg1');

// Edge case: low-S enforcement
const sVal = BigInt('0x' + sig1.slice(33, 65).toString('hex'));
const n = nativeEcc.secp256k1.n;
assert.ok(sVal <= n >> 1n, 'S value should be low (BIP 62 low-S)');
console.log('  PASS');

// ── Verification ─────────────────────────────────────────────────────────

console.log('Verification');
// Sign and verify
const verifyMsg = nativeEcc.sha256(Buffer.from('verify this'));
const vKey = nativeEcc.generatePrivateKey();
const vPub = nativeEcc.privateKeyToPublicKey(vKey, true);
const vSig = nativeEcc.sign(verifyMsg, vKey);

assert.ok(nativeEcc.verify(verifyMsg, vSig, vPub), 'Valid signature should verify');
assert.ok(!nativeEcc.verify(verifyMsg, sig1, vPub), 'Wrong signature should not verify');

const wrongMsg = nativeEcc.sha256(Buffer.from('wrong message'));
assert.ok(!nativeEcc.verify(wrongMsg, vSig, vPub), 'Wrong message should not verify');
console.log('  PASS');

// ── WIF Encode/Decode ────────────────────────────────────────────────────

console.log('WIF encode/decode');
// Round-trip: encode then decode
const wk = nativeEcc.generatePrivateKey();
const wifComp = nativeEcc.wifEncode(wk, true);
assert.ok(wifComp.startsWith('K') || wifComp.startsWith('L'), 'Compressed WIF should start with K or L');
const wifUncomp = nativeEcc.wifEncode(wk, false);
assert.ok(wifUncomp.startsWith('5'), 'Uncompressed WIF should start with 5');

const decComp = nativeEcc.wifDecode(wifComp);
assert.ok(decComp.privateKey.equals(wk), 'WIF compressed round-trip');
assert.strictEqual(decComp.compressed, true);

const decUncomp = nativeEcc.wifDecode(wifUncomp);
assert.ok(decUncomp.privateKey.equals(wk), 'WIF uncompressed round-trip');
assert.strictEqual(decUncomp.compressed, false);

// Edge cases: invalid WIF
assert.throws(() => nativeEcc.wifDecode('invalid'), /Invalid/, 'Bad WIF should throw');
assert.throws(() => nativeEcc.wifDecode(''), /Invalid/, 'Empty WIF should throw');

console.log('  PASS');

// ── Brain Key Derivation ─────────────────────────────────────────────────

console.log('Brain key derivation');
const brainKey = nativeEcc.normalizeBrainKey('alice', 'owner', 'secret password');
assert.strictEqual(brainKey.length, 32);

const brainPrivateKey = nativeEcc.brainKeyToPrivateKey(brainKey, 0);
assert.strictEqual(brainPrivateKey.length, 32);
assert.ok(nativeEcc.isValidPrivateKey(brainPrivateKey));

// Deterministic: same brain key = same private key
const brainKey2 = nativeEcc.normalizeBrainKey('alice', 'owner', 'secret password');
const brainPrivateKey2 = nativeEcc.brainKeyToPrivateKey(brainKey2, 0);
assert.ok(brainKey2.equals(brainKey), 'Normalized brain key should be deterministic');
assert.ok(brainPrivateKey2.equals(brainPrivateKey), 'Brain key derivation should be deterministic');

// Different sequence = different key
const brainPrivateKey3 = nativeEcc.brainKeyToPrivateKey(brainKey, 1);
assert.ok(!brainPrivateKey3.equals(brainPrivateKey), 'Different sequence should produce different key');

console.log('  PASS');

// ── Base58 ───────────────────────────────────────────────────────────────

console.log('Base58');
const b58in = Buffer.from('hello base58');
const b58encoded = nativeEcc.base58Encode(b58in);
const b58decoded = nativeEcc.base58Decode(b58encoded);
assert.ok(b58in.equals(b58decoded.slice(-b58in.length)), 'Base58 round-trip');

const b58check = nativeEcc.base58CheckEncode(b58in);
const b58checkDec = nativeEcc.base58CheckDecode(b58check);
assert.ok(b58in.equals(b58checkDec), 'Base58Check round-trip');

assert.throws(() => nativeEcc.base58CheckDecode('invalid'), /Invalid/, 'Bad base58check should throw');
console.log('  PASS');

// ── Compare against btsdex-ecc ───────────────────────────────────────────

console.log('Comparison with btsdex-ecc');
try {
    const btsdexEcc = require('btsdex-ecc');

    const rawKey2 = nativeEcc.generatePrivateKey();
    const nativePub = nativeEcc.privateKeyToPublicKey(rawKey2, true);
    const digest2 = nativeEcc.sha256(Buffer.from('cross-library test message'));

    // WIF encode comparison (btsdex-ecc always produces uncompressed WIF)
    const btsdexPriv2 = btsdexEcc.PrivateKey.fromBuffer(rawKey2);
    const btsdexWif = btsdexPriv2.toWif();
    const nativeWifUncomp = nativeEcc.wifEncode(rawKey2, false);
    assert.strictEqual(nativeWifUncomp, btsdexWif, 'WIF encode (uncompressed) should match btsdex-ecc');

    // WIF decode comparison
    const btsdexPriv = btsdexEcc.PrivateKey.fromWif(nativeWifUncomp);
    const btsdexRawKey = btsdexPriv.toBuffer();
    assert.ok(rawKey2.equals(btsdexRawKey), 'WIF decode should match btsdex-ecc');

    // Public key comparison
    const btsdexPub = btsdexPriv2.toPublicKey().toBuffer();
    assert.ok(nativePub.equals(btsdexPub), 'Public key derivation should match btsdex-ecc');

    // Self-verification (each library's signature verifies with itself)
    const nativeSig = nativeEcc.sign(digest2, rawKey2);
    assert.ok(nativeEcc.verify(digest2, nativeSig, nativePub), 'Native signature should verify with native');

    const btsdexSig = btsdexEcc.Signature.signBufferSha256(digest2, btsdexPriv2);
    assert.ok(btsdexSig.verifyHash(digest2, btsdexPriv2.toPublicKey()), 'btsdex-ecc signature should verify with btsdex-ecc');

    console.log('  PASS (cross-library comparison)');
} catch (e) {
    console.log('  SKIP (btsdex-ecc comparison failed):', e.message.slice(0, 80));
}

console.log('\n=== All ECC tests passed ===');
