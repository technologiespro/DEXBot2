# Position Management

## Collateral Ratio Zones

The collateral ratio (CR) determines position health. Five zones — too low risks liquidation, too high wastes capital:

| Zone | CR Range | Status |
|---|---|---|
| Red (high) | Above 3.0 | Over-collateralized — increase debt to deploy capital (layer 1) |
| Orange (high) | 2.5 – 3.0 | Excess collateral — consider increasing debt (layer 1) |
| Green | 2.0 – 2.5 | Safe — operating target |
| Orange (low) | 1.7 – 2.0 | Temporarily acceptable — reduce debt to restore CR (layer 1) |
| Red (low) | Below 1.7 | Not acceptable — reduce debt immediately (layer 1) |

MCR for HONEST.Assets is 1.4. The red (low) boundary at 1.7 maintains a ~21% buffer above protocol liquidation. The red (high) boundary at 3.0 flags capital sitting idle as excess collateral that could be deployed elsewhere.

Any position outside the green zone should be treated as a signal to act using two layers:

**Layer 1 (primary) — adjust debt:**
- CR too low → reduce debt (buy back MPA to repay)
- CR too high → increase debt (borrow more MPA to deploy)

**Layer 2 (fallback) — adjust collateral:**
- CR too low → add collateral (if debt reduction alone is insufficient)
- CR too high → withdraw collateral (if debt increase alone is insufficient)

Always exhaust layer 1 before resorting to layer 2.

## Capital Efficiency Principle

The goal is to maximize the BTS that is actively working — either as collateral backing a position or as funds on the order book generating volume — while keeping every open position in the green zone.

BTS sitting idle in a wallet earns nothing. BTS locked as excess collateral beyond what the green zone requires is also underutilized. The balance:

- Enough collateral to stay green (CR >= 2.0)
- Remaining BTS deployed as order book liquidity or available for new positions

## Maximizing Volume

Volume comes from orders being filled. More fills means more volume. What drives fills:

- **Orders on the book** — funds not on the book produce zero volume
- **Maker placement** — 0% maker fee on HONEST.Assets means resting orders cost nothing in market fees
- **Both sides** — having both buy and sell orders on the book means fills happen regardless of which direction the market moves
- **Position recycling** — proceeds from a filled order can be redeployed into a new order

Idle BTS or idle MPA holdings not placed as orders do not contribute to volume.

## Being on the Right Side

A position profits when the market moves in the direction the position is exposed to. The two directions:

- **Short** profits when the MPA price (in BTS) decreases — the MPA bought back cheaper than it was sold
- **Long** profits when the MPA price (in BTS) increases — the MPA sold higher than it was bought

The trend detection system (`analysis/trend_detection/`) provides signals based on AMA deviation from the feed price and the instantaneous premium/discount. These signals indicate which direction the smoothed market is moving relative to the feed anchor.

Combining position direction with the trend signal:

| Trend Signal | Position Aligned | Position Opposed |
|---|---|---|
| UP | Long | Short |
| DOWN | Short | Long |
| NEUTRAL | Either (no directional edge) | Either |

Being on the right side means the position direction matches the detected trend. When no trend is confirmed, there is no directional edge — both sides are equivalent.

## Loss Minimization

Losses come from:

1. **Adverse price movement** — position is on the wrong side
2. **Margin call** — CR drops below MCR, protocol force-covers at unfavorable price
3. **Excess fees** — taker fills when maker placement was possible
4. **Idle capital** — opportunity cost of funds not deployed

Controls:

- **CR zones** enforce collateral discipline — green zone positions have a buffer that absorbs adverse moves without reaching liquidation
- **Maker-first placement** eliminates the largest recurring fee (0% vs 0.1%/0.2%)
- **Trend alignment** reduces the probability of being on the wrong side
- **Position sizing** relative to available capital — no single position should consume all available BTS as collateral

## Profit Maximization

Profits come from:

1. **Spread capture** — buying at bid, selling at ask
2. **Directional gain** — position on the right side of a trend
3. **Fee asymmetry** — earning the spread while paying 0% maker fee
4. **Capital velocity** — the faster proceeds are redeployed, the more cycles of profit per unit of time

The lever is utilization: BTS that is working — on the book or backing a position — has the opportunity to earn. BTS that is idle does not. Maximizing available funds on the book and maintaining position alignment maximizes the rate at which profit accumulates.

## Fund Flow

```
Total BTS
├── Collateral (locked in debt positions)
│   └── Target: CR in green zone (2.0 – 2.5)
├── On book (resting limit orders)
│   └── Target: as much as possible
├── Pending (proceeds from fills, not yet redeployed)
│   └── Target: minimize time in this state
└── Reserve (fee budget for operations)
    └── ~0.1 BTS per order operation
```

MPA holdings follow the same logic — MPA sitting in wallet balance is idle. MPA placed as a sell order or used to repay debt is working.

## Decision Loop

The evaluation pipeline runs as a cycle:

```
discover → trend → assess → recommend
```

1. **Discover** (`position_discovery.js`) — scan account's on-chain call orders to find all open debt positions
2. **Trend** (`feed_price_source.js` + `trend_analyzer.js`) — fetch feed price and market mid-price per market, update the AMA-based trend detector
3. **Assess** (`position_health.js`) — classify each position into a CR zone, check trend alignment, generate prioritized actions
4. **Recommend** (`decision_loop.js`) — sort actions by priority (immediate → soon → evaluate → fallback), return structured assessment

The loop evaluates and recommends. Execution of recommended actions is a separate concern.
