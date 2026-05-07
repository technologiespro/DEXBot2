# Grid Recalculation Mechanisms

DEXBot2 uses **five independent grid reset/update sources** to keep the trading grid synchronized with market conditions, bot funds, and on-chain state.
The market adapter writes the AMA center baseline and selected dynamic-grid payloads first, then emits a reset trigger only when the bot should rebuild around that accepted snapshot.

---

## Overview: Reset and Update Sources

| Mechanism | Trigger | Config | Location | Scope |
|-----------|---------|--------|----------|-------|
| **Market Adapter Bootstrap** | First accepted AMA center for a bot | AMA bot configuration and whitelist | `profiles/orders/<botKey>.dynamicgrid.json` + `profiles/recalculate.<botKey>.trigger` | Per bot |
| **AMA Delta** | AMA center moved significantly | `AMA_DELTA_THRESHOLD_PERCENT` / `deltaThresholdPercent` | `general.settings.json`; pair/bot overrides in `market_adapter_settings.json` | Global default, pair, or bot |
| **AMA Slope Range Reset** | Accepted AMA-slope baseline moved past threshold | `amaSlopeThresholdPercent` / range-scaling profile settings | `market_profiles.json` + `market_adapter_whitelist.json` | Whitelisted range-scaling bots |
| **RMS Divergence** | Grid state diverged from blockchain | `RMS_PERCENTAGE` | `general.settings.json` | Global (all bots) |
| **Regeneration** | Available funds exceed threshold | `GRID_REGENERATION_PERCENTAGE` | `constants.js` | Per-side (BUY/SELL) |

Each source is evaluated independently. Market-adapter reset triggers are serialized through `profiles/recalculate.<botKey>.trigger`; runtime maintenance updates are executed under the order manager fill-processing lock.

---

## 1. AMA Center Baseline and Trigger File

The market adapter persists the AMA-derived grid center directly. There is no
additional deviation-based price adjustment layer on top of the AMA output.

The adapter writes the current center to `profiles/orders/<botKey>.dynamicgrid.json`
and the grid engine uses that snapshot as the baseline for future delta comparisons.

When a rebuild is required, the adapter writes
`profiles/recalculate.<botKey>.trigger` with JSON metadata such as `reason`,
`newCenterPrice`, `previousCenterPrice`, `rawAmaPrice`, and slope diagnostics.
DEXBot watches the `profiles/` directory and also checks for a pending trigger
before startup grid initialization.

The bot executes the reset through `_performGridResync()`:

1. Acquire `_fillProcessingLock`.
2. Defer if the bot is not idle or a pending dust-cancel timer has not settled.
3. Reload this bot's entry from `profiles/bots.json`.
4. For manual or legacy empty triggers, refresh `centerPrice` in
   `<botKey>.dynamicgrid.json` from the latest `amaCenterPrice` before rebuilding.
5. Call `Grid.recalculateGrid()` using fresh open orders from chain.
6. Reset fee-debt bookkeeping, persist the rebuilt grid, and remove the trigger file.

Market-adapter triggers are not treated as manual triggers because their JSON
payload has `source: "market_adapter/market_adapter.js"`. Empty or malformed
trigger files remain supported as manual/legacy resets.

---

## 2. Market Adapter Bootstrap Reset

### What It Does
When the adapter has no accepted `centerPrice` baseline for a bot, it persists
the first valid AMA center and writes a reset trigger so the running bot
rebuilds around that center.

**Why it matters:** The adapter and bot must agree on the first grid center. A
bootstrap trigger prevents the adapter from silently accepting a center while
the bot continues operating on stale or missing dynamic-grid data.

### How It Works

1. `processBot()` detects that the bot has no valid previous `centerPrice`.
2. It writes `profiles/orders/<botKey>.dynamicgrid.json` with `centerPrice`,
   `amaCenterPrice`, AMA slope fields, and whitelisted dynamic weights.
3. Only after that write succeeds, it writes `profiles/recalculate.<botKey>.trigger`
   with `reason: "market_adapter_bootstrap"`.
4. The bot consumes the trigger through the normal grid-resync path.
5. If the snapshot write fails, no trigger is written and the next adapter cycle
   retries bootstrap from scratch.

### Debugging

**Bootstrap persistence failure:**
```text
triggerSuppressedReason: 'ama_center_persist_failed'
```

If this appears repeatedly, check disk space, write permissions for
`profiles/orders/`, and the `writeBotDynamicGrid` service dependency.

---

## 3. AMA Delta Threshold (Market Adapter)

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

For a narrower override, set `deltaThresholdPercent` in
`profiles/market_adapter_settings.json` under either:

- `pairs[].marketAdapterSettings` for one market pair
- `pairs[].botOverrides[<botName>]` for one bot in that pair

**Parameters:**
- `AMA_DELTA_THRESHOLD_PERCENT`: Percentage change in AMA center that triggers grid reset
  - Default: `2%`
  - Range: `0.1` to `50.0` (configurable via CLI and `node dexbot bots` general settings)
  - Example: If set to `1`, grid recalculates when AMA center moves ±1% from last center

### CLI Override
```bash
node market_adapter/market_adapter.js --deltaPercent 2
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

**How this interacts with market profiles:**
- `profiles/market_profiles.json` wins first for matched markets
- `gridPrice: "ama"` uses the pair's `defaultAma`
- `gridPrice: "ama1"` through `gridPrice: "ama4"` force that exact preset
- If no pair profile matches, the bot's `ama` block is used as the fallback

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

1. **Market Adapter** (`market_adapter/market_adapter.js`) runs continuously
2. Loads per-bot AMA configuration (or uses defaults)
3. Calculates AMA from 1h candlestick closing prices
4. Tracks the **AMA center price** for each bot
5. When `|currentAMA - lastRecordedAMA| >= AMA_DELTA_THRESHOLD_PERCENT`:
   - **Checks if the bot is whitelisted** (non-whitelisted bots only log results)
   - Persists `profiles/orders/<botKey>.dynamicgrid.json`
   - Creates `profiles/recalculate.<botKey>.trigger` file
   - DEXBot detects the trigger at startup or through `fs.watch` and runs a full grid resync under `_fillProcessingLock`
6. Last recorded center is updated only after the dynamic-grid snapshot write succeeds

### When to Adjust

**Increase threshold (e.g., 1% → 2%) if:**
- Grid recalculates too frequently (excessive churn)
- Market is choppy/sideways
- You want fewer but larger recalculations

To change the threshold for every bot, edit `profiles/general.settings.json`
or use the `node dexbot bots` general settings menu. To change the AMA preset
used by a specific market, edit `profiles/market_profiles.json`. To change the
fallback bot-level AMA settings, edit the bot entry in `profiles/bots.json`.

**Decrease threshold (e.g., 1% → 0.5%) if:**
- Grid reacts too slowly to market moves
- Market is trending strongly
- You want grid to follow price more closely

---

## 4. AMA Slope Range Reset (Market Adapter)

### What It Does
For bots whitelisted for asymmetric bounds / grid range scaling, the adapter
tracks the AMA slope baseline accepted at the last grid reset. When the slope
delta crosses the configured threshold, the adapter persists the latest range
scaling snapshot and writes a reset trigger.

**Why it matters:** Range scaling changes grid bounds, not just live order
weights. Existing orders need a reset to move to the new asymmetric range.

### Configuration

Range scaling is enabled by whitelist:

```bash
npm run market-adapter:whitelist
```

To leave range scaling disabled while allowing AMA pricing:

```bash
node scripts/generate_market_adapter_whitelist.js --no-asymmetric-bounds
```

The snapshot fields involved are:

- `amaSlope`: latest slope diagnostic
- `gridRangeScalingAmaSlope`: last accepted grid-reset slope baseline
- `amaSlopeDeltaPercent`: distance from the accepted baseline
- `amaSlopeThresholdPercent`: threshold required to trigger the reset

### How It Works

1. Adapter computes the current AMA slope and range-scaling bounds.
2. It compares the current slope with `gridRangeScalingAmaSlope`.
3. If the threshold is crossed and the bot is range-scaling-whitelisted:
   - Persists the dynamic-grid snapshot
   - Writes a trigger with `reason: "market_adapter_ama_slope_delta_threshold"`
   - Advances the accepted slope baseline only after persistence succeeds
4. Direction changes alone do not reset the grid unless the slope delta threshold is crossed.

---

## 5. RMS Divergence Check (Grid Engine)

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
   - Logs the structural divergence metrics
   - Calls `applyGridDivergenceCorrections()`
   - Applies the resulting COW update/cancel/create plan through the batch order path
5. The master grid is committed only after successful blockchain execution; failed COW plans are discarded

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

## 6. Grid Regeneration Threshold (Internal)

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

## Interaction Between Mechanisms

### Independence
All reset/update sources are **independent**:
- Bootstrap reset is triggered by accepting the first AMA center
- AMA delta is triggered by market price changes
- AMA slope reset is triggered by accepted range-scaling slope drift
- RMS divergence is triggered by blockchain state drift
- Regeneration is triggered by available funds
- Runtime execution is serialized by the fill-processing lock and idle/dust deferral

### Configuration Priority
1. **All mechanisms are independent** — no global priority or suppression
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
    "AMA_DELTA_THRESHOLD_PERCENT": 2.0  // Standard threshold
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
TRIGGERED -> profiles/recalculate.<botKey>.trigger
```

Trigger payload reasons:

```text
market_adapter_bootstrap
market_adapter_delta_threshold
market_adapter_ama_slope_delta_threshold
```

**RMS Divergence Trigger:**
```
Grid update triggered by structural divergence during periodic: buy=..., sell=...
Grid divergence corrections applied during periodic
```

**Regeneration Trigger:**
```
Grid update triggered by funds during periodic (buy: ..., sell: ...)
```

**Trigger Resync Execution:**
```text
Pending trigger file detected. Processing reset before startup...
Grid regeneration triggered. Performing full grid resync...
Removed trigger file.
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
- **Feature:** AMA Integration — AMA-derived center snapshots are already used for market-adapter-triggered grid recentering
- **Issue #1:** Fund Validation Bug — Fixed validation logic for order batch placement

---

## References

- `modules/constants.js` — Default configuration values
- `modules/account_bots.js` — Bot configuration schema and defaults
- `market_adapter/market_adapter.js` — AMA calculation and trigger logic
- `market_adapter/core/market_adapter_service.js` — Bootstrap, AMA-delta, and AMA-slope trigger decisions
- `modules/dexbot_maintenance_runtime.js` — Trigger-file detection, manual center refresh, idle/dust deferral, and resync execution
- `modules/order/grid.js` — RMS divergence check and grid comparison
- `modules/order/manager.js` — Regeneration threshold logic
- `profiles/general.settings.json` — User-editable configuration
- `profiles/bots.json` — Per-bot configuration including AMA
