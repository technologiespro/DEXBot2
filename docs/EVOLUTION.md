# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 0.7.0 development cycle.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,307 commits over 6 active months
- **Code Maturity**: Evolution from basic utilities to a ~38,000+ LoC intelligent system
- **Stability**: Progression from manual testing to a suite of 168 automated test files
- **Releases**: 15 tagged releases (v0.1.0 to v0.6.0)

---

## Pre-History: Generational Lineage

DEXBot2 is the third generation of BitShares DEX trading bot development. Two earlier Python-based projects laid the conceptual and architectural groundwork.

### Generation 0: StakeMachine (2017)
**Author**: Fabian Schuh (ChainSquad GmbH)  
**Language**: Python 2/3  
**Version**: 0.0.6 (alpha)

The original proof-of-concept. A straightforward event-driven bot subscribing to BitShares WebSocket notifications (`Notify`). Implemented a single **Walls** strategy — placing a static buy wall and sell wall at fixed percentage offsets from the asset's settlement price feed. Used SQLite via SQLAlchemy for persistent key-value storage. CLI via Click. Demonstrated the core idea of programmatic BitShares DEX trading but lacked sophistication: no grid, no adaptive signals, no multi-node failover, no tests.

**Architectural seeds**:
- Event-driven subscription model (on_block, on_market, on_account)
- Plugin strategy loading via `importlib`
- Persistent per-bot storage namespace
- Transaction bundling (cancel + place in one broadcast)

### Generation 1: DEXBot (Python) — v1.0.0 (2018–2020)
**Author**: Codaone Oy (funded via BitShares worker proposal)  
**Language**: Python 3  
**Dependencies**: pyqt5, bitshares, ccxt, sqlalchemy, alembic, click

A full production rewrite from StakeMachine. Added PyQt5 desktop GUI, three strategies, external price feeds, multi-node management, database migrations, and a Windows installer. Ran hundreds of workers across dozens of BitShares markets.

**Strategies shipped**:
1. **Staggered Orders** (2256 lines) — Grid-based market making across a price range with 5 distribution modes (mountain, valley, neutral, buy_slope, sell_slope). Introduced **virtual orders**: orders beyond operational depth stored locally, promoted to real only when the grid shifts close enough. This is the direct ancestor of DEXBot2's grid.
2. **Relative Orders** (639 lines) — Classic two-sided market making with dynamic spread based on market depth, external price feeds (CoinGecko, CCXT, Waves), and asset-offset center price.
3. **King of the Hill** (426 lines) — Top-of-book strategy placing orders at best bid/ask, re-placing one tick ahead when outbid.

**Key advances over StakeMachine**:
- SQLite with Alembic migrations, not just key-value storage
- Multi-worker architecture (multiple markets per account)
- External price feeds from 100+ exchanges via CCXT
- Multi-node health checking with latency sorting
- PyQt5 GUI with real-time monitoring
- Transaction bundling and retry logic for blockchain errors
- systemd integration and Windows installer

**Architectural seeds for DEXBot2**:
- Staggered grid concept (the anchor + refill pattern)
- Virtual order tracking (off-chain order state)
- Workers as isolated per-market runtimes
- Event dispatch via Python `Events` library
- Market center price calculation

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
**Duration**: December 2 - December 31, 2025  
**Commits**: 408 (31.2% of total)
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
**Commits**: 425 (35.2% of total)
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
**Commits**: 150 (12.4% of total)
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
**Commits**: 54 (4.5% of total)
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
**Duration**: March 4 - May 3, 2026 (ongoing)
**Commits**: 181 (14.9% of total)
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
- **May 1-2**: Market adapter stabilization — fixed-price/orderbook candle modes, test suite repair, node failover hardening, and stale dynamic weight rejection

#### Major Changes
1. **Derivative Signals**: SMA/fastSMA/MACD/RSI signal traps, momentum gate, fast-SMA commitment tracking
2. **Dynamic Weight System**: Live AMA slope, ATR volatility scaling, Kalman confirmation, and weight-only updates
3. **Regime Detection**: Hurst/PE-based dampening for trending, mean-reverting, and noisy states
4. **Market Adapter Signal Pipeline**: Full weight output, collateral recommendation, trend/atr export
5. **Credit/Debt Runtime**: Native MPA and credit-offer workflows with `modules/credit_runtime.js`
6. **Bot Auto-Tuner**: Direct tuning and reasoning bridge for parameter optimization
7. **Fallback Removal**: Strict precision, explicit price derivation modes, no orphan lax matching
8. **Credential/Claw Hardening**: Strict daemon policy, daemon signing cache, secure credential runtime, Claw bridge/runtime support
9. **Analysis Tooling**: TradingView uPlot exporter, volatility research chart, regime window analyzer, simplified chart entrypoints
10. **Maintenance Safety**: Grid maintenance defers structural work during active fills and dust-cancel windows

---

## Architecture Evolution

DEXBot2's architecture transitioned from a monolithic utility-based approach to a strictly decoupled, event-driven, and immutable state system.

### Phase 1-2: The Foundation
Initially built as a set of loose modules for order and account management, focusing on establishing a reliable link to the BitShares blockchain and basic grid trading logic.

### Phase 3-4: COW & Market Adaptation
The introduction of the **Copy-on-Write (COW)** pattern revolutionized the bot's reliability by ensuring that grid modifications are atomic and thread-safe. This phase also saw the birth of the **Market Adapter**, which decoupled market signal intelligence (AMA, Volatility) from the execution logic.

### Phase 5: Intelligent Runtime
This phase achieved a multi-layered approach that defined the system's maturity:
- **Core Execution**: Established order lifecycles and blockchain synchronization using COW.
- **Signal Pipeline**: Introduced the Market Adapter for real-time weights and regime detection.
- **Credit/Debt Layer**: Added a specialized runtime for Margin Position Assets (MPA).
- **Credential Security**: Implemented a secure daemon for policy-gated signing.

---

## Feature Timeline

### Summary
- **2017**: StakeMachine — Proof-of-concept Python bot with buy/sell walls.
- **2018–2020**: DEXBot (Python v1.0.0) — Production bot with 3 strategies, PyQt5 GUI, multi-worker, external feeds.
- **December 2025**: DEXBot2 — JavaScript rewrite. Core grid lifecycle, fees, PM2, reconciliation.
- **January 2026**: AMA signals, precision fixes, recovery, and test migration.
- **February 2026**: Copy-on-Write, multi-node support, and architecture hardening.
- **March-May 2026**: Market adapter, dynamic weights, credit/debt runtime, and docs refresh.

---

## Version History

### Pre-DEXBot2
- **StakeMachine v0.0.6** (2017): Python proof-of-concept, buy/sell walls.
- **DEXBot v1.0.0** (2018–2020): Python production bot, PyQt5 GUI, 3 strategies, CCXT feeds.

### DEXBot2
- **v0.1.x-v0.5.x**: Foundation, fee handling, stability, and the COW groundwork.
- **v0.6.0**: Market adapter release with AMA grid centers and trigger wiring.
- **v0.7 Expansion**: Integration of advanced signals, dynamic weights, credit/debt runtime, and comprehensive documentation.

---

## Development Statistics

### Key Milestones
- **Project Initialization**: December 2, 2025
- **v0.1.0 Alpha**: December 10, 2025
- **v0.6.0 Market Adapter**: March 3, 2026
- **v0.7 Expansion**: May 2026

### Development Progress
The project has maintained a high velocity of commits throughout its first six months, with a strong emphasis on test-driven development and architectural robustness. The evolution from basic grid operations to a signal-intelligent trading system represents a significant shift in sophistication.

---

## Technical Challenges & Solutions

### Challenge 1: Race Conditions in Fill Processing
**Problem**: Concurrent fill processing causing double-counting and fund drift  
**Solution**: Implemented AsyncLock pattern with atomic operations  
**Impact**: Eliminated 12+ critical race conditions

### Challenge 2: Float Precision Errors
**Problem**: Float rounding causing order size mismatches  
**Solution**: Blockchain integer-based calculations (satoshi integers)  
**Impact**: Deterministic behavior matching chain storage semantics

### Challenge 3: Ghost Orders
**Problem**: Tiny remainders hanging in PARTIAL state  
**Solution**: Robust full-fill detection with integer-based rounding  
**Impact**: Prevented stuck orders and fund tracking drift

### Challenge 4: Grid Corruption During Divergence
**Problem**: Boundary shifts causing grid state corruption  
**Solution**: Copy-on-Write architecture with atomic boundary shifts  
**Impact**: Safe concurrent grid modifications without data loss

### Challenge 5: BTS Fee Accounting Drift
**Problem**: Inconsistent fee deduction causing fund tracking errors  
**Solution**: Unified fee deduction in calculateAvailableFunds  
**Impact**: Accurate fund accounting across all operations

### Challenge 6: Rapid-Restart Cascades
**Problem**: Bot restarts causing cascading failures  
**Solution**: Layer 1 & Layer 2 defenses with self-healing recovery  
**Impact**: Stable restart behavior with automatic recovery

---

## Documentation Evolution

### Initial Documentation (December 2025)
- README.md with basic usage
- Inline code comments
- Limited architecture documentation

### Documentation Maturity
By the v0.7 cycle, the project established a comprehensive documentation framework:
- **Core Guides**: Comprehensive README, architecture maps, and developer onboarding.
- **Specialized Docs**: Deep dives into COW invariants, fund accounting, and credential security.
- **Automated Metadata**: High JSDoc coverage (80%+) and structured changelogs.
- **AI-Ready Context**: Specialized `AGENTS.md` for AI assistant orchestration.

### Documentation Statistics
- **Total Documentation Commits**: 137 (11.4% of total)
- **README Updates**: 50+ commits
- **JSDoc Coverage**: 80%+ of exported functions
- **Architecture Docs**: 15+ pages

---

## Testing Strategy

### Test Evolution
1. **Initial**: Manual testing with real blockchain
2. **Jest Era**: Unit tests with Jest framework
3. **Native Tests**: Ported to Node.js assert for lightweight setup
### Advanced Verification Framework
The testing strategy matured into a multi-layered verification suite:
- **Unit & Integration**: Logic validation for accounting, sync, and grid operations.
- **Scenario Simulations**: Complex market behavior and resynchronization tests.
- **Edge Case Coverage**: Boundary handling, precision quantization, and partial fill logic.
- **Architectural Guards**: COW master plan invariants, concurrent fill isolation, and mutation detection.
- **Signal & Credit Gates**: Validation for dynamic weights, derivative traps, and credit runtime workflows.


---

## Conclusion

DEXBot2 has evolved from a basic trading bot to a sophisticated, production-ready system with a robust history of architectural refinement and a clear vision for the future.

---

## Phase 6: Technical Modernization & Growth (Planned)

### UX, Education & Services
- **Web & Terminal UI**: Browser-based and TUI dashboards for bot monitoring, manual intervention, and parameter tuning live.
- **Content Creation**: Instructional videos, tutorials, and onboarding material for user onboarding.
- **Marketing**: Strategic advertisement and outreach to expand the BitShares trading community.
- **Hosting Service**: Managed deployment for users who want bot operation without infrastructure management.

### Backtesting & Statistics
- **Simulation Engine**: Replay historical candles through the core `OrderManager`/COW engine via a `MemoryExchange` (drop-in at the `bitshares_client` boundary). Same strategy code, same grid, same fill processing — zero changes needed for backtest mode.
- **Performance Analytics**: PnL tracking, grid efficiency metrics, risk assessment, and HTML report generation.

### Modernization & Migration
- **TypeScript Migration**: Incremental migration from JS to TypeScript, starting with highest-bug-surface modules (COW, accounting, sync engine).
- **Dependency Reduction**: Continued minimization of external dependencies.

### Architecture & Code Quality — Detailed Breakdown

#### Tier 1 — High Impact

1. **Monorepo & Packages** — Split into `@dexbot/core`, `@dexbot/bitshares`, `@dexbot/strategies`, `@dexbot/indicators`. Enables incremental TypeScript migration and parallelized builds/testing.

2. **Event Bus** — Replace the tight `FillCallback → Manager → Accounting → SyncEngine → chain_orders` call chain with a typed event bus. Modules subscribe independently, testable with mocked events.

3. **Unified Indicator Library** — Centralize scattered signal code (AMA, Kalman, dynamic weight, regime detection) into `@dexbot/indicators`. Add standard indicators (SMA, MACD, RSI, BB) for non-grid strategies.

4. **Incremental TypeScript** — Migrate in package order: `core` (COW + accounting) → `indicators` → `bitshares` → `strategies`.

#### Tier 2 — Medium Impact

5. **Strategy Effects Pattern** — Strategies return declarative action objects (`{ action: 'CREATE_ORDER', price, amount }`) instead of calling `manager.js` directly. Strategy logic becomes a pure function — unit-testable without blockchain.

6. **Database (Prisma/SQLite) + Zod Validation** — Replace JSON file persistence with SQLite. Validate all blockchain objects at the `bitshares_client` boundary via Zod schemas.

7. **Vitest Migration** — Wrap 168 test files in Vitest for parallel execution, watch mode, and coverage reporting.

#### Tier 3 — Nice-to-Have

8. **Exchange Abstraction** — `IExchange` interface over `chain_orders.js` + `bitshares_client.js`.
9. **tRPC API** — Type-safe API layer for remote bot management and dashboard integration.
10. **Pino Logger** — Structured JSON logging with level filtering and composable transports.
11. **Commander.js CLI** — Better `dexbot.js` argument parsing with subcommands and auto-generated help.

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: May 16, 2026
**Total Commits**: 1307
**Date Range**: December 2, 2025 - May 16, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
