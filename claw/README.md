# Claw BitShares Bridge

Integration layer for interacting with the BitShares blockchain from DEXBot2 and the supported Claw runtimes: OpenClaw, Hermes, OpenFang, NanoBot, PicoClaw, NanoClaw, ZeroClaw, NullClaw, and memU.

This scaffold follows the same high-level split used in DEXBot2:

- shared client for reads and subscriptions
- separate signing client for account writes
- small query and broadcast layers

## Install

```bash
npm install
```

## Files

- Core BitShares runtime: `modules/bitshares_client.ts`, `modules/chain_queries.ts`, `modules/chain_broadcast.ts`, `modules/chain_actions.ts`
- Strategy and state helpers: `modules/short_mpa_strategy.ts`, `modules/position_manager.ts`, `modules/position_manager_watch.ts`
- Position health: `modules/position_health.ts`, `modules/position_discovery.ts`, `modules/decision_loop.ts`
- Price sources: `modules/feed_price_source.ts`, `modules/kibana_price_source.ts`
- DEXBot2 and Claw integration: `modules/dexbot_bridge.ts`, `modules/dexbot_profiles.ts`, `modules/dexbot_credential_client.ts`, `modules/claw_bridge.ts`, `modules/claw_catalog.ts`, `modules/claw_manifest.ts`, `modules/claw_skill_md.ts`, `modules/claw_runtime_matrix.ts`, `scripts/claw_bridge.ts`, `scripts/claw_mcp_server.ts`
- Hermes support: `modules/hermes_manifest.ts`, `scripts/claw_mcp_server.ts`
- OpenFang support: `modules/openfang_bridge.ts`, `scripts/openfang_bridge.ts`
- NanoClaw support: `modules/nanoclaw_bridge.ts`, `scripts/nanoclaw_bridge.ts`
- ZeroClaw support: `modules/zeroclaw_bridge.ts`, `modules/zeroclaw_catalog.ts`, `modules/zeroclaw_manifest.ts`, `modules/zeroclaw_skill.ts`
- NullClaw support: `modules/nullclaw_bridge.ts`, `modules/nullclaw_catalog.ts`, `modules/nullclaw_manifest.ts`, `modules/nullclaw_skill.ts`
- memU support: `modules/memu_bridge.ts`, `scripts/memu_runner.py`, `scripts/memu_mcp_server.ts`
- Skill packs: `skills/bitshares-guide/SKILL.md`, `skills/margin-trading/SKILL.md`, `skills/trend-detection/SKILL.md`, `skills/launcher-ops/SKILL.md`, `skills/memu-memory/SKILL.md`, shared boundary references under `skills/shared/references/`
- HONEST support: `modules/honest_ecosystem.ts`, `modules/liquidity_pools.ts`
- Reference docs: `docs/AI_BOT_LIBRARY_API.md`, `docs/DEXBOT2_TUNING_CHEAT_SHEET.md`, `docs/POSITION_HEALTH.md`, `docs/RUNTIME_COMPARISON.md`
- Example entrypoints: `examples/connection_test.ts`, `examples/short_mpa_bts_strategy.ts`, `examples/position_manager_cli.ts`, `examples/nullclaw_bridge_example.ts`, `examples/zeroclaw_bridge_example.ts`, `examples/memu_integration_example.ts`, `examples/claw_profiles_example.ts`, `examples/claw_consumer_example.ts`, `examples/claw_infra_example.ts`, `examples/honest_ecosystem_example.ts`

## Responsibility Boundary

`claw/` is a bridge subtree and integration layer around DEXBot2, not a replacement for the main DEXBot2 runtime.

What it does:

- expose a local JSON/CLI bridge and native runtime packaging for OpenClaw, Hermes, OpenFang, NanoBot, PicoClaw, NanoClaw, ZeroClaw, NullClaw, and memU
- provide BitShares read helpers, broadcast helpers, and account/action wrappers
- expose DEXBot2 profile context, order utilities, and liquidity/pool helpers through a smaller surface
- provide HONEST context helpers, short-MPA helper flows, and position-manager utilities
- generate runtime-native skill definitions and bridge metadata from a shared command catalog
- keep launcher orchestration as its own skill boundary rather than folding PM2 or Docker startup into trading/reference skills

What it does not do:

- replace the main DEXBot2 bot engine or orchestration loop
- own credentials or hand private keys to ZeroClaw, NanoClaw, or NullClaw callers
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

Persistent short-position tracking is available through `modules/position_manager.ts` and the `example:position-manager` CLI.

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
tsx scripts/honest_assets_report.ts --json
```

## Signing And Broadcast

Set the account name by CLI or environment:

```bash
export BITSHARES_ACCOUNT="your-account"
```

Signing uses the DEXBot2 credential daemon. See the API doc for the trust boundary.

## PM2

PM2 can run the watcher process built from `modules/position_manager_watch.ts` alongside DEXBot2:

```bash
npm run service:position-watch -- --account your-account
npm run pm2:start
```

## Skill Packs

The `skills/` tree is intentionally split by responsibility:

- `bitshares-guide` is presentation-only and should stay free of operational instructions.
- `margin-trading` is concept-reference only and should stay free of launcher or deployment content.
- `launcher-ops` owns PM2 startup, `unlock`, `--claw-only`, Docker-friendly startup, and launcher validation.

Shared boundary notes live in `skills/shared/references/skill-boundaries.md`.

## Multi-Runtime Support

`claw/` supports nine native runtime families, listed once here for quick reference:

| Runtime | Native integration | Best fit | Main tradeoff |
| --- | --- | --- | --- |
| OpenClaw | Native plugin plus optional `SKILL.md` | Broadest and heaviest option | Richest runtime surface, but also the highest operational complexity |
| Hermes | MCP server plus optional `SKILL.md` | General-purpose assistant that can also trade | Broader agent platform, but unnecessary overhead if you only need DEXBot actions |
| OpenFang | CLI bridge plus workspace `SKILL.md` | CLI-first local integration | Best when the runtime should consume a thin generated bridge rather than a vendored adapter stack |
| NanoBot | MCP plus `SKILL.md` | Smaller Python codebase with MCP integration | Easier to inspect, but slower and heavier than Go or Rust |
| PicoClaw | MCP plus `SKILL.md` | Small Go-based option with launcher support | Great for low-cost hardware, but still evolving quickly |
| NanoClaw | `SKILL.md` skill file plus local JSON bridge | Claude Code skill-driven local runtime | Keep the DEXBot2 bridge skill named `bitshares-claw` so it does not collide with NanoClaw's built-in `claw` skill |
| ZeroClaw | `SKILL.toml` skill manifest | Smallest and most constrained option | Best cold starts, but the most specialized Rust-oriented workflow |
| NullClaw | `SKILL.toml` skill manifest plus MCP server config | Zig-native runtime with workspace loading | Strong fit for local workspace loading, but more dependent on NullClaw-specific config conventions |
| memU | Subprocess bridge plus MCP server | 24/7 proactive memory for AI agents | Python-based memory framework with LLM-powered extraction and vector search |

Practical selection guide:

| If you optimize for | Best choice | Why |
| --- | --- | --- |
| Broadest assistant surface and plugin depth | OpenClaw | Richest runtime, strongest plugin model, widest ecosystem coverage |
| General-purpose assistant with memory, messaging, and cron | Hermes | MCP-first integration keeps Claw reusable while Hermes handles the broader assistant runtime |
| CLI-first local workspace integration | OpenFang | Thin bridge, generated skill file, and minimal maintenance surface |
| Simple MCP integration with Python ergonomics | NanoBot | Easier to inspect and adapt, good for lightweight tool-driven workflows |
| Small Go binary and low-cost hardware | PicoClaw | Good launcher support, strong fit for tiny boards and constrained Linux targets |
| Claude Code skill-driven local runtime | NanoClaw | Skill-file workflow with a dedicated local bridge and a name that avoids NanoClaw's built-in `claw` skill |
| Lowest footprint and fastest startup | ZeroClaw | Smallest surface, manifest-driven, best for static local automation |
| Zig-native workspace assistant with manifest loading | NullClaw | Native workspace loading, direct skill-file workflows, and optional MCP server support |
| Proactive memory and intent capture | memU | 24/7 memory that learns user preferences, reduces LLM costs, and enables context-aware trading |

Rule of thumb:

- Choose **OpenClaw** for the broadest assistant platform.
- Choose **Hermes** if you want a general-purpose assistant with memory, messaging, cron, and browser tooling that can also trade through Claw.
- Choose **OpenFang** for a CLI-first local workspace integration with a thin generated skill file.
- Choose **NanoBot** for a compact Python codebase with MCP tooling.
- Choose **PicoClaw** for a small Go runtime with launcher support.
- Choose **NanoClaw** for a Claude Code skill-driven local assistant with a narrow local bridge.
- Choose **ZeroClaw** for the smallest and most deterministic runtime.
- Choose **NullClaw** for a Zig-native runtime with workspace-centric skill loading.
- Choose **memU** for 24/7 proactive memory that captures user intent and reduces LLM token costs.

For a deeper comparison of the supported runtimes, see [docs/RUNTIME_COMPARISON.md](docs/RUNTIME_COMPARISON.md).

Run the commands below from the `claw/` directory.

### Shared Bridge

Use the runtime-neutral bridge command for JSON-friendly local integration:

```bash
tsx scripts/claw_bridge.ts manifest
tsx scripts/claw_bridge.ts profile-context --payload '{"botRef":"default"}'
tsx scripts/claw_bridge.ts market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
```

### Bot Settings

Use the bridge to read, preview, and apply DEXBot2 bot settings through the locked profile adapter:

```bash
tsx scripts/claw_bridge.ts bot-settings --payload '{"botRef":"default"}'
tsx scripts/claw_bridge.ts bot-settings-preview --payload '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'
tsx scripts/claw_bridge.ts bot-settings-apply --payload '{"botRef":"default","patch":{"incrementPercent":0.4,"weightDistribution":{"sell":0.7,"buy":0.4}}}'
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

### OpenFang

Generate the OpenFang skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run openfang:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.openfang/skills/bitshares-claw/SKILL.md
```

OpenFang uses the same shared bridge surface through a local CLI wrapper. Keep the generated skill file focused on invoking `openfang_bridge.ts` rather than vendoring OpenFang internals into DEXBot2.

OpenFang compatibility command surface:

```bash
tsx scripts/openfang_bridge.ts manifest
tsx scripts/openfang_bridge.ts profile-context --payload '{"botRef":"default"}'
tsx scripts/openfang_bridge.ts market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
tsx scripts/openfang_bridge.ts create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
```

### Hermes

Generate the Hermes skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run hermes:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.hermes/skills/bitshares-claw/SKILL.md
```

Add the shared Claw MCP server to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  claw:
    command: "tsx"
    args: ["/absolute/path/to/claw/scripts/claw_mcp_server.ts", "--profile-root", "/absolute/path/to/DEXBot2"]
```

Hermes should use the shared MCP server for live tools and keep the generated `SKILL.md` focused on workflow guidance. The Claw MCP server registers raw tool ids such as `claw_manifest`; if Hermes shows a namespaced label in its UI, use the label shown there.

### NanoBot and PicoClaw

Run the MCP server over stdio:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
tsx scripts/claw_mcp_server.ts --profile-root "$DEXBOT_ROOT"
```

The stdio transport uses newline-delimited JSON-RPC messages on `stdin` and `stdout`.

Generate a runtime-native `SKILL.md`:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nanobot:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
npm run picoclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT"
```

On a fresh PicoClaw install, make sure `agents.defaults.workspace` is configured in `config.json` or run `picoclaw onboard` before expecting workspace skills to appear.

### NanoClaw

Generate the NanoClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run nanoclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output /path/to/nanoclaw/.claude/skills/bitshares-claw/SKILL.md
```

NanoClaw already ships its own `claw` skill, so keep this bridge skill named `bitshares-claw`.

NanoClaw compatibility command surface:

```bash
tsx scripts/nanoclaw_bridge.ts manifest
tsx scripts/nanoclaw_bridge.ts profile-context --payload '{"botRef":"default"}'
tsx scripts/nanoclaw_bridge.ts market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
tsx scripts/nanoclaw_bridge.ts create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
```

### ZeroClaw

Generate the ZeroClaw skill file:

```bash
CLAW_ROOT="$(pwd)"
DEXBOT_ROOT="$(cd .. && pwd)"
npm run zeroclaw:skill -- --repo-root "$CLAW_ROOT" --profile-root "$DEXBOT_ROOT" --output ~/.zeroclaw/workspace/skills/ai-bots/SKILL.toml
```

ZeroClaw compatibility command surface:

```bash
tsx scripts/zeroclaw_bridge.ts manifest
tsx scripts/zeroclaw_bridge.ts profile-context --payload '{"botRef":"default"}'
tsx scripts/zeroclaw_bridge.ts market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
tsx scripts/zeroclaw_bridge.ts create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
tsx scripts/zeroclaw_bridge.ts update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
tsx scripts/zeroclaw_bridge.ts execute-batch --payload '{"accountName":"your-account","operations":[]}'
tsx scripts/zeroclaw_bridge.ts borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
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
tsx scripts/nullclaw_bridge.ts manifest
tsx scripts/nullclaw_bridge.ts profile-context --payload '{"botRef":"default"}'
tsx scripts/nullclaw_bridge.ts market-snapshot --payload '{"baseSymbol":"BTS","quoteSymbol":"USD"}'
tsx scripts/nullclaw_bridge.ts create-limit-order --payload '{"accountName":"your-account","sellAsset":"BTS","receiveAsset":"USD","amountToSell":10,"minToReceive":2}'
tsx scripts/nullclaw_bridge.ts update-limit-order --payload '{"accountName":"your-account","orderId":"1.7.123","newParams":{"amountToSell":10,"minToReceive":2}}'
tsx scripts/nullclaw_bridge.ts execute-batch --payload '{"accountName":"your-account","operations":[]}'
tsx scripts/nullclaw_bridge.ts borrow-mpa --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD","debtDelta":10,"collateralDelta":25000}'
```

### memU

memU provides 24/7 proactive memory for AI agents. It captures user intent, reduces LLM token costs, and enables context-aware trading assistance.

**Prerequisites:**

```bash
pip install memu-py
export OPENAI_API_KEY=your_api_key
```

Start the memU MCP server:

```bash
npm run memu:mcp
# or
tsx scripts/memu_mcp_server.ts --memu-dir /path/to/claw/data/memu
```

Check memU status:

```bash
npm run memu:status
```

memU MCP server configuration for Hermes:

```yaml
mcp_servers:
  memu:
    command: "tsx"
    args: ["/absolute/path/to/claw/scripts/memu_mcp_server.ts", "--memu-dir", "/absolute/path/to/claw/data/memu"]
```

memU compatibility command surface:

```bash
# Via claw bridge
tsx scripts/claw_bridge.ts memu-manifest
tsx scripts/claw_bridge.ts memu-memorize --payload '{"resourceUrl":"/path/to/conv.txt","modality":"conversation"}'
tsx scripts/claw_bridge.ts memu-retrieve --payload '{"queries":[{"role":"user","content":{"text":"What are my trading preferences?"}}]}'
tsx scripts/claw_bridge.ts memu-status

# Via npm scripts
npm run memu:status
npm run memu:mcp
```

Available memU capabilities:

- memorize conversations, documents, images, video, and audio
- retrieve memories via RAG (fast) or LLM (deep reasoning)
- list and manage memory categories and items
- trading context memorization and retrieval
- proactive intent capture and preference learning

See [skills/memu-memory/SKILL.md](skills/memu-memory/SKILL.md) for detailed usage patterns.

## HONEST Ecosystem Helper

Inspect the HONEST asset context and a requested LP pair:

```bash
npm run example:honest-ecosystem -- HONEST.MONEY/BTS
```

## Position Health

The position health subsystem discovers on-chain debt positions, classifies collateral ratios into a 5-zone model, checks trend alignment, and recommends actions. See [docs/POSITION_HEALTH.md](docs/POSITION_HEALTH.md) for the full reference.

Inspect one on-chain MPA position:

```bash
tsx scripts/claw_bridge.ts mpa-position --payload '{"accountName":"your-account","mpaAsset":"HONEST.USD"}'
```

The decision loop (`modules/decision_loop.ts`) is exposed as a module API. Its `evaluate()` call ties discovery, trend analysis, and health assessment into a single result with prioritized actions.

## Dynamic Weights

Dynamic weight updates adjust `weightDistribution` based on trend signals. The service evaluates bot eligibility, fetches trend data, computes weight changes, enforces cooldowns, and optionally writes a recalculation trigger.

Inspect the default policy:

```bash
tsx scripts/claw_bridge.ts bot-settings --payload '{"botRef":"default"}'
```

Preview an update without applying:

```bash
tsx scripts/claw_bridge.ts bot-settings-preview --payload '{"botRef":"default","patch":{"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

Apply the update and write the recalc trigger:

```bash
tsx scripts/claw_bridge.ts bot-settings-apply --payload '{"botRef":"default","patch":{"weightDistribution":{"sell":0.7,"buy":0.4}}}'
```

## High-Level Actions

The starter now includes these bot-facing actions in `modules/chain_actions.ts`:

- create limit orders
- cancel limit orders
- update limit orders
- execute batches of operations
- subscribe to account fill events
- borrow MPAs
- repay MPA debt
- adjust MPA collateral
- settle MPAs
