export type { CryptoProvider, EcPoint, ScryptOptions, Aes256GcmEncryptResult } from './provider';
import type { CryptoProvider } from './provider';
import { NodeCryptoProvider } from './node_provider';
import { BrowserCryptoProvider } from './browser_provider';
export { NodeCryptoProvider } from './node_provider';
export { BrowserCryptoProvider } from './browser_provider';
export { ripemd160 as pureRipemd160 } from './pure_ripemd160';
export {
    secp256k1,
    privateKeyToPublicKey as pureSecp256k1Pubkey,
    pointFromPublicKey,
    publicKeyFromPoint,
    ecPointMul,
    ecPointAdd,
    ecPointDouble,
    modPow,
    modInverse,
    mod,
    bigIntFromBuffer,
    bufferFromBigInt,
} from './pure_secp256k1';

// ── Singleton accessor (mirrors getStorage() pattern) ────────────────
let _crypto: CryptoProvider | null = null;

export function getCrypto(): CryptoProvider {
    if (!_crypto) {
        _crypto = typeof globalThis.window !== 'undefined'
            ? new BrowserCryptoProvider()
            : new NodeCryptoProvider();
    }
    return _crypto;
}

export function setCrypto(provider: CryptoProvider | null): void {
    _crypto = provider;
}


