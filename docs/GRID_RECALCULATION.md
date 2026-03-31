# Grid Recalculation Mechanisms

DEXBot2 uses **four independent grid recalculation triggers** to keep the trading grid synchronized with market conditions and bot funds.

---

## Overview: Four Recalculation Mechanisms

| Mechanism | Trigger | Config | Location | Scope |
|-----------|---------|--------|----------|-------|
| **AMA Delta** | Market price moved significantly | `AMA_DELTA_THRESHOLD_PERCENT` | `general.settings.json` | Global (all bots) |
| **Grid Price Offset** | Offset changes the resolved grid reference | `gridPriceOffsetPct` | `bots.json` | Per-bot |
| **RMS Divergence** | Grid state diverged from blockchain | `RMS_PERCENTAGE` | `general.settings.json` | Global (all bots) |
| **Regeneration** | Available funds exceed threshold | `GRID_REGENERATION_PERCENTAGE` | `constants.js` | Per-side (BUY/SELL) |

Each mechanism is **independent and can be configured separately**. They don't interfere with each other.

---

## 1. Grid Price Offset (Resolved Grid Price)

### What It Does
Applies a signed percentage offset to the resolved `gridPrice` reference, producing an **effective center** for grid bound calculations without altering the raw reference price.

**Why it matters:** Lets you shift the grid center relative to the active reference price without changing the underlying reference source.

### Configuration

**File:** `profiles/bots.json` (per bot)
```json
{
  "gridPrice": "market",
  "gridPriceOffsetPct": 1.5
}
```

**Parameters:**
- `gridPrice`: Can be `pool`, `market`, `ama`/`ama1`..`ama4`, a positive number, or `null`
- `gridPriceOffsetPct`: Signed percentage offset (`-10` to `+10`). Formula: `effectiveCenter = resolvedGridPrice × (1 + offset/100)`. Set to `0` to disable the offset

### How It Works

1. `initializeGrid()` resolves the current `gridPrice` reference using the configured mode
2. For non-AMA references (`pool`, `market`, numeric, or `null -> startPrice`) it applies `gridPriceOffsetPct` directly before deriving min/max bounds
3. For AMA references, `price_adapter` persists the effective AMA center so `initializeGrid()` can consume it without double-applying the offset
4. Recalculation for non-AMA offsets is handled independently by whichever workflow updates the bot and writes `recalculate.<botKey>.trigger` (for example dynamic-weight updates)

### Debugging

**Offset Trigger:**
```
[price_adapter] Offset change detected for <botKey>: 0% → 1.5%
```

---

## 2. AMA Delta Threshold (Market Adapter)

### What It Does
Monitors the Adaptive Moving Average (AMA) of market prices. When the AMA center price deviates from the last recorded center by more than the threshold, a grid recalculation is triggered.

**Why it matters:** Big market moves require repositioning the grid to stay centered around the new market price.

### Configuration

**File:** `profiles/general.settings.json`
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 1
  }
}
```

**Parameters:**
- `AMA_DELTA_THRESHOLD_PERCENT`: Percentage change in AMA center that triggers grid reset
  - Default: `1%`
  - Range: `0.1` to `50.0` (configurable via CLI and bot editor)
  - Example: If set to `1`, grid recalculates when AMA center moves ±1% from last center

### CLI Override
```bash
node market_adapter/price_adapter.js --deltaPercent 2
```

### Bot Configuration (Complementary)

**File:** `profiles/bots.json` (per bot)
```json
{
  "ama": {
    "enabled": true,
    "erPeriod": 10,      // Efficiency Ratio lookback period (candles)
    "fastPeriod": 2,     // Fast smoothing period for trending markets
    "slowPeriod": 30     // Slow smoothing period for choppy markets
  }
}
```

**AMA Parameters:**
- `enabled`: Whether to track AMA and trigger grid resets (true/false)
- `erPeriod`: How many candles to look back for trend detection
  - Higher values: More stable, slower response (ER=107 very stable)
  - Lower values: More responsive, catches quick moves (ER=15 very responsive)
  - Default: `10` (balanced)
- `fastPeriod`: Smoothing constant for trending markets
  - Lower = faster response
  - Default: `2` (most responsive)
- `slowPeriod`: Smoothing constant for choppy/sideways markets
  - Higher = more lag, filters noise
  - Default: `30` (conservative)

### How It Works

1. **Market Adapter** (`market_adapter/price_adapter.js`) runs continuously
2. Loads per-bot AMA configuration (or uses defaults)
3. Calculates AMA from 1h candlestick closing prices
4. Tracks the **AMA center price** for each bot
5. When `|currentAMA - lastRecordedAMA| >= AMA_DELTA_THRESHOLD_PERCENT`:
   - Creates `market_adapter/state/recalculate.<botKey>.trigger` file
   - DEXBot's main loop detects the trigger and calls `Grid.recalculateGrid()`
6. Last recorded center is updated after recalculation

### When to Adjust

**Increase threshold (e.g., 1% → 2%) if:**
- Grid recalculates too frequently (excessive churn)
- Market is choppy/sideways
- You want fewer but larger recalculations

**Decrease threshold (e.g., 1% → 0.5%) if:**
- Grid reacts too slowly to market moves
- Market is trending strongly
- You want grid to follow price more closely

---

## 3. RMS Divergence Check (Grid Engine)

### What It Does
Compares the **calculated grid** (in-memory state) with the **persisted grid** (blockchain state). When divergence exceeds a threshold, the grid is regenerated to re-sync with reality.

**Why it matters:** Order fills, rotations, and fee deductions cause the persisted grid to drift from the calculated state. RMS divergence detects and corrects this drift.

### Configuration

**File:** `profiles/general.settings.json`
```json
{
  "GRID_LIMITS": {
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 14.3
    }
  }
}
```

**Parameters:**
- `RMS_PERCENTAGE`: Root Mean Square divergence threshold
  - Default: `14.3%` (balanced)
  - Range: `0` to `100+`
  - Set to `0` to **completely disable RMS checks**

### Threshold Reference Table

| RMS % | Avg Error | Description |
|-------|-----------|-------------|
| 0 | N/A | Disabled (no checks) |
| 4.5% | ~1.0% | Very strict (frequent regens) |
| 9.8% | ~2.2% | Strict |
| **14.3%** | **~3.2%** | **Default (balanced)** |
| 20.1% | ~4.5% | Lenient |
| 31.7% | ~7.1% | Very lenient |
| 44.7% | ~10% | Extremely lenient |

### How It Works

1. **Grid Engine** (`modules/order/grid.js`) calculates the ideal grid state
2. Compares with the actual blockchain grid state after fills/rotations
3. Computes RMS divergence metric:
   ```
   RMS = √(mean of ((calculated - persisted) / persisted)²)
   ```
4. If `RMS >= RMS_PERCENTAGE`:
   - Triggers `Grid.updateGridOrderSizes()` to regenerate
   - Calls `compareGrids()` to report detailed divergence metrics
5. Grid sizes are recalculated and updated

### When to Adjust

**Increase threshold (e.g., 14.3% → 20%) if:**
- Grid regens too frequently (expensive due to order updates)
- You're comfortable with more fill/rotation drift
- Blockchain latency causes false positives

**Decrease threshold (e.g., 14.3% → 9.8%) if:**
- You want tighter sync with blockchain state
- You want to catch drift earlier
- Fill/rotation operations are causing noticeable size errors

**Disable (set to 0) if:**
- You want to rely ONLY on AMA triggers (Issue #5: RMS Divergence Check Disabling)
- You want to prevent automatic grid regeneration from divergence alone
- You manually trigger grid regens via other mechanisms

---

## 4. Grid Regeneration Threshold (Internal)

### What It Does
Monitors available funds on each side (BUY/SELL). When accumulated fill proceeds exceed the threshold, the grid is regenerated to re-utilize the freed capital.

**Why it matters:** As orders fill, capital is freed. Regeneration re-allocates this capital back into active orders instead of leaving it idle.

### Configuration

**File:** `modules/constants.js`
```javascript
GRID_LIMITS: {
  GRID_REGENERATION_PERCENTAGE: 3,
  // ...
}
```

**Parameters:**
- `GRID_REGENERATION_PERCENTAGE`: Percentage of allocated capital that can accumulate as free funds before triggering regen
  - Default: `3%`
  - Example: 20 orders × 100 BTS = 2000 BTS grid
    - Triggers when availableFunds ≥ 60 BTS (3% of 2000)
    - Allows ~3 fill-proceeds to accumulate before resize

### How It Works

1. **OrderManager** tracks available funds per side (BUY and SELL separately)
2. Allocated capital = number of active orders × size per order
3. When `availableFunds / allocatedCapital × 100 >= GRID_REGENERATION_PERCENTAGE`:
   - Triggers `Grid.recalculateGrid()` on that side only
   - Recalculates order sizes to incorporate freed capital
   - Maintains asymmetric fills (BUY fills don't trigger SELL regen)
4. After regen, available funds are re-allocated into active orders

### When to Adjust

**Increase threshold (e.g., 3% → 5%) if:**
- Grid regens too frequently
- You want to accumulate more fill proceeds before rebalancing
- You prefer stability over utilization

**Decrease threshold (e.g., 3% → 1%) if:**
- You want to re-utilize capital more aggressively
- You have high fill rates
- Available funds sitting idle bothers you

---

## Bootstrap Center Persistence

On the **first cycle** for a bot (when no `centerPrice` baseline exists yet), the price adapter must persist the initial AMA center to disk before advancing the in-memory baseline. This ordering prevents a dangerous split where the order engine reads stale or missing snapshot data while the adapter believes it succeeded.

### How It Works

1. `processBot()` detects the bootstrap case (`centerPrice` is not yet set).
2. It calls `writeBotGridPriceCenter(botKey, referencePrice, { amaCenterPrice, gridPriceOffsetPct, effectiveCenterPrice })`.
3. **If the write succeeds** (returns anything other than `false`): the in-memory baseline (`centerPrice`, `amaCenterPrice`, `gridPriceOffsetPct`, `lastGridResetAt`) is set. No recalculation trigger is created during bootstrap — the bot enters normal delta-comparison behavior on subsequent cycles.
4. **If the write fails** (returns `false`): the in-memory baseline is left unset, `triggerSuppressedReason` is set to `ama_center_persist_failed`, and no recalculation trigger is written. The next cycle will retry the bootstrap from scratch.

### Debugging

**Bootstrap persistence failure:**
```
triggerSuppressedReason: 'ama_center_persist_failed'
```

If this appears repeatedly, check:
- disk space and write permissions on the state directory
- whether `writeBotGridPriceCenter` is correctly wired in the service deps

---

## Interaction Between Mechanisms

### Independence
All four mechanisms are **independent**:
- Grid price offset is triggered by offset parameter changes
- AMA delta is triggered by market price changes
- RMS divergence is triggered by blockchain state drift
- Regeneration is triggered by available funds
- They can all fire at the same time without conflict

### Configuration Priority
1. **All four are INDEPENDENT** — no priority or suppression
2. Each can be configured and disabled separately
3. Disabling one doesn't affect the others

### Examples

**Example 1: Conservative Grid (Tight Sync)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 0.5  // Respond to small moves
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 1,  // Regen frequently
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 9.8  // Tight divergence tolerance
    }
  }
}
```
- Grid follows price closely
- Frequently re-utilizes freed capital
- Detects drift early
- **Cost:** More recalculations, higher blockchain fees

**Example 2: Aggressive Grid (High Utilization)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2  // Ignore minor moves
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 5,  // Regen sparingly
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 0  // Disable RMS checks
    }
  }
}
```
- Grid adapts only to major price moves
- Accumulates capital before rebalancing
- No automatic drift correction
- **Benefit:** Fewer recalculations, lower fees

**Example 3: Balanced (Default)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 1  // Standard threshold
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 3,  // Moderate utilization
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 14.3  // Balanced tolerance
    }
  }
}
```
- Default for most bots
- Balances responsiveness and cost
- **Good for:** Normal trading conditions

---

## Debugging: Which Trigger Fired?

Check the logs for these messages:

**AMA Delta Trigger:**
```
[price_adapter] Creating trigger: market_adapter/state/recalculate.<botKey>.trigger
```

**RMS Divergence Trigger:**
```
[grid] compareGrids: RMS divergence 18.5% exceeds threshold 14.3%
[grid] updateGridOrderSizes: Regenerating grid due to divergence
```

**Regeneration Trigger:**
```
[grid] Grid regeneration triggered: available 3.2% >= threshold 3.0%
```

---

## Common Configuration Mistakes

❌ **Don't:** Set `RMS_PERCENTAGE` to 0 without understanding consequences
- Grid will never auto-correct blockchain state drift
- Manual intervention required if major divergence occurs

❌ **Don't:** Set `AMA_DELTA_THRESHOLD_PERCENT` too low (< 0.5%)
- Grid regens constantly (high fees)
- May never stabilize in choppy markets

❌ **Don't:** Disable AMA without disabling AMA configuration
- Orphaned `ama` section in bots.json
- Confusing configuration state

✅ **Do:** Understand your market's volatility
- Trending markets: Lower AMA_DELTA_THRESHOLD_PERCENT
- Choppy markets: Raise both AMA_DELTA_THRESHOLD_PERCENT and RMS_PERCENTAGE
- High-fill markets: Lower GRID_REGENERATION_PERCENTAGE

✅ **Do:** Monitor grid recalculation frequency
- Log output should show recalcs are balanced
- Adjust thresholds if too frequent or too rare

---

## Related Issues

- **Issue #5:** RMS Divergence Check Disabling — Ability to set `RMS_PERCENTAGE: 0` to disable checks
- **Feature:** AMA Integration — Future work to use AMA prices in grid calculations (not just triggers)
- **Issue #1:** Fund Validation Bug — Fixed validation logic for order batch placement

---

## References

- `modules/constants.js` — Default configuration values
- `modules/account_bots.js` — Bot configuration schema and defaults
- `market_adapter/price_adapter.js` — AMA calculation and trigger logic
- `modules/order/grid.js` — RMS divergence check and grid comparison
- `modules/order/manager.js` — Regeneration threshold logic
- `profiles/general.settings.json` — User-editable configuration
- `profiles/bots.json` — Per-bot configuration including AMA
