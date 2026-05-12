# Market Adapter

The market adapter is the live signal layer for AMA-priced bots. It reads
candles, computes the AMA center price, optionally writes dynamic weights, and
creates recalc triggers when a bot accepts its first center, when the center
moves far enough, or when whitelisted range-scaling slope drift requires a
grid-bound reset.

DEXBot2 starts and stops the adapter automatically when active AMA bots exist.

## Big Picture

The adapter feeds four separate grid controls from the same candle/AMA pipeline:

| Control | Signal | Effect |
|---------|--------|--------|
| Grid price | AMA price | Moves the grid center through bootstrap and delta reset triggers |
| Grid range scaling | AMA slope | Widens the trend side and tightens the opposite bound through whitelisted slope reset triggers |
| Asymmetric weight shift | AMA slope + Kalman filter | Biases buy/sell allocation in the trend direction |
| Symmetric weight shift | Volatility | Reduces both buy and sell weights during noisy periods |

In short: AMA price sets the center; AMA slope scales the range; AMA plus
Kalman drives directional weight bias; volatility applies the symmetric penalty.

## Quick Start

### 1. Enable AMA

Set `gridPrice` to `ama`, `ama1`, `ama2`, `ama3`, or `ama4` in
`profiles/bots.json` or through `node dexbot bots`. Use `ama` for the pair's
default preset.

`startPrice` selects the candle source:

| `startPrice` | Adapter source |
|--------------|----------------|
| `pool` | LP history |
| `book` | Orderbook history |
| numeric value | Fixed anchor (skips candle fetching and SMA warmup); used directly as the static seed price |

When fetching candles (`pool` or `book`), the adapter requires a full historical window. The oldest `erPeriod` candles are used for an initial SMA (Simple Moving Average) warmup phase to seed the AMA and establish the first Efficiency Ratio (ER) calculation. See [AMA Warmup Window](#ama-warmup-window--why-candle-length-matters) for technical details.

### 2. Whitelist Live Writes

Generate the whitelist from AMA-enabled bots. Without a whitelist entry, the
adapter still computes state, but live grid snapshots and recalc triggers stay
in dry-run mode.

```bash
npm run market-adapter:whitelist
```

This writes `profiles/market_adapter_whitelist.json`.

To whitelist AMA pricing but keep dynamic weights disabled:

```bash
node scripts/generate_market_adapter_whitelist.js --no-dynamic-weight
```

To keep asymmetric bounds disabled:

```bash
node scripts/generate_market_adapter_whitelist.js --no-asymmetric-bounds
```

### 3. Start DEXBot2

Start DEXBot2 normally. The bot runtime launches the adapter when needed.

## Grid Price

Grid price is the AMA price used as the grid center. `gridPrice: "ama"` uses
the pair's `defaultAma` from
`profiles/market_profiles.json`. `gridPrice: "ama1"` through
`gridPrice: "ama4"` force a specific preset. If no pair profile matches, the
bot's `ama` block is used as the fallback.

### Empirical Divergence Risk Management

The adapter uses tiered clamping thresholds to manage inventory risk during extreme price divergence from the AMA trend center. These thresholds are derived from historical pool volatility and replace static 'fit cap' multipliers. The specific clamping limits and exit parameters are calculated per pair and preset using:

```bash
node analysis/ama_fitting/calculate_clamping_limits.js
```

| AMA preset | 99.9% — 3.29σ (Soft-Clamp) | 99.99% — 3.89σ (Hard-Clamp) | 99.999% — 4.42σ (Limit Exit) |
|------------|-------------------:|--------------------:|-------------------------:|
| AMA1 | 1.461x | 1.571x | 1.626x |
| AMA2 | 1.467x | 1.564x | 1.619x |
| **AMA3** | 1.473x | 1.557x | 1.612x |
| AMA4 | 1.479x | 1.546x | 1.601x |

Divergence is calculated as `abs(Price - AMA) / AMA`. Limit exits trigger when price exceeds the 99.9th percentile of historical divergence, protecting the bot from extreme price excursions and preventing runaway inventory accumulation during high-divergence volatility.

## Grid Range Scaling

AMA slope can tilt the configured range. In a trend, the adapter gives the grid
more room on the trend side and less room on the opposite side.

This is separate from dynamic buy/sell weighting. It is enabled only when
`asymmetricBounds: true` is set in
`profiles/market_adapter_whitelist.json`.

Technical formula and tuning details are in
[Grid Range Scaling Model](#grid-range-scaling-model).

When range scaling is whitelisted, the adapter persists the accepted slope
baseline in `gridRangeScalingAmaSlope`. A reset trigger is emitted only when
the slope delta crosses the configured threshold; direction changes alone do
not reset the grid.

## Asymmetric Weight Shift

AMA slope plus Kalman filter confirmation can bias the bot's configured
`weightDistribution` in the trend direction. In an uptrend or downtrend, this
can shift allocation toward the side the strategy wants to emphasize while
still starting from the bot's static buy/sell weights.

## Symmetric Weight Shift

Volatility can reduce both buy and sell weights during noisy periods. This is a
shared penalty on both sides, separate from the directional AMA/Kalman bias.

Both weight shifts are controlled separately from AMA pricing. Set
`dynamicWeight: false` in `profiles/market_adapter_whitelist.json` to keep AMA
pricing active but leave buy/sell weights static. Most users should leave the
tuning values alone unless they are fitting or testing strategy parameters.
Technical formula and tuning details are in [Dynamic Weight Model](#dynamic-weight-model).

## Trigger Threshold

The adapter writes a recalc trigger when both conditions are true:

- the AMA center moved more than `AMA_DELTA_THRESHOLD_PERCENT`
- candle data is not stale

Configure the default in `profiles/general.settings.json` or from the
`node dexbot bots` general settings menu:

```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2.0
  }
}
```

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

## Live Writes and Dry-Run

The whitelist controls what the adapter may write. Non-whitelisted bots are
still processed, but live grid files and recalc triggers are suppressed.

| Invocation | Behavior |
|---|---|
| `node market_adapter/market_adapter.js` | Whitelisted bots write live files; others dry-run |
| `node market_adapter/market_adapter.js --dryRun` | All bots dry-run |
| `node market_adapter/market_adapter.js --whitelist-all` | All AMA bots write live files |

Dry-run log lines include `[DRY RUN]` or `[suppressed, dry-run]`.

## Useful Commands

| Task | Command |
|------|---------|
| Generate whitelist | `npm run market-adapter:whitelist` |
| Preview whitelist | `node scripts/generate_market_adapter_whitelist.js --dry-run` |
| Run one adapter cycle | `node market_adapter/market_adapter.js --once` |
| Run one cycle with threshold override | `node market_adapter/market_adapter.js --once --deltaPercent 1.5` |
| Run continuously | `node market_adapter/market_adapter.js` |
| Print one-cycle JSON signals | `node market_adapter/ama_signal_runner.js` |
| Print one bot's compact signal output | `node market_adapter/ama_signal_runner.js --bot <botKey> --compact` |

`--deltaPercent` changes the threshold only for that run.

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

Export candles and charts:

```bash
node market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 8760h
node market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start 2025-03-06 --end 2026-03-06
npm run lp:chart -- --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

Research and calibration:

```bash
node analysis/analyze_dynamic_weight.js --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node analysis/analyze_volatility.js --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node analysis/ama_fitting/calibrate_convergence_er.js --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

More tools:

- [Analysis README](../analysis/README.md)
- [Scripts README](../scripts/README.md)

## Technical Reference

This section keeps the full market adapter details in one place. Normal
operation should follow the Quick Start above.

### Purpose and Boundaries

The market adapter bridges historical analysis and live bot operation. It keeps
fresh market candles per bot, computes the AMA-based market center, evaluates
trend and volatility signals, writes dynamic weight snapshots, and emits recalc
triggers when the grid should be rebuilt.

For the similar bot-scoped debt workflow and collateral advisory path, see
[MPA and Credit Usage](../docs/MPA_CREDIT_USAGE.md).

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

AMA slope      -> grid range scaling
AMA slope      -> directional trend channel
Kalman signal  -> trend confirmation channel
ATR            -> symmetric volatility penalty
trend + ATR    -> dynamic buy/sell weights

trend regime   -> advisory collateral-ratio hint
first AMA center -> recalculate.<botKey>.trigger for bootstrap
AMA delta      -> recalculate.<botKey>.trigger
AMA slope delta -> recalculate.<botKey>.trigger for grid range scaling bots
```

Per cycle, per processed bot, the adapter can produce:

| Output | Meaning |
|--------|---------|
| `gridCenterPrice` | AMA-derived grid center, clamped to bounds |
| `weights` | Dynamic `{ buy, sell }` grid weights |
| `trend` | `UP`, `DOWN`, or `NEUTRAL` |
| `atr` / `weightVariance` | Volatility diagnostics |
| `dynamicWeights` | Runtime payload with effective weights and range-scaling diagnostics |
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
9. Persist the first accepted center, compare center delta, and compare whitelisted range-scaling slope delta.
10. Suppress live writes if the bot is not whitelisted or candle data is stale.
11. Write `dynamicgrid.json` and a recalc trigger for bootstrap, AMA-center threshold, or grid-range-scaling AMA-slope threshold events.
12. Persist state snapshots under `market_adapter/state/`.

### Files

| File | Purpose |
|------|---------|
| `profiles/bots.json` | Active bots, symbols, pool IDs, and `gridPrice` settings |
| `profiles/market_profiles.json` | Pair AMA profiles and defaults |
| `profiles/market_adapter_whitelist.json` | Per-bot live-write permissions |
| `profiles/market_adapter_settings.json` | Advanced adapter and dynamic-weight tuning |
| `profiles/general.settings.json` | Global market adapter threshold settings |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |
| `profiles/logs/market_adapter.log` | Standalone adapter runtime log |

### What the Adapter Writes

During normal operation, the adapter may write:

| File | Purpose |
|------|---------|
| `profiles/orders/<botKey>.dynamicgrid.json` | Persisted AMA center snapshot, AMA slope diagnostics, and optional dynamic weights used by the bot runtime |
| `profiles/recalculate.<botKey>.trigger` | Signal for `dexbot.js` to rebuild the grid |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |
| `market_adapter/data/` | Candle caches and exported LP data |
| `profiles/logs/market_adapter.log` | Standalone adapter runtime log |

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
  "gridCenterPrice": 1294.6,
  "centerPrice": 1294.6,
  "amaCenterPrice": 1294.6,
  "amaSlope": {
    "trend": "UP",
    "slopePct": 0.04,
    "slopeOffset": 0.16
  },
  "amaSlopeDeltaPercent": 0.015,
  "amaSlopeThresholdPercent": 0.015,
  "updatedAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.js",
  "dynamicWeights": {
    "effectiveWeights": { "sell": 0.45, "buy": 0.55 },
    "baseWeights": { "sell": 0.5, "buy": 0.5 },
    "isReady": true
  }
}
```

- `gridCenterPrice` is the persisted grid baseline used for future delta checks.
- `centerPrice` remains as a compatibility alias for older readers.
- `amaCenterPrice` is the raw AMA output before downstream handling.
- `amaSlope` is the latest AMA slope snapshot used for diagnostics and snapshot writes.
- `gridRangeScalingAmaSlope` in adapter state is the last grid-reset slope baseline used for slope-triggered range-scaling resets.
- `amaSlopeDeltaPercent` records the change from the last grid-reset slope baseline.
- `amaSlopeThresholdPercent` is the configured slope-reset threshold.
- `amaSlope.trend` records the current direction; direction changes do not trigger resets unless the slope delta threshold is crossed.
- During a manual grid reset, the bot refreshes `gridCenterPrice` from the latest
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
|-- log_format.js                  adapter startup and signal log formatting
|-- test_helpers.js                test utilities
|-- core/
|   |-- asymmetric_bounds.js       AMA-slope range scaling helpers
|   |-- market_adapter_service.js  full signal pipeline service
|   |-- config_normalizers.js      shared config normalization
|   |-- kibana_client.js           low-level Kibana/ES query client
|   |-- kibana_candles.js          LP pool candle fetch engine
|   |-- kibana_market_candles.js   orderbook candle fetch and transform
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
      "dynamicWeight": true,
      "asymmetricBounds": true
    }
  }
}
```

- `ama: true` allows live `dynamicgrid.json` and recalc trigger writes.
- `dynamicWeight: true` allows dynamic weights to be applied by the bot runtime,
  but only when the snapshot is also marked ready.
- `asymmetricBounds: true` allows AMA-slope grid range scaling during grid rebuilds.
  Runtime code reports this as `gridRangeScalingWhitelisted`; the whitelist key
  remains `asymmetricBounds` for compatibility.
- Omitted whitelist flags are treated as `false`.
- Missing whitelist file means all live AMA writes are suppressed.
- Missing bot entry means that bot runs in dry-run mode.

### Grid Range Scaling Model

Grid range scaling is the technical path for:

```text
AMA slope -> min/max bound tilt
```

During a grid rebuild, the bot loads the latest dynamic grid snapshot and uses
the AMA slope diagnostics to tilt the configured `minPrice` and `maxPrice`
around the AMA center. An uptrend widens the upper bound and tightens the lower
bound; a downtrend widens the lower bound and tightens the upper bound.

This uses `dynamicWeights.trend`, `dynamicWeights.slopeOffset`, and
`dynamicWeights.maxSlopeOffset`, but it is separate from the dynamic buy/sell
weight shift. The whitelist flag is `asymmetricBounds`.

```
slope = average AMA slope percent per bar over the lookback window
slopeOffset = slope normalized to the configured dynamic-weight slope cap
asymmetry = min(|slopeOffset| / maxSlopeOffset, 1) × maxAsymmetryFactor

Downtrend: minPrice = center / (M × (1 + asymmetry))
           maxPrice = center × (M × (1 - asymmetry))

Uptrend:   maxPrice = center × (M × (1 + asymmetry))
           minPrice = center / (M × (1 - asymmetry))

Neutral:   symmetric bounds (asymmetry = 0)
```

`ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR` defaults to `0.35`; `0` disables the
tilt. Override per bot in `profiles/market_adapter_settings.json`:

```json
{
  "asymmetricBounds": {
    "maxAsymmetryFactor": 0.35
  }
}
```

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
  "amaCenterPrice": 1294.6,
  "poolId": "1.19.133"
}
```

`dexbot.js` watches for this file and rebuilds the affected grid from current
runtime state. The trigger is separate from `dynamicgrid.json`: the trigger
requests a rebuild, while the snapshot carries the center and live weight state
that the runtime can reload.

### Dynamic Weight Model

Dynamic weights start from the bot's configured `weightDistribution`. These
configured values are the static baseline.

The production dynamic-weight output combines:

| Branch | Role |
|--------|------|
| AMA slope | Measures filtered market direction and velocity |
| Kalman signal | Confirms directional movement |
| ATR volatility | Applies a symmetric risk penalty to both sides |
| Regime gates | Suppress weak or noisy signals |

On each closed-candle cycle, the adapter applies two adjustments:

| Adjustment | Signal | Formula effect |
|------------|--------|----------------|
| `trendOffset` | AMA slope + Kalman confirmation | Subtracts from sell, adds to buy |
| `volatilityPenalty` | Volatility | Adds the same normally negative value to both sides |

```text
effectiveSell = staticSell - trendOffset + volatilityPenalty
effectiveBuy  = staticBuy  + trendOffset + volatilityPenalty
```

A positive `trendOffset` shifts weight toward buy and away from sell. A
negative `trendOffset` shifts weight toward sell and away from buy. The final
values are clamped and rounded before being written to the dynamic grid
snapshot.

Main override knobs live in `profiles/market_adapter_settings.json`:

| Setting | Meaning |
|---------|---------|
| `alpha` | AMA vs Kalman blend |
| `dw` | Kalman displacement weighting |
| `gain` | Output amplitude |
| `amaSlopePercentMode` | Slope override units: `perBar` for average percent per bar, or `window`/unset for legacy cumulative percent over the lookback |
| `amaSlope.lookbackBars` | AMA slope lookback; slope is averaged per bar over this window |
| `amaSlope.neutralZonePct` | Dead band around flat average AMA slope |
| `amaSlope.maxSlopePct` | Average AMA slope saturation |
| `amaSlopeDeltaThresholdPercent` | Average AMA slope delta threshold for slope-based resets |
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

When migrating older settings, either divide AMA slope percent overrides by
`amaSlope.lookbackBars`, or add `"amaSlopePercentMode": "window"` and let the
adapter convert them at load time. New settings should use
`"amaSlopePercentMode": "perBar"` so small per-bar values are not converted
again by pair or bot overrides.

Most operators should tune only the price and slope trigger thresholds plus the AMA profile unless
they are deliberately fitting a market.

### Candle and Staleness Handling

The adapter keeps candle caches current using Kibana bootstrap plus native
incremental updates. It repairs gaps through targeted Kibana fetches when
possible, prunes old candles to the required AMA window, and acts only on closed
1h candles.

#### AMA Warmup Window — Why Candle Length Matters

The AMA is a recursive (infinite impulse response) filter. On cold start, the adapter uses an initial warmup phase: it calculates an **SMA (Simple Moving Average)** over the first `erPeriod` candles to establish a stable seed price, while simultaneously building the price history needed to calculate the first valid Efficiency Ratio (ER).

Starting the recursive AMA formula from this SMA, rather than a single raw closing price, provides a more stable anchor. However, a residual initialization bias still exists and decays asymptotically — each bar, the AMA "forgets" a fraction equal to its smoothing constant:

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
| `gridCenterPrice` | Stored center used for delta comparison |
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
