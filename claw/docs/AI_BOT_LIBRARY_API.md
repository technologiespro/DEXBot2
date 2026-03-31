# Claw Infrastructure API Boundary

This document defines the boundary between:

- `DEXBot2`: runtime infrastructure, BitShares connectivity, credentials, and execution substrate
- `Claw`: bridge layer, shared infrastructure, and workflow owner

The goal is simple:

- `Claw` provides shared infrastructure helpers and a bridge surface
- `Claw` can talk to DEXBot2 and the blockchain directly
- The infrastructure layer stays reusable and decision-free

The current scaffold lives in [../modules/claw_infra.js](../modules/claw_infra.js), [../modules/dexbot_profiles.js](../modules/dexbot_profiles.js), and [../modules/zeroclaw_bridge.js](../modules/zeroclaw_bridge.js), and is exported from [../index.js](../index.js).

## Design Rules

The Claw infrastructure layer should:

- provide shared runtime helpers
- provide connection and credential adapters
- provide configuration, logging, and state helpers
- provide market-data and BitShares utility wrappers
- provide order/grid math primitives only
- expose write-capable clients only behind explicit caller intent
- avoid process management
- avoid exposing raw private keys or bypassing the credential daemon boundary
- avoid owning persistent execution state
- avoid making strategy decisions

The Claw workflow layer should:

- manage lifecycle and persistence
- place, cancel, and rebalance orders
- talk to DEXBot2 when it needs shared runtime support
- decide whether to apply or ignore recommendations

## Recommended Shape

The cleanest shape is a small library with a narrow, typed surface:

- input: plain objects / JSON
- output: plain objects / JSON
- no side effects unless explicitly requested

Think of Claw's infrastructure layer as the shared foundation that the workflow layer builds on.

## ZeroClaw Compatibility

ZeroClaw should use Claw as a compatibility layer, not as a second signing or credential system.

- ZeroClaw can invoke the JSON/CLI bridge in [../scripts/zeroclaw_bridge.js](../scripts/zeroclaw_bridge.js).
- The manifest lives in [../modules/zeroclaw_manifest.js](../modules/zeroclaw_manifest.js) and is safe to query without starting the BitShares runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- ZeroClaw gets read access to market, profile, HONEST, and order context, plus explicit action entrypoints when it needs to request a trade operation.

The bridge surface currently includes:

- runtime and manifest inspection
- profile, market, and account snapshots
- open-order queries
- HONEST context and pricing
- limit order create, cancel, update, and batch execution
- MPA borrow, repay, collateral adjustment, and settlement
- BTS-backed short open, take-profit, close, and plan builders
- MPA position lookup

Recommended trust boundary:

1. ZeroClaw sends an intent or request.
2. Claw resolves the request and, when needed, asks DEXBot2 for the signing key.
3. DEXBot2 returns the key only to Claw over the local daemon socket.
4. Claw broadcasts the operation.
5. ZeroClaw never receives or stores the key.

To generate the skill file from Claw, run:

```bash
npm run zeroclaw:skill -- --profile-root /home/alex/BTS/Git/DEXBot2 --output ~/.zeroclaw/workspace/skills/ai-bots/SKILL.toml
```

## Core Types

### `RuntimeContext`

The shared runtime wiring Claw assembles for its consumers.

```ts
type RuntimeContext = {
  accountName: string | null;
  createdAt: string;
  cwd: string;
  dataDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  name: string;
  profileRoot: string | null;
  readyFilePath: string;
  socketPath: string;
  stateDir: string;
  config: Record<string, unknown>;
};
```

### `BotState`

The bot-specific state Claw already owns and passes through the infrastructure layer.

```ts
type BotState = {
  botId: string;
  name: string;
  activeOrders?: number;
  incrementPercent?: number;
  targetSpreadPercent?: number;
  weightDistribution?: { sell: number; buy: number };
  botFunds?: { sell: string | number; buy: string | number };
  minPrice?: string | number;
  maxPrice?: string | number;
  gridPrice?: string | number | null;
  lastResetAt?: number;
  lastCenterPrice?: number;
};
```

### `ConstraintSet`

The execution limits Claw wants its own logic to respect.

```ts
type ConstraintSet = {
  minIncrementPercent?: number;
  maxIncrementPercent?: number;
  minSpreadPercent?: number;
  maxSpreadPercent?: number;
  minOrdersPerSide?: number;
  maxOrdersPerSide?: number;
  reservePercent?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
  avoidDust?: boolean;
};
```

## Public API

### 1. `createRuntimeContext(options)`

Creates a shared runtime object for Claw.

```ts
type RuntimeOptions = {
  name: string;
  accountName?: string;
  socketPath?: string;
  readyFilePath?: string;
  dataDir?: string;
  stateDir?: string;
  profileRoot?: string;
  logger?: unknown;
  config?: Record<string, unknown>;
};
```

This should be the central bootstrap helper for a consistent runtime shape.

### 2. `createBitsharesClient(options)`

Returns a read/write BitShares client wrapper.

This helper should:

- connect to BitShares
- reuse the shared client pattern already in Claw
- ask the DEXBot2 credential daemon for keys when needed
- keep key handling out of callers

### 3. `createCredentialClient(options)`

Returns a thin client for DEXBot2's Unix-socket credential daemon.

This is the bridge between Claw and the DEXBot2 credential infrastructure.

### 4. `createStateStore(options)`

Returns a simple filesystem-backed state store.

Use this for:

- bot metadata
- position snapshots
- cached market snapshots
- restart recovery

### 5. `createMarketAdapter(options)`

Returns a data access layer for market snapshots and chain-derived state.

This is infrastructure only:

- reads
- subscriptions
- normalization
- no decision making

### 6. `createOrderTools(options)`

Returns the DEXBot2 order subsystem exports directly:

- grid math
- order sizing
- spread calculation
- bounds validation
- fee estimation

This is the right place for reusable mechanics that Claw needs before it decides what to do.

### 7. `createDexbotProfileAdapter(profileRoot, options)`

Reads the DEXBot2 `profiles/` directory and normalizes:

- `profiles/config.json` when present
- `profiles/bots.json`
- `profiles/general.settings.json`
- `profiles/ama_profiles.json`
- per-bot files in `profiles/orders/`

This is the profile-folder bridge for Claw.

### 8. `getClawProfileContext(identifier, options)`

Returns one normalized JSON object that combines:

- DEXBot2 profile files
- selected bot metadata
- selected bot order snapshots
- selected AMA profile match
- derived summary fields

This is the preferred one-call entrypoint for Claw.

### 9. `createHonestEcosystemAdapter(options)`

Returns a HONEST-focused infrastructure helper that:

- loads `HONEST.*` assets
- exposes the hardcoded `HONEST.MONEY/BTS` bridge
- resolves HONEST pair contexts with DEXBot2 pool utilities
- resolves pair prices without introducing strategy decisions

Useful companion method:

- `resolveHonestPairPrice(assetA, assetB, options)` for the special-case bridge plus DEXBot2 fallback pool pricing

### 10. Command bridge

The bridge exposed by [../modules/claw_bridge.js](../modules/claw_bridge.js) supports:

- `manifest`
- `runtime`
- `profile-context`
- `market-snapshot`
- `account-snapshot`
- `open-orders`
- `honest-context`
- `honest-pair`
- `honest-price`
- `create-limit-order`
- `cancel-limit-order`
- `build-update-limit-order-op`
- `update-limit-order`
- `execute-batch`
- `borrow-mpa`
- `repay-mpa`
- `adjust-mpa-collateral`
- `settle-mpa`
- `open-short-bts`
- `take-profit-bts`
- `close-short-bts`
- `build-open-short-plan`
- `build-take-profit-plan`
- `build-close-short-plan`
- `mpa-position`
- `dynamic-weight-policy`
- `dynamic-weight-preview`
- `dynamic-weight-apply`

## Root Export Disambiguation

The barrel export in `claw/index.js` spreads every module into one flat namespace. Several modules define functions with the same name but different semantics. The barrel resolves these collisions with explicit trailing overrides:

| Export name | Source module | Purpose |
|---|---|---|
| `resolveAccountName` | `chain_queries` | Async lookup — returns the account name string for an ID, or passes through the original name |
| `resolveSigningAccountName` | `chain_broadcast` | Sync extraction — returns the signing account name string from a context object |
| `describeZeroClawBridge` | `zeroclaw_manifest` | Returns the ZeroClaw manifest descriptor (runtime name, command examples) |
| `describeZeroClawRuntimeBridge` | `zeroclaw_bridge` | Returns the ZeroClaw runtime bridge descriptor |

When consuming `claw/index.js` as a library, use the disambiguated names above. The non-prefixed `resolveAccountName` and `describeZeroClawBridge` point to the query/manifest variants by default.

## Dynamic Weight Service: Non-BTS Quote Support

The dynamic weight service (`modules/dynamic_weight_service.js`) defaults to requiring BTS as the quote asset. Two mechanisms extend this for markets with non-BTS quote assets.

### `supportsNonBtsQuotes` option

Pass `supportsNonBtsQuotes: true` to `createDynamicWeightService(deps)` to allow bots whose quote asset is not BTS to pass eligibility checks.

When omitted, the service auto-detects: if a custom `fetchTrendInput` function is injected (i.e. it differs from the built-in default), `supportsNonBtsQuotes` defaults to `true` on the assumption that custom trend sources know how to price non-BTS pairs. Pass `supportsNonBtsQuotes: false` explicitly to override the auto-detection.

When a bot has a non-BTS quote and the trend source does not support it, `isEligibleBot` rejects with reason `trend_source_requires_bts_quote` before any trend data is fetched.

### `fetchTrendInput` context parameter

`fetchTrendInput` now receives a second argument — a context object:

```ts
type TrendInputContext = {
  bot: object;         // deep clone of the selected bot
  marketRef: string;   // resolved market asset reference
  quoteRef: string;    // resolved quote asset reference
  requireBtsQuote: boolean; // current policy value
};
```

Custom `fetchTrendInput` implementations can use the context to route pricing for non-BTS markets (e.g. fetching an external oracle instead of the BTS feed).

The built-in `fetchTrendInput` ignores the context parameter, so existing callers are unaffected.

## Suggested Runtime Flow

1. Claw collects market data and its own state.
2. Claw creates shared runtime helpers via `createRuntimeContext`.
3. Claw loads the DEXBot2 profile bundle through the adapter.
4. Claw uses HONEST and profile context helpers when needed.
5. Claw makes all decisions.
6. Claw executes against DEXBot2 and the blockchain.

That keeps the separation clean:

- Claw infrastructure provides the foundation
- Claw workflow decides
- DEXBot2 supports runtime execution

## Practical Policy

The Claw infrastructure layer should be allowed to provide:

- connection wrappers
- credential daemon access
- file-backed state stores
- market-data adapters
- order and grid math helpers
- validation and normalization utilities
- explicit execution adapters that still keep key material behind DEXBot2

The Claw infrastructure layer should not be responsible for:

- strategy decisions
- signing policy
- key ownership
- PM2 lifecycle
- bot orchestration
- persisting execution decisions
- autonomous trade execution without explicit caller intent

## Minimal JSON Contract

If you want the simplest possible integration, use one request and one response for infrastructure wiring.

### Request

```json
{
  "runtime": {
    "name": "claw-runtime",
    "accountName": "your-account",
    "socketPath": "/tmp/dexbot-cred-daemon.sock"
  },
  "state": {
    "botId": "claw-01",
    "dataDir": "./data",
    "stateDir": "./data/state"
  }
}
```

### Response

```json
{
  "runtime": {
    "ready": true,
    "resolvedSocketPath": "/tmp/dexbot-cred-daemon.sock",
    "notes": ["Credential daemon is reachable."]
  },
  "stores": {
    "stateStore": "filesystem",
    "cacheStore": "filesystem"
  },
  "tools": {
    "orderMath": "available",
    "marketAdapter": "available",
    "bitsharesClient": "available"
  }
}
```

## Good Default Split

If you want a simple division of responsibility:

- `Claw` infrastructure provides the common foundation
- `Claw` workflow makes trading decisions
- `DEXBot2` handles the runtime substrate and credentials

That gives you a reusable infrastructure layer without coupling it to any single executor.
