import * as crypto from 'crypto';
import type { CryptoProvider, ScryptOptions, Aes256GcmEncryptResult } from './provider';

export class NodeCryptoProvider implements CryptoProvider {
    sha256(data: Uint8Array): Promise<Uint8Array> {
        return Promise.resolve(crypto.createHash('sha256').update(data).digest());
    }

    sha512(data: Uint8Array): Promise<Uint8Array> {
        return Promise.resolve(crypto.createHash('sha512').update(data).digest());
    }

    ripemd160(data: Uint8Array): Promise<Uint8Array> {
        return Promise.resolve(crypto.createHash('ripemd160').update(data).digest());
    }

    hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
        return Promise.resolve(crypto.createHmac('sha256', key).update(data).digest());
    }

    privateKeyToPublicKey(privateKey: Uint8Array, compressed = true): Promise<Uint8Array> {
        const ecdh = crypto.createECDH('secp256k1');
        ecdh.setPrivateKey(privateKey);
        const format = compressed ? 'compressed' : 'uncompressed';
        return Promise.resolve(ecdh.getPublicKey(undefined, format));
    }

    async aes256GcmEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Aes256GcmEncryptResult> {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return { ciphertext: new Uint8Array(encrypted), iv: new Uint8Array(iv), authTag: new Uint8Array(authTag) };
    }

    async aes256GcmDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, authTag: Uint8Array): Promise<Uint8Array> {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return new Uint8Array(decrypted);
    }

    scrypt(password: Uint8Array, salt: Uint8Array, keyLength: number, options?: ScryptOptions): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, keyLength, options as crypto.ScryptOptions, (err, key) => {
                if (err) reject(err);
                else resolve(new Uint8Array(key));
            });
        });
    }

    hkdf(key: Uint8Array, salt: Uint8Array, info: Uint8Array, keyLength: number): Promise<Uint8Array> {
        const raw = crypto.hkdfSync('sha256', key, salt, info, keyLength);
        return Promise.resolve(new Uint8Array(raw));
    }

    timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
        if (a.length !== b.length) return Promise.resolve(false);
        return Promise.resolve(crypto.timingSafeEqual(a, b));
    }

    randomBytes(size: number): Promise<Uint8Array> {
        return Promise.resolve(crypto.randomBytes(size));
    }
}
