# DEXBot2 Test Suite

This directory contains the test suite for DEXBot2, covering logic tests, integration tests, strategy verification, and infrastructure checks.

## Overview

The test suite validates:
- **Core Infrastructure**: Blockchain connectivity, state management, subscriptions
- **Fund Accounting**: Balance calculations, fee deduction, fund invariant checks
- **Grid Management**: Order generation, sizing, divergence detection, reconciliation
- **Copy-on-Write Rebalancing**: Safe concurrent rebalancing with isolated working grids (see [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md))
- **Fill Processing**: Adaptive batching, partial fills, consolidation, rotation order sizing
- **Market Scenarios**: Realistic trading conditions, edge cases, recovery mechanisms

## Running Tests

Tests run directly with Node.js using native `assert`:

```bash
# Run all tests
npm test

# Run specific test file
node --import tsx tests/test_strategy_logic.ts
```

**Module References:** For understanding the code being tested, see [root README 📦 Modules section](../README.md#-modules)

### 1. Core Infrastructure & Connection
Tests ensuring the bot can connect to the blockchain and manage local state.

*   `connection_test.ts` - Interactive test to verify connectivity to BitShares nodes.
*   `test_indexdb.ts` - Verifies IndexedDB functionality for local data storage.
*   `test_subscriptions.ts` - Tests market subscription handling and data updates.
*   `test_logger.ts` - Verifies the logging system.

### 2. Account & Authentication
Tests for account handling, key validation, and balance calculations.

*   `test_key_validation.ts` - Unit tests for private/public key format validation.
*   `test_privatekey_sanitize.ts` - Checks sanitization logic for pasted private keys.
*   `test_account_selection.ts` - Interactive tool to test account selection logic.
*   `test_account_totals.ts` - Verifies account balance calculation and asset totals.

### 3. Market Data & Pricing
Tests for fetching prices, order books, and deriving trading prices.

*   `test_market_price.ts` - Comprehensive test of market price fetching (Pool vs Orderbook).
*   `test_price_derive.ts` - Tests logic for deriving prices from market data.
*   `test_price_orientation.ts` - Verifies price orientation (buy/sell side) logic.
*   `test_price_no_positional.ts` - Tests price handling when no positional data is available.
*   `test_price_tolerance.ts` - Checks price tolerance boundaries.
*   `test_debug_orderbook.ts` - Diagnostic tool for inspecting the order book.
*   `test_any_pair.ts` - Discovers and tests active trading pairs.
*   `test_autoderive.ts` - Tests automatic derivation of strategy parameters.

### 4. Order Management & Execution
Tests for order lifecycle: placement, open order tracking, and fill processing.

*   `test_open_orders.ts` - Tests retrieval and management of open orders.
*   `test_fills.ts` - interactive test for processing order fills.
*   `test_fill_queue_logic.ts` - Verifies the logic for the fill processing queue.
*   `test_trade_history.ts` - Tests retrieval of account trade history.
*   `test_blockchain_fill_history.ts` - Verifies fill history against blockchain data.

### 5. Strategy & Grid Logic
Tests for the core trading strategies, specifically the grid logic.

*   `test_order_grid.ts` - Core grid order generation and logic.
*   `test_grid_comparison.ts` - Compares different grid strategy configurations.
*   `test_grid_funding_manual.ts` - Tests manual funding scenarios for grids.
*   `test_rebalance_orders.ts` - Tests logic for rebalancing orders within a grid.
*   `test_rotation_order_sizing.ts` - Verifies order sizing logic for rotation strategies.
*   `test_rotation_available_funds.ts` - Tests available-funds budget in rotation strategies.
*   `test_conditional_rotation.ts` - Tests conditional rotation logic.
*   `test_crossed_rotation.ts` - Tests scenarios where rotation orders might cross.
*   `test_strategy_edge_cases.ts` - Tests various edge cases in strategy execution.
*   `test_templates_ordering.ts` - Verifies correct ordering of order templates.

### 6. Fees & Accounting
Tests for fee calculations, fund management, and asset precision.

*   `test_funds.ts` - specific tests for fund management logic.
*   `test_fee_cache.ts` - Tests the fee caching mechanism.
*   `test_fee_cache_twentix.ts` - Fee caching tests specific to complex assets (e.g. Twentix).
*   `test_fee_refinement.ts` - Tests refinement of fee calculations.
*   `test_market_fee_deduction.ts` - Verifies deduction of market fees from orders.
*   `test_fix_proceeds_fee_deduction.ts` - Verification for proceeds fee deduction logic.

### 7. Integration & Workflows
Complex tests that simulate larger workflows or system integration.

*   `test_engine_integration.ts` - Integration tests for the core engine.
*   `test_market_scenarios.ts` - Realistic market simulation (Pumps, Dumps, V-Shape recovery).
*   `test_anchor_refill_integration.ts` - Integration tests for the anchor refill mechanism.
*   `test_anchor_refill_endtoend.ts` - End-to-end tests for anchor refill.
*   `test_anchor_refill_strategy.ts` - Strategy logic tests for anchor refill.
*   `test_integration_partial_complex.ts` - Tests complex partial fill integration.
*   `test_integration_pending_proceeds.ts` - Integration tests for pending proceeds handling.
*   `test_startup_reconcile.ts` - Tests the reconciliation process at bot startup.
*   `test_startup_decision.ts` - Verifies startup decision-making logic.
*   `test_startup_partial_fill.ts` - Tests handling of partial fills detected at startup.

### 8. Edge Cases & Bug Fixes
Tests created to reproduce or verify fixes for specific bugs and edge cases.

*   `test_critical_bug_fixes.ts` - Regression tests for critical historical bugs.
*   `test_partial_order_edge_cases.ts` - Edge cases for partial orders.
*   `test_multi_partial_edge_cases.ts` - Edge cases for multiple partial fills.
*   `test_multi_partial_consolidation.ts` - Tests consolidation of multiple partial fills.
*   `test_twentix_only.ts` - specific asset lookup test (Twentix).

### 9. Utilities & Helpers
Tests for shared utility functions and helper modules.

*   `test_utils.ts` - General utility function tests.
*   `test_chain_helpers.ts` - Tests for blockchain interaction helpers.
*   `test_precision_integration.ts` - Integration tests for precision handling.
*   `test_precision_quantization.ts` - Tests logic for quantizing values to asset precision.
*   `test_fund_cycling_trigger.ts` - Tests triggers for fund cycling.
*   `test_manager.ts` - Tests for the OrderManager module.

---

## 🏗️ Key Architectural Patterns Tested

### Copy-on-Write (COW) Rebalancing
Tests verify that:
- Master grid remains immutable during rebalancing
- Working grids are isolated copies for planning
- Fills arriving during rebalance are properly synchronized
- Delta building correctly identifies changes between grids
- Atomic commits apply changes only on success

**Reference:** [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md)

### RMS Divergence Checking
Tests validate:
- Quadratic penalty for large errors (not just average error)
- Concentrated errors require higher RMS thresholds
- Grid recalculation triggers at correct divergence levels
- Threshold interpretation matches README documentation

**Reference:** [docs](../docs/README.md) - GRID RECALCULATION section

### Fund Invariants
Tests ensure:
- Available funds never exceed free blockchain balance
- Committed funds correctly tracked across states
- Fee deductions and refunds maintain consistency
- No double-spending between orders

**Reference:** [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)

---

## 📚 Documentation References

- **Module Architecture**: [root README 📦 Modules](../README.md#-modules)
- **Copy-on-Write Pattern**: [COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md)
- **Fund Accounting**: [FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Logging System**: [LOGGING.md](../docs/LOGGING.md)
- **Developer Guide**: [developer_guide.md](../docs/developer_guide.md)

---

**Note:** Interactive tests (like `connection_test.ts`) may require network access and user input.
