# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 0.7.2 release cycle.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,326 commits over ~5.5 active months
- **Code Maturity**: Evolution from basic utilities to a ~48,000+ LoC intelligent system
- **Stability**: Progression from manual testing to a suite of 158 automated test files
- **Releases**: 18 tagged releases (v0.1.0 to v0.7.2)

---

## Pre-History: Generational Lineage

DEXBot2 is the third generation of BitShares DEX trading bot development, preceded by two Python-based projects.

### Generation 0: StakeMachine (2017)
**Author**: Fabian Schuh (ChainSquad GmbH) — v0.0.6 alpha

Proof-of-concept. Subscribed to BitShares WebSocket notifications and placed static buy/sell walls at fixed percentage offsets from the settlement price feed. No grid, no adaptive signals, no tests. Established the event-driven subscription model (on_block, on_market, on_account), plugin strategy loading, and per-bot persistent storage.

### Generation 1: DEXBot Python v1.0.0 (2018–2020)
**Author**: Codaone Oy (BitShares worker proposal funded)

Full production rewrite with PyQt5 GUI, three strategies, CCXT/CoinGecko/Waves external feeds, multi-node management, SQLite with Alembic migrations, systemd integration, and Windows installer. Ran hundreds of workers across dozens of BitShares markets.

**Strategies**: **Staggered Orders** (2256 lines, grid-based with 5 distribution modes and virtual orders — the direct ancestor of DEXBot2's grid), **Relative Orders** (two-sided market making with dynamic spread), **King of the Hill** (top-of-book best bid/ask).

**Carried into DEXBot2**: Staggered grid concept, virtual/off-chain order tracking, isolated per-market workers, event dispatch via Events library, and market center price calculation.

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
**Duration**: December 2 - December 31, 2025
**Focus**: Establishing core trading infrastructure, order management, and fund accounting

#### Key Milestones
- **Dec 2**: Project initialization from DEXBot (Python) concepts; JavaScript rewrite from scratch
- **Dec 3**: BitShares client integration and order broadcast handling
- **Dec 4**: Grid calculation system with exact step multipliers
- **Dec 5**: Utility function extraction and price helper consolidation
- **Dec 7-8**: Fund calculation and PARTIAL order state implementation
- **Dec 9-10**: PM2 process management and multi-bot support
- **Dec 10**: First release (v0.1.0) - Alpha stage
- **Dec 11-12**: BTS fee accounting system
- **Dec 12**: Release v0.2.0 with fee caching
- **Dec 12**: Release v0.3.0 with grid regeneration threshold
- **Dec 13-15**: Grid divergence detection and automatic recalculation
- **Dec 14-31**: Stability improvements, logging enhancements, and partial fill handling

#### Architecture Decisions
1. **Modular Architecture**: Separation into chain_orders, account_orders, account_bots
2. **Grid System**: OrderGridGenerator (later renamed to Grid) with precise spacing
3. **Fund Management**: Centralized fund calculation with available-funds tracking
4. **State Management**: Introduction of PARTIAL state for partial fills
5. **Process Management**: PM2 integration for production deployment

---

### Phase 2: Stabilization & Advanced Features (January 2026)
**Duration**: January 1 - January 31, 2026
**Focus**: Bug fixes, race condition resolution, advanced trading strategies, and system hardening

#### Key Milestones
- **Jan 1-5**: AMA (Adaptive Moving Average) trend detection system
- **Jan 6-8**: Asset precision handling and integer-based calculations
- **Jan 9-12**: Comprehensive test suite development
- **Jan 13-15**: Fund accounting improvements and BTS fee settlement
- **Jan 16-18**: Ghost order detection and full-fill handling
- **Jan 19-22**: Native test porting from Jest to Node.js assert
- **Jan 23-26**: Layer 1 & Layer 2 defenses against rapid-restart cascades
- **Jan 27-28**: Startup auto-recovery and trigger reset stabilization
- **Jan 29-31**: Documentation consolidation and cross-platform improvements

#### Major Features
1. **AMA Optimization Suite**: High-resolution parameter tuning for trend detection
2. **Precision System**: Blockchain integer-based calculations (satoshi integers)
3. **Ghost Order Prevention**: Robust full-fill detection for tiny remainders
4. **Native Test Suite**: Ported from Jest to eliminate heavy dependencies
5. **BTS Fee Settlement**: Complete fee accounting with maker refunds
6. **Self-Healing Recovery**: Layer 2 stabilization with automatic recovery
7. **Fund-Driven Boundary Sync**: Align grid with inventory distribution

#### Critical Fixes
- **Jan 6**: Resolved 100,000x order size multiplier bug
- **Jan 14**: Fixed high available funds and duplicate cleanup
- **Jan 15**: Eliminated 12 critical race conditions in fill processing
- **Jan 22**: Fixed ghost orders causing doubled funds
- **Jan 26**: Resolved critical fund tracking corruption
- **Jan 30**: Fixed phantom fund losses during boundary-crawl

---

### Phase 3: Architecture Refinement & COW Pattern (February 2026)
**Duration**: February 1 - February 18, 2026
**Focus**: Copy-on-Write architecture, code quality, and production hardening

#### Key Milestones
- **Feb 1**: Order analysis script for grid trading metrics
- **Feb 2**: Pipeline timeout safeguard and comprehensive documentation
- **Feb 3**: Spread correction redesign with edge-based strategy
- **Feb 4-5**: Price orientation standardization (B/A format)
- **Feb 5**: Robust full-fill detection with integer-based rounding
- **Feb 6**: Multi-node management with health checking
- **Feb 7**: Dashboard scaffolding with ratatui operations
- **Feb 8-9**: Fill pipeline hardening and readline-sync replacement
- **Feb 10**: Immutable Master Grid Architecture (Phase 1-4)
- **Feb 14**: Copy-on-Write (COW) grid architecture implementation
- **Feb 15-16**: COW deadlocks resolution and lock routing
- **Feb 17**: Hybrid COW pattern with static mutation detection
- **Feb 18**: Atomic boundary shifts and patch20 documentation

#### Architecture Evolution
1. **Immutable Master Grid**: Transactional rollback and logic decomposition
2. **Copy-on-Write Pattern**: Safe concurrent grid modifications
3. **Atomic Service Pattern**: Safe concurrency without race conditions
4. **State Manager**: Centralized state management for grid operations
5. **COW Rebalance Engine**: Dedicated engine for safe rebalancing
6. **Atomic Boundary Shifts**: Prevent boundary index corruption during divergence

---

### Phase 4: Market Adapter & Production Hardening (Late Feb - March 2026)
**Duration**: February 19 - March 3, 2026
**Focus**: AMA integration, market adapter consolidation, fill processing finalization, credential daemon hardening

#### Key Milestones
- **Feb 19-22**: COW invariant sealing and stable-theory contract (`COW_INVARIANTS.md`)
- **Feb 22-26**: Spread correction simplification and doubled-side removal
- **Feb 26-28**: Market adapter refactor — split data sources, retire monitors, add adapter regressions
- **Mar 1**: Grid recalculation documentation, AMA and market-adapter config semantics
- **Mar 1-3**: Shard-parallel cap-based AMA fitting and profile sync
- **Mar 3**: Fixed-cap batching finalized, adaptive-tier references removed
- **Mar 3**: Release v0.6.0 — gridPrice merge and market adapter foundation

#### Major Changes
1. **Fixed-Cap Fill Batching**: Finalized at 4-fill cap; adaptive-tier system fully removed
2. **Market Adapter Consolidation**: Split data sources (Kibana, native API), removed whitelist fallback
3. **AMA Grid Integration**: AMA-derived grid center during initialization
4. **Shard-Parallel AMA Fitting**: Cap-based AMA fitting with profile sync across shards
5. **Doubled-Side Removal**: Removed doubled-side replacement flow from sync engine
6. **CacheFunds Removal**: Eliminated cacheFunds tracking in favor of real-time commitment accounting
7. **Credential Daemon Hardening**: Strict daemon policy, session hardening, signing cache, memory safety
8. **Claw Expansion**: Hermes runtime manifest, launcher command bridge, skill packs

---

### Phase 5: Signal Intelligence & Debt Runtime (March - May 2026)
**Duration**: March 4 - May 18, 2026
**Focus**: Market adapter offset groundwork, Claw/credential hardening, SMA derivative signals, dynamic-weight/Kalman research, regime filtering, credit/debt runtime, and production stabilization

#### Key Milestones
- **Mar 4-10**: AMA and adapter research tooling — AMA3 defaults, expanded candle history, Kibana date-range/merge tools
- **Mar 20-24**: Dust-cancel delay, settings/analyze-orders cleanup, README refresh
- **Mar 28-31**: Claw bridge/runtime expansion, feed-anchored trend research, AMA grid-price offset state, dynamic weight policy scaffolding
- **Apr 1-5**: Fill replay hardening, runtime extraction, Claw bridge expansion, credential daemon strict policy/session hardening
- **Apr 6-8**: Market adapter modularization, PM2/dry-run logging cleanup, orphaned-grid-slot recovery
- **Apr 9-10**: Derivative signal engine and market-profile offset controls — SMA/fastSMA/MACD/RSI, momentum gate, dry-run output separation
- **Apr 11-13**: Fallback removal and analysis chart cleanup — legacy input/runtime removal, AMA preset refresh, uPlot chart paths
- **Apr 14**: Dynamic grid and dynamic-weight groundwork — AMA slope weight adjustment, ATR volatility scaling, Kalman-AMA research chart
- **Apr 15-16**: Regime detection and production parity — Hurst/PE analyzers, regime gate, percentile clip, weight-only updates
- **Apr 17-20**: Dynamic weight runtime alignment — volatility chart, Kalman echo latching, research-to-production parity
- **Apr 20**: Credit/debt runtime — MPA borrowing, credit offer accept/repay, auto-reborrow
- **Apr 21-22**: Dynamic weight snapshot persistence, warmup/closed-candle alignment, rebalance refresh wiring
- **Apr 23-28**: Credit-offer hardening, direct market adapter runtime management, whitelist generator, and documentation hub reorganization
- **May 1-2**: Market adapter stabilization — fixed-price/orderbook candle modes, test suite repair, node failover hardening, stale dynamic weight rejection
- **May 8-10**: AMA warmup rework — SMA-based progressive warmup replaces first-price and full-convergence approaches. Market adapter lifecycle stability, candle merge robustness
- **May 11**: AMA delta threshold refresh and constants update
- **May 12**: Analysis expansion — trade heatmap (volume distribution by AMA deviation), risk profile analyzer with sigma metrics
- **May 13**: Credential daemon hardening sprint — broadcast retry, node list mirroring, bootstrap resilience, PM2 restart loop prevention, stale socket exit. AMA slope market price offset applied
- **May 14-15**: Credit runtime fixes — MPA target CR encoding, pair-scoped pricing, reborrow policy preservation. Documentation finalization for 0.7.0
- **May 16-18**: Credit maintenance hardening — collateral-gated credit increases, renew-only credit offer policy, credit deal renewal with fallback safety, startup credit maintenance, autoRepay state sync, centralized grid reset metadata handling, dynamic grid reset state preservation, empirical table source documentation
- **May 18**: Release v0.7.0 - final 0.7 hardening and signal refinement
- **May 21-22**: AMA strategy sharing, slope readiness warmup logic, and release v0.7.1
- **May 22**: Release v0.7.1 - share AMA strategy and readiness fix
- **May 22**: Release v0.7.2 - dynamic-weight Kalman stability patch

#### Major Changes
1. **Derivative Signals**: SMA/fastSMA/MACD/RSI signal traps, momentum gate, fast-SMA commitment tracking
2. **Dynamic Weight System**: Live AMA slope, ATR volatility scaling, Kalman confirmation, and weight-only updates
3. **Regime Detection**: Hurst/PE-based dampening for trending, mean-reverting, and noisy states
4. **Market Adapter Signal Pipeline**: Full weight output, collateral recommendation, trend/atr export
5. **Credit/Debt Runtime**: Native MPA and credit-offer workflows with `modules/credit_runtime.js`
6. **Bot Auto-Tuner**: Direct tuning and reasoning bridge for parameter optimization
7. **Fallback Removal**: Strict precision, explicit price derivation modes, no orphan lax matching
8. **Credential/Claw Hardening**: Strict daemon policy, daemon signing cache, secure credential runtime, Claw bridge/runtime support
9. **Analysis Tooling**: TradingView uPlot exporter, volatility research chart, regime window analyzer, simplified chart entrypoints, trade heatmap, risk profile analyzer
10. **Maintenance Safety**: Grid maintenance defers structural work during active fills and dust-cancel windows
11. **AMA Warmup Rework**: SMA-based progressive warmup replaces first-price initialization and full-convergence warmup
12. **AMA Slope Price Offset**: Asymmetric market price offset driven by live AMA slope, applied at grid recalculation
13. **Credential Daemon Resilience**: Broadcast retry, stale socket handling, node list mirroring, PM2 restart loop prevention
14. **Credit Maintenance Hardening**: Collateral-gated credit increases, renew-only policy, deal renewal with fallback safety, startup credit maintenance, autoRepay state synchronization
15. **Grid Reset Metadata**: Centralized reset metadata handling with dynamic reset state preservation

---

## Architecture Evolution

DEXBot2's architecture transitioned from monolithic utilities to a decoupled, event-driven, immutable state system:
- **Phase 1-2**: Loose modules for order/account management, basic grid trading.
- **Phase 3-4**: Copy-on-Write grid with atomic modifications, Market Adapter decoupling signals from execution.
- **Phase 5**: Multi-layered runtime — COW core execution, signal pipeline (AMA/Kalman/regime), credit/debt MPA runtime, credit maintenance hardening, credential daemon.

---

## Version History

### v0.7.1 → v0.7.2 (2 commits)

| Category | Commits |
|----------|---------|
| 1. Dynamic-weight Kalman stability | 1 |
| 2. Dynamic-weight chart slope floor | 1 |
| **Total** | **2** |

---

### v0.7.0 → v0.7.1 (2 commits)

| Category | Commits |
|----------|---------|
| 1. Share AMA strategy with market adapter | 1 |
| 2. Expand version history docs | 1 |
| **Total** | **2** |

---

### v0.6.0 → v0.7.0 (325 commits)

| Category | Commits |
|----------|---------|
| 1. AMA-based market adapter | ~120 |
| 2. Startup & credential hardening | ~35 |
| 3. Connection resilience | ~9 |
| 4. Credit/MPA debt runtime | ~19 |
| 5. Safer grid lifecycle | ~23 |
| 6. Expanded analysis suite | ~25 |
| Docs-only commits (not listed) | ~94 |
| **Total** | **325** |

---

### v0.5.0 → v0.6.0 (598 commits)

| Category | Commits |
|----------|---------|
| 1. Fund accounting overhaul | ~80 |
| 2. Bug fixes & hardening | ~100 |
| 3. Strategy engine refactoring | ~60 |
| 4. Documentation | ~60 |
| 5. Order manager modularization | ~50 |
| 6. COW (Copy-on-Write) architecture | ~40 |
| 7. Fill processing hardening | ~40 |
| 8. Testing | ~40 |
| 9. Sync engine improvements | ~30 |
| 10. AMA/market adapter | ~30 |
| 11. Refactoring & code quality | ~48 |
| 12. Credential daemon & security | ~15 |
| 13. Dashboard | ~5 |
| **Total** | **598** |

---

### v0.4.0 → v0.5.0 (92 commits)

| Category | Commits |
|----------|---------|
| 1. Critical bug fixes | ~15 |
| 2. Race condition prevention (AsyncLock) | ~15 |
| 3. Fund management centralization | ~15 |
| 4. Spread correction | ~10 |
| 5. Fill processing & deduplication | ~10 |
| 6. Grid health & dust recovery | ~10 |
| 7. Documentation | ~10 |
| 8. Testing | ~7 |
| **Total** | **92** |

---

### v0.3.0 → v0.4.0 (18 commits)

| Category | Commits |
|----------|---------|
| 1. Fund management consolidation | ~5 |
| 2. Grid sizing & quantization | ~4 |
| 3. Market fees & RMS threshold | ~3 |
| 4. Partial order handling | ~3 |
| 5. Documentation | ~3 |
| **Total** | **18** |

---

### v0.2.0 → v0.3.0 (155 commits)

| Category | Commits |
|----------|---------|
| 1. Fund management & BTS fees | ~30 |
| 2. Grid divergence detection | ~25 |
| 3. Persistence & race conditions | ~25 |
| 4. Order rotation & sizing | ~20 |
| 5. Documentation | ~20 |
| 6. Refactoring & code quality | ~20 |
| 7. Scripts & tooling | ~15 |
| **Total** | **155** |

---

### v0.1.0 → v0.2.0 (29 commits)

| Category | Commits |
|----------|---------|
| 1. Core order/fund management | ~10 |
| 2. Documentation | ~10 |
| 3. Scripts & tooling | ~5 |
| 4. Release & chore | ~4 |
| **Total** | **29** |

---

### Pre-DEXBot2
- **StakeMachine v0.0.6** (2017): Python proof-of-concept, buy/sell walls.
- **DEXBot v1.0.0** (2018–2020): Python production bot, PyQt5 GUI, 3 strategies, CCXT feeds.

---

## Development Statistics

158 automated tests, 15 tagged releases. See **Version History** for commit breakdown by release.

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

## Documentation Evolution

Evolved from basic README + inline comments to a comprehensive framework: 23 docs/ entries (architecture map, COW invariants, fund accounting, credential security, developer guide, TypeScript migration analysis), 80%+ JSDoc coverage, 137+ documentation commits (10.4% of total), and an `AGENTS.md` for AI-assisted development.

---

## Testing Strategy

Evolved from manual blockchain testing → Jest unit tests → lightweight Node.js assert (zero test dependencies for the 158-file suite). Multi-layered verification: unit/integration for accounting/sync/grid, complex market scenario simulations, edge-case coverage, COW architectural guards (invariants, mutation detection), and signal/credit runtime validation.


---

## Conclusion

DEXBot2 has matured from a basic grid bot into a signal-intelligent, production-ready trading system.

---

## Phase 6: Technical Modernization & Growth (Planned)

### UX, Education & Services
- **Web & Terminal UI**: Browser-based and TUI dashboards for bot monitoring, manual intervention, and parameter tuning live. *(TUI dashboard scaffolded in `dashboard/` — Rust/ratatui sidecar)*
- **Content Creation**: Instructional videos, tutorials, and onboarding material for user onboarding.
- **Marketing**: Strategic advertisement and outreach to expand the BitShares trading community.
- **Hosting Service**: Managed deployment for users who want bot operation without infrastructure management.

### Backtesting & Statistics
- **Simulation Engine**: Replay historical candles through the core `OrderManager`/COW engine via a `MemoryExchange` (drop-in at the `bitshares_client` boundary). Same strategy code, same grid, same fill processing — zero changes needed for backtest mode.
- **Performance Analytics**: PnL tracking, grid efficiency metrics, risk assessment, and HTML report generation.

### Modernization & Migration
- **TypeScript Migration**: Incremental migration from JS to TypeScript, starting with highest-bug-surface modules (COW, accounting, sync engine). *(Analysis complete — see `docs/TYPESCRIPT_MIGRATION_ANALYSIS.md`: ~48K LoC, 158 test files, 2 external deps, 4-5 month estimate with 3-4 developers)*
- **Dependency Reduction**: Continued minimization of external dependencies. *(Already at 2 deps: btsdex, bs58check)*

### Architecture & Code Quality — Detailed Breakdown

#### Tier 1 — High Impact

1. **Monorepo & Packages** — Split into `@dexbot/core`, `@dexbot/bitshares`, `@dexbot/strategies`, `@dexbot/indicators`. Enables incremental TypeScript migration and parallelized builds/testing.

2. **Event Bus** — Replace the tight `FillCallback → Manager → Accounting → SyncEngine → chain_orders` call chain with a typed event bus. Modules subscribe independently, testable with mocked events.

3. **Unified Indicator Library** — Centralize scattered signal code (AMA, Kalman, dynamic weight, regime detection) into `@dexbot/indicators`. Add standard indicators (SMA, MACD, RSI, BB) for non-grid strategies.

4. **Incremental TypeScript** — Migrate in package order: `core` (COW + accounting) → `indicators` → `bitshares` → `strategies`.

#### Tier 2 — Medium Impact

5. **Strategy Effects Pattern** — Strategies return declarative action objects (`{ action: 'CREATE_ORDER', price, amount }`) instead of calling `manager.js` directly. Strategy logic becomes a pure function — unit-testable without blockchain.

6. **Database (Prisma/SQLite) + Zod Validation** — Replace JSON file persistence with SQLite. Validate all blockchain objects at the `bitshares_client` boundary via Zod schemas.

7. **Vitest Migration** — Wrap 158 test files in Vitest for parallel execution, watch mode, and coverage reporting.

#### Tier 3 — Nice-to-Have

8. **Exchange Abstraction** — `IExchange` interface over `chain_orders.js` + `bitshares_client.js`.
9. **tRPC API** — Type-safe API layer for remote bot management and dashboard integration.
10. **Pino Logger** — Structured JSON logging with level filtering and composable transports.
11. **Commander.js CLI** — Better `dexbot.js` argument parsing with subcommands and auto-generated help.

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: May 18, 2026
**Total Commits**: 1320
**Date Range**: December 2, 2025 - May 18, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
