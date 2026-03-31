# Position Health And Decision Loop

This document covers the position health subsystem: on-chain position discovery, collateral ratio assessment, trend alignment, and the decision loop that ties them together.

## Overview

The subsystem has three layers:

1. **Discovery** (`modules/position_discovery.js`) — scans an account's on-chain call orders and normalizes them into position objects.
2. **Health assessment** (`modules/position_health.js`) — classifies each position into a collateral ratio zone, checks trend alignment, and recommends actions.
3. **Decision loop** (`modules/decision_loop.js`) — orchestrates discovery, trend analysis, and health assessment into a single evaluation cycle.

The subsystem evaluates and recommends. It does not execute trades.

## Position Discovery

`discoverPositions(accountName)` scans the account's call orders on-chain and returns normalized position objects. It does not depend on PositionManager state files — it sees what actually exists on-chain.

Each discovered position includes:

- call order ID, borrower, market pair
- debt amount and collateral amount (float-converted)
- BTS-per-MPA derived from the settlement feed
- computed collateral ratio
- feed publication time

`discoverPositionsSummary(accountName)` returns a compact summary with rounded values for quick inspection.

## 5-Zone CR Model

The health assessor classifies collateral ratios into five zones based on HONEST asset MCR (1.4):

| Zone | CR range | Status | Meaning |
|---|---|---|---|
| `red_low` | below 1.7 | `not_acceptable` | Near liquidation, immediate action needed |
| `orange_low` | 1.7 – 2.0 | `temporary` | Uncomfortable but survivable, act soon |
| `green` | 2.0 – 2.5 | `safe` | Healthy operating range |
| `orange_high` | 2.5 – 3.0 | `excess_collateral` | Capital sitting idle, consider deploying |
| `red_high` | above 3.0 | `over_collateralized` | Significant capital inefficiency |

## Dual-Layer Actions

When a position needs adjustment, the assessor recommends actions in two layers:

- **Layer 1 (primary)**: adjust debt first — reduce debt when CR is low, increase debt when CR is high.
- **Layer 2 (fallback)**: adjust collateral if debt changes are insufficient — add collateral when CR is low, withdraw collateral when CR is high.

This mirrors the actual strategy levers: debt adjustments are the primary tool, collateral adjustments are the backup.

Action priorities:

| Zone | Priority | Layer 1 | Layer 2 |
|---|---|---|---|
| `red_low` | `immediate` | `reduce_debt` | `add_collateral` |
| `orange_low` | `soon` | `reduce_debt` | `add_collateral` |
| `green` | — | no action | no action |
| `orange_high` | `soon` | `increase_debt` | `withdraw_collateral` |
| `red_high` | `immediate` | `increase_debt` | `withdraw_collateral` |

## Trend Alignment

When a trend signal is available, the assessor checks whether the position direction is aligned with the trend:

- A short position aligned with a `DOWN` trend is `aligned`.
- A short position opposed to an `UP` trend with confidence >= 50% triggers a `review_direction` action.
- Neutral trends produce no directional action.

## CR Adjustment Planning

The `planCrAdjustment()` function computes concrete deltas:

- `debtDeltaForTargetCr()` — how much debt to add or remove to reach target CR.
- `collateralDeltaForTargetCr()` — how much collateral to add or remove to reach target CR.
- The plan picks a primary action (debt first) and a fallback action (collateral second).

## Margin Trading Plan

`buildMarginTradingPlan()` combines all signals into a unified plan:

- CR adjustment intent (debt first, collateral second)
- grid price offset percentage derived from trend direction and confidence
- weight distribution derived from trend analysis
- price range ratio recommendation based on historical price action
- a concrete `botPatch` object ready to apply to the bot config

## Decision Loop

`evaluate(accountName, options)` runs one full cycle:

1. Discover all on-chain positions for the account.
2. Fetch trend input per market (feed price + market price).
3. Update a per-market trend analyzer (KAMA-based, state persists across calls).
4. Assess each position's health with the trend signal.
5. Sort assessments by action priority (immediate first).
6. Return assessments with a summary of zone distribution and action counts.

The summary includes:

- zone counts (`red_low`, `orange_low`, `green`, `orange_high`, `red_high`)
- immediate and soon action counts
- `allGreen` flag for quick health checks

## Position Manager Watch

`modules/position_manager_watch.js` is a PM2-compatible watcher process that keeps `PositionManager` state synchronized and reacts to fills. It does not invoke `decision_loop.evaluate()` itself.

```bash
npm run service:position-watch -- --account your-account
```

## Related Modules

- `modules/feed_price_source.js` — fetches on-chain settlement feed prices and order book mid-prices for trend input.
- `modules/kibana_price_source.js` — alternative price source using Kibana for historical candle data (order book fills and LP pool swaps).
- `modules/position_manager.js` — persistent short-position tracking (create, update, close, export). Separate from on-chain discovery.

## Source Of Truth

The executable behavior lives in the modules. This document should be kept aligned with:

- `modules/position_health.js`
- `modules/position_discovery.js`
- `modules/decision_loop.js`
- `modules/feed_price_source.js`
- `modules/position_manager_watch.js`
- `modules/tests/test_position_health.js`
