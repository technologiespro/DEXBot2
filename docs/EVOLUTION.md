# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 0.7 development cycle.

### Key Metrics
- **Total Commits**: 1205
- **Development Period**: December 2, 2025 - May 1, 2026 (ongoing)
- **Active Months**: 6 (Dec 2025, Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026)
- **Primary Developer**: froooze - 99.2% of commits
- **Lines of Code**: ~25,000+ (core modules)
- **Test Coverage**: 160 test files covering unit, integration, scenario, and regression tests
- **Tagged Releases**: 15 tagged releases (v0.1.0 to v0.6.0)
- **Current Internal Version**: v0.7

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
**Duration**: December 2 - December 31, 2025  
**Commits**: 408 (33.8% of total)
**Focus**: Establishing core trading infrastructure, order management, and fund accounting

#### Key Milestones
- **Dec 2**: Project initialization with squashed history from predecessor
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
**Duration**: March 4 - May 1, 2026 (ongoing)
**Commits**: 170 (14.1% of total)
**Focus**: Market adapter offset groundwork, Claw/credential hardening, SMA derivative signals, dynamic-weight/Kalman research, regime filtering, credit/debt runtime

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
- **Apr 23**: Credit-offer and CR safety hardening — LP credit-offer CR ceiling, safe borrow sizing, shared adapter whitelist
- **Apr 24**: Market adapter patch hardening, maintenance deferral during active fills, chart entrypoint simplification, Claw validation/tests, v0.7 metadata
- **May 1**: Market adapter README restructure and docs cross-link refresh for the dynamic-weight research path

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

### Initial Architecture (December 2025)
```
dexbot.js (entry)
    ├── modules/bot_instance.js
    ├── modules/manager.js
    ├── modules/account_orders.js
    ├── modules/account_bots.js
    ├── modules/order_grid.js
    └── modules/utils.js
```

### Current Architecture (May 2026)
```
dexbot.js (entry)
    ├── modules/dexbot_class.js (core bot class - 3,155 lines)
    ├── modules/dexbot_fill_runtime.js (fill processing - 142 lines)
    ├── modules/dexbot_maintenance_runtime.js (maintenance loops - 1,001 lines)
    ├── modules/constants.js (centralized configuration - 1,022 lines)
    ├── modules/chain_orders.js (blockchain operations - 1,104 lines)
    ├── modules/chain_keys.js (authentication - 1,047 lines)
    ├── modules/account_orders.js (order queries - 682 lines)
    ├── modules/account_bots.js (bot management - 1,223 lines)
    ├── modules/node_manager.js (multi-node failover - 455 lines)
    ├── modules/bitshares_client.js (blockchain client - 162 lines)
    ├── market_adapter/
    │   ├── market_adapter.js (AMA calculation & triggers)
    │   ├── core/market_adapter_service.js (full signal pipeline)
    │   ├── core/strategies/ama_slope_model.js (slope-based weights)
    │   ├── core/strategies/collateral_manager.js (CR advisory)
    │   ├── core/strategies/atr/calculator.js (ATR volatility)
    │   ├── inputs/kibana_source.js (Kibana price data)
    │   ├── inputs/fetch_lp_data.js (LP analysis exporter)
    │   ├── interval_utils.js (shared interval labels)
    │   ├── candle_utils.js (candle transforms)
    │   └── lp_chart_runner.js (LP chart orchestration)
    ├── claw/
    │   ├── modules/credit_runtime.js (debt workflow executor)
    │   ├── modules/short_mpa_strategy.js (MPA short strategy)
    │   └── ... (bridge modules for OpenClaw, Hermes, ZeroClaw, etc.)
    └── modules/order/
        ├── manager.js (order lifecycle - 1,496 lines)
        ├── grid.js (grid calculation - 1,833 lines)
        ├── strategy.js (trading strategies - 435 lines)
        ├── accounting.js (fund accounting - 1,018 lines)
        ├── sync_engine.js (blockchain sync - 1,122 lines)
        ├── startup_reconcile.js (startup reconciliation - 1,317 lines)
        ├── working_grid.js (COW wrapper - 238 lines)
        ├── processed_fill_store.js (fill dedupe persistence - 161 lines)
        ├── logger.js (logging system - 512 lines)
        ├── format.js (formatting utilities - 319 lines)
        ├── export.js (data export - 327 lines)
        ├── runner.js (order execution - 141 lines)
        ├── async_lock.js (concurrency control - 200 lines)
        └── utils/
            ├── math.js (precision, RMS, fund math - 1,034 lines)
            ├── order.js (order predicates, helpers - 1,133 lines)
            ├── system.js (price derivation, fill dedup - 1,045 lines)
            └── validate.js (COW action building - 1,022 lines)
```

### Key Architectural Improvements

1. **Module Decomposition**: Extracted order subsystem into dedicated module
2. **Constants Centralization**: All configuration in modules/constants.js
3. **Separation of Concerns**: Clear boundaries between chain, account, and order management
4. **Concurrency Control**: AsyncLock pattern for thread-safe operations
5. **COW Architecture**: Copy-on-Write pattern for safe grid modifications
6. **State Management**: Explicit state transitions with validation

---

## Feature Timeline

### Summary
- **December 2025**: Core grid lifecycle, fees, PM2, and reconciliation.
- **January 2026**: AMA signals, precision fixes, recovery, and test migration.
- **February 2026**: Copy-on-Write, multi-node support, and architecture hardening.
- **March-May 2026**: Market adapter, dynamic weights, credit/debt runtime, and docs refresh.

---

## Version History

- **v0.1.x-v0.5.x**: Foundation, fee handling, stability, and the COW groundwork.
- **v0.6.0**: Market adapter release with AMA grid centers and trigger wiring.
- **v0.7**: Current internal work on signals, dynamic weights, credit/debt, and docs/tooling.

---

## Development Statistics

### Monthly Activity

| Month | Commits |
|-------|---------|
| December 2025 | 401 |
| January 2026 | 421 |
| February 2026 | 164 |
| March 2026 | 57 |
| April 2026 | 158 |

### Code Metrics

#### Largest Files (by line count)
1. **modules/dexbot_class.js**: 3,155 lines
2. **modules/order/grid.js**: 1,833 lines
3. **modules/order/manager.js**: 1,496 lines

#### Test Coverage
- **Total Test Files**: 160
- **Test Categories**:
  - Unit tests (logic ported from Jest)
  - Integration tests (fill processing, grid, manager)
  - Scenario tests (market scenarios, resync)
  - Edge case tests (boundary, precision, partial fills)
  - COW tests (master plan, commit guards, concurrent fills, divergence correction)
  - Signal tests (dynamic weight, derivative trap, momentum gate)
  - Credit/debt tests (CR planner, credit runtime, MPA wiring)
  - Credential tests (daemon, session cache, policy)

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

### Current Documentation (May 2026, v0.7)
- **[README.md](../README.md)**: Comprehensive user guide with icons and sections
- **[architecture.md](architecture.md)**: System architecture and module relationships
- **[developer_guide.md](developer_guide.md)**: Developer quick start and glossary
- **[WORKFLOW.md](WORKFLOW.md)**: Branch workflow and development process
- **[EVOLUTION.md](EVOLUTION.md)**: Project timeline, architecture phases, and release history
- **[FUND_MOVEMENT_AND_ACCOUNTING.md](FUND_MOVEMENT_AND_ACCOUNTING.md)**: Fund accounting mechanics
- **[CHANGELOG.md](../CHANGELOG.md)**: Detailed version history
- **[AGENTS.md](../AGENTS.md)**: AI assistant guidelines
- **[COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md)**: COW architecture documentation
- **Inline JSDoc**: Comprehensive function documentation

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
4. **Current**: Comprehensive suite with unit, integration, and scenario tests

### Test Categories

#### Unit Tests
- `test_accounting_logic.js`: Fee accounting logic
- `test_strategy_logic.js`: Trading strategy logic
- `test_sync_logic.js`: Blockchain synchronization
- `test_grid_logic.js`: Grid calculation logic
- `test_manager_logic.js`: Order manager logic
- `test_bts_fee_logic.js`: BTS fee settlement

#### Integration Tests
- `test_fills_integration.js`: Fill processing
- `test_grid_integration.js`: Grid operations
- `test_manager_integration.js`: Manager operations
- `test_engine_integration.js`: Engine integration

#### Scenario Tests
- `test_market_scenarios.js`: Market scenario simulations
- `test_resync_*.js`: Resynchronization scenarios
- `test_ghost_order_fix.js`: Ghost order prevention

#### Edge Case Tests
- `test_boundary_*.js`: Boundary handling
- `test_precision_*.js`: Precision edge cases
- `test_partial_*.js`: Partial fill handling

---

## Deployment & Operations

### Process Management
- **PM2 Integration**: Production process manager
- **Multi-Bot Support**: Multiple bots per account
- **Auto-Restart**: Automatic recovery on failures
- **Log Management**: Structured logging with rotation

### Configuration Management
- **bots.json**: Bot configurations
- **constants.js**: Centralized tuning parameters
- **keys.json**: Encrypted private keys
- **Dynamic Refresh**: Periodic configuration reload (4h interval)

### Update Mechanism
- **Automated Updates**: Cross-platform weekly updater
- **Safe Updates**: Preserve user settings during updates
- **Branch Promotion**: test → dev → main pipeline
- **Rollback Support**: Backup branches for recovery

### Monitoring
- **Dashboard**: Ratatui-based operations dashboard
- **Health Checks**: Multi-node health checking
- **Diagnostics**: Enhanced diagnostics and logging
- **Analysis Tools**: Order analysis script for metrics

---

## Lessons Learned

### Technical Lessons
1. **Concurrency is Hard**: Race conditions require careful design (AsyncLock pattern)
2. **Precision Matters**: Blockchain integers prevent float errors
3. **State Management**: Explicit state transitions prevent bugs
4. **Testing**: Comprehensive test suite catches edge cases
5. **Documentation**: Good docs accelerate development

### Process Lessons
1. **Incremental Development**: Small, focused commits > large changes
2. **Testing Early**: Catch bugs before they compound
3. **Documentation**: Document as you code, not after
4. **Code Review**: Regular refactoring prevents technical debt
5. **User Feedback**: Real-world usage reveals edge cases

### Architecture Lessons
1. **Modularity**: Clear module boundaries improve maintainability
2. **Separation of Concerns**: Each module should have one responsibility
3. **Immutability**: COW pattern prevents corruption
4. **Fail-Fast**: Early validation prevents cascading failures
5. **Observability**: Good logging saves debugging time

---

## Acknowledgments

### Primary Developer
- **froooze**: 1,157 commits (99.2%)

### Contributors
- **froooze** (via GitHub): 9 commits (0.8%)

### Tools & Technologies
- **BitShares Blockchain**: Decentralized exchange platform
- **Node.js**: Runtime environment
- **PM2**: Process manager
- **Git**: Version control
- **Jest** (historical): Testing framework (now migrated)

---

## Conclusion

DEXBot2 has evolved from a basic trading bot to a sophisticated, production-ready system with:

- **Robust Architecture**: Modular, maintainable, and scalable (~25,000+ lines across 80+ runtime modules)
- **Comprehensive Testing**: 160 test files covering all critical paths
- **Production Hardening**: Battle-tested with real funds on mainnet
- **Advanced Features**: COW architecture, self-healing, multi-node support, AMA market adaptation, dynamic weight regime detection, derivative signals, credit/debt runtime
- **Excellent Documentation**: Comprehensive guides for users and developers
- **Active Development**: 1205 commits over 6 months

The project demonstrates strong engineering practices, continuous improvement, and a commitment to quality. The Copy-on-Write architecture, dynamic weight signal pipeline, and native credit/debt runtime represent the current production-grade foundation.

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: May 1, 2026
**Total Commits**: 1205
**Date Range**: December 2, 2025 - May 1, 2026 (ongoing)
**Repository**: DEXBot2 (BitShares DEX Trading Bot)
