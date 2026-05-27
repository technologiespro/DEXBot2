# DEXBot2 Credential Security

## System Architecture

DEXBot2 implements a layered security model to protect private keys and 
credentials at rest, in transit, and in RAM during a live session.

### Policy Engine & Strict Enforcement
The credential daemon employs a strictly enforced HMAC policy engine. All 
operations require cryptographic validation. The daemon dynamically loads
parameters, ensuring that bots cannot bypass verification or hit unauthorized
resource limits.

### Session Management & Auto-Heal
The daemon supports persistent operations via session IDs. To mitigate 
interruptions (e.g., daemon restarts or TTL expiration), the system implements 
a transparent renegotiation loop. When an `executeViaDaemonToken` call fails, 
the system automatically fetches a new `sessionId`, injects it into the 
`signingToken`, and cleanly replays the pending operations.

### Daemon Policy & Batch Limits
The credential daemon enforces granular operation policies via `daemon-policies.json`.
These policies are strictly enforced at the daemon boundary. To prevent 
resource exhaustion, the daemon enforces a global `maxOpsPerBatch` limit 
(defaulting to 200). This ensures that complex grid replacements or 
batch orders do not overwhelm the daemon's internal state.

### Memory Safety & Zeroing
To minimize the window of exposure for sensitive key material, the credential
daemon implements explicit memory scrubbing on a best-effort basis. Upon process
termination, the `shutdown()` handler iterates all sensitive objects (vault
secrets, session secrets, and cached account keys), calls `Buffer.fill(0)` on
any Buffer properties, and nulls all references. Hex-string key properties
(`vaultKeyHex`, `sessionSaltHex`) are immutable in V8 and cannot be zeroed
in place — they are dropped via reference nulling and reclaimed by the garbage
collector.

---

## Overview

DEXBot2 keeps private keys out of the bot process entirely. A dedicated
**credential daemon** holds the vault secret in memory and serves signing
requests over a local socket. The bot uses a *signing token* to tell the daemon
which account to use; the daemon signs or broadcasts operations internally and
returns results. Raw private keys never leave the daemon process.

The full chain from user password to on-chain operation looks like this:

```
Master password
      │
      ▼ scrypt (N=2¹⁷, r=8, p=1)
  Vault key ──────────────────────────────┬── HMAC-SHA256 (vault verifier)
      │                                   │
      ▼ HKDF-SHA256 (per-record salt)     ▼
  Record key → AES-256-GCM → keys.json   timingSafeEqual on unlock
      │
      ▼ daemon startup
  Session secret (HKDF-SHA256, new random salt each run)
      │
      ▼ AES-256-GCM re-encrypt
  In-RAM session cache (encrypted entries)
      │
      ▼ signing token handed to bot
  Daemon signs/broadcasts  →  result returned to bot
```

---

## 1. Key Storage — `keys.json` (vault v2)

### Password-to-key derivation

The master password is never stored. It is run through **scrypt** to produce a
32-byte *vault key*:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| N         | 2¹⁷ (131 072) | Memory-hard work factor |
| r         | 8    | Block size |
| p         | 1    | Parallelism |
| dkLen     | 32 bytes | AES-256 key length |
| salt      | 16 random bytes, stored in vault | Prevents rainbow tables |
| maxmem    | 256 MB | Caps memory usage |

This makes offline brute-force attacks against a stolen `keys.json` expensive.

### Per-record key isolation (HKDF)

The vault key is **never used directly** to encrypt a private key. Each record
gets its own 16-byte random salt, and a record-specific key is derived via
**HKDF-SHA256**:

```
record key = HKDF-SHA256(
    ikm  = vault key,
    salt = random 16 bytes (stored with the record),
    info = "dexbot2:v2:record-key"
)
```

This means compromising one record key does not help an attacker decrypt any
other record.

### Encryption

Each private key is encrypted with **AES-256-GCM**:

- 12-byte random IV per encryption operation
- 16-byte GCM authentication tag (detects tampering)
- Stored format: `v2:<recordSalt>:<iv>:<authTag>:<ciphertext>` (all hex)

### Vault verifier (unlock check without storing the password)

A short **HMAC-SHA256** of a fixed label under the vault key is stored in
`keys.json`. On unlock, the candidate vault key is reproduced and its HMAC is
compared with **`crypto.timingSafeEqual`** to prevent timing attacks. If the
comparison fails, the wrong password was supplied — no key material is ever
decrypted.

---

## 2. Credential Daemon

The daemon (`credential-daemon.ts`) is a long-running local process that holds
the vault key and session cache in RAM. Callers communicate with it over a Unix
domain socket; the main signing flow never hands raw key bytes to the bot.

### Startup sequence

1. Launcher creates a **one-shot bootstrap socket** in a freshly created
   `mkdtemp` directory (chmod 0700) and writes the socket path to a stable
   **bootstrap path file** (`.dexbot-cred-bootstrap-path`, mode 0600) in the
   runtime directory.
2. The launcher passes `DEXBOT_CRED_BOOTSTRAP_PATH_FILE` (pointing to the
   path file) to the daemon child process — **not** the socket path directly.
   This prevents PM2 from persisting the one-shot socket path across restarts.
3. The daemon reads the env var, **immediately deletes it from `process.env`**,
   reads the path file, connects to the bootstrap socket, requests the secret,
   and deletes the path file from disk.
4. Once the secret is transferred the bootstrap server closes, the socket and
   temp directory are removed, and the bootstrap path becomes unreachable.
5. Daemon loads `keys.json` into memory, builds the session cache (see §3).
6. Daemon writes a *ready file* and begins accepting signing requests on the main
   socket. The bootstrap socket no longer exists at this point.

A configurable timeout (default: a few seconds) aborts the entire bootstrap if
the daemon does not connect in time, preventing the bootstrap socket from being
left open indefinitely.

### What the daemon exposes

| Request type          | What it does |
|-----------------------|-------------|
| `ping`                | Lightweight health check (no session created, no audit log entry) |
| `probe-account`       | Confirms an account is available and creates a session (no key material returned) |
| `broadcast-operation` | Signs and broadcasts a single operation; returns result |
| `execute-operations`  | Signs and broadcasts a batch; returns result |

The daemon **never** exports raw private keys. All signing happens internally;
callers receive only operation results.

### Daemon signing token

The bot receives a **signing token** at startup:

```js
{
  kind: 'dexbot-daemon-signing-token',
  accountName: '<account>',
  socketPath: '/run/user/<uid>/dexbot2/dexbot-cred-daemon.sock'
}
```

This token carries no key material. If intercepted, an attacker can only submit
signing requests to the daemon for the named account while the daemon is running —
they cannot extract the private key.

---

## 3. Session Cache — Ephemeral Re-encryption

When the daemon starts, every account key is re-encrypted under a **session
secret** that is freshly randomized each run. This is the "temporary key"
mechanism:

```
session secret = HKDF-SHA256(
    ikm  = vault key,
    salt = random 16 bytes (generated at daemon start, never persisted),
    info = "dexbot2:v2:session-key"
)
```

All private keys are then re-encrypted with AES-256-GCM under this session
secret and stored in a `Map` in RAM. Consequences:

- **No plaintext keys are retained in the cache.** Decrypted keys exist only
  transiently while a request is being serviced, then are re-encrypted under
  the session secret.
- **Session isolation.** A memory snapshot from one run cannot be replayed into
  another because the session salt is never written to disk.
- **Vault fallback.** If `keys.json` is readable, the daemon always re-derives
  the key from disk on a cache miss, keeping the session cache fresh after key
  rotation or new account additions — without a restart.

---

## 4. Runtime File Security

The daemon communicates over a Unix domain socket. All runtime paths are
validated before use or before any stale path is removed.

### Directory

The runtime directory defaults to `$XDG_RUNTIME_DIR/dexbot2/` when
`$XDG_RUNTIME_DIR` is usable; otherwise it falls back to `profiles/run/` under
the repository root. In both cases it is created with mode **0700** (owner
read/write/execute only) and verified at every startup.

### Socket and ready file

Both the socket (`dexbot-cred-daemon.sock`) and the ready file
(`dexbot-cred-daemon.ready`) are chmod'd to **0600** after creation.

Before trusting or unlinking either path, the code asserts all of the following:

| Check | Requirement |
|-------|-------------|
| Symbolic link | Refused — `lstat` is used, not `stat` |
| File type | Must match expected type (`socket` or `file`) |
| Owner UID | Must match the current process UID |
| Permissions | Must be exactly `0600` |

A stale socket that fails any of these checks is not removed, preventing a
malicious process from placing a rogue socket at the expected path and having the
daemon silently unlink it and take over.

### Bootstrap directory cleanup

During stale bootstrap directory cleanup, the code additionally probes any
`bootstrap.sock` file found inside a temp directory with a short connection
attempt (`probeBootstrapSocket`, 300ms timeout). If the connection succeeds,
the socket is live and its parent directory is preserved — even if the directory
mtime suggests it is stale. This prevents accidentally removing a bootstrap
directory that is actively being used by a concurrent launcher.

---

## 5. Authentication Failure Handling

Interactive master-password attempts are capped at **3**. Once the budget is
exhausted:

- An unambiguous PM2-compatible error message is printed.
- The process exits immediately.
- No partial state is left behind.

The failure path is consistent regardless of whether the daemon or the
interactive password prompt handled the authentication, making the output
predictable for monitoring and alerting.

### Legacy vault migration

Older vaults stored a plain **SHA-256** hash of the master password for
verification. This hash is deliberately weak by modern standards. During the
first successful unlock of a legacy vault, the code:

1. Verifies the password against the SHA-256 hash.
2. Re-encrypts all keys under the v2 scrypt-derived vault key.
3. Writes the HMAC-SHA256 vault verifier.
4. **Deletes `masterPasswordHash`** from the vault file.

After migration the weak hash is gone and subsequent unlocks use only the
HMAC-SHA256 verifier. Legacy data cannot be decrypted without first migrating
through this path.

---

## 6. Startup Path — Daemon-First, Interactive Fallback

```
bot.ts / dexbot.ts
      │
      ▼ probe daemon (probe-account)
  Daemon healthy?
  ├── YES  →  obtain signing token  →  start bot with token
  └── NO   →  fall back to interactive master-password prompt
                    │
                    ▼ attempts exhausted?
                YES  →  print failure message, exit
```

This means production deployments running the daemon never expose the master
password interactively, while the interactive path remains available for
development and recovery.

---

## 7. Summary of Techniques

| Technique | Where applied | Purpose |
|-----------|--------------|---------|
| scrypt (N=2¹⁷) | Password → vault key | Memory-hard KDF; resists brute force |
| HKDF-SHA256 (per-record) | Vault key → record key | Key isolation per account |
| HKDF-SHA256 (random salt) | Vault key → session key | Ephemeral RAM-only re-encryption |
| AES-256-GCM | All encryption operations | Authenticated encryption; detects tampering |
| HMAC-SHA256 | Vault verifier | Unlock check without storing the password |
| `crypto.timingSafeEqual` | Verifier comparison | Prevents timing-based password oracle |
| Batch limit (200) | `execute-operations` | Prevents resource exhaustion |
| Signing token (no key export) | Bot ↔ daemon IPC | Private key never leaves daemon boundary; raw key export removed |
| `lstat` + owner/mode/type checks | Runtime socket & ready file | Prevents symlink attacks and rogue sockets |
| 0700 runtime dir / 0600 sockets | Filesystem | OS-level access restriction |
| Random session salt (not persisted) | Session cache | Memory snapshot from one run is useless in another |
| One-shot bootstrap socket (mkdtemp 0700, auto-cleanup) | Secret handoff to daemon | Secret is never written to disk; socket destroyed after first use |
| `probeBootstrapSocket` (live probe before cleanup) | Bootstrap dir cleanup | Prevents removing a live bootstrap directory |
| `delete process.env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE` | Daemon startup | Bootstrap path cannot be inherited by child processes or read from /proc |
| Attempt limit (3) + immediate exit | Interactive auth | Limits online brute-force window |
| SHA-256 hash deleted after migration | Legacy vault upgrade | Weak verifier removed on first successful unlock |
