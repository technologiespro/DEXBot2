# Market Adapter

The market adapter keeps AMA-priced bots centered on the current market. It
uses `startPrice` to pick the candle source (`pool`, `book`, or fixed), then
updates candles, calculates the AMA center price, applies optional dynamic
weights, and emits a recalc trigger when the center moves far enough.

DEXBot2 launches and stops the adapter automatically for active AMA bots.

## Quick Start

### 1. Enable AMA on a Bot

Set the bot's `gridPrice` to `ama` in `profiles/bots.json` or through the
`node dexbot bots` menu. Valid values are `ama`, `ama1`, `ama2`, `ama3`, and
`ama4`; `ama` is the recommended normal setting.

Use `startPrice` to choose the candle source for the adapter: `pool` for LP
history, `book` for orderbook history, or a numeric value to disable candle
fetching and run as a fixed-price anchor.

### 2. Generate the Whitelist

Generate the whitelist from the AMA-enabled bots to enable live grid snapshots
and recalc triggers. **Without whitelisting, the adapter runs in dry-run
mode (logging only).**

```bash
npm run market-adapter:whitelist
```

This writes `profiles/market_adapter_whitelist.json` for the currently
AMA-enabled bots.

To whitelist AMA pricing but keep dynamic weights disabled:

```bash
node scripts/generate_market_adapter_whitelist.js --no-dynamic-weight
```

To keep asymmetric bounds disabled:

```bash
node scripts/generate_market_adapter_whitelist.js --no-asymmetric-bounds
```

### 3. Start DEXBot2

Start DEXBot2. The bot runtime will launch and stop the adapter automatically
when AMA-priced bots are active.

## AMA Profiles and Price Bounds

`gridPrice: "ama"` uses the pair's `defaultAma` from
`profiles/market_profiles.json`. `gridPrice: "ama1"` through
`gridPrice: "ama4"` force a specific preset. If no pair profile matches, the
bot's `ama` block is used as the fallback.

Choose a bound multiplier larger than the AMA fit cap so the bot has room to
absorb normal noise without making the book unnecessarily wide.

| AMA preset | AMA fit cap | Suggested bound multiplier | Wide | Excessive |
|------------|------------:|---------------------------:|-----:|----------:|
| AMA1 | 25% | 1.30x to 1.35x | 1.40x | 1.45x+ |
| AMA2 | 30% | 1.35x to 1.40x | 1.45x | 1.50x+ |
| AMA3 | 35% | 1.40x to 1.45x | 1.50x | 1.55x+ |
| AMA4 | 40% | 1.45x to 1.50x | 1.55x | 1.60x+ |

The multiplier notation is symmetric around the grid center in ratio terms:
`minPrice: "1.40x"` means `center / 1.40`, and `maxPrice: "1.40x"` means
`center * 1.40`.

Use the selected multiplier for both bounds.

## Asymmetric Bound Tilt

When the bot uses `gridPrice: "ama"` mode, the AMA slope signal can tilt the
bounds asymmetrically — widening the bound in the trend direction and tightening
the opposite side. This gives the grid more room when the AMA center trails
price during a trend.

```
slope = AMA slope percent over the lookback window
asymmetry = min(|slope| / maxSlopePct, 1) × maxAsymmetryFactor

Downtrend: minPrice = center / (M × (1 + asymmetry))
           maxPrice = center × (M × (1 - asymmetry))

Uptrend:   maxPrice = center × (M × (1 + asymmetry))
           minPrice = center / (M × (1 - asymmetry))

Neutral:   symmetric bounds (asymmetry = 0)
```

| Setting | Default | Description |
|---------|--------:|-------------|
| `ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR` | 0.35 | Maximum ratio tilt at full slope (0 = disabled) |

Override per-bot via `market_adapter_settings.json`:
```json
{
  "asymmetricBounds": {
    "maxAsymmetryFactor": 0.35
  }
}
```

Enable/disable per-bot via the whitelist (`profiles/market_adapter_whitelist.json`):
```json
{
  "whitelist": {
    "my-bot-0": { "ama": true, "dynamicWeight": true, "asymmetricBounds": true },
    "my-bot-1": { "ama": true, "asymmetricBounds": false }
  }
}
```
Asymmetric bounds default to **on** for all whitelisted bots. Set `asymmetricBounds: false`
to disable for a specific bot while keeping AMA and/or dynamic weights enabled.

## Trigger Threshold

The adapter writes a recalc trigger when the AMA center moves more than the
configured percentage threshold and candle data is not stale.

Configure the default threshold in `profiles/general.settings.json`:

```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2.5
  }
}
```

You can also adjust this global setting from `node dexbot bots` in the
general settings menu.

## Settings and Overrides

Market-adapter settings resolve in this order:

1. Built-in defaults in `modules/constants.js`
2. Global overrides in `profiles/general.settings.json` or `node dexbot bots`
3. Pair-specific overrides in `profiles/market_profiles.json`
4. Bot-specific overrides in `profiles/market_adapter_settings.json`

`profiles/market_adapter_settings.json` has its own override layers:

- `globals` applies to every market and bot
- `pairs[].marketAdapterSettings` overrides one market pair
- `pairs[].botOverrides[<botName>]` overrides one bot inside that pair

## Dry-Run Safety

Bots that are not AMA-whitelisted are processed in dry-run mode. Their candles
and state are computed, but live grid files and recalc triggers are suppressed
(logging only).

| Invocation | Behavior |
|---|---|
| `node market_adapter/market_adapter.js` | Whitelisted bots write live files; others dry-run |
| `node market_adapter/market_adapter.js --dryRun` | All bots dry-run |
| `node market_adapter/market_adapter.js --whitelist-all` | All AMA bots write live files |

Dry-run log lines include `[DRY RUN]` or `[suppressed, dry-run]`.

## Dynamic Weights

Dynamic weights are controlled separately from AMA pricing. `ama` allows live
AMA grid files and recalc triggers. `dynamicWeight` allows the adapter's
buy/sell weights to be written and applied by the bot runtime.

Dynamic weights start from the bot's configured `weightDistribution`. These
configured values are the static baseline.

For the research chart and tuning notes behind this signal path, see
[Dynamic Weight Research](../analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md).

On each closed-candle cycle, the adapter adds an asymmetric trend offset and a
symmetric volatility penalty:

- `effectiveSell = staticSell + trendOffset + volatilityPenalty`
- `effectiveBuy = staticBuy - trendOffset + volatilityPenalty`

A positive `trendOffset` shifts weight toward sell and away from buy. A
negative `trendOffset` shifts weight toward buy and away from sell.
`volatilityPenalty` is normally zero or negative, so it reduces both sides
equally. The final values are clamped to the adapter's configured min/max
weight bounds and rounded before being written to the dynamic grid snapshot.

Pair-level and bot-level tuning lives in
`profiles/market_adapter_settings.json`. Most users should leave these values
alone unless they are fitting or testing strategy parameters.

## Useful Commands

```bash
# Generate whitelist from bots with gridPrice set to ama/ama1/ama2/ama3/ama4
npm run market-adapter:whitelist

# Preview generated whitelist without writing it
node scripts/generate_market_adapter_whitelist.js --dry-run

# Run one adapter cycle
node market_adapter/market_adapter.js --once

# Override the threshold for a single run
node market_adapter/market_adapter.js --once --deltaPercent 1.5

# Run continuously
node market_adapter/market_adapter.js

# Print one-cycle JSON signal output
node market_adapter/ama_signal_runner.js

# Print one bot's signal output
node market_adapter/ama_signal_runner.js --bot <botKey> --compact
```

`--deltaPercent` overrides the configured threshold for that run.

## Troubleshooting

### Bot is not processed

- Confirm `gridPrice` is `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
- Regenerate the whitelist with `npm run market-adapter:whitelist`.
- Confirm the expected `botKey` exists in `profiles/market_adapter_whitelist.json`.
- If `startPrice` is numeric, the adapter will not fetch pool/book candles for that bot. Use `startPrice` only for a fixed anchor in that case; `gridPrice` remains a separate grid setting.

### Trigger is not created

- Check `lastDeltaPercent` vs `thresholdPercent`.
- Check `staleData` and `staleAgeHours`.
- **Confirm the bot is whitelisted.** Non-whitelisted bots only log and do not write triggers.
- Confirm the bot's whitelist entry has `"ama": true`.
- Run `node market_adapter/market_adapter.js --once --deltaPercent <lower-value>` for a one-cycle threshold test.

### Trigger fires too often

- Increase `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`.
- Inspect `lastDeltaPercent` to see the normal movement range for the pair.

### Adapter will not start

- Check for an old lock file at `market_adapter/state/market_adapter.lock`.
- If the adapter is not running and the lock is from a crashed process, remove
  the stale lock file manually.
- If you are using the direct bot launcher, make sure at least one active bot
  has `gridPrice` set to `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
- If you are using PM2, confirm that `dexbot-adapter` exists in the PM2 app
  list.

## Related Tools

```bash
# Export pool candles for analysis
node market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 8760h

# Generate LP chart from an exported candle file
npm run lp:chart -- --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

## Technical Reference

This section keeps the full market adapter details in one place. Normal
operation should follow the Quick Start above.

### Purpose and Boundaries

The market adapter bridges historical analysis and live bot operation. It keeps
fresh LP candles per bot, computes the AMA-based market center, evaluates trend
and volatility signals, writes dynamic weight snapshots, and emits recalc
triggers when the grid should be rebuilt.

For the similar bot-scoped debt workflow and collateral advisory path, see
[MPA and Credit Usage](../docs/MPA_CREDIT_USAGE.md).

For the research tools behind AMA fitting, signal analysis, and parameter
calibration, see [Analysis README](../analysis/README.md).

The adapter runs independently from `dexbot.js`. It does not place orders,
manage bot lifecycle, or edit bot configuration. Order execution and grid
rebuilds stay owned by the bot runtime.

Standalone daemon mode is still available for direct inspection or manual
operation:

```bash
node market_adapter/market_adapter.js
```

The adapter acts only on closed 1h candles. It can poll more often, but live
updates wait for the next completed candle.

### Signal Pipeline

```text
price_candles -> market_adapter -> AMA -> grid center

AMA slope      -> trend offset
Kalman signal  -> trend confirmation
ATR            -> symmetric volatility penalty
trend + ATR    -> dynamic buy/sell weights

trend regime   -> advisory collateral-ratio hint
AMA delta      -> recalculate.<botKey>.trigger
```

Per cycle, per processed bot, the adapter can produce:

| Output | Meaning |
|--------|---------|
| `gridPrice` / `centerPrice` | AMA-derived grid center, clamped to bounds |
| `weights` | Dynamic `{ buy, sell }` grid weights |
| `trend` | `UP`, `DOWN`, or `NEUTRAL` |
| `atr` / `weightVariance` | Volatility diagnostics |
| `collateralRecommendation` | Advisory collateral-ratio hint |
| `recalculate.<botKey>.trigger` | Runtime signal for grid rebuild |

### Runtime Flow

1. Load active bots from `profiles/bots.json`.
2. Select bots with `gridPrice` set to `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
3. Resolve AMA settings from `profiles/market_profiles.json`.
4. Read `startPrice` to choose the candle source: `pool`, `book`, or fixed.
5. Sync candle data from Kibana or native BitShares data, using the selected source.
6. Repair missing candle gaps when possible.
7. Ignore still-forming 1h candles.
8. Compute AMA center, trend, ATR, weights, and collateral hint.
9. Compare the new AMA center to the stored center.
10. Suppress live writes if the bot is not whitelisted or candle data is stale.
11. Write `dynamicgrid.json` and a recalc trigger when the threshold is crossed.
12. Persist state snapshots under `market_adapter/state/`.

### Configuration Files

| File | Purpose |
|------|---------|
| `profiles/bots.json` | Active bots, symbols, pool IDs, and `gridPrice` settings |
| `profiles/market_profiles.json` | Pair AMA profiles and defaults |
| `profiles/market_adapter_whitelist.json` | Per-bot live-write permissions |
| `profiles/market_adapter_settings.json` | Advanced adapter and dynamic-weight tuning |
| `profiles/general.settings.json` | Global market adapter threshold settings |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |

### What the Adapter Writes

For each whitelisted AMA bot, the adapter may write:

| File | Purpose |
|------|---------|
| `profiles/orders/<botKey>.dynamicgrid.json` | Persisted AMA center snapshot and optional dynamic weights used by the bot runtime |
| `profiles/recalculate.<botKey>.trigger` | Signal for `dexbot.js` to rebuild the grid |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |

`dexbot.js` consumes the recalc trigger and handles the grid rebuild. The market
adapter does not place orders, start bots, stop bots, or edit
`profiles/bots.json`.

### Dynamic Grid Snapshot

`profiles/orders/<botKey>.dynamicgrid.json` is the live snapshot that the bot
runtime reloads on selected rebalance and maintenance paths. It is written with
the current AMA-derived center and, when enabled, the live dynamic-weight
payload.

Typical fields:

```json
{
  "centerPrice": 1294.6,
  "amaCenterPrice": 1294.6,
  "updatedAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.js",
  "dynamicWeights": {
    "effectiveWeights": { "sell": 0.45, "buy": 0.55 },
    "baseWeights": { "sell": 0.5, "buy": 0.5 },
    "isReady": true
  }
}
```

- `centerPrice` is the persisted grid baseline used for future delta checks.
- `amaCenterPrice` is the raw AMA output before downstream handling.
- During a manual grid reset, the bot refreshes `centerPrice` from the latest
  `amaCenterPrice` before rebuilding the grid.
- `dynamicWeights` is present only when live dynamic weights were computed and
  the bot is allowed to consume them.
- The runtime applies `dynamicWeights` only when the bot is whitelisted for
  `dynamicWeight` and the snapshot reports `isReady: true`.
- The bot reads this snapshot before fill processing and other selected
  structural maintenance so new orders use the latest accepted center and
  weights.

### Module Map

```text
market_adapter/
|-- market_adapter.js              main adapter daemon
|-- ama_signal_runner.js           one-cycle JSON signal CLI
|-- candle_utils.js                candle transforms, gap detection, pruning
|-- interval_utils.js              shared interval label helpers
|-- merge_lp_data.js               candle export merge utility
|-- lp_chart_core.js               chart HTML renderer
|-- lp_chart_strategy_loader.js    AMA strategy/profile resolver for charts
|-- lp_chart_runner.js             LP chart orchestration
|-- test_helpers.js                test utilities
|-- core/
|   |-- market_adapter_service.js  full signal pipeline service
|   |-- config_normalizers.js      shared config normalization
|   |-- kibana_client.js           low-level Kibana/ES query client
|   |-- kibana_candles.js          LP pool candle fetch engine
|   |-- kibana_market_candles.js   orderbook candle fetch and transform
|   |-- consolidate_candles.js     candle consolidation helpers
|   `-- strategies/
|       |-- ama_slope_model.js     AMA slope and trend weight logic
|       |-- collateral_manager.js  advisory collateral-ratio logic
|       |-- regime_gate.js         regime multiplier gating
|       `-- atr/calculator.js      ATR calculation
|-- inputs/
|   |-- kibana_source.js           Elasticsearch LP data source
|   `-- fetch_lp_data.js           historical LP candle exporter
|-- utils/
|   |-- chain.js                   blockchain query helpers
|   |-- ws_client.js               lightweight BitShares WebSocket client
|   |-- adapter_client.js          inter-process credential daemon client
|   |-- native_history.js          native BitShares market history fetch
|   |-- file_lock.js               single-instance file lock
|   `-- data_discovery.js          data directory auto-discovery
|-- data/                          runtime candle caches and exports
`-- state/                         runtime state, centers, and lock file
```

### Whitelist Semantics

`profiles/market_adapter_whitelist.json` controls live writes:

```json
{
  "whitelist": {
    "<botKey>": {
      "ama": true,
      "dynamicWeight": true
    }
  }
}
```

- `ama: true` allows live `dynamicgrid.json` and recalc trigger writes.
- `dynamicWeight: true` allows dynamic weights to be applied by the bot runtime,
  but only when the snapshot is also marked ready.
- Missing whitelist file means all live AMA writes are suppressed.
- Missing bot entry means that bot runs in dry-run mode.

### Trigger Files

When the threshold is exceeded, the adapter writes a trigger file under
`profiles/` at the repo root:

- `profiles/recalculate.<botKey>.trigger`

The file contains a trigger payload like:

```json
{
  "createdAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.js",
  "botName": "IOB.XRP/BTS",
  "botKey": "<botKey>",
  "thresholdPercent": 0.8,
  "deltaPercent": 1.1,
  "previousCenterPrice": 1280.5,
  "newCenterPrice": 1348.32,
  "referencePrice": 1294.6,
  "rawAmaPrice": 1294.6,
  "poolId": "1.19.133"
}
```

`dexbot.js` watches for this file and rebuilds the affected grid from current
runtime state. The trigger is separate from `dynamicgrid.json`: the trigger
requests a rebuild, while the snapshot carries the center and live weight state
that the runtime can reload.

### Dynamic Weight Model

The production dynamic-weight output combines:

| Branch | Role |
|--------|------|
| AMA slope | Measures filtered market direction and velocity |
| Kalman signal | Confirms directional movement |
| ATR volatility | Applies a symmetric risk penalty to both sides |
| Regime gates | Suppress weak or noisy signals |

Main override knobs live in `profiles/market_adapter_settings.json`:

| Setting | Meaning |
|---------|---------|
| `alpha` | AMA vs Kalman blend |
| `dw` | Kalman displacement weighting |
| `gain` | Output amplitude |
| `amaSlope.lookbackBars` | AMA slope lookback |
| `amaSlope.neutralZonePct` | Dead band around flat AMA slope |
| `amaSlope.maxSlopePct` | AMA slope saturation |
| `minOutputThreshold` | Minimum trend output before directional shift applies |
| `maxSlopeOffset` | Cap for asymmetric trend offset |
| `maxVolatilityOffset` | Cap for symmetric ATR penalty |
| `clipPercentile` | Outlier filter for AMA/Kalman velocity (clips top N% of values) |
| `absoluteThreshold` | Dead band before regime filtering |
| `atrPeriod` | ATR lookback |
| `volatilityExponent` | ATR penalty exponent |
| `volatilityScaleX` | ATR penalty scale |
| `volatilityThreshold` | Minimum volatility penalty before applying shift |
| `kalmanSmoothPct` | Raw vs smoothed Kalman blend |
| `dispScaleMinPct` | Kalman displacement minimum scale floor |
| `kalmanDispScaleMult` | Kalman displacement scale multiplier |
| `kalmanDispThresholdMult` | Kalman displacement threshold multiplier |
| `kalmanSlope.maxSlopePct` | Kalman slope saturation |
| `kalmanSmoothSpanPct` | Adaptive EMA span ratio |
| `signalConfirmBars` | Signal latch confirmation bars |

Most operators should tune only the trigger threshold and AMA profile unless
they are deliberately fitting a market.

### Candle and Staleness Handling

The adapter keeps candle caches current using Kibana bootstrap plus native
incremental updates. It repairs gaps through targeted Kibana fetches when
possible, prunes old candles to the required AMA window, and acts only on closed
1h candles.

#### AMA Warmup Window — Why Candle Length Matters

The AMA is a recursive (infinite impulse response) filter. On cold start it
initialises to the first price after the Efficiency Ratio (ER) buffer, creating
an initialisation bias. This bias decays asymptotically — each bar, the AMA
"forgets" a fraction equal to its smoothing constant:

```
bias_remaining(K) ≈ bias_initial × ∏ (1 − SC_i)      for i = 1..K
```

Kaufman's smoothing constant is the ER-scaled value, squared:

```
SC_i = [ER_i × (fastSC − slowSC) + slowSC]²

where  fastSC = 2 / (fastPeriod + 1)
      slowSC = 2 / (slowPeriod + 1)
```

Because `ER_i` varies bar-by-bar, a **typical-market ER** (`ER_avg`) is used to
estimate an average decay rate:

```
SC_avg = [ER_avg × (fastSC − slowSC) + slowSC]²
```

Bars needed to reduce bias below a target fraction ε:

```
convergenceBars = ln(ε) / ln(1 − SC_avg)
```

The **full warmup window** the adapter requires:

```
amaWarmupBars = erPeriod + convergenceBars + lookbackBars
```

| Component | Role |
|-----------|------|
| `erPeriod` | Bars for the first Efficiency Ratio value to become available |
| `convergenceBars` | Bars to decay 99 % of the cold-start initialisation bias |
| `lookbackBars` | Extra lookback for slope/trend analysis (AMA slope, ATR) |

The two **calibration constants** live in `modules/constants.js` under
`MARKET_ADAPTER`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `AMA_CONVERGENCE_ER_AVG` | `0.151` | Typical-market Efficiency Ratio. Lower = more conservative (assumes more noise, slower convergence, more candles needed). Calibrated against the fetched 3-year pool 133 1h dataset (`2023-05-07` -> `2026-05-06`); corrects for Jensen's inequality — `E[f(ER)] ≠ f(E[ER])` when `f` is the squaring function. |
| `AMA_CONVERGENCE_EPSILON` | `0.01` | Target remaining bias fraction. `0.01` means 99 % of the initial bias has decayed by the end of the convergence window. |

To recalibrate `AMA_CONVERGENCE_ER_AVG` against new market data, use the
research script:
```bash
node analysis/ama_fitting/calibrate_convergence_er.js [--data <lp-file.json>] [--amas AMA3,AMA4]
```
See `analysis/ama_fitting/calibrate_convergence_er.js` for details on the
implied-ER correction (Jensen's inequality).

For a calibrated `AMA_CONVERGENCE_ER_AVG` of `0.151` and
`AMA_CONVERGENCE_EPSILON = 0.01` in 1-hour candles, the full AMA warm-up for
the built-in presets is:

| Preset | Candles | Days |
|--------|---------|------|
| `AMA1` | `1,822` | `75.9` |
| `AMA2` | `1,874` | `78.1` |
| `AMA3` | `1,925` | `80.2` |
| `AMA4` | `2,023` | `84.3` |

These totals include the ER buffer, the convergence window, and the default
9-bar lookback used by the dynamic-weight logic. If the candle timeframe is
not 1 hour, scale the total by the candle duration.

**Why `slowPeriod` dominates:** `slowSC ≈ 2 / slowPeriod`, so `SC_avg` scales
as `~ (2 / slowPeriod)² = 4 / slowPeriod²`. Since `convergenceBars` is
proportional to `1 / SC_avg`, the required candle count scales as
**O(slowPeriod²)**, not O(slowPeriod). For the AMA3 default (`slowPeriod = 112.7`)
this is roughly 1130 convergence bars; doubling `slowPeriod` would quadruple
that requirement.

If the adapter has fewer candles than the warmup window, the AMA output is too
biased for grid centering and the cycle skips with reason
`ama_warmup_insufficient`.

Stale data suppresses trigger writes. Check `staleData` and `staleAgeHours` in
`market_adapter/state/market_adapter_state.json` when a trigger should have
fired but did not.

### State Files

| File | Contents |
|------|----------|
| `market_adapter/state/market_adapter_state.json` | Full per-bot state, signals, weights, staleness, and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Compact center-price snapshot |
| `market_adapter/state/market_adapter.lock` | Single-instance runtime lock |

If the adapter crashed and is no longer running, a stale lock file can be
removed manually.

### Monitoring Fields

Important fields in `market_adapter/state/market_adapter_state.json`:

| Field | Meaning |
|-------|---------|
| `lastRunAt` | Last completed adapter cycle |
| `botsProcessed` | Number of bots evaluated |
| `cycleMs` | Cycle wall-clock duration |
| `lastAmaPrice` | Latest computed AMA price for a bot |
| `centerPrice` | Stored center used for delta comparison |
| `lastDeltaPercent` | Move from stored center to latest AMA |
| `thresholdPercent` | Active recalc trigger threshold |
| `triggered` | Whether a trigger was written this cycle |
| `staleData` | Whether stale candles suppressed live writes |
| `staleAgeHours` | Age of the newest usable candle |
| `trend` | `UP`, `DOWN`, or `NEUTRAL` |
| `atr` | Average True Range value |
| `weightVariance` | Normalized volatility ratio |
| `weights` | Current dynamic buy/sell weights |
| `collateralRecommendation` | Advisory collateral-ratio hint |
