# Claw BitShares Bridge

Integration layer for interacting with the BitShares blockchain from DEXBot2 and the supported Claw runtimes: OpenClaw, NanoBot, PicoClaw, ZeroClaw, and NullClaw.

This scaffold follows the same high-level split used in DEXBot2:

- shared client for reads and subscriptions
- separate signing client for account writes
- small query and broadcast layers

## Install

```bash
npm install
```

This installs:

```bash
npm install btsdex
```

## Files

- Core BitShares runtime: `modules/bitshares_client.js` (loads `modules/btsdex_event_patch` for shared reconnect handling), `modules/chain_queries.js`, `modules/chain_broadcast.js`, `modules/chain_actions.js`
- Strategy and state helpers: `modules/short_mpa_strategy.js`, `modules/position_manager.js`, `modules/position_manager_watch.js`
- Position health: `modules/position_health.js`, `modules/position_discovery.js`, `modules/decision_loop.js`
- Dynamic weights: `modules/dynamic_weight_service.js`
- Price sources: `modules/feed_price_source.js`, `modules/kibana_price_source.js`
- DEXBot2 and Claw integration: `modules/dexbot_bridge.js`, `modules/dexbot_profiles.js`, `modules/dexbot_credential_client.js`, `modules/claw_bridge.js`, `modules/claw_catalog.js`, `modules/claw_manifest.js`, `modules/claw_skill_md.js`, `modules/claw_runtime_matrix.js`, `scripts/claw_bridge.js`, `scripts/claw_mcp_server.js`
- ZeroClaw support: `modules/zeroclaw_bridge.js`, `modules/zeroclaw_catalog.js`, `modules/zeroclaw_manifest.js`, `modules/zeroclaw_skill.js`
- NullClaw support: `modules/nullclaw_bridge.js`, `modules/nullclaw_catalog.js`, `modules/nullclaw_manifest.js`, `modules/nullclaw_skill.js`
- Skill packs: `skills/bitshares-guide/SKILL.md`, `skills/margin-trading/SKILL.md`, `skills/launcher-ops/SKILL.md`, shared boundary references under `skills/shared/references/`
- HONEST support: `modules/honest_ecosystem.js`, `modules/liquidity_pools.js`
- Reference docs: `docs/AI_BOT_LIBRARY_API.md`, `docs/DEXBOT2_TUNING_CHEAT_SHEET.md`, `docs/POSITION_HEALTH.md`, `docs/RUNTIME_COMPARISON.md`
- Example entrypoints: `examples/connection_test.js`, `examples/short_mpa_bts_strategy.js`, `examples/position_manager_cli.js`, `examples/nullclaw_bridge_example.js`, `examples/zeroclaw_bridge_example.js`

## Responsibility Boundary

`claw/` is a bridge subtree and integration layer around DEXBot2, not a replacement for the main DEXBot2 runtime.

What it does:

- expose a local JSON/CLI bridge and native runtime packaging for OpenClaw, NanoBot, PicoClaw, ZeroClaw, and NullClaw
- provide BitShares read helpers, broadcast helpers, and account/action wrappers
- expose DEXBot2 profile context, order utilities, and liquidity/pool helpers through a smaller surface
- provide HONEST context helpers, short-MPA helper flows, and position-manager utilities
- generate runtime-native skill definitions and bridge metadata from a shared command catalog
- keep launcher orchestration as its own skill boundary rather than folding PM2 or Docker startup into trading/reference skills

What it does not do:

- replace the main DEXBot2 bot engine or orchestration loop
- own credentials or hand private keys to ZeroClaw or NullClaw callers
- become the canonical source of truth for core DEXBot2 math or runtime behavior
- make strategy decisions for the main bot runtime beyond the explicit helper flows included here
- guarantee that exposed write actions are safe just because they are wrapped by the bridge

## Run The Example

```bash
npm run example:connection
```

## Standard Short Workflow

The default strategy path is now `MPA/BTS` only:

- borrow the MPA against `BTS` collateral
- place a maker sell order on `MPA/BTS`
- place a maker rebuy order on `MPA/BTS`
- repay the MPA debt and optionally release `BTS` collateral

Dry-run the plan:

```bash
npm run example:short-mpa-bts -- --mode open --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000
```

Broadcast the open leg:

```bash
npm run example:short-mpa-bts -- --mode open --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000 --execute
```

Place the take-profit rebuy order:

```bash
npm run example:short-mpa-bts -- --mode tp --mpa HONEST.USD --cover 10 --buy-price 900 --execute
```

Repay debt and release collateral:

```bash
npm run example:short-mpa-bts -- --mode close --mpa HONEST.USD --repay 10 --release-collateral 25000 --execute
```

## Position Manager

Persistent short-position tracking is available through `modules/position_manager.js` and the `example:position-manager` CLI.

```bash
npm run example:position-manager -- --mode create --account your-account --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000
```

## HONEST Asset Report

Scan BitShares assets, isolate `HONEST.*`, and report HONEST pricing:

```bash
npm run report:honest-assets
```

JSON output:

```bash
node scripts/honest_assets_report.js --json
```

## Signing And Broadcast

Set the account name by CLI or environment:

```bash
export BITSHARES_ACCOUNT="your-account"
```

Signing uses the DEXBot2 credential daemon. See the API doc for the trust boundary.

## PM2

PM2 can run the watcher process built from `modules/position_manager_watch.js` alongside DEXBot2:

```bash
npm run service:position-watch -- --account your-account
npm run pm2:start
```

## Skill Packs

The `skills/` tree is intentionally split by responsibility:

- `bitshares-guide` is presentation-only and should stay free of operational instructions.
- `margin-trading` is concept-reference only and should stay free of launcher or deployment content.
- `launcher-ops` owns PM2 startup, `unlock-start`, `--claw-only`, Docker-friendly startup, and launcher validation.

Shared boundary notes live in `skills/shared/references/skill-boundaries.md`.

## Multi-Runtime Support

`claw/` supports five native runtime families, listed once here for quick reference:

| Runtime | Native integration | Best fit | Main tradeoff |
| --- | --- | --- | --- |
| OpenClaw | Native plugin plus optional `SKILL.md` | Broadest and heaviest option | Richest runtime surface, but also the highest operational complexity |
| NanoBot | MCP plus `SKILL.md` | Smaller Python codebase with MCP integration | Easier to inspect, but slower and heavier than Go or Rust |
| PicoClaw | MCP plus `SKILL.md` | Small Go-based option with launcher support | Great for low-cost hardware, but still evolving quickly |
| ZeroClaw | `SKILL.toml` skill manifest | Smallest and most constrained option | Best cold starts, but the most specialized Rust-oriented workflow |
| NullClaw | `SKILL.toml` skill manifest plus MCP server config | Zig-native runtime with workspace loading | Strong fit for local workspace loading, but more dependent on NullClaw-specific config conventions |

Practical selection guide:

| If you optimize for | Best choice | Why |
| --- | --- | --- |
| Broadest assistant surface and plugin depth | OpenClaw | Richest runtime, strongest plugin model, widest ecosystem coverage |
| Simple MCP integration with Python ergonomics | NanoBot | Easier to inspect and adapt, good for lightweight tool-driven workflows |
| Small Go binary and low-cost hardware | PicoClaw | Good launcher support, strong fit for tiny boards and constrained Linux targets |
| Lowest footprint and fastest startup | ZeroClaw | Smallest surface, manifest-driven, best for static local automation |
| Zig-native workspace assistant with manifest loading | NullClaw | Native workspace loading, direct skill-file workflows, and optional MCP server support |

Rule of thumb:

- Choose **OpenClaw** for the broadest assistant platform.
- Choose **NanoBot** for a compact Python codebase with MCP tooling.
- Choose **PicoClaw** for a small Go runtime with launcher support.
- Choose **ZeroClaw** for the smallest and most deterministic runtime.
- Choose **NullClaw** for a Zig-native runtime with workspace-centric skill loading.

For a deeper comparison of the five supported runtimes, see [docs/RUNTIME_COMPARISON.md](docs/RUNTIME_COMPARISON.md).

Run the commands below from the `claw/` directory.

### Shared Bridge

Use the runtime-neutral bridge command for JSON-friendly local integration:

```bash
node scripts/claw_bridge.js manifest
node scripts/claw_bridge.js profile-context --payload '{"botRef":"default"}'
node scripts/claw_bridge.js market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
```

### Bot Settings

Use the bridge to read, preview, and apply DEXBot2 bot settings through the locked profile adapter:

```bash
node scripts/claw_bridge.js bot-settings --payload '{"botRef":"default"}'
node scripts/claw_bridge.js bot-settings-preview --payload '{"botRef":"default","patch":{"gridPriceOffsetPct":0.2}}'
node scripts/claw_bridge.js bot-settings-apply --payload '{"botRef":"default","patch":{"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

Settings writes are serialized through the profile lock and the recalc trigger is written atomically, so concurrent bot-setting updates do not clobber each other.

### OpenClaw

Install the native plugin bundle from this repository:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
openclaw plugins install -l "$CLAW_ROOT"
openclaw plugins enable bitshares-claw
```

Generate an optional OpenClaw `SKILL.md`:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run openclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
```

Available bridge and native tool surfaces include:

- runtime and manifest inspection
- profile, market, and account snapshots
- open-order queries
- HONEST context and pricing
- limit order create, cancel, update, and batch execution
- MPA borrow, repay, collateral adjustment, and settlement
- BTS-backed short open, take-profit, close, and plan builders
- MPA position lookup

### NanoBot and PicoClaw

Run the MCP server over stdio:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
node scripts/claw_mcp_server.js --profile-root "$DEXBOT_ROOT"
```

Generate a runtime-native `SKILL.md`:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nanobot:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
npm run picoclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
```

On a fresh PicoClaw install, make sure `agents.defaults.workspace` is configured in `config.json` or run `picoclaw onboard` before expecting workspace skills to appear.

### ZeroClaw

Generate the ZeroClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run zeroclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.zeroclaw/workspace/skills/ai-bots/SKILL.toml
```

ZeroClaw compatibility command surface:

```bash
node scripts/zeroclaw_bridge.js manifest
node scripts/zeroclaw_bridge.js profile-context --payload '{"botRef":"default"}'
node scripts/zeroclaw_bridge.js market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
node scripts/zeroclaw_bridge.js create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
node scripts/zeroclaw_bridge.js update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
node scripts/zeroclaw_bridge.js execute-batch --payload '{"accountName":"your-account","operations":[]}'
node scripts/zeroclaw_bridge.js borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
```

### NullClaw

Generate the NullClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nullclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.nullclaw/workspace/skills/bitshares-claw/SKILL.toml
```

NullClaw compatibility command surface:

```bash
node scripts/nullclaw_bridge.js manifest
node scripts/nullclaw_bridge.js profile-context --payload '{"botRef":"default"}'
node scripts/nullclaw_bridge.js market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
node scripts/nullclaw_bridge.js create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
node scripts/nullclaw_bridge.js update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
node scripts/nullclaw_bridge.js execute-batch --payload '{"accountName":"your-account","operations":[]}'
node scripts/nullclaw_bridge.js borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
```

## HONEST Ecosystem Helper

Inspect the HONEST asset context and a requested LP pair:

```bash
npm run example:honest-ecosystem -- HONEST.MONEY/BTS
```

## Position Health

The position health subsystem discovers on-chain debt positions, classifies collateral ratios into a 5-zone model, checks trend alignment, and recommends actions. See [docs/POSITION_HEALTH.md](docs/POSITION_HEALTH.md) for the full reference.

Inspect one on-chain MPA position:

```bash
node scripts/claw_bridge.js mpa-position --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD"}'
```

The decision loop (`modules/decision_loop.js`) is exposed as a module API. Its `evaluate()` call ties discovery, trend analysis, and health assessment into a single result with prioritized actions.

## Dynamic Weights

Dynamic weight updates adjust `weightDistribution` and `gridPriceOffsetPct` based on trend signals. The service evaluates bot eligibility, fetches trend data, computes weight and offset changes, enforces cooldowns, and optionally writes a recalculation trigger.

Inspect the default policy:

```bash
node scripts/claw_bridge.js dynamic-weight-policy
```

Preview an update without applying:

```bash
node scripts/claw_bridge.js dynamic-weight-preview --payload '{"botRef":"default"}'
```

Apply the update and write the recalc trigger:

```bash
node scripts/claw_bridge.js dynamic-weight-apply --payload '{"botRef":"default"}'
```

## High-Level Actions

The starter now includes these bot-facing actions in `modules/chain_actions.js`:

- create limit orders
- cancel limit orders
- update limit orders
- execute batches of operations
- subscribe to account fill events
- borrow MPAs
- repay MPA debt
- adjust MPA collateral
- settle MPAs
