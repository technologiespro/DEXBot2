const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((ch, index) => [ch, index]));

function checksum(payload) {
    const first = crypto.createHash('sha256').update(payload).digest();
    return crypto.createHash('sha256').update(first).digest().subarray(0, 4);
}

function base58Encode(buffer) {
    const bytes = Buffer.from(buffer);
    if (bytes.length === 0) return '';

    let value = 0n;
    for (const byte of bytes) {
        value = (value << 8n) + BigInt(byte);
    }

    let encoded = '';
    while (value > 0n) {
        const mod = Number(value % 58n);
        encoded = ALPHABET[mod] + encoded;
        value /= 58n;
    }

    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = '1' + encoded;
    }

    return encoded || '1';
}

function base58Decode(value) {
    if (typeof value !== 'string') throw new TypeError('Base58 value must be a string');
    if (value.length === 0) return Buffer.alloc(0);

    let decoded = 0n;
    for (const ch of value) {
        const digit = ALPHABET_MAP.get(ch);
        if (digit === undefined) throw new Error(`Invalid Base58 character "${ch}"`);
        decoded = decoded * 58n + BigInt(digit);
    }

    const bytes = [];
    while (decoded > 0n) {
        bytes.unshift(Number(decoded & 0xffn));
        decoded >>= 8n;
    }

    for (const ch of value) {
        if (ch !== '1') break;
        bytes.unshift(0);
    }

    return Buffer.from(bytes);
}

function encode(payload) {
    const body = Buffer.from(payload);
    return base58Encode(Buffer.concat([body, checksum(body)]));
}

function decode(value) {
    const decoded = base58Decode(value);
    if (decoded.length < 4) throw new Error('Invalid Base58Check payload');

    const payload = decoded.subarray(0, -4);
    const expected = decoded.subarray(-4);
    const actual = checksum(payload);
    if (!crypto.timingSafeEqual(expected, actual)) {
        throw new Error('Invalid Base58Check checksum');
    }

    return payload;
}

export = {
    decode,
    encode,
};
