/**
 * modules/chain_keys.js - Authentication and Key Management
 *
 * Secure storage and management of BitShares private keys.
 * Provides authentication, key storage, and transaction signing capabilities.
 *
 * Features:
 * - Master password authentication with derived vault-key verification
 * - AES-256-GCM encryption with random salt and IV
 * - Private key retrieval for transaction signing
 * - Interactive CLI for key management (add/modify/remove)
 * - Daemon readiness checking
 *
 * Storage: profiles/keys.json (gitignored, never committed)
 *
 * Supported key formats:
 * - WIF (Wallet Import Format): 51-52 character Base58Check encoded
 * - PVT_K1_* style keys used by some Graphene chains
 * - Raw 64-character hexadecimal private keys
 *
 * Security: Master password never stored; only a derived vault key is kept in memory.
 * Legacy SHA-256 password hashes are supported only to migrate existing vaults.
 * All newly written private keys use the v2 vault format.
 *
 * ===============================================================================
 * EXPORTS (13 functions + 1 error class)
 * ===============================================================================
 *
 * AUTHENTICATION (1 function)
 *   1. authenticate() - Authenticate and return a derived vault secret (async)
 *      Prompts user for password, verifies vault metadata
 *      Throws MasterPasswordError on failure
 *
 * KEY MANAGEMENT (3 functions)
 *   2. getPrivateKey(accountName, vaultSecret) - Get private key for account
 *      Returns decrypted private key string
 *      Throws Error if account not found
 *
 *   3. main() - Interactive CLI for key management (async)
 *      Add/modify/remove keys from storage
 *      Re-encrypts entire key store
 *
 *   4. validatePrivateKey(key) - Validate private key format
 *
 * CRYPTO HELPERS (8 functions)
 *   5. encrypt(text, secret) - AES-256-GCM encryption
 *   6. decrypt(encryptedHex, secret) - AES-256-GCM decryption
 *   7. hashPassword(password) - SHA-256 hash for legacy verification
 *   8. deriveVaultKey(password, vaultSalt) - Derive the session vault key
 *   9. deriveSessionSecret(vaultSecret, sessionSalt) - Derive a session-only signing key
 *  10. loadAccounts() - Load accounts from keys.json
 *  11. saveAccounts(data) - Save accounts to keys.json
 *  12. createVaultSecret(...) - Build a serializable derived secret object
 *
 * DAEMON (3 functions)
 *  10. isDaemonReady() - Check if credential daemon is ready
 *  11. waitForDaemon(timeoutMs) - Wait for daemon to become ready (async)
 *  12. getPrivateKeyFromDaemon(accountName) - Request key via daemon socket (async)
 *
 * ERROR HANDLING (1 error class)
 *  13. MasterPasswordError - Thrown when authentication fails
 *
 * ===============================================================================
 *
 * KEY STORAGE STRUCTURE (profiles/keys.json):
 * {
 *   "vaultVersion": 2,
 *   "vaultSalt": "hex-salt",
 *   "vaultVerifier": "hex-hmac",
 *   "accounts": {
 *     "accountName": "v2:recordSalt:iv:authTag:ciphertext"
 *   }
 * }
 *
 * ENCRYPTION PROCESS:
 * 1. Generate random vault salt (16 bytes) and derive a vault key with scrypt
 * 2. Derive a per-record key from the vault key with HKDF and a record salt
 * 3. Encrypt private key with AES-256-GCM and a 12-byte IV
 * 4. Store: v2:recordSalt:iv:authTag:ciphertext
 *
 * ===============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { readInput, readPassword } = require('./order/utils/system');
const { TIMING } = require('./constants');
const {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('./credential_runtime');

const VAULT_VERSION = 2;
const VAULT_SALT_BYTES = 16;
const VAULT_RECORD_SALT_BYTES = 16;
const VAULT_IV_BYTES = 12;
const VAULT_KEY_BYTES = 32;
const VAULT_SCRYPT_PARAMS = Object.freeze({
    N: 2 ** 17,
    r: 8,
    p: 1,
    // 128 * N * r bytes plus headroom for Node/OpenSSL overhead.
    maxmem: 256 * 1024 * 1024,
});
const VAULT_RECORD_INFO = Buffer.from('dexbot2:v2:record-key', 'utf8');
const VAULT_SESSION_INFO = Buffer.from('dexbot2:v2:session-key', 'utf8');
const VAULT_VERIFIER_LABEL = 'dexbot2:v2:verifier';
const VAULT_SECRET_KIND = 'dexbot-vault-secret';
const VAULT_SESSION_SECRET_KIND = 'dexbot-session-secret';
const VAULT_DAEMON_SIGNING_TOKEN_KIND = 'dexbot-daemon-signing-token';

// Profiles key file (ignored) only
const PROFILES_KEYS_FILE = process.env.DEXBOT_KEYS_FILE
    ? path.resolve(process.env.DEXBOT_KEYS_FILE)
    : path.join(__dirname, '..', 'profiles', 'keys.json');

/**
 * Ensures that the profiles/keys directory exists.
 * @private
 */
function ensureProfilesKeysDirectory() {
    const dir = path.dirname(PROFILES_KEYS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toBuffer(value, encoding = 'hex') {
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (typeof value === 'string' && value.length > 0) {
        return Buffer.from(value, encoding);
    }
    return null;
}

function isVaultSecret(value) {
    return !!(value && typeof value === 'object' && value.kind === VAULT_SECRET_KIND);
}

function resolveVaultKey(secret) {
    if (!secret) return null;
    if (Buffer.isBuffer(secret)) {
        return Buffer.from(secret);
    }
    if (isVaultSecret(secret) && typeof secret.vaultKeyHex === 'string') {
        return toBuffer(secret.vaultKeyHex);
    }
    if (typeof secret === 'object' && typeof secret.vaultKeyHex === 'string') {
        return toBuffer(secret.vaultKeyHex);
    }
    if (typeof secret === 'object' && Buffer.isBuffer(secret.vaultKey)) {
        return Buffer.from(secret.vaultKey);
    }
    return null;
}

function createVaultSecret(vaultKey, extra = {}) {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault secret requires a derived key');
    }
    return {
        kind: VAULT_SECRET_KIND,
        version: extra.version || VAULT_VERSION,
        vaultKeyHex: keyBuffer.toString('hex'),
    };
}

function createSessionSecret(vaultKey, sessionSalt = crypto.randomBytes(VAULT_SALT_BYTES)) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(sessionSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault secret and session salt are required');
    }

    const sessionKey = Buffer.from(
        crypto.hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_SESSION_INFO, VAULT_KEY_BYTES)
    );

    return {
        kind: VAULT_SESSION_SECRET_KIND,
        version: VAULT_VERSION,
        sessionSaltHex: saltBuffer.toString('hex'),
        vaultKeyHex: sessionKey.toString('hex'),
    };
}

function createDaemonSigningToken(accountName, options = {}) {
    if (!accountName || typeof accountName !== 'string') {
        throw new Error('accountName is required for daemon signing');
    }

    return {
        kind: VAULT_DAEMON_SIGNING_TOKEN_KIND,
        accountName,
        socketPath: options.socketPath || getCredentialSocketPath(options),
        sessionId: options.sessionId || null,
        botHmacSecret: options.botHmacSecret || null,
    };
}

function isDaemonSigningToken(value) {
    return !!(value && typeof value === 'object' && value.kind === VAULT_DAEMON_SIGNING_TOKEN_KIND && typeof value.accountName === 'string');
}

function deriveVaultKey(password, vaultSalt) {
    const saltBuffer = toBuffer(vaultSalt) || crypto.randomBytes(VAULT_SALT_BYTES);
    return crypto.scryptSync(password, saltBuffer, VAULT_KEY_BYTES, VAULT_SCRYPT_PARAMS);
}

function deriveRecordKey(vaultKey, recordSalt) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(recordSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault key and record salt are required');
    }
    return Buffer.from(crypto.hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_RECORD_INFO, VAULT_KEY_BYTES));
}

function createVaultVerifier(vaultKey) {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault key is required');
    }
    return crypto.createHmac('sha256', keyBuffer).update(VAULT_VERIFIER_LABEL).digest('hex');
}

function timingSafeEqualHex(leftHex, rightHex) {
    if (typeof leftHex !== 'string' || typeof rightHex !== 'string' || leftHex.length !== rightHex.length) {
        return false;
    }
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    if (left.length !== right.length) {
        return false;
    }
    return crypto.timingSafeEqual(left, right);
}

function normalizeAccountsData(data = {}) {
    const accountsSource = data.accounts && typeof data.accounts === 'object'
        ? data.accounts
        : {};

    return {
        vaultVersion: Number(data.vaultVersion) || 0,
        vaultSalt: typeof data.vaultSalt === 'string' ? data.vaultSalt : '',
        vaultVerifier: typeof data.vaultVerifier === 'string' ? data.vaultVerifier : '',
        masterPasswordHash: typeof data.masterPasswordHash === 'string' ? data.masterPasswordHash : '',
        accounts: accountsSource,
    };
}

function hasModernVault(accountsData) {
    return !!(
        accountsData
        && accountsData.vaultVersion === VAULT_VERSION
        && typeof accountsData.vaultSalt === 'string'
        && accountsData.vaultSalt.length > 0
        && typeof accountsData.vaultVerifier === 'string'
        && accountsData.vaultVerifier.length > 0
    );
}

function deriveModernSecretFromPassword(password, accountsData) {
    if (!hasModernVault(accountsData)) {
        throw new Error('Vault metadata missing');
    }
    const vaultSalt = toBuffer(accountsData.vaultSalt);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    return createVaultSecret(vaultKey);
}

function verifyModernPassword(password, accountsData) {
    if (!hasModernVault(accountsData)) {
        return false;
    }
    const secret = deriveModernSecretFromPassword(password, accountsData);
    return timingSafeEqualHex(createVaultVerifier(secret), accountsData.vaultVerifier);
}

function isVersionedEncryptedPayload(encrypted) {
    return String(encrypted || '').startsWith('v2:');
}

/**
 * Encrypt text using the v2 AES-256-GCM vault format.
 * @param {string} text - Plain text to encrypt
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Encrypted data as hex string
 */
function encrypt(text, secret) {
    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to encrypt v2 key data');
    }

    const salt = crypto.randomBytes(VAULT_RECORD_SALT_BYTES);
    const key = deriveRecordKey(vaultKey, salt);
    const iv = crypto.randomBytes(VAULT_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return 'v2:' + salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with the encrypt() function.
 * @param {string} encrypted - Colon-separated encrypted data
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
function decrypt(encrypted, secret) {
    const parts = String(encrypted || '').split(':');
    if (parts.length < 4) {
        throw new Error('Invalid encrypted payload');
    }

    const isVersioned = parts.length === 5 && parts[0] === 'v2';
    if (!isVersioned && parts.length !== 4) {
        throw new Error('Unsupported encrypted payload version');
    }

    const saltIndex = isVersioned ? 1 : 0;
    const ivIndex = isVersioned ? 2 : 1;
    const authTagIndex = isVersioned ? 3 : 2;
    const payloadIndex = isVersioned ? 4 : 3;

    const salt = toBuffer(parts[saltIndex]);
    const iv = toBuffer(parts[ivIndex]);
    const authTag = toBuffer(parts[authTagIndex]);
    const encryptedText = parts[payloadIndex];
    if (!salt || !iv || !authTag || typeof encryptedText !== 'string') {
        throw new Error('Invalid encrypted payload');
    }

    if (!isVersioned) {
        throw new Error('Legacy encrypted data requires migration before decrypt');
    }

    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to decrypt v2 key data');
    }
    const key = deriveRecordKey(vaultKey, salt);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const base58check = require('./utils/base58check');

/**
 * Validate a private key format.
 * Supports WIF (Base58Check), PVT_K1_* style, and 64-char hex.
 * @param {string} key - Private key to validate
 * @returns {Object} { valid: boolean, reason?: string }
 */
function validatePrivateKey(key) {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Empty key' };
    const k = key.trim();

    // Basic characters allowed for base58-like / ASCII keys
    const base58chars = /^[1-9A-HJ-NP-Za-km-z]+$/;

    // Strict WIF validation using base58check decode (verifies checksum & structure)
    try {
        // Base58Check decode throws if checksum or characters are invalid.
        const payload = base58check.decode(k);
        // WIFs for Bitcoin-style keys use 0x80 version byte and payload lengths 33 or 34
        // Uncompressed WIF payload: [0x80 | 32-byte privkey]
        // Compressed WIF payload: [0x80 | 32-byte privkey | 0x01]
        if (payload && payload.length >= 33) {
            // version is first byte
            const version = payload[0];
            if (version === 0x80) {
                // valid WIF format
                // payload length 33 (no compression byte) => uncompressed, 34 => compressed
                if (payload.length === 33 || payload.length === 34) {
                    return { valid: true };
                }
            }
        }
    } catch (err) {
        // Not a valid base58check WIF; continue to other formats
    }

    // PVT-style private key used by some Graphene-based chains (e.g. PVT_K1_<data>)
    // Example shape: PVT_K1_base58...
    if (/^PVT_(?:K1_)?[A-Za-z0-9_-]+$/.test(k)) {
        return { valid: true };
    }

    // Hex private key (64 hex chars) - accept optionally
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
        return { valid: true };
    }

    return { valid: false, reason: 'Unrecognized key format' };
}

/**
 * Load stored accounts from profiles/keys.json.
 * Returns empty structure if file doesn't exist or is corrupted.
 * @returns {Object} { vaultVersion: number, vaultSalt: string, vaultVerifier: string, masterPasswordHash: string, accounts: Object }
 */
function loadAccounts() {
    try {
        if (!fs.existsSync(PROFILES_KEYS_FILE)) {
            return normalizeAccountsData();
        }
        const content = fs.readFileSync(PROFILES_KEYS_FILE, 'utf8').trim();
        if (!content) {
            return normalizeAccountsData();
        }
        return normalizeAccountsData(JSON.parse(content));
    } catch (error) {
        console.error('Error loading accounts file, resetting to default:', error.message);
        return normalizeAccountsData();
    }
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function setupModernVault(accountsData, password) {
    const vaultSalt = crypto.randomBytes(VAULT_SALT_BYTES);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    accountsData.vaultVersion = VAULT_VERSION;
    accountsData.vaultSalt = vaultSalt.toString('hex');
    accountsData.vaultVerifier = createVaultVerifier(vaultKey);
    delete accountsData.masterPasswordHash;
    return createVaultSecret(vaultKey);
}

function decryptLegacyRecord(encrypted, password) {
    const parts = String(encrypted || '').split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid legacy encrypted payload');
    }

    const salt = toBuffer(parts[0]);
    const iv = toBuffer(parts[1]);
    const authTag = toBuffer(parts[2]);
    const encryptedText = parts[3];
    if (!salt || !iv || !authTag || typeof encryptedText !== 'string') {
        throw new Error('Invalid legacy encrypted payload');
    }

    const key = crypto.scryptSync(password, salt, VAULT_KEY_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function migrateLegacyVault(accountsData, password) {
    const decryptedKeys = {};
    for (const [name, account] of Object.entries(accountsData.accounts)) {
        decryptedKeys[name] = decryptLegacyRecord(account.encryptedKey, password);
    }

    const secret = setupModernVault(accountsData, password);
    for (const [name, account] of Object.entries(accountsData.accounts)) {
        account.encryptedKey = encrypt(decryptedKeys[name], secret);
    }

    saveAccounts(accountsData);
    return secret;
}

function unlockWithPassword(password, accountsData = loadAccounts()) {
    if (hasModernVault(accountsData)) {
        if (!verifyModernPassword(password, accountsData)) {
            throw new MasterPasswordError('Incorrect master password.');
        }
        return deriveModernSecretFromPassword(password, accountsData);
    }

    if (accountsData.masterPasswordHash) {
        if (hashPassword(password) !== accountsData.masterPasswordHash) {
            throw new MasterPasswordError('Incorrect master password.');
        }
        return migrateLegacyVault(accountsData, password);
    }

    if (Object.keys(accountsData.accounts || {}).length > 0) {
        throw new Error('Unsupported key vault format. Recreate profiles/keys.json with the current key manager.');
    }

    throw new Error('No master password set. Please run modules/chain_keys.js first.');
}

function verifyCurrentPassword(password, accountsData) {
    if (hasModernVault(accountsData)) {
        return verifyModernPassword(password, accountsData);
    }
    return !!accountsData.masterPasswordHash && hashPassword(password) === accountsData.masterPasswordHash;
}

class MasterPasswordError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = 'MASTER_PASSWORD_FAILED';
    }
}

function isMasterPasswordFailure(err) {
    return !!(err && (err instanceof MasterPasswordError || err.code === 'MASTER_PASSWORD_FAILED'));
}

const MASTER_PASSWORD_MAX_ATTEMPTS = 3;
let masterPasswordAttempts = 0;

/**
 * Prompts the user for the master password with retry tracking.
 * @returns {Promise<string>} The entered password.
 * @throws {MasterPasswordError} If max attempts are reached.
 * @private
 */
async function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    // Use readPassword instead of readlineSync to support Delete key and consistent masking
    return await readPassword('Enter master password: ');
}

/**
 * Authenticate and return a derived vault secret.
 * Prompts user interactively with limited retry attempts.
 * @returns {Promise<Object>} The verified vault secret
 * @throws {Error} If no master password is set
 * @throws {MasterPasswordError} If max attempts exceeded
 */
async function authenticate() {
    const accountsData = loadAccounts();
    try {
        while (true) {
            const enteredPassword = await _promptPassword();
            try {
                const secret = unlockWithPassword(enteredPassword, accountsData);
                masterPasswordAttempts = 0;
                return secret;
            } catch (error) {
                if (!(error instanceof MasterPasswordError)) {
                    throw error;
                }
            }

            if (masterPasswordAttempts < MASTER_PASSWORD_MAX_ATTEMPTS) {
                console.log('Master password not correct. Please try again.');
            }
        }
    } catch (err) {
        if (err instanceof MasterPasswordError) {
            masterPasswordAttempts = 0;
        }
        throw err;
    }
}

/**
 * Retrieve and decrypt a stored private key.
 * @param {string} accountName - Name of the account
 * @param {Object|Buffer} vaultSecret - Derived vault secret
 * @returns {string} Decrypted private key
 * @throws {Error} If account not found
 */
function getPrivateKey(accountName, vaultSecret) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }

    if (!isVersionedEncryptedPayload(account.encryptedKey)) {
        throw new Error('Legacy encrypted data should have been migrated during unlock');
    }

    return decrypt(account.encryptedKey, vaultSecret);
}
/**
 * Display stored account names to console.
 * @param {Object} accounts - Accounts object from loadAccounts()
 * @returns {Array<string>} Array of account names
 */
function listKeyNames(accounts) {
    if (!accounts || Object.keys(accounts).length === 0) {
        console.log('  (no accounts stored yet)');
        return [];
    }
    console.log('Stored keys:');
    return Object.keys(accounts).map((name, index) => {
        console.log(`  ${index + 1}. ${name}`);
        return name;
    });
}

/**
 * Prompts the user to select an account name from the stored keys.
 * @param {Object} accounts - The accounts object.
 * @param {string} promptText - The prompt message to display.
 * @returns {Promise<string|null>} The selected account name, or null/ESC.
 */
async function selectKeyName(accounts, promptText) {
    const names = Object.keys(accounts);
    if (!names.length) {
        console.log('No accounts available to select.');
        return null;
    }
    names.forEach((name, index) => console.log(`  ${index + 1}. ${name}`));
    const raw = (await readInput(`${promptText} [1-${names.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';

    const idx = Number(raw) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= names.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return names[idx];
}

/**
 * Interactively changes the master password and re-encrypts all stored keys.
 * @param {Object} accountsData - The loaded accounts data object.
 * @param {Object|Buffer|null} currentSecret - The current derived secret.
 * @returns {Promise<Object|Buffer|null>} The new vault secret, or the old one if failed/cancelled.
 */
async function changeMasterPassword(accountsData, currentSecret) {
    if (!hasModernVault(accountsData) && !accountsData.masterPasswordHash) {
        console.log('No master password is set yet.');
        return currentSecret;
    }

    const oldPassword = await readPassword('Enter current master password: ');
    if (oldPassword === '\x1b') return currentSecret;

    if (!verifyCurrentPassword(oldPassword, accountsData)) {
        console.log('Incorrect master password!');
        return currentSecret;
    }

    const oldSecret = hasModernVault(accountsData)
        ? deriveModernSecretFromPassword(oldPassword, accountsData)
        : migrateLegacyVault(accountsData, oldPassword);

    const newPassword = await readPassword('Enter new master password:     ');
    if (newPassword === '\x1b') return currentSecret;

    const confirmPassword = await readPassword('Confirm new master password:   ');
    if (confirmPassword === '\x1b') return currentSecret;

    if (newPassword !== confirmPassword) {
        console.log('Passwords do not match!');
        return currentSecret;
    }
    if (!newPassword) {
        console.log('New master password cannot be empty.');
        return currentSecret;
    }

    const decryptedKeys = {};
    try {
        for (const [name, account] of Object.entries(accountsData.accounts)) {
            decryptedKeys[name] = decrypt(account.encryptedKey, oldSecret);
        }
    } catch (error) {
        console.log('Failed to decrypt stored keys with the current master password:', error.message);
        return currentSecret;
    }

    const newSecret = setupModernVault(accountsData, newPassword);
    for (const [name, account] of Object.entries(accountsData.accounts)) {
        account.encryptedKey = encrypt(decryptedKeys[name], newSecret);
    }
    saveAccounts(accountsData);
    console.log('Master password updated successfully.');
    return newSecret;
}

/**
 * Save accounts data to profiles/keys.json.
 * Creates directory if needed.
 * @param {Object} data - Accounts data to save
 */
function saveAccounts(data) {
    // Always save sensitive data to the live path (ignored by git)
    ensureProfilesKeysDirectory();

    const serialized = {
        vaultVersion: data && Number(data.vaultVersion) ? Number(data.vaultVersion) : 0,
        vaultSalt: data && typeof data.vaultSalt === 'string' ? data.vaultSalt : '',
        vaultVerifier: data && typeof data.vaultVerifier === 'string' ? data.vaultVerifier : '',
        masterPasswordHash: data && typeof data.masterPasswordHash === 'string' ? data.masterPasswordHash : '',
        accounts: data && data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
    };

    if (!serialized.masterPasswordHash) {
        delete serialized.masterPasswordHash;
    }
    if (!serialized.vaultSalt) {
        delete serialized.vaultSalt;
    }
    if (!serialized.vaultVerifier) {
        delete serialized.vaultVerifier;
    }
    if (!hasModernVault(serialized)) {
        delete serialized.vaultVersion;
    }

    fs.writeFileSync(PROFILES_KEYS_FILE, JSON.stringify(serialized, null, 2));
}

/**
 * Launch the interactive key management CLI.
 * Provides menu for: add/modify/remove keys, test decryption,
 * change master password.
 */
async function main() {
    console.log('Chain Key Manager');
    console.log('========================');

    let accountsData = loadAccounts();
    let vaultSecret = null;

    // Check if master password is set
    if (!hasModernVault(accountsData) && !accountsData.masterPasswordHash) {
        console.log('No master password set. Please set one:');
        const password1 = await readPassword('Enter master password:   ');
        const password2 = await readPassword('Confirm master password: ');
        if (password1 !== password2) {
            console.log('Passwords do not match!');
            return;
        }
        vaultSecret = setupModernVault(accountsData, password1);
        saveAccounts(accountsData);
        console.log('Master password set successfully.');
    } else {
        try {
            vaultSecret = await authenticate();
            accountsData = loadAccounts();
            console.log('Authenticated successfully.');
        } catch (err) {
            if (err instanceof MasterPasswordError) {
                console.log(err.message);
                return;
            }
            throw err;
        }
    }

     while (true) {
         console.log('\nMenu:');
         console.log('1. Add key');
         console.log('2. Modify key');
         console.log('3. Remove key');
         console.log('4. List keys');
         console.log('5. Test decryption');
         console.log('6. Change master password');
         console.log('7. Exit (or press Enter)');

         const choiceRaw = await readInput('Choose an option: ');
         console.log('');

         if (choiceRaw === '\x1b' || choiceRaw.trim() === '') {
             console.log('Keymanager closed!');
             break;
         }

         const choice = choiceRaw.trim();

        if (choice === '1') {
            const accountNameRaw = await readInput('Enter account name: ');
            if (accountNameRaw === '\x1b') continue;
            const accountName = accountNameRaw.trim();
            if (!accountName) {
                continue;
            }

            const privateKeyRaw = await readPassword('Enter private key:  ');
            if (privateKeyRaw === '\x1b') continue;

            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, vaultSecret);

            accountsData.accounts[accountName] = { encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' added successfully.`);
        } else if (choice === '2') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to modify');
            if (accountName === '\x1b' || !accountName) continue;
            
            const privateKeyRaw = await readPassword('Enter private key:   ');
            if (privateKeyRaw === '\x1b') continue;
            
            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, vaultSecret);
            accountsData.accounts[accountName] = { ...accountsData.accounts[accountName], encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' updated successfully.`);
        } else if (choice === '3') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to remove');
            if (accountName === '\x1b' || !accountName) continue;
            
            const confirm = (await readInput(`Remove '${accountName}'? (y/n): `)).trim().toLowerCase();
            if (confirm === '\x1b') continue;

            if (confirm === 'y') {
                delete accountsData.accounts[accountName];
                saveAccounts(accountsData);
                console.log(`Account '${accountName}' removed successfully.`);
            } else {
                console.log('Cancelled.');
            }
        } else if (choice === '4') {
            listKeyNames(accountsData.accounts);
        } else if (choice === '5') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to test');
            if (accountName === '\x1b' || !accountName) continue;
            
            try {
                const decryptedKey = decrypt(accountsData.accounts[accountName].encryptedKey, vaultSecret);
                console.log(`First 5 characters: ${decryptedKey.substring(0, 5)}`);
            } catch (error) {
                console.log('Decryption failed - wrong master password or corrupted data');
            }
        } else if (choice === '6') {
            vaultSecret = await changeMasterPassword(accountsData, vaultSecret);
        } else if (choice === '7') {
            console.log('Keymanager closed!');
            break;
        } else {
            console.log('Invalid choice.');
        }
    }
}

/**
 * Check if dexbot-cred daemon is ready and responsive
 * @param {Object} [options={}] - Optional socket/ready-file path overrides
 * @returns {boolean} True if daemon socket is responsive
 */
function isDaemonReady(options = {}) {
    try {
        return fs.existsSync(getCredentialReadyFilePath(options)) && fs.existsSync(getCredentialSocketPath(options));
    } catch {
        return false;
    }
}

/**
 * Check if dexbot-cred daemon is actually responsive by opening a socket
 * connection and waiting for any reply. This catches stale socket/ready
 * files left behind by a crashed daemon.
 * @param {Object} options - Optional socket/ready-file path overrides
 * @param {number} timeout - Probe timeout in milliseconds (default 2000)
 * @returns {Promise<boolean>} True if the daemon accepts connections and replies
 */
function isDaemonResponsive(options = {}, timeout = 2000) {
    return new Promise((resolve) => {
        if (!isDaemonReady(options)) {
            return resolve(false);
        }

        const socketPath = getCredentialSocketPath(options);
        const socket = net.createConnection(socketPath);
        let settled = false;
        let responseBuffer = '';

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(false);
            }
        }, timeout);

        socket.on('connect', () => {
            // Send a minimal request that forces the daemon to reply.
            // Missing fields trigger an error response, which is enough
            // to prove the daemon is alive and processing.
            socket.write('{}\n');
        });

        socket.on('data', (data) => {
            responseBuffer += data.toString();
            if (!settled && responseBuffer.trim().length > 0) {
                settled = true;
                clearTimeout(timer);
                socket.end();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });

        socket.on('end', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });
    });
}

/**
 * Wait for dexbot-cred daemon to be ready
 * @param {number} maxWaitMs - Maximum time to wait in milliseconds (default 60000)
 * @param {Object} [options] - Optional socket/ready-file path overrides
 * @returns {Promise<void>} Resolves when daemon is ready
 * @throws {Error} If daemon doesn't start within timeout
 */
async function waitForDaemon(maxWaitMs = TIMING.DAEMON_STARTUP_TIMEOUT_MS, options = {}) {
    const startTime = Date.now();
    const checkInterval = TIMING.CHECK_INTERVAL_MS; // Check every 100ms

    while (Date.now() - startTime < maxWaitMs) {
        if (isDaemonReady(options)) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error(`Daemon did not start within ${maxWaitMs}ms`);
}

/**
 * Request private key from dexbot-cred daemon via Unix socket
 * @param {string} accountName - Name of the account
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} [options] - Optional socket/ready-file path overrides
 * @returns {Promise<string>} Decrypted private key
 * @throws {Error} If daemon unavailable or request fails
 */
function getPrivateKeyFromDaemon(accountName, timeout = 5000, options = {}) {
    const net = require('net');
    const socketPath = getCredentialSocketPath(options);

    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
            // Send request
            socket.write(JSON.stringify({ type: 'private-key', accountName }) + '\n');
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('Daemon request timeout'));
        }, timeout);

        socket.on('data', (data) => {
            responseBuffer += data.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop();

            for (const line of lines) {
                if (line.trim()) {
                    clearTimeout(timer);
                    socket.end();

                    try {
                        const response = JSON.parse(line);
                        if (response.success) {
                            return resolve(response.privateKey);
                        } else {
                            return reject(new Error(response.error || 'Unknown error'));
                        }
                    } catch (err) {
                        return reject(new Error('Invalid daemon response'));
                    }
                }
            }
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`Daemon connection failed: ${error.message}`));
        });

        socket.on('end', () => {
            clearTimeout(timer);
            if (!responseBuffer.trim()) {
                reject(new Error('Daemon closed connection unexpectedly'));
            }
        });
    });
}

/**
 * Probe the credential daemon for a specific account without fetching the key.
 * Verifies the account exists in the daemon's session cache.
 * @param {string} accountName - Name of the account to probe
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @returns {Promise<string|null>} Resolves with sessionId if account is available, rejects otherwise
 */
function probeAccountInDaemon(accountName, timeout = 5000, options = {}) {
    const net = require('net');
    const socketPath = getCredentialSocketPath(options);

    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = net.createConnection(socketPath, () => {
            socket.write(JSON.stringify({ type: 'probe-account', accountName }) + '\n');
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            if (!settled) { settled = true; reject(new Error('Daemon probe timeout')); }
        }, timeout);

        socket.on('data', (data) => {
            responseBuffer += data.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop();

            for (const line of lines) {
                if (line.trim()) {
                    clearTimeout(timer);
                    socket.end();
                    if (!settled) {
                        settled = true;
                        try {
                            const response = JSON.parse(line);
                            if (response.success) {
                                resolve(response.sessionId || null);
                            } else {
                                reject(new Error(response.error || 'Daemon probe failed'));
                            }
                        } catch (err) {
                            reject(new Error('Invalid daemon probe response'));
                        }
                    }
                    return;
                }
            }
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(new Error(`Daemon connection failed: ${error.message}`)); }
        });

        socket.on('end', () => {
            clearTimeout(timer);
            if (!settled && !responseBuffer.trim()) {
                settled = true;
                reject(new Error('Daemon closed connection unexpectedly'));
            }
        });
    });
}

module.exports = {
    validatePrivateKey,
    loadAccounts,
    saveAccounts,
    encrypt,
    decrypt,
    hashPassword,
    deriveVaultKey,
    createDaemonSigningToken,
    createSessionSecret,
    createVaultSecret,
    isVaultSecret,
    isDaemonSigningToken,
    unlockWithPassword,
    main,
    authenticate,
    getPrivateKey,
    isMasterPasswordFailure,
    MasterPasswordError,
    isDaemonReady,
    isDaemonResponsive,
    waitForDaemon,
    getPrivateKeyFromDaemon,
    probeAccountInDaemon,
};
