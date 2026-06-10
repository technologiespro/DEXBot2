# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 0.7.16 release cycle.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,519 commits over ~6 active months
- **Code Maturity**: Evolution from basic utilities to a ~57,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 208+ automated test files
- **Releases**: 32 release entries (v0.1.0 to v0.7.16)

---

## Pre-History: Generational Lineage

DEXBot2 is the third generation of BitShares DEX trading bot development, preceded by two Python-based projects. See [DEXBOT_COMPARISON.md](DEXBOT_COMPARISON.md) for a full architectural comparison.

### Generation 0: StakeMachine (2017)
Proof-of-concept by Fabian Schuh (ChainSquad GmbH). Static buy/sell walls with event-driven subscription model.

### Generation 1: DEXBot Python v1.0.0 (2018–2020)
Production bot by Codaone Oy (worker proposal funded). PyQt5 GUI, three strategies (Staggered Orders, Relative Orders, King of the Hill), CCXT/CoinGecko feeds, SQLite persistence.

**Carried into DEXBot2**: Staggered grid concept, virtual/off-chain order tracking, market center price calculation.

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
Started Dec 2 with a JavaScript rewrite from the Python DEXBot. Built core trading infrastructure (BitShares client, grid calculation system, fund accounting, order management) and released v0.1.0–v0.3.0 within the first month, establishing the modular architecture, PARTIAL order state, and PM2 process management that underpin the entire project.

### Phase 2: Stabilization & Advanced Features (January 2026)
Added AMA trend detection, blockchain integer-based precision system, comprehensive test suite, ghost order prevention, self-healing recovery layers, and fund-driven boundary sync. Ported the test suite from Jest to native Node.js assert to eliminate heavy dependencies. Resolved 12+ critical race conditions in fill processing.

### Phase 3: Architecture Refinement & COW Pattern (February 2026)
Implemented Copy-on-Write grid architecture with immutable master grid, atomic boundary shifts, and deadlock resolution. Added multi-node health checking, dashboard scaffolding (Rust/ratatui), and spread correction redesign with edge-based strategy.

### Phase 4: Market Adapter & Production Hardening (Late Feb - March 2026)
Consolidated the market adapter with split data sources (Kibana, native API), AMA-derived grid center, fixed-cap fill batching, and credential daemon hardening. Removed cacheFunds tracking in favor of real-time commitment accounting. Expanded the Claw runtime. Released v0.6.0.

---

### Phase 5: Signal Intelligence & Debt Runtime (March - May 2026)
**Duration**: March 4 - May 31, 2026
**Focus**: Market adapter signal pipeline, dynamic-weight/Kalman research, credit/debt runtime, TypeScript migration, and production stabilization

**Mar–Apr**: Added derivative signal engine (SMA/MACD/RSI), dynamic-weight system with Kalman confirmation and ATR volatility scaling, Hurst/PE regime detection, and credit/debt runtime for MPA borrow/repay and credit offers.

**May 1–18**: Stabilized market adapter (fixed-price/orderbook modes, node failover), reworked AMA warmup to SMA-based progressive, hardened credential daemon (broadcast retry, stale socket handling), applied AMA slope as market price offset, hardened credit maintenance (collateral gating, renew-only policy, startup validation). Released v0.7.0.

**May 21–22**: Shared AMA strategy with market adapter runtime, Kalman stability patch, adapter packaging consolidation, documentation refresh. Released v0.7.1–v0.7.4.

**May 23–25**: Replaced `btsdex` npm dependency with native BitShares integration, codified zero-dependency policy, completed full TypeScript migration (48K+ lines, 173 tests → 184+ by v0.7.14). Released v0.7.5.

**May 26–28**: Overhauled fill detection (direct-notice dispatch, instance-based cursor, subscription reconnect), BTS fee acquisition via AMM pool, centralized logging, credential daemon security hardening (private-key removal, memory zeroing, bootstrap leak fix).

**May 29–31**: Hardened unlock (signal handler cleanup, polling guards), removed deprecated legacy migration patterns, swept 14 documentation files. Released v0.7.6. Then added default background daemon + crash restart, auto-update for monolithic path, per-bot log files, MPA `debtOnly` flag, and simplified CLI. Released v0.7.7. Renamed `unlock-start` → `unlock`, unified launcher summaries, hardened monolithic restart after auto-update, cleaned stale build artifacts, and polished DEXBot comparison docs. Released v0.7.8.

**Jun 1**: Enhanced unlock status with market adapter and credential daemon health indicators, fixed update lifecycle to restart all runtime services, removed PM2 reload wrapper, and de-emphasized PM2 in the README. Released v0.7.9. Then hardened runtime self-healing paths: promoted structural grid drift into an explicit resync path, added targeted chain-truth reconciliation for idle maintenance, guarded post-reset spread correction with a fresh chain sync, and deferred fill processing during order batches; deduplicated the chain-sync/fill pipeline into a shared helper, made launcher wrappers work without a `dist/` build, and added a `node dexbot order` subcommand with green active-bot feedback in `node unlock status`. Released v0.7.10.

**Jun 2–3**: Closed several COW grid-integrity windows (pre-broadcast unmatched-chain guard, post-broadcast missing-`chainOrderId` blocker, sync-engine occupied-slot exclusion, startup `SUSPECTED DUPLICATE` diagnostics) and hardened uncertainty-recovery with a typed `BroadcastUncertainError`, price-drift-orphan prioritization, pre-broadcast price freshness, and a persistence-commit guard. Renamed the shared reconciler to `grid_reconcile.ts`. Defended the launcher against foreign credential daemons, hardened the market adapter watchdog lock, force-rebuilt the updater bundle, and added socket-scoped close coalescing, failover cooldown, idempotent shutdown, and local-cancel artifact filtering. CLI polish: `node dexbot clear`, plural/singular CLI aliases, `node dexbot status` unified runtime status, and live dynamic-weight/adapter-offline alerts in `node dexbot order`. Released v0.7.11.

**Jun 4**: CLI polish (`default`, `white`/`stat` aliases, `start`→`test`, `restart all`/`stop all`), terminal color brightening, doubled-log fix, 20-file doc sweep. Released v0.7.12.

**Jun 6**: Added pair orientation toggle to TradingView charts, CEX synthetic candle seeding to complement native candle data, tuned AMA reset and asymmetry defaults, kept key manager startup quiet, avoided duplicate builds during update install, preserved masked terminal input editing, darkened active sell color in order display, and removed stale doc references. Released v0.7.13.

**Jun 9**: Refined `node dexbot order` / analyze-orders output with aligned columns, richer AMA metadata, and 5-digit pricing; hardened market-adapter whitelist preservation, default dynamic-weight behavior, AMA snapshot refresh, and whitelist gating; made unlock monolithic startup idempotent; simplified whole-runtime controls to `node unlock stop` / `node unlock restart` while keeping `all` and isolated bot targets compatible. Released v0.7.14. Also added quiet orderbook candle carry-forward and TTY-safe launcher/updater terminal polish. Released v0.7.15.

**Jun 10**: Hardened pipeline blocking: stale `_gridSidesUpdated` self-blocking fix, dead `anyRotations` removal, redundant fund recalc deduplication in grid init, finally-block cleanup of correction entries, dead `_batchRetryInFlight` removal, and throw-safe grid resize guarding. Released v0.7.16.

---

## Architecture Evolution

DEXBot2's architecture transitioned from monolithic utilities to a decoupled, event-driven, immutable state system:
- **Phase 1-2**: Loose modules for order/account management, basic grid trading.
- **Phase 3-4**: Copy-on-Write grid with atomic modifications, Market Adapter decoupling signals from execution.
- **Phase 5**: Multi-layered runtime — COW core execution, signal pipeline (AMA/Kalman/regime), credit/debt MPA runtime, credit maintenance hardening, credential daemon.
- **Post-5: Zero-Dependency & TypeScript Migration**: Full codebase migration from JavaScript to TypeScript with strict mode, `tsc` build pipeline, zero-dependency runtime via `tsx`, and explicit architectural policy removing all external runtime dependencies.
- **Post-5.1: Fill Detection Overhaul**: Complete rewrite of native BitShares fill detection subsystem — direct-notice dispatch replaces history scanning, instance-based cursor filtering, subscription reconnect retry, deferred cursor advancement on callback failure, unfiltered `get_account_history`, and btsFeeState hardening
- **Post-5.2: Runtime Self-Healing**: Runtime maintenance now reconciles from chain truth whenever an active-order shortfall or fund drift is detected, treating structural grid drift as an explicit resync signal and guarding order batches so in-flight fills are never credited through the orphan path.

---

## Version History

### v0.1.0 → v0.2.0 (29 commits)
Core order/fund management, documentation, scripts & tooling.

### v0.2.0 → v0.3.0 (155 commits)
Fund management & BTS fees, grid divergence detection, persistence & race conditions, order rotation & sizing, refactoring.

### v0.3.0 → v0.4.0 (18 commits)
Fund management consolidation, grid sizing & quantization, market fees & RMS threshold, partial order handling.

### v0.4.0 → v0.5.0 (92 commits)
Critical bug fixes, race condition prevention (AsyncLock), fund management centralization, spread correction, fill processing & deduplication, grid health & dust recovery.

### v0.5.0 → v0.6.0 (598 commits)
Fund accounting overhaul, COW architecture, strategy engine refactoring, sync engine improvements, fill processing hardening, credential daemon, dashboard scaffolding, AMA prototype, comprehensive documentation and testing.

### v0.6.0 → v0.7.0 (325 commits)
AMA-based market adapter with signal pipeline, credential daemon hardening, connection resilience, credit/MPA debt runtime, safer grid lifecycle, expanded analysis suite.

### v0.7.0 → v0.7.1 (2 commits)
Share AMA strategy with market adapter, version history docs.

### v0.7.1 → v0.7.2 (2 commits)
Dynamic-weight Kalman stability patch, chart slope floor adjustment.

### v0.7.2 → v0.7.3 (3 commits)
Docker launcher docs alignment, centralized AMA slope conversion helpers.

### v0.7.3 → v0.7.4 (5 commits)
Code cleanup (unused deps, inline helper), documentation refresh.

### v0.7.4 → v0.7.5 (93 commits)
Removal of all external runtime dependencies and full TypeScript migration (48K+ lines, 173 tests → 184+ by v0.7.14). Native BitShares integration replaces `btsdex`, fill detection overhaul with direct-notice dispatch, BTS fee acquisition via AMM pool, centralized logging, credential daemon security hardening.

### v0.7.5 → v0.7.6 (5 commits)
Unlock-start launcher hardening (signal handler cleanup, polling guards), deprecated legacy migration code removal, broken reference fixes, 14-file documentation sweep.

### v0.7.6 → v0.7.7 (6 commits)
Default background daemon + crash restart for unlock, auto-update for monolithic path, per-bot log files with daemon output redirect, MPA `debtOnly` flag with discriminated-union types, CLI simplification.

### v0.7.7 → v0.7.8 (7 commits)
Rename `unlock-start` → `unlock`, unify launcher startup/control summaries, harden monolithic restart after auto-update, clean stale build artifacts, add Performance & Speed section to DEXBot comparison doc.

### v0.7.8 → v0.7.9 (9 commits)
Enhance unlock status with market adapter and credential daemon health indicators, fix unlock update lifecycle to restart all runtime services, remove PM2 reload wrapper, de-emphasize PM2 and clarify unlock modes in the README.

### v0.7.9 → v0.7.10 (8 commits)
Harden runtime self-healing: promote structural grid drift into an explicit resync path, add targeted chain-truth reconciliation for idle maintenance, guard post-reset spread correction with a fresh chain sync, and defer fill processing during order batches. Deduplicate the chain-sync/fill pipeline into a shared helper, make launcher wrappers work without a `dist/` build, and add a `node dexbot order` subcommand with green active-bot feedback in `node unlock status`.

### v0.7.10 → v0.7.11 (16 commits)
Close COW grid-integrity windows (unmatched chain orders, missing `chainOrderId` results, occupied-slot adoption, startup `SUSPECTED DUPLICATE` diagnostics); harden uncertainty-recovery with `BroadcastUncertainError`, price-drift-orphan prioritization, and a persistence-commit guard. Rename the shared reconciler to `grid_reconcile.ts`. Defend the launcher against foreign credential daemons, harden the market adapter watchdog lock, force-rebuild the updater bundle, and add native transport close coalescing, failover cooldown, idempotent shutdown, and local-cancel artifact filtering. CLI polish: `node dexbot clear`, plural/singular CLI aliases, `node dexbot status` unified runtime command, and live dynamic-weight/adapter-offline alerts in `node dexbot order`. Documentation sweep for stale version references, file renames, and hardcoded paths; README clarity pass emphasizing unlock as the recommended runtime.

### v0.7.11 → v0.7.12 (7 commits)
CLI polish (`default`, `white`/`stat` aliases, `start`→`test`, `restart all`/`stop all`), terminal color brightening, doubled-log lazy-init fix, 20-file doc sweep.

### v0.7.12 → v0.7.13 (9 commits)
TradingView chart pair orientation toggle, CEX synthetic candle seeding, AMA reset and asymmetry default tuning, key manager startup quieting, duplicate build avoidance during update install, masked terminal input editing preservation, active sell color darkening in order display, stale doc reference cleanup.

### v0.7.13 → v0.7.14 (10 commits)
Analyze-orders display overhaul with aligned columns, AMA metadata, and 5-digit pricing; market-adapter whitelist preservation, dynamic weights defaulting off, AMA snapshot refresh every cycle, whitelist-gated dynamic weights, and AMA status display without dynamic weights. Unlock monolithic startup is idempotent, `node unlock stop` / `node unlock restart` are canonical whole-runtime controls, and legacy `all` plus isolated bot targets remain compatible.

### v0.7.14 → v0.7.15 (5 commits)
Quiet orderbook candle carry-forward for book-sourced market data, plus TTY-safe launcher/updater terminal polish.

### v0.7.15 → v0.7.16 (5 commits)
Pipeline blocking hardening: stale `_gridSidesUpdated` self-blocking fix, dead `anyRotations` removal, redundant fund recalc deduplication, `correctOrderPriceOnChain` finally-block cleanup for all exit paths, dead `_batchRetryInFlight` removal, and throw-safe grid resize guarding. Docs cleanup and whitelist generation simplification.

---

### Pre-DEXBot2
- **StakeMachine v0.0.6** (2017): Python proof-of-concept, buy/sell walls.
- **DEXBot v1.0.0** (2018–2020): Python production bot, PyQt5 GUI, 3 strategies, CCXT feeds.

---

## Development Statistics

208+ automated test files (all TypeScript), 32 release entries. See **Version History** for commit breakdown by release.

---

## Technical Challenges & Solutions

| Challenge | Solution | Impact |
|-----------|----------|--------|
| Race conditions in fill processing | AsyncLock pattern with atomic operations | Eliminated 12+ critical race conditions |
| Float precision in order sizes | Blockchain integer-based calculations (satoshi integers) | Deterministic behavior matching chain storage |
| Ghost orders (tiny remainders in PARTIAL state) | Integer-based full-fill detection | Prevented stuck orders and fund drift |
| Grid corruption during divergence | Copy-on-Write with atomic boundary shifts | Safe concurrent modifications, no data loss |
| BTS fee accounting drift | Unified fee deduction in calculateAvailableFunds | Accurate fee tracking across all operations |
| Rapid-restart cascading failures | Layer 1 & Layer 2 self-healing defenses | Stable restart with automatic recovery |

---

## Documentation & Testing

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across a 208+ file suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Conclusion

DEXBot2 has matured from a basic grid bot into a signal-intelligent, production-ready trading system.

---

## Phase 6: Planned

- **Web & Terminal UI**: Browser-based and TUI dashboards for monitoring and tuning (TUI scaffolded in `dashboard/` — Rust/ratatui)
- **Backtesting Engine**: Replay historical candles through `OrderManager`/COW via a `MemoryExchange` drop-in at the `bitshares_client` boundary
- **Performance Analytics**: PnL tracking, grid efficiency metrics, HTML report generation
- **Monorepo Split**: Package into `@dexbot/core`, `@dexbot/bitshares`, `@dexbot/indicators` for parallelized builds
- **Injectable Module Interfaces**: Dependency inversion at call boundaries for testability (no event bus)
- **Database (SQLite) + Zod Validation**: Replace JSON persistence, validate blockchain objects at the client boundary
- ~~**Dependency Reduction**~~ ✅ Completed in v0.7.5

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: June 10, 2026
**Total Commits**: 1530
**Date Range**: December 2, 2025 - June 10, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
