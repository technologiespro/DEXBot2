# Plan: Replace btsdex with Native BitShares Integration

## Executive Summary

Replace the `btsdex` library (v0.7.11) with a purpose-built native module that implements only the BitShares JSON-RPC APIs, binary serialization, ECC cryptography, and transaction signing actually used by DEXBot2. **Zero external dependencies** — everything implemented using Node.js built-in `crypto`, `Buffer`, native `BigInt`, and the built-in `WebSocket`. ~20 npm packages removed. ~2,200 lines of owned code replace ~7,400 lines of third-party code.

## Current State

### btsdex Dependency Tree
```
btsdex@0.7.11 (single declared dependency)
├── btsdex-api@0.7.2       (connection status, history API, auto-reconnect)
├── btsdex-ecc@0.7.0       (elliptic curve cryptography for signing)
└── btsdex-serializer@0.7.9 (binary serialization for transactions)
```

Transitive dependencies to eliminate: `@babel/runtime`, `assert`, `bigi`, `bignumber.js`, `bytebuffer`, `bs58`, `create-hash`, `create-hmac`, `crypto-js`, `deep-equal`, `ecurve`, `isomorphic-ws`, `lzma`, `safe-buffer`, `secure-random` — **~20 npm packages total**.

### Monkey-Patches Required
Three patches in `modules/btsdex_event_patch.js` fix btsdex bugs:
1. `EventClass.getUpdate()` - crashes when `block.map.all` is uninitialized during reconnect
2. `EventClass.updateAccounts()` - crashes on empty history / missing account map entries
3. Resubscribe on auto-reconnect - btsdex-api reconnects WS but never re-registers subscriptions

### Architectural Pattern
- **Main bot**: Shared `BitSharesLib` for reads, per-account clients for signing
- **Claw subsystem**: Separate `BitSharesLib` instance for isolation
- **Credential daemon**: Direct `BitSharesLib` for broadcast with retry
- **Market adapter**: Already has lightweight `ws_client.js` (read-only JSON-RPC)

---

## Zero-Dependency Approach

Every function is implemented using only Node.js built-in modules. No npm packages required.

| Need | btsdex Uses | Replacement | How |
|---|---|---|---|
| WebSocket | `btsdex-api` → `isomorphic-ws` | **Node.js `WebSocket`** | Built-in since Node.js 22; market_adapter already proves raw WS works (see `ws_client.js`). Fallback to `ws` package documented for Node < 22. |
| JSON-RPC | `btsdex-api` | Custom `transport.js` | ~100 lines of protocol code |
| ECC key generation | `btsdex-ecc` → `ecurve`, `bigi` | **`crypto.createECDH('secp256k1')`** | OpenSSL C-level, 32-byte privkeys, compressed pubkeys |
| ECDSA signing (R,S) | `btsdex-ecc` → `ecurve`, `bigi` | **`crypto.sign()`** with `dsaEncoding: 'ieee-p1363'` | 64-byte R∥S at C speed; ~0.5 ms per sign |
| Recovery ID (v) | `btsdex-ecc` | **BigInt** point recovery | Only 2 candidate iterations per sign (~2 ms total); the only BigInt math in the hot path |
| SHA-256, SHA-512 | `btsdex-ecc` → `create-hash` | **`crypto.createHash()`** | Built-in |
| RIPEMD-160 | `btsdex-ecc` → `create-hash` | **`crypto.createHash('ripemd160')`** | Built-in |
| Secure random | `btsdex-ecc` → `secure-random` | **`crypto.randomBytes()`** | Built-in |
| Binary serializer | `btsdex-serializer` → `bytebuffer` | **`Buffer` + inline BufferReader** | Merged into `serializer.js` (~50-line wrapper) |
| Base58 | `btsdex-ecc` → `bs58` | In-house algorithm | ~30 lines (well-known encoding) |
| Big integers | `btsdex-ecc` → `bigi` | **Native `BigInt`** | Built-in since Node.js 10.4. Used only for recovery ID + modular inverse |

---

## Error Hierarchy

Custom error types for actionable debugging. All extend `ChainError` with `.code`, optional `.method`, and `.params`.

```
ChainError (base, extends Error)
├── ConnectionError          # WS handshake failed, timeout, or code
│   └── AllNodesFailed       # Every node in the list unreachable
├── RpcError                 # JSON-RPC returned an error
│   ├── RpcTimeoutError      # Request exceeded timeout
│   └── RpcMethodError       # Method-specific error (e.g., unknown asset symbol)
├── SerializationError       # Invalid or missing field in operation data
├── BroadcastError           # Transaction rejected by chain (with tx result)
├── CryptoError              # Invalid key format, signature failure
└── SubscriptionError        # Subscribe/unsubscribe on disconnected client
```

---

## Scope: What DEXBot2 Actually Uses

### 1. WebSocket Connection Management
| API | Used In | Description |
|-----|---------|-------------|
| `BitShares.connect(servers, autoreconnect)` | bitshares_client.js, claw, credential-daemon | Connect to node list |
| `BitShares.disconnect()` | bitshares_client.js, credential-daemon | Disconnect |
| `BitShares.node` (read/write) | bitshares_client.js, credential-daemon | Node list for failover |
| `BitShares.autoreconnect` | bitshares_client.js | Auto-reconnect flag |
| `BitShares.connectPromise` | bitshares_client.js, credential-daemon | Connection promise reset |
| `BitShares.chain.coreAsset` | bitshares_client.js, claw | Fee symbol lookup |

### 2. Database API (Read Operations)
| API | Used In | Description |
|-----|---------|-------------|
| `BitShares.db.get_assets([id])` | chain_orders.js, claw/chain_queries | Asset metadata by ID |
| `BitShares.db.lookup_asset_symbols([sym])` | chain_orders.js, claw/chain_queries | Asset metadata by symbol |
| `BitShares.db.get_full_accounts([ref], false)` | chain_orders.js, claw/chain_queries | Account data (balances, orders) |
| `BitShares.db.get_order_book(base, quote, depth)` | order/utils/system.js, claw/chain_queries | Order book |
| `BitShares.db.get_ticker(base, quote)` | order/utils/system.js, claw/chain_queries | Market ticker |
| `BitShares.db.get_objects([id])` | claw/chain_queries | Generic object lookup |
| `BitShares.db.getGlobalProperties()` | (indirect) | Chain globals |
| `BitShares.db.get_dynamic_global_properties()` | claw/chain_queries | Dynamic globals |
| `BitShares.db.call(method, args)` | claw/chain_queries | Generic RPC call |
| `BitShares.db.get_liquidity_pool_by_asset_ids(a, b)` | (LP queries) | LP lookup |
| `BitShares.db.get_liquidity_pools_by_share_asset([share])` | (LP queries) | LP by share asset |
| `BitShares.db.list_liquidity_pools(...)` | (LP queries) | LP pagination |
| `BitShares.db.get_call_orders(...)` | claw/chain_queries | Call orders for MPA |
| `BitShares.db.list_assets(...)` | claw/honest_ecosystem | Asset listing |

### 3. History API
| API | Used In | Description |
|-----|---------|-------------|
| `BitShares.history.getMarketHistory(...)` | market_adapter | Candlestick data |
| `BitShares.history.get_account_history_by_operations(...)` | btsdex_event_patch | Account history for patch |
| `BitShares.history.get_relative_account_history(...)` | (tests) | Relative history |
| `BitShares.history.get_liquidity_pool_history(...)` | market_adapter | LP trade history |
| `BitShares.history.get_liquidity_pool_history_by_sequence(...)` | market_adapter | LP history pagination |
| `BitShares.history.getAccountHistory(...)` | btsdex_event_patch | Account history |

### 4. Transaction Signing & Broadcasting
| API | Used In | Description |
|-----|---------|-------------|
| `new BitSharesLib(name, key, feeSymbol)` | chain_orders.js, claw, credential-daemon | Per-account signing client |
| `client.initPromise` | chain_orders.js, claw | Initialization wait |
| `client.newTx()` | chain_orders.js, credential-daemon, claw | Transaction builder |
| `tx.limit_order_create(data)` | chain_orders.js, claw | Create limit order op (ID 1) |
| `tx.limit_order_update(data)` | chain_orders.js, claw | Update limit order op (ID 77) |
| `tx.limit_order_cancel(data)` | chain_orders.js, claw | Cancel limit order op (ID 2) |
| `tx.call_order_update(data)` | claw/chain_actions | Borrow/adjust MPA (ID 3) |
| `tx.asset_settle(data)` | claw/chain_actions | Settle MPA (ID 17) |
| `tx.transfer(data)` | chain_orders.js (batch) | Asset transfer (ID 0) |
| `tx.broadcast()` | chain_orders.js, credential-daemon | Sign + broadcast |
| `client.broadcast(operation)` | credential-daemon | Direct broadcast |

### 5. Subscriptions & Events
| API | Used In | Description |
|-----|---------|-------------|
| `BitShares.subscribe('account', cb, name)` | chain_orders.js, claw/chain_actions | Account fill events |
| `BitShares.unsubscribe('account', cb, name)` | chain_orders.js, claw/chain_actions | Remove subscription |
| `EventClass.resubscribe()` | btsdex_event_patch | Re-register after reconnect |
| `EventClass.connected.subFunc` | bitshares_client.js | Connection error capture |
| `setNotifyStatusCallback(cb)` | btsdex_event_patch, bitshares_client | Connection status fanout |

### 6. Asset/Account Resolution
| API | Used In | Description |
|-----|---------|-------------|
| `BitShares.assets[id]` / `[symbol]` | (property access) | Asset cache lookup |
| `BitShares.accounts[name]` | (property access) | Account cache lookup |
| `accountHelpers.id(accountId)` | btsdex_event_patch | Resolve account ID to name |

---

## Target Architecture

### Layer Separation

The native library is split into three layers. Each layer depends only on the one below it and is independently testable.

```
┌──────────────────────────────────────────────┐
│  Facade (modules/bitshares_client.js)        │
│  Backward-compatible API surface. Thin       │
│  adapter over the clean native library.      │
│  Mirrors btsdex's static class + Proxy       │
│  patterns for existing consumers.            │
├──────────────────────────────────────────────┤
│  Native Library (modules/bitshares-native/)  │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐ │
│  │ chain      │ │ subscriptions │ resolvers │ │
│  │ _client.js │ │ .js       │ │ .js        │ │
│  ├────────────┤ └──────────┘ └────────────┘ │
│  │ signing    │ ┌──────────┐ ┌────────────┐ │
│  │ _client.js │ │ tx/builder│ │ serial/    │ │
│  └────────────┤ │ .js       │ │            │ │
│               │ └──────────┘ └────────────┘ │
│               │ ┌──────────────────────────┐ │
│               │ │ crypto/ecc.js            │ │
│               │ │ (BigInt + crypto module) │ │
│               │ └──────────────────────────┘ │
├──────────────────────────────────────────────┤
│  Transport (transport.js)                    │
│  Pure WebSocket + JSON-RPC 2.0. No chain    │
│  knowledge. Replaceable (WS, IPC, mock).    │
└──────────────────────────────────────────────┘
```

### Module Structure (13 files)

```
modules/bitshares-native/
├── index.js                  # Public exports (clean native API)
├── transport.js              # WS + JSON-RPC 2.0 (no chain logic)
├── chain_client.js           # Login, API discovery, db/history/broadcast proxies,
│                             #   chain config (chainId, coreAsset, addressPrefix),
│                             #   setNodes(), getConfig(), lazy API registration
├── subscriptions.js          # Account fill subscriptions, reconnect-safe
├── signing_client.js         # Per-account signing client factory
├── resolvers.js              # Asset/account resolution (LRU cached)
├── serial/
│   ├── index.js              # Re-exports
│   ├── serializer.js         # Serializer core + BufferReader/BufferWriter (~200 lines)
│   ├── types.js              # Primitive types (uint8→asset, static_variant) + ObjectId (~440 lines)
│   ├── operations.js         # 6 operations + fee params + signed_transaction envelope (~200 lines)
│   └── chain_constants.js    # Op type IDs, precision helpers, chain config constants (~80 lines)
├── crypto/
│   └── ecc.js                # All crypto: hash wrappers, secp256k1 (hybrid C/JS),
│                             #   ECDSA sign (crypto.sign + BigInt recovery), WIF encode/decode,
│                             #   brain key derivation (~430 lines)
├── tx/
│   └── builder.js            # Tx assembly, fee calculation, sign, broadcast + op helpers (~330 lines)
└── interfaces.d.ts           # TypeScript ambient declarations
```

### Design Principles
1. **Zero external dependencies** — Node.js `crypto`, `Buffer`, `BigInt`, `WebSocket` only
2. **No monkey-patching needed** — built correctly from the start
3. **Clean reconnection** — subscriptions re-registered automatically after reconnect
4. **Hybrid C/JS ECC** — `crypto.sign()` + `crypto.createECDH()` for heavy math (C speed); BigInt only for recovery ID (~1.5–2.0 ms per sign; total ~2.0–2.5 ms per signature)
5. **Layered architecture** — transport ⊥ chain_client ⊥ subscriptions/tx; each independently testable and replaceable
6. **Facade over clean API** — `bitshares_client.js` is a thin backward-compat adapter; native library has a clean modern interface
7. **TypeScript-ready** — JSDoc type annotations for all exports, `interfaces.d.ts` ambient declarations, no Proxy/monkey-patching
8. **Custom error hierarchy** — actionable error types with `.code`, `.method`, `.params`
9. **Lazy API registration** — `database` first, `history` second, `network_broadcast` last; reads work even if broadcast fails

---

## Key Design Details

### Facade Pattern

The native library exposes a clean, modern API. `modules/bitshares_client.js` wraps it in a backward-compatible facade:

```js
// Clean native API (modules/bitshares-native/index.js):
const client = createChainClient({ nodes, onStatusChange });
await client.connect();
await client.db.get_assets(['1.3.0']);
const accountClient = createSigningClient(client, accountName, privateKey);

// Backward-compat facade (modules/bitshares_client.js):
BitShares.connect = async (nodes) => _client.connect(nodes);
BitShares.db = new Proxy({}, { get: (_, m) => (...a) => _client.db(m, a) });
BitShares.subscribe = (event, cb, name) => _client.subscribe(name, cb);
// ... etc
```

Consumers that import the facade (`require('./bitshares_client')`) see no breaking changes. New code or claw can use the clean native API directly.

### Hybrid ECC Architecture

The hot path (signing) uses Node.js `crypto` built-in (OpenSSL C speed). BigInt is only used for the recovery ID iteration.

```
crypto.sign()           →  64-byte R∥S signature   (C, ~0.5 ms)
BigInt point recovery   →  recovery_id v            (JS, ~1.5–2.0 ms, up to 2 iterations)
Assembly                →  65-byte compact sig      (R∥S∥v)
```

> **Benchmark correction**: A single sign + recovery takes ~2.0–2.5 ms total. 1,000 signs ≈ 2.0–2.5 s (not 0.5 s). The C path dominates but recovery ID is unavoidable per signature. Batch operations amortize setup cost but do not reduce per-sign recovery work.

```
crypto.createECDH()     →  key generation           (C)
ecdh.setPrivateKey()    →  import raw 32-byte key   (C)
ecdh.getPublicKey()     →  33-byte compressed pub   (C)
crypto.createHash()     →  SHA-256, RIPEMD-160      (C)
crypto.randomBytes()    →  secure randomness        (C)
```

The raw 32-byte private key is imported into `crypto.sign()` via a SEC1 DER wrapper:
```js
const keyObj = crypto.createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e0201010420', 'hex'),  // SEC1 DER header
    rawPrivateKey,                          // 32 bytes
    Buffer.from('a00706052b8104000a', 'hex') // SEC1 DER trailer (secp256k1 OID)
  ]),
  format: 'der',
  type: 'sec1'
});
```

### Transaction Fee Calculation

BitShares fee schedules are more complex than a flat per-op fee. The tx builder queries the chain for current fees and must handle:

1. `getGlobalProperties()` → `parameters.current_fees.parameters` — a sorted `flat_set` of `fee_parameters` (a `static_variant` over all `fee_params_t` structs).
2. **Scale factor**: `parameters.current_fees.scale` (default `10000`). Final fee = `raw_fee * scale / 10000`.
3. **Per-operation fee params**:
   - `limit_order_create`: `fee` only
   - `limit_order_cancel`: `fee = 0` (hardcoded in core)
   - `limit_order_update`: `fee` only
   - `call_order_update`: `fee = 20 * GRAPHENE_BLOCKCHAIN_PRECISION`
   - `transfer`: `fee + price_per_kbyte` (memo size adds cost)
   - `asset_settle`: `fee` only
4. **Non-BTS fee assets**: If paying fees in an asset other than core (BTS), the builder must fetch the asset's `core_exchange_rate` and compute: `core_fee_amount * core_exchange_rate.quote.amount / core_exchange_rate.base.amount`. Rounding follows core rules (round up).
5. Set `fee` (`asset` struct with correct `amount` + `asset_id`) on each operation before signing.

**Safety guard**: `tx/builder.js` enforces a `MAX_TX_SIZE` limit (conservative 64 KB) and `MAX_OPS_PER_TX` (conservative 200) to prevent constructing transactions that would be rejected by chain validators. This aligns with the credential daemon's existing `maxOpsPerBatch` policy.

### Resolver Cache Policy

`resolvers.js` caches asset and account metadata to avoid repeated chain lookups. Define explicit cache semantics for long-running bot stability:
- **Assets**: TTL = 1 hour, keyed by `asset_id` + symbol. Invalidate on `asset_update` operation detection in subscription stream. Cap LRU at 2,000 entries.
- **Accounts**: Infinite TTL (IDs never change), but cap LRU at 1,000 entries to bound memory growth.
- **Account name → ID mappings**: TTL = 1 hour, because account names can technically be updated (rare).

### Lazy API Registration

API namespaces are registered on first use, not all at connect time:

1. `login` → always on connect
2. `database` → registered first (always needed for reads)
3. `history` → registered when first `client.history.*` call is made (needed for subscriptions/candles)
4. `network_broadcast` → registered when first `client.broadcast.*` call is made (only for signing clients)

If broadcast registration fails, read queries continue to work. The transport layer caches API IDs after first registration.

### Chain Config Validation

After `login`, the response includes `chain_id`, `immutable_parameters`, and `address_prefix`. `chain_client.getConfig()` caches and returns this. On connect, validate `chain_id` against the expected BitShares mainnet ID (`4018d7844c78...`). Reject connections to wrong networks.

---

## Implementation Phases

### Phase 0: Serialization Layer (starts first — critical path)
**Goal**: Port binary serialization for 6 operation types + signed_transaction envelope. Byte-for-byte identical to btsdex-serializer output.

**Deliverables**:
- `serial/serializer.js` — Serializer core: field→byte encode/decode + BufferReader/BufferWriter (~50 lines, replaces `bytebuffer`)
- `serial/types.js` — Primitive type codecs (`varint32`, `uint8` → `asset`, `static_variant`, `extension`, `public_key`, `time_point_sec`) + ObjectId encoding (~440 lines)
- `serial/operations.js` — 6 operation serializers + fee parameter types + `signed_transaction` envelope (~200 lines)
- `serial/chain_constants.js` — Operation type IDs, precision helpers (`GRAPHENE_BLOCKCHAIN_PRECISION = 100000`), chain ID constant (`4018d7844c78...`), address prefix (`BTS`) (~80 lines)

**Operation Type IDs**:
| ID | Name | DEXBot2 Usage |
|----|------|---------------|
| 0 | `transfer` | Batch transfers |
| 1 | `limit_order_create` | Grid order placement, startup reconciliation |
| 2 | `limit_order_cancel` | Grid order removal, maintenance cleanup |
| 3 | `call_order_update` | Claw MPA borrow/adjust |
| 4 | `fill_order` | Fill event filtering (read-only, no serializer needed) |
| 17 | `asset_settle` | Claw MPA settlement |
| 77 | `limit_order_update` | Grid order delta updates |

**Critical Serialization Details from BitShares Core**:
- **`extensions_type` binary format**: Not `[]`. In binary, `extensions_type` is a `flat_set<future_extensions>` which serializes as `unsigned_int count` followed by `(unsigned_int which + data)` pairs. Empty extensions = `unsigned_int(0)` (one zero byte). In JSON it is `{}`. The `extension<T>` type (used by `limit_order_create`, `call_order_update`) serializes the same way: count of present optional fields, then each field tagged by its index.
- **Object ID encoding**: Typed IDs (e.g., `account_id_type`, `asset_id_type`) serialize as `fc::unsigned_int` for the instance only (space/type are implicit). Generic `object_id_type` serializes as `uint64_t` raw. The serializer must use the compact `unsigned_int` form for all operation fields.
- **`optional<T>` encoding**: `true` byte + value if present; `false` byte (0x00) if absent. Used by `transfer.memo`, `limit_order_update.new_price`, `limit_order_update.delta_amount_to_sell`, `limit_order_update.new_expiration`, `limit_order_update.on_fill`.
- **`asset` encoding**: `int64 amount` + `unsigned_int asset_id` (instance only). Precision is NOT serialized in the operation; it is metadata looked up separately.
- **`time_point_sec` encoding**: `uint32` Unix timestamp. BitShares core uses `fc::time_point_sec`.
- **`price` encoding**: `{ base: asset, quote: asset }` (used inside `limit_order_update_operation`).
- **`future_extensions` passthrough**: Because `future_extensions` is a `static_variant<void_t>` that may gain new types in protocol upgrades, implement it as a passthrough: read `unsigned_int count`, then for each entry read `unsigned_int which` + raw bytes length + raw bytes. This ensures forward compatibility without hardcoding every extension type.

**Critical Gate**: Serialize known transactions from real chain data and compare byte-for-byte against btsdex-serializer output. This MUST pass before any code using serialization is deployed. Test vectors should cover all 6 operation types plus batch transactions.

**Testing**:
- Unit tests for each primitive type (round-trip serialize/deserialize)
- Unit tests for each operation type (byte-for-byte comparison against btsdex-serializer)
- Unit tests for signed_transaction envelope
- **Fuzz tests**: Random valid values for `asset`, `price`, `optional` fields, random extension arrays → serialize → deserialize → deep-equal
- **Mainnet corpus test**: Capture 50+ real transactions from mainnet blocks, serialize with native code, compare bytes to the block's embedded tx data (validates against ground truth, not just btsdex)
- Edge cases: empty extensions, min/max amounts, missing optionals, nested `extension<options_type>` fields

---

### Phase 1: Transport + Read-Only Client (runs in parallel with Phase 0)
**Goal**: Replace all read-only btsdex usage with native WebSocket + JSON-RPC 2.0 client.

**Deliverables**:
- `transport.js` — Pure transport layer (no chain knowledge):
  - Multi-node connect with sequential failover
  - JSON-RPC 2.0: request/response ID matching, per-call timeouts
  - Connection state machine: `connecting → open → closing → closed`
  - `onStatusChange(callback)` observer pattern (no monkey-patching)
  - `call(method, params, timeout)` — raw RPC
  - Jittered exponential backoff for reconnects
- `chain_client.js` — Chain-aware layer:
  - `connect()` — login → discover API IDs → validate chain config
  - Lazy API registration: database first, history/broadcast on demand
  - `db(method, args)`, `history(method, args)`, `broadcast(method, args)` RPC proxies
  - `setNodes(servers)` — runtime node rotation without reconnect
  - `getConfig()` → `{ chainId, coreAsset, addressPrefix }`
  - Chain ID validation against BitShares mainnet
  - `createReadOnlyClient()` — lightweight client for market adapter (db + history only, no broadcast API registration, no subscription overhead)

**Built on**: The proven `market_adapter/utils/ws_client.js` pattern (144 lines), extended for persistent connections, multi-node, and broadcasting.

**Testing**:
- Unit tests for transport lifecycle (mock WebSocket server)
- Unit tests for multi-node failover
- Unit tests for lazy API registration
- Integration tests against live node (gated by env var)

---

### Phase 1.5: Shadow Mode (Differential Testing)
**Goal**: Run native read-only client in parallel with btsdex for 24-48 hours to detect behavioral drift before any signing code is swapped.

**Deliverables**:
- `scripts/shadow_test.js` — Shadow runner:
  - Connects both btsdex and native `createReadOnlyClient()` to the same node(s).
  - Issues identical DB + history queries every 30 seconds: `get_assets`, `lookup_asset_symbols`, `get_full_accounts`, `get_order_book`, `get_ticker`, `getMarketHistory`.
  - Deep-compares responses object-for-object (ignoring field order).
  - Logs mismatches with full context (method, params, btsdex result, native result).
- `scripts/shadow_report.js` — Parses shadow logs, produces mismatch summary.

**What it catches**:
- JSON-RPC parsing differences (e.g., `null` vs missing fields, string vs number for IDs)
- Asset precision handling differences
- History API pagination edge cases
- Connection lifecycle timing differences

**Gate**: Zero mismatches on 6+ hours of shadow testing against mainnet before proceeding to Phase 2.

**Testing**:
- Shadow run against testnet (gated by env var)
- Shadow run against mainnet (read-only, no funds at risk)
- Forced node failover during shadow run to compare reconnection behavior

---

### Phase 2: Subscriptions & Events
**Goal**: Replace subscription system with native implementation (eliminates all 3 monkey-patches).

**Deliverables**:
- `subscriptions.js` — Subscription manager:
  - `subscribe(accountName, callback)` — register for fill events
  - `unsubscribe(accountName, callback)` — remove subscription
  - `onReconnect()` — re-register `setSubscribeCallback` + re-fetch `getFullAccounts`
  - Reconnect-safe state management (defensive initialization of all internal maps)
  - Empty-history-safe processing (null/empty guards on all history responses)
  - Object notification handler: filter for 2.5.x (fill) objects → fetch account history → invoke callbacks

**Key Improvements Over btsdex**:
- No `block.map.all` null pointer crashes — maps initialized before first use
- No missing account map entry crashes — null-safe history resolution
- Resubscribe is built-in — `onReconnect()` invoked explicitly by the connection lifecycle, not relying on btsdex-api's broken notification
- Observer pattern replaces monkey-patched fanouts
- **Fill deduplication reuses existing infrastructure**: The native subscription layer tracks the last seen `account_history` object ID (`1.11.X`) per account and delegates duplicate suppression to the existing `modules/order/processed_fill_store.js`. Do not build a second dedup system.

**Implementation Details**:
```
// Internal flow:
// 1. chain_client subscribes: database.setSubscribeCallback(handler, false)
// 2. Initial state: getFullAccounts([id], true) for each subscribed account
// 3. Notification: handler receives object updates
// 4. Fill detection: filter for 2.5.x objects owned by subscribed accounts
// 5. History fetch: history.getAccountHistory(id, '1.11.0', 100, '1.11.0')
// 6. Fill filtering: extract fill_order operations from history
// 7. Callback: invoke subscriber callbacks with fill batch
// 8. On reconnect: goto step 1 + step 2
```

**Testing**:
- Subscription lifecycle tests (subscribe → receive events → unsubscribe)
- Reconnect + resubscribe tests (force disconnect mid-session, verify fills still arrive)
- Multiple-account subscription tests
- Empty history edge case tests
- Fill deduplication across reconnect boundary

---

### Phase 3: Crypto + Transaction Signing
**Goal**: Replace ECC signing with hybrid C/JS implementation. Replace transaction building.

> **Security gate**: Before any native crypto module handles production private keys, a second developer must independently review `crypto/ecc.js`. Additionally, compare native signatures against `btsdex-ecc` for **1,000+ mainnet transaction vectors** (not just synthetic unit tests). The credential daemon is the only process that ever touches raw keys; its crypto path must be the most scrutinized code in the project.

#### 3a. Crypto Layer
Hybrid architecture: Node.js `crypto` (C) for heavy math, BigInt (JS) for recovery ID only.

`crypto/ecc.js` (~430 lines):
- Hash wrappers (inline helpers): `sha256()`, `sha512()`, `ripemd160()`, `hash160()` using `crypto.createHash()`
- Key management: `generatePrivateKey()`, `privateKeyToPublicKey()`, `importPrivateKey(raw)` using `crypto.createECDH()`
- Signing: `sign(digest, privateKey)` → 65-byte compact sig
  1. `crypto.sign('sha256', digest, { key: keyObj, dsaEncoding: 'ieee-p1363' })` → 64-byte R∥S (C, ~0.5 ms)
  2. For v ← 0,1: recover candidate public key; compare to known public key using BigInt point math (~1.5–2.0 ms)
  3. Assemble: `Buffer.concat([R, S, Buffer.from([v])])` → 65 bytes
- Verification: `verify(digest, signature, publicKey)` — decompress sig, recover pubkey, compare
- WIF: `wifDecode(wif)` → `{ privateKey: Buffer, compressed: boolean }`, `wifEncode(key, compressed)` → WIF string (base58check, ~30 lines)
- Brain key: `normalizeBrainKey(name, role, password)` → `brainKeyToPrivateKey(brainKey)` → 32-byte key

> **Performance note**: Total per-sign latency is ~2.0–2.5 ms. 1,000 signs ≈ 2.0–2.5 s. Recovery ID is the only unavoidable JS BigInt cost. Consider caching the recovery ID for identical (digest, key) pairs if batch-cancel workloads show repetition.

#### 3b. Transaction Builder
`tx/builder.js` (~330 lines):
- `createTransaction(client)` — fetch `get_objects(['2.0.0', '2.1.0'])` for ref block, set expiration (default 5 minutes, capped at chain max of 1 day)
- `addOperation(tx, type, params)` — serialize operation using Phase 0; throws `TransactionTooLargeError` if adding this op would exceed `MAX_TX_SIZE` or `MAX_OPS_PER_TX`
- `setRequiredFees(tx, client, feeAssetId)` — query `getGlobalProperties()` → parse fee schedule (including `scale` factor and `core_exchange_rate` for non-BTS fee assets) → calculate fees per operation
- `sign(tx, privateKey)` — serialize unsigned tx → SHA-256 digest → `sign(digest, key)` (Phase 3a)
- `broadcast(tx, client)` — `client.broadcast('broadcast_transaction', [signedTxBytes])` + parse result
- Batch safety guards:
  - `MAX_TX_SIZE = 64000` bytes (conservative, well below `GRAPHENE_DEFAULT_MAX_TRANSACTION_SIZE`)
  - `MAX_OPS_PER_TX = 200` (matches credential daemon `maxOpsPerBatch` policy; forces caller to split oversized batches)
- Inline operation creation helpers: `createLimitOrderOp()`, `createCancelOp()`, `createUpdateOp()`, etc.
- `createSigningClient(chainClient, accountName, privateKey)` — per-account client factory

**Testing**:
- ECC: Compare signatures byte-for-byte against btsdex-ecc for known test vectors
- ECC: Compare WIF encode/decode against btsdex-ecc for known key pairs
- ECC: Verify recovery ID computation correctness
- Tx: Round-trip: serialize → sign → verify against known test vectors
- Integration tests for order create/update/cancel on testnet (gated)

---

### Phase 4: Integration & Migration
**Goal**: Wire up native client to all consumers, remove btsdex.

**Deliverables**:
- **Feature-flag rollout strategy** (`DEXBOT_NATIVE_CHAIN` env var):
  ```js
  // modules/bitshares_client.js
  const USE_NATIVE = process.env.DEXBOT_NATIVE_CHAIN === '1';
  module.exports = USE_NATIVE
    ? require('./bitshares-native/facade')
    : require('./btsdex_legacy'); // existing btsdex path
  ```
  This allows instant rollback without code revert: set `DEXBOT_NATIVE_CHAIN=0` and restart.
- Update `modules/bitshares_client.js`:
  - Replace `require('btsdex')` with native client import (behind flag)
  - Replace `require('btsdex-api')` with native API
  - Remove `require('./btsdex_event_patch')` import
  - Wrap native API in backward-compatible facade: same exported API surface (`BitShares`, `waitForConnected()`, `createAccountClient()`)
  - Integrate with `NodeManager`: `setNodes()` on health check results
- Update `claw/modules/bitshares_client.js`:
  - Same pattern as main client; can use clean native API directly (no facade needed)
- Update `credential-daemon.js`:
  - Replace `require('btsdex')` with native client
  - Update `broadcastWithRetry()` to use native broadcast API
  - **Preserve security invariants from `docs/CREDENTIAL_SECURITY.md`**: The daemon remains the sole process holding decrypted keys. The native signing client runs only inside the daemon. Signing tokens exported to bot processes contain zero key material. All session cache, HKDF re-encryption, and `Buffer.fill(0)` zeroing on shutdown remain unchanged. The native crypto module must not introduce any key-export APIs that bypass the daemon boundary.
- Update `modules/chain_orders.js`:
  - `BitShares.db.*` → `client.db()`
  - `BitShares.subscribe()` → `client.subscribe()`
  - `tx.limit_order_create()` → `addOperation('limit_order_create', params)`
  - `tx.broadcast()` → `sign(key); broadcast(client)`
- Update market adapter:
  - Replace `ws_client.js` / `adapter_client.js` with `createReadOnlyClient()` from native library
- Update `modules/order/utils/system.js`, `credential_policy.js`, `credit_runtime.js`
- Update `package.json`:
  - Remove `"btsdex": "^0.7.11"`
  - (No new dependencies to add)
- Update all test mocks to use native client patterns
- Delete `modules/btsdex_event_patch.js`

**Canary rollout order** (after all tests pass):
1. `test` branch: 1 bot with `DEXBOT_NATIVE_CHAIN=1` for 48 hours
2. `test` branch: all bots with `DEXBOT_NATIVE_CHAIN=1` for 1 week
3. `dev` branch: merge and monitor
4. `main` branch: merge only after 2 weeks of stable `dev` operation
5. Remove feature flag and btsdex fallback in a subsequent release

**Testing**:
- Full test suite pass
- Live integration tests (gated)
- PM2 startup/shutdown tests
- Credential daemon integration tests

---

### Phase 5: Cleanup & TypeScript Preparation
**Goal**: Remove dead code, add type foundations, benchmark, document.

**Deliverables**:
- Delete `tests/test_btsdex_event_patch.js`
- Remove all btsdex-related mocking from test files
- Add JSDoc `@type`, `@param`, `@returns` annotations on all exports
- Create `interfaces.d.ts` with ambient TypeScript declarations:
  ```typescript
  // Key types for future TS migration
  export interface Asset { asset_id: string; amount: number; }
  export interface LimitOrderCreateOp { fee: Asset; seller: string; amount_to_sell: Asset; min_to_receive: Asset; expiration: string; fill_or_kill: boolean; extensions: object; }
  export interface ChainClient { connect(): Promise<void>; disconnect(): void; getStatus(): string; getConfig(): ChainConfig; setNodes(nodes: string[]): void; db(method: string, args: any[]): Promise<any>; history(method: string, args: any[]): Promise<any>; broadcast(method: string, args: any[]): Promise<any>; }
  export interface SigningClient { newTx(): TxBuilder; broadcast(operation: any): Promise<any>; }
  ```
- Performance benchmarks vs btsdex (connection time, RPC latency, sign latency)
- Migration guide for any external consumers

**TypeScript Readiness Rules** (applied throughout all phases):
| Rule | Why |
|---|---|
| JSDoc on every export | TS `checkJs` can type-check `.js` with JSDoc. Migration = rename `.js` → `.ts` |
| No Proxy, no monkey-patching (in native lib) | TS can't type-check these. Explicit functions only. Proxy only in compat facade. |
| `interfaces.d.ts` | Ambient type declarations in one file, referenced by JSDoc `@type` tags |
| Single-responsibility files | Each file does one thing. Trivial to convert file-by-file |
| Named exports | `module.exports = { connect, sign }` → easy to convert to `export { connect, sign }` |
| Native `BigInt`, `Buffer`, `crypto` | All have first-class TypeScript types |
| No class inheritance | Factory functions and plain objects; classes OK but no deep hierarchies |
| Write `.d.ts` during Phase 0 | Eliminates the 20-30 hour `@types/btsdex` wrapper effort from the TS migration analysis; types are correct because we own the API |

---

## Rollback & Incident Response

| Scenario | Detection | Response | Rollback |
|----------|-----------|----------|----------|
| Native serializer produces invalid tx on mainnet | `BroadcastError` with `tx_expired` or `invalid_transaction` | Halt all signing via daemon; alert operator; inspect `shadow_test` logs | `DEXBOT_NATIVE_CHAIN=0` + restart |
| Fill events dropped after reconnect | `processed_fill_store.js` staleness alarm (> 60 s without new fills) | Fallback to periodic `get_account_history` poll; do not rely solely on subscriptions | `DEXBOT_NATIVE_CHAIN=0` + restart |
| Signature rejected by chain | `BroadcastError` with `missing_active_authority` or `bad_signature` | Halt signing immediately; do NOT auto-retry broadcast | `DEXBOT_NATIVE_CHAIN=0` + restart; inspect `crypto/ecc.js` |
| Node failover loop (> 3 reconnects in 60 s) | NodeManager stats | Throttle reconnects; fallback to btsdex path | `DEXBOT_NATIVE_CHAIN=0` + restart |
| Credential daemon crash on native crypto | Daemon ready file missing | Bot falls back to interactive prompt (existing behavior) | Restart daemon on btsdex path; fix native crypto |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Serialization bugs cause invalid transactions | Medium | **Critical** | Byte-for-byte comparison against btsdex-serializer for all 6 op types + batch; **mainnet corpus test** against real block data; exhaustive test vectors; testnet validation before deployment |
| `extension<T>` binary format drift vs core | Low | **Critical** | Implement `future_extensions` as passthrough (`unsigned_int count` + raw bytes) for forward compatibility; validate against core `ext.hpp` serialization logic |
| Object ID serialization uses wrong width | Low | **Critical** | Typed IDs serialize as `fc::unsigned_int` instance only (space/type implicit); validated against mainnet corpus and btsdex-serializer output |
| ECC recovery ID computation wrong | Low | **High** | Recovery ID is the only BigInt math; verified against btsdex-ecc for **1,000+ mainnet vectors**; second-developer audit gate; RFC6979 reference implementation |
| `crypto.sign()` signature format mismatch | Low | **High** | `ieee-p1363` encoding produces standard 64-byte R∥S; validated against btsdex-ecc output |
| Reconnection edge cases drop fills | Medium | **High** | Built-in resubscribe designed from scratch to fix btsdex's 3 bugs; forced-reconnect integration tests; fill dedup across reconnect boundary using `processed_fill_store.js` |
| Chain ID validation blocks testnet | Low | **Medium** | Configurable chain ID override; testnet CI uses env var |
| Node.js `WebSocket` API quirks | Low | **Low** | `WebSocket` is stable in Node.js 22+; market adapter already uses raw WS successfully; fallback to `ws` package documented |
| BigInt performance for recovery ID | **Low** | **Low** | ~2.0–2.5 ms per sign total; 1,000 signs ≈ 2.0–2.5 s; signing hot path is in C via `crypto.sign()`; cache recovery ID for identical (digest, key) pairs if batch workloads show repetition |
| Backward-compatible API surface gaps | Low | **Medium** | Facade pattern isolates compat layer; full test suite catches regressions; gated live tests; **feature flag allows instant rollback** |
| Credential daemon security regression | Low | **Critical** | Native crypto module provides **no key-export APIs**; daemon boundary enforced by architecture review; `docs/CREDENTIAL_SECURITY.md` invariants preserved |

---

## What Gets Eliminated

| Old | New | Lines Owned |
|---|---|---|
| `btsdex` (high-level: event, tx builder, accounts/assets) ~1,530 lines | `chain_client.js` + `subscriptions.js` + `signing_client.js` + `resolvers.js` | ~600 lines |
| `btsdex-api` (WS + JSON-RPC) ~441 lines | `transport.js` | ~150 lines |
| `btsdex-ecc` (ECC + 11 transitive deps) ~1,703 lines | `crypto/ecc.js` (hybrid C/JS) | ~430 lines |
| `btsdex-serializer` (binary + `bytebuffer`) ~3,732 lines | `serial/` directory (4 files) | ~920 lines |
| `btsdex_event_patch.js` (198 lines of patches) | Built correctly from start | **Deleted** |
| `@types/btsdex` wrapper effort (from TS migration analysis) | Native library ships with `.d.ts` from Phase 0 | **Saved: 20-30 hours** |
| `elliptic`, `bs58check`, `create-hash`, `isomorphic-ws` | None needed (proposed in v1 of this plan) | **Never added** |
| **~20 npm packages, ~7,400 lines** | **~2,100 lines of DEXBot2-owned code, 13 files** | **Zero external deps** |

---

## API Compatibility Matrix

### Facade Maintains (Drop-in Compatible via `bitshares_client.js`)

```javascript
// Connection
BitShares.connect(servers, autoreconnect)
BitShares.disconnect()
BitShares.node = [...]
BitShares.autoreconnect = true
BitShares.connectPromise = undefined
BitShares.chain.coreAsset

// Database
BitShares.db.get_assets([id])
BitShares.db.lookup_asset_symbols([symbol])
BitShares.db.get_full_accounts([ref], false)
BitShares.db.get_order_book(base, quote, depth)
BitShares.db.get_ticker(base, quote)
BitShares.db.get_objects([id])
BitShares.db.call(method, args)
BitShares.db.get_liquidity_pool_by_asset_ids(a, b)
BitShares.db.get_liquidity_pools_by_share_asset([share])
BitShares.db.list_liquidity_pools(...)
BitShares.db.get_call_orders(...)
BitShares.db.list_assets(...)
BitShares.db.getGlobalProperties()
BitShares.db.get_dynamic_global_properties()

// History
BitShares.history.getMarketHistory(...)
BitShares.history.get_account_history_by_operations(...)
BitShares.history.get_liquidity_pool_history(...)
BitShares.history.get_liquidity_pool_history_by_sequence(...)
BitShares.history.getAccountHistory(...)

// Signing
new BitShares(name, key, feeSymbol)
client.initPromise
client.newTx()
tx.limit_order_create(data)
tx.limit_order_update(data)
tx.limit_order_cancel(data)
tx.call_order_update(data)
tx.asset_settle(data)
tx.transfer(data)
tx.broadcast()
client.broadcast(operation)

// Subscriptions
BitShares.subscribe('account', callback, accountName)
BitShares.unsubscribe('account', callback, accountName)
```

### Clean Native API (New Consumers / Claw)
```javascript
const { createChainClient, createSigningClient, createReadOnlyClient } = require('bitshares-native');

// Full client
const client = createChainClient({ nodes, onStatusChange });
await client.connect();
const assets = await client.db.get_assets(['1.3.0']);
client.setNodes(newNodes); // runtime rotation

// Read-only client (market adapter)
const roClient = createReadOnlyClient({ nodes });
const candles = await roClient.history.getMarketHistory(...);

// Signing client
const signer = createSigningClient(client, accountName, privateKey);
const tx = signer.newTx();
tx.addOperation('limit_order_create', { ... });
await tx.setRequiredFees();
tx.sign();
await tx.broadcast();

// Subscriptions
const unsub = await client.subscribe(accountName, (fills) => { ... });
```

### Can Change (Internal Only)
- `btsdex-api` direct imports → native equivalents
- `btsdex/lib/event` imports → native subscription manager
- `btsdex/lib/account` imports → native account resolver
- Module cache stubbing in tests → mock the native client
- `market_adapter/utils/ws_client.js` → replaced by `createReadOnlyClient()`

---

## Success Criteria

1. **Zero btsdex imports** — `grep -r "require('btsdex')"` returns no results
2. **Zero npm runtime dependencies** — `package.json` has no `dependencies`
3. **All tests pass** — `npm test` passes without modification to test logic
4. **Live operations work** — gated live tests pass against real BitShares node
5. **No monkey-patching** — `btsdex_event_patch.js` deleted, no equivalent needed
6. **Performance at parity or better** — connection and RPC latency at parity or better; signing latency ~2.0–2.5 ms per op (acceptable vs btsdex)
7. **Clean reconnection** — fills not lost during node failover
8. **TypeScript-ready** — JSDoc annotations + `interfaces.d.ts` enable future `tsc --checkJs` pass; types written during Phase 0, not bolted on later
9. **Custom errors** — all error paths throw typed `ChainError` subclasses with `.code` and context
10. **Feature flag operational** — `DEXBOT_NATIVE_CHAIN=1` enables native; `DEXBOT_NATIVE_CHAIN=0` instantly reverts to btsdex without code change
11. **Shadow mode clean** — 6+ hours of shadow differential testing against mainnet with zero mismatches
12. **Security audit signed off** — second developer review of `crypto/ecc.js`; 1,000+ mainnet signature vectors match btsdex-ecc
13. **Credential daemon invariants preserved** — no raw key export APIs in native crypto; daemon remains sole key holder

---

## Estimated Timeline

| Phase | Duration | Cumulative | Depends On |
|-------|----------|------------|------------|
| Phase 0: Serialization | 1-2 weeks | 1-2 weeks | — (critical path, starts first) |
| Phase 1: Transport + Read-Only | 1-2 weeks | 2-3 weeks | — (runs in parallel with Phase 0) |
| Phase 1.5: Shadow Mode | 3-5 days | 2.5-3.5 weeks | Phase 1 |
| Phase 2: Subscriptions | 1 week | 3.5-4.5 weeks | Phase 1 |
| Phase 3: Crypto + Tx Signing | 1-2 weeks | 4.5-6.5 weeks | Phase 0 + Phase 1 |
| Phase 4: Integration + Canary | 1-2 weeks | 5.5-8.5 weeks | Phases 0-3 |
| Phase 5: Cleanup + TS prep | 1 week | 6.5-9.5 weeks | Phase 4 |

**Total**: 7-10 weeks of focused development (includes shadow mode and security audit).
**Critical path**: Phase 0 (serializer) must complete before Phase 3 (crypto/tx) can be validated end-to-end. Phase 1.5 (shadow mode) is a hard gate before Phase 3.

---

## References

### BitShares JSON-RPC API
- Database API: `call(<api_id>, "<method>", [<args>])` where api_id is discovered via `call(1, "database", [])`
- History API: `call(<api_id>, "<method>", [<args>])` where api_id is discovered via `call(1, "history", [])`
- Network Broadcast: `call(<api_id>, "<method>", [<args>])` via `call(1, "network_broadcast", [])`
- Login: `call(1, "login", ["", ""])` → returns chain config with `chain_id`, `address_prefix`

### Operation Type IDs (BitShares Protocol)
| ID | Name | DEXBot2 Usage |
|----|------|---------------|
| 0 | `transfer` | Batch transfers |
| 1 | `limit_order_create` | Grid order placement, startup reconciliation |
| 2 | `limit_order_cancel` | Grid order removal, maintenance cleanup |
| 3 | `call_order_update` | Claw MPA borrow/adjust |
| 4 | `fill_order` | Fill event filtering (read-only, no serializer needed) |
| 17 | `asset_settle` | Claw MPA settlement |
| 77 | `limit_order_update` | Grid order delta updates |

### secp256k1 Curve Parameters (SEC2 Standard)
```
p = FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
n = FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = 02 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    (compressed generator, x-coordinate only)
a = 0
b = 7
```

### Chain Type Serialization Reference
- Object IDs: `1.2.X` (account), `1.3.X` (asset), `1.7.X` (limit_order), `1.10.X` (account_balance), `1.11.X` (account_transaction_history), `1.19.X` (liquidity_pool)
- **Typed Object ID binary format**: In operation fields, typed IDs (e.g., `account_id_type`) serialize as `fc::unsigned_int` for the instance only (space/type are implicit from context). Generic `object_id_type` serializes as full `uint64_t`.
- Asset amounts: `{ amount: <int64>, asset_id: <protocol_id_type> }`
- Prices: `{ base: <asset_amount>, quote: <asset_amount> }`
- Signatures: 65-byte compact format `(r[32] ∥ s[32] ∥ recovery_id[1])`
- Public keys: 33-byte compressed format `(02/03 ∥ x[32])`
- Fee parameter structures: operation-specific (e.g., `limit_order_create_operation_fee_parameters` has `fee: int64` + `price_per_kbyte: uint32`)
- **Extensions binary format**: `extension<T>` and `extensions_type` serialize as `unsigned_int count` followed by `(unsigned_int which + data)` pairs. Empty = `unsigned_int(0)` (one zero byte). JSON form is `{}`. See `libraries/protocol/include/graphene/protocol/ext.hpp`.
- SEC1 DER key wrapper: `302e0201010420<32-byte-key>a00706052b8104000a` (for importing raw keys into `crypto.sign()`)

### Existing Pattern Reference
- `market_adapter/utils/ws_client.js` — lightweight read-only client (144 lines). Proof that raw WS + JSON-RPC works for BitShares queries.
- `node_modules/btsdex-serializer/lib/` — reference implementation for serialization. Operations are defined declaratively as `{ fieldName: typeCodec }` maps.
- `node_modules/btsdex-ecc/lib/` — reference for ECC output format. Uses RFC6979 deterministic nonces.

### Security & Migration References
- `docs/CREDENTIAL_SECURITY.md` — Credential daemon architecture: session cache, HKDF re-encryption, signing tokens, Unix socket security, `maxOpsPerBatch` policy. Native replacement must preserve every invariant.
- `docs/TYPESCRIPT_MIGRATION_ANALYSIS.md` — TS migration effort estimate. Because btsdex is replaced by a native library with built-in types, the 20-30 hour `@types/btsdex` wrapper effort is eliminated. Reinvest that time into writing `interfaces.d.ts` during Phase 0.

---

## Implementation Notes

- **`limit_order_create` vs `limit_order_update` extension layout**: In `limit_order_create`, `on_fill` lives inside `extension<options_type>` (the `extensions` field). In `limit_order_update`, `on_fill` is a **top-level optional** separate from `extensions`. `operations.js` must reflect the correct field order for each.
- **`transfer` memo encryption**: DEXBot2 batch transfers currently omit memos. If memos are ever added, the builder needs `memo_data` serialization (1-byte prefix + AES payload). Not required for initial scope.
- **Fee stabilization loop**: BitShares core caps fee iteration at `MAX_FEE_STABILIZATION_ITERATION = 4`. DEXBot2 ops don't trigger circular fees, but the builder should loop until convergence or 4 iterations to match core behavior.
