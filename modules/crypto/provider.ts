export interface EcPoint {
    x: bigint;
    y: bigint;
}

export interface ScryptOptions {
    N: number;
    r: number;
    p: number;
    maxmem?: number;
}

export interface Aes256GcmEncryptResult {
    ciphertext: Uint8Array;
    authTag: Uint8Array;
    iv: Uint8Array;
}

export interface CryptoProvider {
    sha256(data: Uint8Array): Promise<Uint8Array>;
    sha512(data: Uint8Array): Promise<Uint8Array>;
    ripemd160(data: Uint8Array): Promise<Uint8Array>;
    hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;

    /** secp256k1: derive compressed (33-byte) or uncompressed (65-byte) public key from private key */
    privateKeyToPublicKey(privateKey: Uint8Array, compressed?: boolean): Promise<Uint8Array>;

    /** AES-256-GCM encrypt with auto-generated IV */
    aes256GcmEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<Aes256GcmEncryptResult>;

    /** AES-256-GCM decrypt */
    aes256GcmDecrypt(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, authTag: Uint8Array): Promise<Uint8Array>;

    /** Password-based key derivation (scrypt) */
    scrypt(password: Uint8Array, salt: Uint8Array, keyLength: number, options?: ScryptOptions): Promise<Uint8Array>;

    /** HKDF key derivation (digest defaults to sha256) */
    hkdf(key: Uint8Array, salt: Uint8Array, info: Uint8Array, keyLength: number): Promise<Uint8Array>;

    timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean>;
    randomBytes(size: number): Promise<Uint8Array>;
}
