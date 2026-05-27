# Claw Infrastructure API Boundary

This document defines the boundary between:

- `DEXBot2`: runtime infrastructure, BitShares connectivity, credentials, and execution substrate
- `Claw`: bridge layer, shared infrastructure, and workflow owner

The goal is simple:

- `Claw` provides shared infrastructure helpers and a bridge surface
- `Claw` can talk to DEXBot2 and the blockchain directly
- The infrastructure layer stays reusable and decision-free

The current scaffold lives in [../modules/claw_infra.ts](../modules/claw_infra.ts), [../modules/dexbot_profiles.ts](../modules/dexbot_profiles.ts), [../modules/nanoclaw_bridge.ts](../modules/nanoclaw_bridge.ts), [../modules/openfang_bridge.ts](../modules/openfang_bridge.ts), [../modules/zeroclaw_bridge.ts](../modules/zeroclaw_bridge.ts), and [../modules/nullclaw_bridge.ts](../modules/nullclaw_bridge.ts), and is exported from [../index.ts](../index.ts).

## Design Rules

The Claw infrastructure layer should:

- provide shared runtime helpers
- provide connection and credential adapters
- provide configuration, logging, and state helpers
- provide market-data and BitShares utility wrappers
- provide low-level order/grid math helpers only
- expose write-capable clients only behind explicit caller intent
- manage bot-level settings only; keep DEXBot general settings default-first and explicit-only
- treat `profiles/general.settings.json` as read-only context, not a Claw write surface
- avoid process management
- avoid exposing raw private keys or bypassing the credential daemon boundary
- avoid owning persistent execution state
- avoid making strategy decisions

The Claw workflow layer should:

- manage lifecycle and persistence
- place, cancel, and rebalance orders
- talk to DEXBot2 when it needs shared runtime support
- decide whether to apply or ignore recommendations
- keep launcher orchestration, PM2 startup, and Docker entrypoint behavior in the `launcher-ops` skill boundary instead of the infrastructure API boundary

## Recommended Shape

The cleanest shape is a small library with a narrow, typed surface:

- input: plain objects / JSON
- output: plain objects / JSON
- no side effects unless explicitly requested

Think of Claw's infrastructure layer as the shared foundation that the workflow layer builds on.

## ZeroClaw Compatibility

ZeroClaw should use Claw as a compatibility layer, not as a second signing or credential system.

- ZeroClaw can invoke the JSON/CLI bridge in [../scripts/zeroclaw_bridge.ts](../scripts/zeroclaw_bridge.ts).
- The manifest lives in [../modules/zeroclaw_manifest.ts](../modules/zeroclaw_manifest.ts) and is safe to query without starting the BitShares runtime.
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

Launcher behavior such as `tsx unlock-start --claw-only` and `tsx pm2 claw-only` is documented and maintained separately under `skills/launcher-ops/`.

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

## NullClaw Compatibility

NullClaw uses the same bridge surface, with a native skill path centered on `SKILL.toml` in the workspace.

- NullClaw can invoke the JSON/CLI bridge in [../scripts/nullclaw_bridge.ts](../scripts/nullclaw_bridge.ts).
- The manifest lives in [../modules/nullclaw_manifest.ts](../modules/nullclaw_manifest.ts) and is safe to query without starting the BitShares runtime.
- Claw keeps private-key access inside its existing DEXBot2 credential path.
- NullClaw gets the same read access to market, profile, HONEST, and order context, plus explicit action entrypoints when it needs to request a trade operation.

To generate the skill file from Claw, run:

```bash
npm run nullclaw:skill -- --profile-root /home/alex/BTS/Git/DEXBot2 --output ~/.nullclaw/workspace/skills/bitshares-claw/SKILL.toml
```

## NanoClaw Compatibility

NanoClaw uses the same bridge surface, with a native `SKILL.md` path in the workspace skill tree.

- NanoClaw can invoke the JSON/CLI bridge in [../scripts/nanoclaw_bridge.ts](../scripts/nanoclaw_bridge.ts).
- The bridge lives in [../modules/nanoclaw_bridge.ts](../modules/nanoclaw_bridge.ts) and uses the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` so it does not collide with NanoClaw's bundled `claw` skill.

To generate the skill file from Claw, run:

```bash
npm run nanoclaw:skill -- --profile-root /home/alex/BTS/Git/DEXBot2 --output /path/to/nanoclaw/.claude/skills/bitshares-claw/SKILL.md
```

## OpenFang Compatibility

OpenFang uses the same bridge surface through a CLI-first wrapper and a workspace skill file.

- OpenFang can invoke the JSON/CLI bridge in [../scripts/openfang_bridge.ts](../scripts/openfang_bridge.ts).
- The bridge lives in [../modules/openfang_bridge.ts](../modules/openfang_bridge.ts) and uses the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` so it stays separate from runtime-specific OpenFang skills and remains a thin wrapper around the shared CLI bridge.

To generate the skill file from Claw, run:

```bash
npm run openfang:skill -- --profile-root /home/alex/BTS/Git/DEXBot2 --output ~/.openfang/skills/bitshares-claw/SKILL.md
```

## Hermes Compatibility

Hermes should consume Claw through the shared MCP server, with an optional local `SKILL.md` for workflow guidance.

- Hermes can invoke the MCP server in [../scripts/claw_mcp_server.ts](../scripts/claw_mcp_server.ts).
- The manifest wrapper lives in [../modules/hermes_manifest.ts](../modules/hermes_manifest.ts) and advertises Hermes as an MCP-first runtime over the shared Claw command surface.
- Keep the generated skill named `bitshares-claw` and focused on workflow guidance rather than copying bridge logic into Hermes.
- Claw keeps private-key access inside its existing DEXBot2 credential path.

To generate the Hermes skill file from Claw, run:

```bash
npm run hermes:skill -- --profile-root /home/alex/BTS/Git/DEXBot2 --output ~/.hermes/skills/bitshares-claw/SKILL.md
```

Add the MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  claw:
    command: "tsx"
    args: ["/absolute/path/to/claw/scripts/claw_mcp_server.ts", "--profile-root", "/home/alex/BTS/Git/DEXBot2"]
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
  lastGridCenterPrice?: number;
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
- `profiles/market_profiles.json`
- per-bot files in `profiles/orders/`

This is the profile-folder bridge for Claw.

`profiles/general.settings.json` is read-only context here, not a Claw write surface.

### 8. `getBotSettings(identifier, forceReload)`

Returns the current DEXBot2 bot config in a normalized, read-only view.

The result includes:

- raw bot data
- effective values with DEXBot2 defaults merged in
- current validation status
- file locations for the selected bot
- mutability metadata for the bridge

### 9. `previewBotSettingsUpdate(identifier, patch, options)`

Validates a bot-settings patch without writing it.

Use this before any settings write to check:

- merged next-state values
- validation errors
- whether the patch would require a recalc trigger

### 10. `applyBotSettingsPatch(identifier, patch, options)`

Applies a bot-settings patch through the DEXBot2 profile lock.

This helper should:

- acquire the `bots.json` lock before reading and writing
- merge the patch against the current bot record
- validate the merged result before persisting
- optionally write the recalc trigger atomically while still inside the lock
- reload the bundle before returning the updated bot view

This is the preferred write path for bot tuning and for any bridge command that needs to change DEXBot2 bot settings safely.

### 11. `getClawProfileContext(identifier, options)`

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

The bridge exposed by [../modules/claw_bridge.ts](../modules/claw_bridge.ts) supports:

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
- `bot-settings`
- `bot-settings-preview`
- `bot-settings-apply`

## Root Export Disambiguation

The barrel export in `claw/index.ts` spreads every module into one flat namespace. Several modules define functions with the same name but different semantics. The barrel resolves these collisions with explicit trailing overrides:

| Export name | Source module | Purpose |
|---|---|---|---|
| `resolveAccountName` | `chain_queries` | Async lookup — returns the account name string for an ID, or passes through the original name |
| `resolveSigningAccountName` | `chain_broadcast` | Sync extraction — returns the signing account name string from a context object |
| `describeHermesBridge` | `hermesManifest` | Returns the Hermes manifest descriptor |
| `describeOpenClawBridge` | `openclawManifest` | Returns the OpenClaw manifest descriptor |
| `describeOpenFangBridge` | `openfangBridge` | Returns the OpenFang bridge descriptor |
| `describeNanoClawBridge` | `nanoclawBridge` | Returns the NanoClaw bridge descriptor |
| `describeNullClawBridge` | `nullclawManifest` | Returns the NullClaw manifest descriptor |
| `describeZeroClawBridge` | `zeroclawManifest` | Returns the ZeroClaw manifest descriptor (runtime name, command examples) |
| `describeMemuBridge` | `memuBridge` | Returns the memU bridge descriptor |

When consuming `claw/index.ts` as a library, use the disambiguated names above. The non-prefixed `resolveAccountName` and `describeZeroClawBridge` point to the query/manifest variants by default.

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
    "socketPath": "./profiles/run/dexbot-cred-daemon.sock"
  },
  "state": {
    "botId": "claw-01",
    "dataDir": "./data",
    "stateDir": "./data/state"
  }
}
```

### Response

Example response with the resolved absolute socket path:

```json
{
  "runtime": {
    "ready": true,
    "resolvedSocketPath": "/app/profiles/run/dexbot-cred-daemon.sock",
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
