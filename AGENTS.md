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
- `dexbot.js` - Main CLI entry point
- `bot.js` - Alternative bot starter
- `pm2.js` - PM2 process management
- `unlock-start.js` - Single-prompt starter (no PM2)
- `credential-daemon.js` - Credential daemon

### Core Bot
- `modules/dexbot_class.js` - Core bot class, lifecycle orchestration, and shared runtime wiring
- `modules/dexbot_fill_runtime.js` - Fill processing runtime and replay-safe accounting helpers
- `modules/dexbot_maintenance_runtime.js` - Maintenance runtime for sync loops and grid checks
- `modules/constants.js` - Centralized configuration and tuning parameters
- `modules/bitshares_client.js` - BitShares connection and node management integration
- `modules/node_manager.js` - Multi-node health checking and failover
- `modules/general_settings.js` - General settings management
- `modules/graceful_shutdown.js` - Graceful shutdown handling
- `modules/chain_keys.js` - Key management
- `modules/bots_file_lock.js` - Bot config file locking
- `modules/btsdex_event_patch.js` - BitShares DEX event patching

### Order Management (`modules/order/`)
- `manager.js` - Order lifecycle and state management
- `grid.js` - Grid calculation, placement, and management
- `working_grid.js` - Copy-on-write working grid
- `strategy.js` - Trading strategy (anchor & refill, consolidation)
- `accounting.js` - Fee accounting and fund tracking
- `sync_engine.js` - Blockchain synchronization
- `processed_fill_store.js` - Processed fill dedupe persistence and batching
- `startup_reconcile.js` - Startup order reconciliation
- `runner.js` - Order execution runner
- `async_lock.js` - Concurrency control
- `logger.js` - Order logging
- `logger_state.js` - Logger state tracking
- `format.js` - Order formatting
- `export.js` - Order data export
- `index.js` - Module exports
- `utils/` - Utilities (math, order, system, validate)

### Market Adapter (`market_adapter/`)
- `market_adapter.js` - AMA delta threshold, grid price offset persistence, and grid recalculation trigger
- `core/market_adapter_service.js` - Price adapter service core (offset calculation, bound clamping)
- `ama_signal_runner.js` - AMA signal processing
- `inputs/kibana_source.js` - Kibana data source
- `inputs/fetch_lp_data.js` - Liquidity pool data fetching
- `merge_lp_data.js` - LP data merging
- `candle_utils.js` - Candlestick utilities
- `interval_utils.js` - Shared interval label helpers
- `lp_chart_core.js` - LP chart core logic
- `lp_chart_runner.js` - Shared LP chart orchestration used by the supported chart scripts

### Blockchain Interaction
- `modules/chain_orders.js` - Blockchain order operations
- `modules/account_orders.js` - Account order queries
- `modules/account_bots.js` - Account bot data management

### Configuration
- `profiles/ecosystem.config.js` - PM2 ecosystem configuration
- `profiles/bots.json` - Bot configuration
- `profiles/general.settings.json` - Global settings (auto-generated on first run)
- `profiles/market_profiles.json` - Market-specific settings (AMA params, price offset params)

### Claw Integration (`claw/`)
- `index.js` - Main export combining all modules
- `modules/claw_bridge.js` - JSON bridge for runtime integration
- `modules/zeroclaw_bridge.js` - ZeroClaw runtime bridge
- `modules/bitshares_client.js` - BitShares connection wrapper
- `modules/chain_queries.js` - Chain read helpers
- `modules/chain_broadcast.js` - Chain write helpers
- `modules/chain_actions.js` - High-level chain operations
- `modules/position_manager.js` - Position tracking and management
- `modules/position_health.js` - Position health monitoring
- `modules/dexbot_profiles.js` - DEXBot2 profile reader
- `modules/dexbot_credential_client.js` - Credential daemon client
- `modules/honest_ecosystem.js` - HONEST asset helpers
- `modules/short_mpa_strategy.js` - Short MPA workflow
- `modules/dynamic_weight_service.js` - Dynamic weight policy
- `modules/claw_infra.js` - Shared runtime infrastructure
- `docs/AI_BOT_LIBRARY_API.md` - API boundary and responsibility split
- `docs/DEXBOT2_TUNING_CHEAT_SHEET.md` - Grid tuning reference

### Analysis Tools (`analysis/`)

Research scripts for parameter tuning — output interactive HTML charts, not used in production.

#### Dynamic Weight Research
- `analyze_dynamic_weight.js` - Runner: loads candles, computes AMA3 + Kalman, generates chart
- `trend_detection/dynamic_weight_chart_generator.js` - 4-panel uPlot chart with interactive knobs (α, maxS%, maxOff, clip%, nz%, gain)
- Docs: `docs/DYNAMIC_WEIGHT_RESEARCH.md`

#### Derivative / Signal Research
- `analyze_derivatives.js` - SMA/MACD/RSI signal analyzer runner
- `analyze_derivatives_uplot.js` - uPlot variant of the above
- `trend_detection/derivative_analyzer.js` - Core signal engine (MACD, RSI, trend filter)
- `trend_detection/trend_analyzer.js` - SMA-based trend direction helper
- `trend_detection/kalman_trend_analyzer.js` - Kalman filter with tactical/modal state tracking
- `trend_detection/kalman_chart_generator.js` - Kalman signal chart generator
- `analyze_kalman_uplot.js` - Kalman standalone analyzer runner
- Docs: `analysis/trend_detection/SIGNAL_DOCUMENTATION.md`

#### AMA Fitting
- `ama_fitting/ama.js` - Kaufman Adaptive Moving Average implementation
- `ama_fitting/optimizer_high_resolution.js` - AMA parameter optimizer
- `ama_fitting/generate_unified_comparison_chart_uplot.js` - AMA comparison chart
- `ama_fitting/analyze_ama_price_changes.js` - AMA price change analysis

#### Data Sources
- `price_sources.js` - Unified candle source abstraction (`json`, `market_adapter`)
- `mexc_fetcher.js` - MEXC exchange candle fetcher

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
