# Position Management

## Collateral Ratio Zones

See `claw/docs/POSITION_HEALTH.md` for the full 5-zone CR model, dual-layer action system, and trend alignment logic.

The skill-level summary:

| Zone | CR Range | Status |
|---|---|---|
| Red (high) | Above 3.0 | Over-collateralized |
| Orange (high) | 2.5 – 3.0 | Excess collateral |
| Green | 2.0 – 2.5 | Safe — operating target |
| Orange (low) | 1.7 – 2.0 | Temporarily acceptable |
| Red (low) | Below 1.7 | Not acceptable |

MCR for HONEST.Assets is 1.4. See `honest-assets.md` for full ecosystem properties.

Any position outside the green zone triggers two-layer adjustment (debt first, collateral second). See POSITION_HEALTH.md for full action tables.

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

The shared trend-detection service provides signals based on AMA deviation from the feed price and the instantaneous premium/discount. These signals indicate which direction the smoothed market is moving relative to the feed anchor.

Combining position direction with the trend signal:

| Trend Signal | Position Aligned | Position Opposed |
|---|---|---|
| UP | Long | Short |
| DOWN | Short | Long |
| NEUTRAL | Either (no directional edge) | Either |

Being on the right side means the position direction matches the detected trend. When no trend is confirmed, there is no directional edge — both sides are equivalent.

## Shared Trend Service

Trend detection, signal monitoring, and signal-driven bot-setting updates are owned by the shared trend-detection skill.

- Use `../trend-detection/SKILL.md` for the trend model, tuning workflow, and bot-setting update boundary.
- Keep this file focused on position health, CR discipline, and how margin positions consume the adaptive settings.

## Control Split

The bot should be treated as two layers:

- a fixed structural grid layer
- an adaptive trading layer on top of AMA

### Fixed Structural Settings

These should stay static unless you intentionally retune the bot for a different market regime:

- `incrementPercent`
- `targetSpreadPercent`
- `activeOrders`

These settings define the ladder geometry:

- `incrementPercent` sets slot spacing
- `targetSpreadPercent` sets the empty center buffer
- spread is coupled to increment in the engine, so changing it changes slot count, order sizes, and gap structure

Because of that, increment/spread are not good tactical knobs. They are setup choices.

### Adaptive Trading Settings

These are the practical knobs for building an advanced margin trader on top of the AMA price adapter:

- debt adjustment
- collateral adjustment
- `weightDistribution`
- `minPrice` / `maxPrice` ratio

These settings change behavior without redefining the whole ladder:

- CR is repaired through debt first, collateral second
- AMA remains the base anchor
- `weightDistribution` changes where size is concentrated within the existing ladder
- the min/max ratio changes the outer operating envelope slowly based on former price action

Practical range-ratio bands:

- below `2x` = very competitive
- around `2x` = competitive
- around `3x` = conservative
- above `3x` = very conservative

### Unified Plan

The planner in `claw/modules/position_health.ts` (`buildMarginTradingPlan(...)`) should therefore produce one unified plan with:

- position assessment
- target CR resolution
- debt/collateral action plan
- final `weightDistribution`
- final min/max price ratio recommendation
- a structural reset requirement when the CR plan changes debt or collateral

This keeps the bot architecture clean:

- AMA = anchor
- weights = deployment bias within the grid
- range ratio = slow structural width
- debt/collateral actions = margin-risk control
- CR execution is not the market-adapter's responsibility; the debt runtime applies the change and then rebuilds the grid from the new capital base

Example: weak short, strong DOWN trend

- repair the weak short by reducing debt first
- front-load buys and flatten sells

Example: sideways market

- `weightDistribution` stays balanced or double-mountain
- the bot keeps full deployment, centered by AMA, with no strong directional skew beyond the configured price bounds

Example unified plan output:

```js
{
  targetCr: 2.0,
  crPlan: {
    primaryAction: 'reduce_debt',
    fallbackAction: 'add_collateral',
    debtDelta: -18.4,
    collateralDelta: 920,
    needsGridReset: true
  },
  gridPlan: {
    finalPriceRangeRatio: 2.4,
    weightDistribution: {
      sell: 0.1,
      buy: 1.05
    }
  },
  botPatch: {
    minPrice: '2.4x',
    maxPrice: '2.4x',
    weightDistribution: {
      sell: 0.1,
      buy: 1.05
    }
  }
}
```

Interpretation:

- CR is below target, so debt reduction is the first action
- if a CR leg executes, the bot must rebuild the grid before reusing fund assumptions
- buys are front-loaded because they are the with-trend side
- sells are flattened because price is moving away from them
- the range ratio stays competitive rather than widening all the way to a conservative `3x`

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

1. **Discover** (`position_discovery.ts`) — scan account's on-chain call orders to find all open debt positions
2. **Trend** (`feed_price_source.ts` + `kalman_trend_analyzer.ts`) — fetch feed price and market mid-price per market, update the Kalman-based trend detector
3. **Assess** (`position_health.ts`) — classify each position into a CR zone, check trend alignment, generate prioritized actions
4. **Recommend** (`decision_loop.ts`) — sort actions by priority (immediate → soon → evaluate → fallback), return structured assessment

The loop evaluates and recommends. Execution of recommended actions is a separate concern.
