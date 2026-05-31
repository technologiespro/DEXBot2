# Development Context - DEXBot2

## Branch Strategy
**Pipeline: `test` → `dev` → `main`** (ONE DIRECTION ONLY!)

- **test**: Primary development branch (where work happens)
- **dev**: Integration/staging (merged from test)
- **main**: Production-ready (merged from dev)

⚠️ **KEY RULE**: Always merge **test → dev**, NEVER dev → test
⚠️ **KEY RULE**: See **Absolute Git Action Gate** below for all write-action authorization rules.
⚠️ **KEY RULE**: Default to manual merge/push flow for branch promotion when requested, unless the user specifically asks to use one of the sync scripts.

## Absolute Git Action Gate (User-Directed Writes)

**Agent must NOT proactively ask for or execute git write actions.**
The agent only runs git write actions when the user clearly requests them.

Git write actions include:
- `git add`
- `git commit`
- `git commit --amend`
- `git reset` (any mode)
- `git rebase`
- `git merge`
- `git push`
- `git tag`
- `git checkout` / `git switch` to another branch

Branch-promotion scripts include:
- `npm run ptest`
- `npm run pdev`
- `npm run pmain`

Read-only git commands are always allowed (for example: `git status`, `git diff`, `git log`, `git show`).

Interpretation rules:
1. If a user clearly asks for a git write action, execute it.
2. Short approvals like "yes", "ok", "do it", or "go ahead" are valid confirmation when they clearly refer to the immediately previous proposed action.
3. If wording is ambiguous, ask one clarifying question before running destructive actions.
4. `git commit --amend` is allowed when explicitly requested by the user.
5. Before a git write action, restate the user authorization in one short line.

See `docs/WORKFLOW.md` for detailed workflow guide.

## Commit Quality Standard
When creating commits, prefer high-context commit messages for non-trivial fixes/features.

- **Subject**: concise conventional prefix (`fix:`, `feat:`, `docs:`) with clear scope.
- **Body required for substantial changes**: explain **why**, not only what changed.
- **Structure**:
  1. Short problem statement/context
  2. Per-fix sections with file path(s) and behavioral impact
  3. Risk/edge-case notes when relevant
  4. Validation/testing notes (commands or scenario checks)
- **Formatting**: use readable markdown headers/bullets in commit body for scanability.
- **CLI formatting safety**:
  - Never use `/n` or literal `\\n` text as a newline placeholder in commit/PR bodies.
  - Always pass real newlines to Git/GitHub (multi-line body), not escaped newline text.
  - Prefer heredocs for reliability when using `git commit` and `gh pr create`.
- **Atomicity**: keep unrelated edits out of the commit; document only included changes.

Recommended CLI patterns (newline-safe):

```bash
# Commit message with proper markdown/newlines
git commit -F- <<'EOF'
fix: <short summary>

<context>

## <Fix area>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test command>
EOF

# PR body with proper markdown/newlines
gh pr create --title "<title>" --body-file - <<'EOF'
## Summary
- <item>

## Testing
- <command>
EOF
```

Recommended template:

```text
fix: <short summary>

<1-2 line context>

## <Fix area 1>
File: <path>
- Problem:
- Impact:
- Solution:

## <Fix area 2>
File: <path>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test/verification>
```

## Key Files

### Entry Points
- `dexbot.ts` - Main CLI entry point
- `bot.ts` - Alternative bot starter
- `pm2.ts` - PM2 process management
- `unlock.ts` - Single-prompt starter (no PM2)
- `credential-daemon.ts` - Credential daemon

### Core Bot
- `modules/dexbot_class.ts` - Core bot class, lifecycle orchestration, and shared runtime wiring
- `modules/dexbot_fill_runtime.ts` - Fill processing runtime and replay-safe accounting helpers
- `modules/dexbot_maintenance_runtime.ts` - Maintenance runtime for sync loops and grid checks
- `modules/constants.ts` - Centralized configuration and tuning parameters
- `modules/bitshares_client.ts` - BitShares connection and node management integration
- `modules/node_manager.ts` - Multi-node health checking and failover
- `modules/general_settings.ts` - General settings management
- `modules/graceful_shutdown.ts` - Graceful shutdown handling
- `modules/chain_keys.ts` - Key management
- `modules/bots_file_lock.ts` - Bot config file locking

### Order Management (`modules/order/`)
- `manager.ts` - Order lifecycle and state management
- `grid.ts` - Grid calculation, placement, and management
- `working_grid.ts` - Copy-on-write working grid
- `strategy.ts` - Trading strategy (anchor & refill, consolidation)
- `accounting.ts` - Fee accounting and fund tracking
- `sync_engine.ts` - Blockchain synchronization
- `processed_fill_store.ts` - Processed fill dedupe persistence and batching
- `startup_reconcile.ts` - Startup order reconciliation
- `runner.ts` - Order execution runner
- `async_lock.ts` - Concurrency control
- `logger.ts` - Order logging
- `logger_state.ts` - Logger state tracking
- `format.ts` - Order formatting
- `export.ts` - Order data export
- `index.ts` - Module exports
- `utils/` - Utilities (math, order, system, validate)

### Market Adapter (`market_adapter/`)
- `market_adapter.ts` - AMA delta threshold, grid price offset persistence, and grid recalculation trigger
- `core/market_adapter_service.ts` - Price adapter service core (offset calculation, bound clamping)
- `ama_signal_runner.ts` - AMA signal processing
- `inputs/kibana_source.ts` - Kibana data source
- `inputs/fetch_lp_data.ts` - Liquidity pool data fetching
- `merge_lp_data.ts` - LP data merging
- `candle_utils.ts` - Candlestick utilities
- `interval_utils.ts` - Shared interval label helpers
- `lp_chart_core.ts` - LP chart core logic
- `lp_chart_runner.ts` - Shared LP chart orchestration used by the supported chart scripts

### Blockchain Interaction
- `modules/chain_orders.ts` - Blockchain order operations
- `modules/account_orders.ts` - Account order queries
- `modules/account_bots.ts` - Account bot data management

### Configuration
- `profiles/ecosystem.config.js` - PM2 ecosystem configuration
- `profiles/bots.json` - Bot configuration
- `profiles/general.settings.json` - Global settings (auto-generated on first run)
- `profiles/market_profiles.json` - Market-specific settings (AMA params, price offset params)

### Claw Integration (`claw/`)
- `claw/index.ts` - Main export combining all modules
- `claw/modules/claw_bridge.ts` - JSON bridge for runtime integration
- `claw/modules/zeroclaw_bridge.ts` - ZeroClaw runtime bridge
- `claw/modules/bitshares_client.ts` - BitShares connection wrapper
- `claw/modules/chain_queries.ts` - Chain read helpers
- `claw/modules/chain_broadcast.ts` - Chain write helpers
- `claw/modules/chain_actions.ts` - High-level chain operations
- `claw/modules/position_manager.ts` - Position tracking and management
- `claw/modules/position_health.ts` - Position health monitoring
- `claw/modules/dexbot_profiles.ts` - DEXBot2 profile reader
- `claw/modules/dexbot_credential_client.ts` - Credential daemon client
- `claw/modules/honest_ecosystem.ts` - HONEST asset helpers
- `claw/modules/short_mpa_strategy.ts` - Short MPA workflow
- `claw/modules/claw_infra.ts` - Shared runtime infrastructure
- `claw/docs/AI_BOT_LIBRARY_API.md` - API boundary and responsibility split
- `claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md` - Grid tuning reference


### Analysis Tools (`analysis/`)

Research scripts for parameter tuning — output interactive HTML charts, not used in production.

- `analysis/README.md` - top-level analysis index and folder map

#### Dynamic Weight Research
- `analyze_dynamic_weight.ts` - Runner: loads candles, computes AMA3 + Kalman, generates chart
- `trend_detection/dynamic_weight_chart_generator.ts` - 4-panel uPlot chart with interactive knobs (α, maxS%, gain, clip%, nz%)
- Docs: `analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md`

#### Derivative / Signal Research
- `analyze_derivatives.ts` - SMA/MACD/RSI signal analyzer runner
- `trend_detection/derivative_analyzer.ts` - Core signal engine (MACD, RSI, trend filter)
- `trend_detection/kalman_trend_analyzer.ts` - Kalman filter with tactical/modal state tracking
- `trend_detection/kalman_chart_generator.ts` - Kalman signal chart generator
- `trend_detection/volatility_chart_generator.ts` - Volatility / symmetric shift chart generator
- `analyze_kalman.ts` - Kalman standalone analyzer runner
- Docs: `analysis/trend_detection/SIGNAL_DOCUMENTATION.md`
- `trend_detection/README.md` - local index for the trend detection research docs

#### AMA Fitting
- `market_adapter/core/strategies/ama.ts` - Kaufman Adaptive Moving Average implementation
- `ama_fitting/optimizer_high_resolution.ts` - AMA parameter optimizer
- `ama_fitting/generate_unified_comparison_chart.ts` - AMA comparison chart
- `ama_fitting/analyze_ama_price_changes.ts` - AMA price change analysis

#### Data Sources
- `price_sources.ts` - Unified candle source abstraction (`json`, `market_adapter`)

### Testing
- `tests/` - Comprehensive test suite (unit, integration, scenario tests)

## Quick Commands
```bash
# Create feature
git checkout test && git pull
git checkout -b feature/my-feature test

# Merge to test
git checkout test && git pull && git merge --no-ff feature/my-feature && git push

# Integrate to dev
git checkout dev && git pull && git merge --no-ff test && git push

# Release to main
git checkout main && git pull && git merge --no-ff dev && git push
```
