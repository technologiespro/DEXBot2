# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 0.7.17 release cycle.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,535 commits over ~6 active months
- **Code Maturity**: Evolution from basic utilities to a ~57,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 208+ automated test files
- **Releases**: 33 release entries (v0.1.0 to v0.7.17)

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

**May 1–18**: Market adapter stabilization, AMA warmup rework, credential daemon hardening, AMA slope offset, credit maintenance hardening — v0.7.0.

**May 21–22**: Shared AMA strategy with market adapter runtime, Kalman stability patch, adapter packaging consolidation, documentation refresh. Released v0.7.1–v0.7.4.

**May 23–25**: Native BitShares integration (replaced `btsdex`), zero-dependency policy, full TypeScript migration — v0.7.5.

**May 26–28**: Fill detection overhaul, BTS fee via AMM pool, centralized logging, credential daemon security hardening.

**May 29–31**: Unlock hardening (signal cleanup, polling guards), legacy migration cleanup, doc sweep — v0.7.6. Background daemon, auto-update, per-bot logs, MPA `debtOnly` — v0.7.7. Rename `unlock-start` → `unlock`, launcher unification, comparison docs — v0.7.8.

**Jun 1**: Unlock status health indicators, PM2 reload wrapper removal, unlock mode clarity — v0.7.9. Runtime self-healing (structural resync, targeted reconciliation, post-reset spread guard), shared sync/fill helper, launcher wrappers without `dist/`, `node dexbot order` subcommand — v0.7.10.

**Jun 2–3**: COW grid-integrity windows closed, uncertainty-recovery hardening, launcher foreign-daemon defense, native transport improvements, CLI polish (`clear`, aliases, `status`, dynamic-weight alerts) — v0.7.11.

**Jun 4**: CLI polish (`default`, `white`/`stat` aliases, `start`→`test`, `restart all`/`stop all`), terminal color brightening, doubled-log fix, 20-file doc sweep. Released v0.7.12.

**Jun 6**: TradingView pair orientation toggle, CEX synthetic candle seeding, AMA default tuning, key manager quieting, masked input editing, stale doc cleanup — v0.7.13.

**Jun 9**: Analyze-orders display overhaul, market-adapter whitelist/dynamic-weight hardening, idempotent unlock startup, simplified runtime controls — v0.7.14. Quiet orderbook candles, TTY-safe terminal polish — v0.7.15.

**Jun 10**: Pipeline blocking hardening, dead code removal — v0.7.16. Then BUILD_DIR centralization, HMAC recovery, error handling hardening, plus a full codebase audit fixing stale types, dead tests, hardcoded paths, empty dirs, and comments — v0.7.17.

---

## Architecture Evolution

DEXBot2's architecture transitioned from monolithic utilities to a decoupled, event-driven, immutable state system:
- **Phase 1-2**: Loose modules for order/account management, basic grid trading.
- **Phase 3-4**: Copy-on-Write grid with atomic modifications, Market Adapter decoupling signals from execution.
- **Phase 5**: Multi-layered runtime — COW core execution, signal pipeline (AMA/Kalman/regime), credit/debt MPA runtime, credit maintenance hardening, credential daemon.
- **Post-5: Zero-Dependency & TypeScript Migration**: Full codebase migration from JavaScript to TypeScript with strict mode, `tsc` build pipeline, zero-dependency runtime via `tsx`, and explicit architectural policy removing all external runtime dependencies.
- **Post-5.1: Fill Detection Overhaul**: Native BitShares fill detection rewrite — direct-notice dispatch, instance-based cursor, subscription reconnect, btsFeeState hardening
- **Post-5.2: Runtime Self-Healing**: Chain-truth reconciliation for shortfalls and drift, structural resync signaling, order-batch fill guarding.

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
Zero-dependency and TypeScript migration, native BitShares integration replacing `btsdex`, fill detection overhaul, centralized logging, credential daemon security hardening.

### v0.7.5 → v0.7.6 (5 commits)
Unlock-start launcher hardening (signal handler cleanup, polling guards), deprecated legacy migration code removal, broken reference fixes, 14-file documentation sweep.

### v0.7.6 → v0.7.7 (6 commits)
Default background daemon + crash restart for unlock, auto-update for monolithic path, per-bot log files with daemon output redirect, MPA `debtOnly` flag with discriminated-union types, CLI simplification.

### v0.7.7 → v0.7.8 (7 commits)
Rename `unlock-start` → `unlock`, unify launcher startup/control summaries, harden monolithic restart after auto-update, clean stale build artifacts, add Performance & Speed section to DEXBot comparison doc.

### v0.7.8 → v0.7.9 (9 commits)
Enhance unlock status with market adapter and credential daemon health indicators, fix unlock update lifecycle to restart all runtime services, remove PM2 reload wrapper, de-emphasize PM2 and clarify unlock modes in the README.

### v0.7.9 → v0.7.10 (8 commits)
Runtime self-healing (structural resync, targeted reconciliation, post-reset spread guard), shared sync/fill helper, launcher wrappers without `dist/`, `node dexbot order` subcommand.

### v0.7.10 → v0.7.11 (16 commits)
COW grid-integrity windows closed, uncertainty-recovery hardening, foreign-daemon defense, native transport and watchdog improvements, CLI polish (`clear`, aliases, `status`, dynamic-weight alerts), doc sweep.

### v0.7.11 → v0.7.12 (7 commits)
CLI polish (`default`, `white`/`stat` aliases, `start`→`test`, `restart all`/`stop all`), terminal color brightening, doubled-log lazy-init fix, 20-file doc sweep.

### v0.7.12 → v0.7.13 (9 commits)
TradingView chart pair orientation toggle, CEX synthetic candle seeding, AMA reset and asymmetry default tuning, key manager startup quieting, duplicate build avoidance during update install, masked terminal input editing preservation, active sell color darkening in order display, stale doc reference cleanup.

### v0.7.13 → v0.7.14 (10 commits)
Analyze-orders display overhaul, market-adapter whitelist and dynamic-weight hardening, idempotent unlock startup, simplified runtime controls.

### v0.7.14 → v0.7.15 (5 commits)
Quiet orderbook candle carry-forward for book-sourced market data, plus TTY-safe launcher/updater terminal polish.

### v0.7.15 → v0.7.16 (5 commits)
Pipeline blocking hardening: stale `_gridSidesUpdated` self-blocking fix, dead `anyRotations` removal, redundant fund recalc deduplication, `correctOrderPriceOnChain` finally-block cleanup for all exit paths, dead `_batchRetryInFlight` removal, and throw-safe grid resize guarding. Docs cleanup and whitelist generation simplification.

### v0.7.16 → v0.7.17 (6 commits)
BUILD_DIR centralization, source-mode runtime, HMAC recovery, error hardening, zero-budget shortfall suppression, plus a full codebase audit fixing stale types, dead tests, hardcoded paths, empty dirs, and doc references.

---

### Pre-DEXBot2
- **StakeMachine v0.0.6** (2017): Python proof-of-concept, buy/sell walls.
- **DEXBot v1.0.0** (2018–2020): Python production bot, PyQt5 GUI, 3 strategies, CCXT feeds.

---

## Development Statistics

208+ automated test files (all TypeScript), 33 release entries. See **Version History** for commit breakdown by release.

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
