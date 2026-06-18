/**
 * Pure-JS RIPEMD-160 implementation.
 * Ported from the well-known `ripemd160` npm package (MIT).
 * Verified against Node.js crypto hash.
 */

function rotl(x: number, n: number): number {
    return (x << n) | (x >>> (32 - n));
}

const zl = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];

const zr = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];

const sl = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];

const sr = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];

const hl = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const hr = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

function fn1(a: number, b: number, c: number, d: number, e: number, m: number, k: number, s: number): number {
    return (rotl((a + (b ^ c ^ d) + m + k) | 0, s) + e) | 0;
}

function fn2(a: number, b: number, c: number, d: number, e: number, m: number, k: number, s: number): number {
    return (rotl((a + ((b & c) | (~b & d)) + m + k) | 0, s) + e) | 0;
}

function fn3(a: number, b: number, c: number, d: number, e: number, m: number, k: number, s: number): number {
    return (rotl((a + ((b | ~c) ^ d) + m + k) | 0, s) + e) | 0;
}

function fn4(a: number, b: number, c: number, d: number, e: number, m: number, k: number, s: number): number {
    return (rotl((a + ((b & d) | (c & ~d)) + m + k) | 0, s) + e) | 0;
}

function fn5(a: number, b: number, c: number, d: number, e: number, m: number, k: number, s: number): number {
    return (rotl((a + (b ^ (c | ~d)) + m + k) | 0, s) + e) | 0;
}

function ripemd160(data: Uint8Array): Uint8Array {
    const msgLen = data.length;
    const totalBits = BigInt(msgLen) * 8n;

    // Padding: append 0x80, zero bytes, then 64-bit bit-length (little-endian)
    const padLen = (56 - ((msgLen + 1) % 64) + 64) % 64;
    const totalLen = msgLen + 1 + padLen + 8;
    const padded = new Uint8Array(totalLen);
    padded.set(data);
    padded[msgLen] = 0x80;
    for (let i = 0; i < 8; i++) {
        padded[totalLen - 8 + i] = Number((totalBits >> BigInt(i * 8)) & 0xffn);
    }

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;

    for (let off = 0; off < padded.length; off += 64) {
        const words: number[] = new Array(16);
        for (let j = 0; j < 16; j++) {
            const o = off + j * 4;
            words[j] = (padded[o] | (padded[o + 1] << 8) | (padded[o + 2] << 16) | (padded[o + 3] << 24)) | 0;
        }

        let al = h0 | 0;
        let bl = h1 | 0;
        let cl = h2 | 0;
        let dl = h3 | 0;
        let el = h4 | 0;

        let ar = h0 | 0;
        let br = h1 | 0;
        let cr = h2 | 0;
        let dr = h3 | 0;
        let er = h4 | 0;

        for (let i = 0; i < 80; i++) {
            let tl: number;
            let tr: number;

            if (i < 16) {
                tl = fn1(al, bl, cl, dl, el, words[zl[i]], hl[0], sl[i]);
                tr = fn5(ar, br, cr, dr, er, words[zr[i]], hr[0], sr[i]);
            } else if (i < 32) {
                tl = fn2(al, bl, cl, dl, el, words[zl[i]], hl[1], sl[i]);
                tr = fn4(ar, br, cr, dr, er, words[zr[i]], hr[1], sr[i]);
            } else if (i < 48) {
                tl = fn3(al, bl, cl, dl, el, words[zl[i]], hl[2], sl[i]);
                tr = fn3(ar, br, cr, dr, er, words[zr[i]], hr[2], sr[i]);
            } else if (i < 64) {
                tl = fn4(al, bl, cl, dl, el, words[zl[i]], hl[3], sl[i]);
                tr = fn2(ar, br, cr, dr, er, words[zr[i]], hr[3], sr[i]);
            } else {
                tl = fn5(al, bl, cl, dl, el, words[zl[i]], hl[4], sl[i]);
                tr = fn1(ar, br, cr, dr, er, words[zr[i]], hr[4], sr[i]);
            }

            // State permutation for both lines
            al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = tl;
            ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = tr;
        }

        // Cross-pattern combination (matching reference implementation)
        const t = (h1 + cl + dr) | 0;
        h1 = (h2 + dl + er) | 0;
        h2 = (h3 + el + ar) | 0;
        h3 = (h4 + al + br) | 0;
        h4 = (h0 + bl + cr) | 0;
        h0 = t;
    }

    const out = new Uint8Array(20);
    const v = new DataView(out.buffer);
    v.setUint32(0, h0, true);
    v.setUint32(4, h1, true);
    v.setUint32(8, h2, true);
    v.setUint32(12, h3, true);
    v.setUint32(16, h4, true);
    return out;
}

export { ripemd160 };
