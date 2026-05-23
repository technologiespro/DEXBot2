'use strict';

const crypto = require('crypto');

const secp256k1 = {
    p: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F'),
    n: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    Gx: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
    Gy: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8'),
    a: BigInt(0),
    b: BigInt(7),
};

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const SEC1_DER_PREFIX = Buffer.from('302e0201010420', 'hex');
const SEC1_DER_SUFFIX = Buffer.from('a00706052b8104000a', 'hex');
const SECP256K1_BASE_POINT = {
    x: secp256k1.Gx,
    y: secp256k1.Gy,
};

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

function sha512(data) {
    return crypto.createHash('sha512').update(data).digest();
}

function ripemd160(data) {
    return crypto.createHash('ripemd160').update(data).digest();
}

function hash160(data) {
    return ripemd160(sha256(data));
}

function hash256(data) {
    return sha256(sha256(data));
}

function randomBytes(length) {
    return crypto.randomBytes(length);
}

function privateKeyFromRaw(rawKey) {
    const keyData = Buffer.concat([SEC1_DER_PREFIX, rawKey, SEC1_DER_SUFFIX]);
    return crypto.createPrivateKey({
        key: keyData,
        format: 'der',
        type: 'sec1',
    });
}

function generatePrivateKey() {
    let key;
    do {
        key = randomBytes(32);
    } while (!isValidPrivateKey(key));
    return key;
}

function isValidPrivateKey(rawKey) {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) return false;
    const keyInt = BigInt('0x' + rawKey.toString('hex'));
    return keyInt > 0n && keyInt < secp256k1.n;
}

function privateKeyToPublicKey(rawKey, compressed = true) {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
        throw new Error('Invalid private key: must be 32 bytes');
    }
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(rawKey);
    return ecdh.getPublicKey(null, compressed ? 'compressed' : 'uncompressed');
}

function sigFromDer(derSig) {
    const rStart = derSig[0] === 0x30 && derSig[1] > 0 ? 4 : 3;
    const rLen = derSig[rStart - 1];
    const r = derSig.slice(rStart, rStart + rLen);
    const sStart = rStart + rLen + 2;
    const sLen = derSig[sStart - 1];
    const s = derSig.slice(sStart, sStart + sLen);
    return { r, s };
}

function bigIntFromBuffer(buf) {
    return BigInt('0x' + buf.toString('hex'));
}

function bufferFromBigInt(bn, length = 32) {
    let hex = bn.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (hex.length > length * 2) hex = hex.slice(hex.length - length * 2);
    if (hex.length < length * 2) hex = hex.padStart(length * 2, '0');
    return Buffer.from(hex, 'hex');
}

function mod(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
}

function publicKeyFromBuffer(pubKeyBuffer) {
    if (!Buffer.isBuffer(pubKeyBuffer)) {
        throw new Error('public key must be a Buffer');
    }
    return pubKeyBuffer;
}

function publicKeyFromPoint(point) {
    const prefix = (point.y & 1n) === 1n ? 0x03 : 0x02;
    const xBuf = bufferFromBigInt(point.x, 32);
    return Buffer.concat([Buffer.from([prefix]), xBuf]);
}

function pointFromPublicKey(pubKeyBuffer) {
    if (!Buffer.isBuffer(pubKeyBuffer)) {
        throw new Error('public key must be a Buffer');
    }
    if (pubKeyBuffer.length === 33) {
        const prefix = pubKeyBuffer[0];
        if (prefix !== 0x02 && prefix !== 0x03) {
            throw new Error('Unsupported compressed public key prefix');
        }
        const x = bigIntFromBuffer(pubKeyBuffer.slice(1));
        const alpha = mod(x * x * x + secp256k1.a * x + secp256k1.b, secp256k1.p);
        let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);
        if ((y & 1n) !== BigInt(prefix & 1)) {
            y = secp256k1.p - y;
        }
        return { x, y };
    }
    if (pubKeyBuffer.length === 65 && pubKeyBuffer[0] === 0x04) {
        return {
            x: bigIntFromBuffer(pubKeyBuffer.slice(1, 33)),
            y: bigIntFromBuffer(pubKeyBuffer.slice(33, 65)),
        };
    }
    if (pubKeyBuffer.length === 64) {
        return {
            x: bigIntFromBuffer(pubKeyBuffer.slice(0, 32)),
            y: bigIntFromBuffer(pubKeyBuffer.slice(32, 64)),
        };
    }
    throw new Error('Unsupported public key length: ' + pubKeyBuffer.length);
}

function deterministicK(digest, privateKey) {
    const x = bufferFromBigInt(bigIntFromBuffer(privateKey), 32);
    const h1 = bufferFromBigInt(bigIntFromBuffer(digest) % secp256k1.n, 32);
    let K = Buffer.alloc(32, 0x00);
    let V = Buffer.alloc(32, 0x01);

    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00]), x, h1]));
    V = hmacSha256(K, V);
    K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x01]), x, h1]));
    V = hmacSha256(K, V);

    while (true) {
        V = hmacSha256(K, V);
        const candidate = bigIntFromBuffer(V);
        if (candidate > 0n && candidate < secp256k1.n) {
            return candidate;
        }
        K = hmacSha256(K, Buffer.concat([V, Buffer.from([0x00])]));
        V = hmacSha256(K, V);
    }
}

function recoverPublicKey(digest, r, s, recoveryId) {
    const n = secp256k1.n;
    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    const e = bigIntFromBuffer(digest) % n;

    if (rBig < 1n || rBig >= n || sBig < 1n || sBig >= n) {
        throw new Error('Invalid signature parameters');
    }

    const isYOdd = recoveryId & 1;
    const recoveryGroup = recoveryId >> 1;
    const x = rBig + BigInt(recoveryGroup) * n;
    if (x >= secp256k1.p) {
        throw new Error('Invalid recovery point');
    }

    const alpha = (x * x * x + secp256k1.a * x + secp256k1.b) % secp256k1.p;
    let y = modPow(alpha, (secp256k1.p + 1n) / 4n, secp256k1.p);

    if ((y & 1n) !== BigInt(isYOdd)) {
        y = secp256k1.p - y;
    }

    const R = { x, y };

    const rInv = modInverse(rBig, n);
    const eNeg = (n - (e % n)) % n;
    const sr = ecPointMul(R, sBig);
    const eGNeg = ecPointMul(SECP256K1_BASE_POINT, eNeg);
    const sum = ecPointAdd(sr, eGNeg);
    if (!sum) {
        throw new Error('Failed to recover public key point');
    }
    const Q = ecPointMul(
        sum,
        rInv
    );
    if (!Q) {
        throw new Error('Failed to recover public key');
    }
    return publicKeyFromPoint(Q);
}

function modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function modInverse(a, n) {
    let [t, newT] = [0n, 1n];
    let [r, newR] = [n, a];
    while (newR !== 0n) {
        const quotient = r / newR;
        [t, newT] = [newT, t - quotient * newT];
        [r, newR] = [newR, r - quotient * newR];
    }
    if (r > 1n) throw new Error('modular inverse does not exist');
    if (t < 0n) t += n;
    return t;
}

function ecPointMul(point, scalar) {
    if (scalar === 0n) return null;
    if (scalar < 0n) {
        return ecPointMul({ x: point.x, y: secp256k1.p - point.y }, -scalar);
    }

    let result = null;
    let addend = { x: point.x, y: point.y };
    let s = scalar;

    while (s > 0n) {
        if (s & 1n) {
            result = result ? ecPointAdd(result, addend) : addend;
        }
        addend = ecPointAdd(addend, addend);
        s >>= 1n;
    }
    return result;
}

function ecPointAdd(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.x === b.x && a.y === b.y) {
        return ecPointDouble(a);
    }
    if (a.x === b.x) return null;

    const p = secp256k1.p;
    const lam = mod((b.y - a.y) * modInverse(mod(b.x - a.x, p), p), p);
    const x = mod(lam * lam - a.x - b.x, p);
    const y = mod(lam * (a.x - x) - a.y, p);

    return { x, y };
}

function ecPointDouble(point) {
    const p = secp256k1.p;
    const lam = mod((3n * point.x * point.x + secp256k1.a) * modInverse(mod(2n * point.y, p), p), p);
    const x = mod(lam * lam - 2n * point.x, p);
    const y = mod(lam * (point.x - x) - point.y, p);

    return { x, y };
}

function sign(digest, privateKey) {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }

    const d = bigIntFromBuffer(privateKey);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    let k = deterministicK(digest, privateKey);
    let R = ecPointMul(SECP256K1_BASE_POINT, k);
    let rBig = R ? R.x % secp256k1.n : 0n;

    while (!R || rBig === 0n) {
        k = mod(k + 1n, secp256k1.n);
        if (k === 0n) k = 1n;
        R = ecPointMul(SECP256K1_BASE_POINT, k);
        rBig = R ? R.x % secp256k1.n : 0n;
    }

    let sBig = mod(modInverse(k, secp256k1.n) * (e + rBig * d), secp256k1.n);
    if (sBig === 0n) {
        throw new Error('Failed to generate non-zero signature scalar');
    }

    const nHalf = secp256k1.n >> 1n;
    let recoveryId = (R.y & 1n) === 1n ? 1 : 0;
    if (R.x >= secp256k1.n) {
        recoveryId |= 2;
    }
    if (sBig > nHalf) {
        sBig = secp256k1.n - sBig;
        recoveryId ^= 1;
    }

    const r = bufferFromBigInt(rBig, 32);
    const finalS = bufferFromBigInt(sBig, 32);

    const pubKeyKnown = privateKeyToPublicKey(privateKey, true);

    for (let i = 0; i < 4; i++) {
        try {
            const recovered = recoverPublicKey(digest, r, finalS, i);
            if (Buffer.isBuffer(recovered) && recovered.equals(pubKeyKnown)) {
                recoveryId = i;
                break;
            }
        } catch (_) {}
    }
    if (recoveryId < 0 || recoveryId > 3) {
        throw new Error('Failed to derive compact signature recovery id');
    }

    const compactI = recoveryId + 27 + 4;
    return Buffer.concat([r, finalS, Buffer.from([compactI])]);
}

function verify(digest, signature, publicKey) {
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
        throw new Error('Digest must be 32 bytes');
    }

    let r;
    let s;
    if (signature.length === 65) {
        r = signature.slice(0, 32);
        s = signature.slice(32, 64);
    } else if (signature.length === 64) {
        r = signature.slice(0, 32);
        s = signature.slice(32, 64);
    } else {
        throw new Error('Invalid signature length: ' + signature.length);
    }

    const rBig = bigIntFromBuffer(r);
    const sBig = bigIntFromBuffer(s);
    if (rBig <= 0n || rBig >= secp256k1.n || sBig <= 0n || sBig >= secp256k1.n) {
        return false;
    }

    const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, 'hex');
    const Q = pointFromPublicKey(pubBuf);
    const e = bigIntFromBuffer(digest) % secp256k1.n;
    const w = modInverse(sBig, secp256k1.n);
    const u1 = mod(e * w, secp256k1.n);
    const u2 = mod(rBig * w, secp256k1.n);
    const point = ecPointAdd(
        ecPointMul(SECP256K1_BASE_POINT, u1),
        ecPointMul(Q, u2)
    );

    if (!point) {
        return false;
    }

    return mod(point.x, secp256k1.n) === rBig;
}

function buildPublicKeyDer(compressedPub) {
    let point;
    if (compressedPub.length === 64) {
        point = Buffer.concat([Buffer.from([0x04]), compressedPub]);
    } else if (compressedPub.length === 33) {
        const prefix = compressedPub[0];
        const x = bigIntFromBuffer(compressedPub.slice(1, 33));
        const x3 = x * x * x;
        const ySq = (x3 + secp256k1.b) % secp256k1.p;
        let y = modPow(ySq, (secp256k1.p + 1n) / 4n, secp256k1.p);
        const isOdd = (prefix === 0x03);
        if ((y & 1n) !== BigInt(isOdd)) {
            y = secp256k1.p - y;
        }
        point = Buffer.concat([
            Buffer.from([0x04]),
            bufferFromBigInt(x, 32),
            bufferFromBigInt(y, 32),
        ]);
    } else if (compressedPub.length === 65) {
        point = compressedPub;
    } else {
        throw new Error('Unsupported public key length: ' + compressedPub.length);
    }

    const seqHeader = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
    return Buffer.concat([seqHeader, point]);
}

function buildSignatureDer(r, s) {
    const encodeInt = (buf) => {
        let data = buf;
        if (data[0] & 0x80) {
            data = Buffer.concat([Buffer.from([0x00]), data]);
        }
        return Buffer.concat([
            Buffer.from([0x02, data.length]),
            data,
        ]);
    };

    const rEnc = encodeInt(r);
    const sEnc = encodeInt(s);

    return Buffer.concat([
        Buffer.from([0x30, rEnc.length + sEnc.length]),
        rEnc,
        sEnc,
    ]);
}

function wifEncode(privateKey, compressed = true) {
    if (!Buffer.isBuffer(privateKey) || privateKey.length !== 32) {
        throw new Error('Private key must be 32 bytes');
    }
    const prefix = Buffer.from([0x80]);
    let payload = Buffer.concat([prefix, privateKey]);
    if (compressed) {
        payload = Buffer.concat([payload, Buffer.from([0x01])]);
    }
    return base58CheckEncode(payload);
}

function wifDecode(wif) {
    const payload = base58CheckDecode(wif);
    if (!payload || payload.length < 33) {
        throw new Error('Invalid WIF: too short');
    }
    if (payload[0] !== 0x80) {
        throw new Error('Invalid WIF: wrong version byte');
    }
    const compressed = payload.length === 34 && payload[33] === 0x01;
    const privateKey = payload.slice(1, 33);
    if (!isValidPrivateKey(privateKey)) {
        throw new Error('Invalid WIF: invalid private key');
    }
    return { privateKey, compressed };
}

function base58Encode(buf) {
    let num = BigInt('0x' + buf.toString('hex'));
    let encoded = '';
    while (num > 0n) {
        const remainder = Number(num % 58n);
        encoded = BASE58_ALPHABET[remainder] + encoded;
        num = num / 58n;
    }
    for (let i = 0; i < buf.length && buf[i] === 0; i++) {
        encoded = '1' + encoded;
    }
    return encoded;
}

function base58Decode(str) {
    let num = 0n;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        const index = BASE58_ALPHABET.indexOf(c);
        if (index === -1) throw new Error('Invalid base58 character: ' + c);
        num = num * 58n + BigInt(index);
    }
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;

    let leadingZeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
        leadingZeros++;
    }

    return Buffer.from('00'.repeat(leadingZeros) + hex, 'hex');
}

function base58CheckEncode(payload) {
    const checksum = hash256(payload).slice(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]));
}

function base58CheckDecode(str) {
    const decoded = base58Decode(str);
    if (decoded.length < 4) throw new Error('Invalid base58check: too short');
    const payload = decoded.slice(0, -4);
    const checksum = decoded.slice(-4);
    const expected = hash256(payload).slice(0, 4);
    if (!checksum.equals(expected)) throw new Error('Invalid base58check: checksum mismatch');
    return payload;
}

function normalizeBrainKey(name, role, password) {
    const combined = `${name} ${role} ${password}`.replace(/\s+/g, ' ').trim();
    return sha256(sha512(combined));
}

function brainKeyToPrivateKey(brainKey, sequence = 0) {
    const seq = ` ${sequence}`;
    return sha256(sha512(brainKey + seq));
}

function publicKeyToString(pubKeyBuf, addressPrefix = 'BTS') {
    const checksum = ripemd160(pubKeyBuf).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([pubKeyBuf, checksum]));
}

function addressFromPublicKey(pubKeyBuf, addressPrefix = 'BTS') {
    const hash = ripemd160(sha512(pubKeyBuf));
    const version = Buffer.from([0x35]);
    const versioned = Buffer.concat([version, hash]);
    const checksum = hash256(versioned).slice(0, 4);
    return addressPrefix + base58Encode(Buffer.concat([versioned, checksum]));
}

module.exports = {
    sha256,
    sha512,
    ripemd160,
    hash160,
    hash256,
    randomBytes,
    generatePrivateKey,
    isValidPrivateKey,
    privateKeyToPublicKey,
    sign,
    verify,
    recoverPublicKey,
    wifEncode,
    wifDecode,
    normalizeBrainKey,
    brainKeyToPrivateKey,
    publicKeyToString,
    addressFromPublicKey,
    publicKeyFromBuffer,
    base58Encode,
    base58Decode,
    base58CheckEncode,
    base58CheckDecode,
    buildSignatureDer,
    buildPublicKeyDer,
    secp256k1,
};
