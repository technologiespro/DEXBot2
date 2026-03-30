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

## Weight Factors

Two independent weight systems operate at different levels. They solve different problems and must not be confused.

### Order Sizing Weight (`weightDistribution`)

The `weightDistribution` config (`{ sell: W, buy: W }`) controls how the bot's total fund budget is spread across individual grid slots. This is a geometric decay applied per-slot:

```
slotWeight[i] = (1 - incrementFactor) ^ (i * W)
slotSize[i]   = (slotWeight[i] / totalWeight) * totalFunds
```

| W value | Effect | When to use |
|---|---|---|
| 0 | Flat — all slots equal size | Thin markets, want uniform depth |
| 0.5 | Neutral baseline — gentle taper | Default for most pairs |
| 1.0 | Front-loaded — large near market, small at edges | Liquid markets, capture spread |
| > 1.0 | Extreme front-load | Aggressive scalping, tight spread |
| < 0 | Inverted — larger at edges | Fade moves, expect mean reversion |

This weight operates **within** the grid engine (`allocateFundsByWeights` in `order/utils/math.js`). It determines *how funds are distributed across slots* — not how much capital to deploy overall.

#### Dynamic Weight Computation

Static W values ignore market conditions. The dynamic weight system lives in `market_adapter/dynamic_weights.js` and should be used to compute candidate `weightDistribution` values outside the order engine:

1. **Current trend** (direction + confidence from TrendAnalyzer)
2. **Price position within observed range** (from PriceRatio)
3. **Oscillation ratio** (volatility context)

The computation is scenario-based rather than a single additive formula:

- **NEUTRAL** trend uses a double-mountain profile: both sides start near baseline and are pushed toward the front-loaded target, then a small position bias is applied.
- **UP/DOWN** trend uses a mountain/valley profile: the with-trend side is front-loaded, the against-trend side is flattened or inverted, then price-position bias and oscillation damping are applied.
- Oscillation does not add a separate delta; it dampens the distance from baseline after the trend and position adjustments are applied.
- Final `W` values are clamped to `[-0.5, 1.5]`.

**Trend direction** sets the primary shift:

| Trend | Confidence | With-trend side delta | Against-trend side delta |
|---|---|---|---|
| UP/DOWN | 80–100 (strong) | +0.5 (heavy front-load) | -0.4 (flatten/invert) |
| UP/DOWN | 60–79 (moderate) | +0.3 | -0.2 |
| UP/DOWN | 40–59 (weak) | +0.15 | -0.1 |
| UP/DOWN | < 40 (minimal) | +0.05 | -0.05 |
| NEUTRAL | any | 0 | 0 |

- **DOWN trend**: buy side is "with trend" (price falling toward buys), sell side is "against trend"
- **UP trend**: sell side is "with trend" (price rising toward sells), buy side is "against trend"

**Price position** adds directional bias. If price is at the top of the observed range (`position = 1.0`), sells are more likely to fill, so `sellW` increases and `buyW` decreases. At the bottom, the reverse happens. The bias is centered around `0.5` and scales to roughly ±0.3.

**Oscillation** dampens deviations from baseline. In volatile markets (oscillation ratio > 10), extreme front-loading is counterproductive — distant orders fill anyway. In tight markets (ratio < 1), concentration near market is rewarded.

Practical interpretation:

- lower volatility / tighter oscillation -> increase weights and keep more funds near the spread
- higher volatility / wider oscillation -> lower weights and keep more funds on the outside of the ladder
- very high volatility is where flatter or mildly inverted ladders make sense

| Oscillation Ratio | Dampening Factor |
|---|---|
| < 1 (very tight) | 1.2 (amplify) |
| 1–3 (tight) | 1.0 (no change) |
| 3–5 (normal) | 0.85 |
| 5–10 (choppy) | 0.7 |
| > 10 (very volatile) | 0.5 (halve deviations) |

**Bounds**: W is clamped to [-0.5, 1.5] to prevent degenerate allocations while keeping the range symmetric around the `0.5` baseline.

#### Per-Slot Fill Probability

For more granular control, `computeSlotFillProbabilities()` estimates the probability of each grid level being filled. This uses:

- **Distance decay**: `exp(-distance * 1.5)` where distance is measured as a fraction of the observed price range
- **Trend boost/dampening**: with-trend direction slots get up to +50% probability boost; against-trend slots get up to -30%
- **Range containment**: slots within the observed min/max price range get a 1.2x multiplier

This can be used to directly weight individual slot sizes rather than relying on geometric decay, when the grid engine supports per-slot sizing.

#### Claw Usage

The claw layer should treat the trend-analysis result as configuration input, not as core logic:

1. Read trend and price context from the trend-analysis layer.
2. Call `computeDynamicWeights()` to derive the desired `{ sell, buy }` weights.
3. Compute `gridPriceOffsetPct` separately from the same trend signal when AMA offsetting is enabled.
4. Persist those values back into `profiles/bots.json` with `claw/modules/dexbot_profiles.js` `updateBotSettings()`.
5. Let the normal bot lifecycle pick up the updated config, or trigger a recalc when the policy says to do so.

The bridge exposes this as `dynamic-weight-policy`, `dynamic-weight-preview`, and `dynamic-weight-apply`.

#### Policy Layer Variables

These are the knobs that control whether claw should apply a weight update:

| Variable | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master on/off switch for the workflow |
| `requireBtsQuote` | `true` | Only manage bots whose quote asset resolves to BTS |
| `requireTrendReady` | `true` | Wait until TrendAnalyzer has enough history |
| `requireConfirmedTrend` | `true` | Only update after trend confirmation |
| `allowNeutralUpdate` | `true` | Allow double-mountain updates when the trend is NEUTRAL |
| `minConfidence` | `60` | Skip weak signals below this confidence |
| `minWeightDelta` | `0.1` | Ignore tiny changes that would churn config |
| `cooldownMs` | `1800000` | Minimum time between weight updates per bot |
| `triggerOnApply` | `true` | Write `recalculate.<botKey>.trigger` after config update |
| `writeTriggerPayload` | `true` | Store a JSON trigger payload instead of an empty file |
| `triggerReason` | `dynamic_weight_update` | Label written into the trigger payload |
| `gridPriceOffsetEnabled` | `true` | Enable trend-biased grid-price offsets for AMA bots |
| `gridPriceOffsetRequireAmaGridPrice` | `true` | Only apply offsets to bots using AMA grid pricing |
| `gridPriceOffsetRequireConfirmedTrend` | `true` | Require confirmed trend before moving the grid center |
| `gridPriceOffsetMinConfidence` | `70` | Skip weak signals below this confidence for offset updates |
| `gridPriceOffsetMaxPct` | `0.5` | Cap the signed grid-price offset percentage |
| `gridPriceOffsetScale` | `1` | Scale the confidence-based offset magnitude |
| `gridPriceOffsetMinDeltaPct` | `0.1` | Ignore tiny offset changes that would churn config |
| `gridPriceOffsetCooldownMs` | `1800000` | Minimum time between grid-price offset updates per bot |
| `gridPriceOffsetAllowNeutralReset` | `true` | Allow NEUTRAL trend to reset the offset back to zero |

Policy should stay in claw or a claw-owned scheduler. It should not be pushed into `modules/order/`.

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
- `gridPriceOffsetPct`
- `weightDistribution`
- `minPrice` / `maxPrice` ratio

These settings change behavior without redefining the whole ladder:

- CR is repaired through debt first, collateral second
- AMA remains the base anchor
- `gridPriceOffsetPct` biases the center ahead of raw AMA when trend is confirmed
- `weightDistribution` changes where size is concentrated within the existing ladder
- the min/max ratio changes the outer operating envelope slowly based on former price action

Practical range-ratio bands:

- below `2x` = very competitive
- around `2x` = competitive
- around `3x` = conservative
- above `3x` = very conservative

### Unified Plan

The planner in `claw/modules/position_health.js` (`buildMarginTradingPlan(...)`) should therefore produce one unified plan with:

- position assessment
- target CR resolution
- debt/collateral action plan
- final `gridPriceOffsetPct`
- final `weightDistribution`
- final min/max price ratio recommendation

This keeps the bot architecture clean:

- AMA = anchor
- offset = short-term lead
- weights = deployment bias within the grid
- range ratio = slow structural width
- debt/collateral actions = margin-risk control

Example: weak short, strong DOWN trend

- repair the weak short by reducing debt first
- bias the grid center downward while the downtrend persists
- front-load buys and flatten sells

Example: sideways market

- `gridPriceOffsetPct` stays neutral or resets toward zero
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
    collateralDelta: 920
  },
  gridPlan: {
    finalGridPriceOffsetPct: -0.35,
    finalPriceRangeRatio: 2.4,
    weightDistribution: {
      sell: 0.1,
      buy: 1.05
    }
  },
  botPatch: {
    gridPriceOffsetPct: -0.35,
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
- the confirmed DOWN trend shifts the center lower with a negative offset
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

1. **Discover** (`position_discovery.js`) — scan account's on-chain call orders to find all open debt positions
2. **Trend** (`feed_price_source.js` + `trend_analyzer.js`) — fetch feed price and market mid-price per market, update the AMA-based trend detector
3. **Assess** (`position_health.js`) — classify each position into a CR zone, check trend alignment, generate prioritized actions
4. **Recommend** (`decision_loop.js`) — sort actions by priority (immediate → soon → evaluate → fallback), return structured assessment

The loop evaluates and recommends. Execution of recommended actions is a separate concern.
