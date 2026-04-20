# Market Adapter

## Overview

The **Market Adapter** is the central entry point for all dynamic bot adjustment in DEXBot2.

It combines candle synchronization, AMA signal computation, trend detection,
ATR-based volatility analysis, dynamic weight calculation, and collateral
management into a single service layer.

**Core Purpose**: Bridge historical analysis (`/analysis`) and live operations by:
- Keeping fresh LP candles per-bot
- Computing the AMA-based market center (grid price)
- Detecting trend and volatility regime
- Computing dynamic buy/sell weight bias
- Estimating target collateral ratio
- Emitting trigger files for grid re-centering

The adapter runs as a standalone process, separate from `dexbot.js`. How often
it fetches new candles from the BitShares API or Kibana server is governed by a
timing setting (default: **1 hour**).

---

## Signal Pipeline

```
price_candles -> price_adapter -> AMA -> Grid Price

AMA           -> slope_analysis -> slope_offset      (asymmetric weight shift) \
price_candles -> ATR            -> weight_variance  (symmetric shift)         +-> weight_output

slope_analysis -> expected Collateral Ratio
               -> adjust debt -> adjust collateral -> delta liquidity -> reset bot
```

**Inputs**:
- `price_candles` — from the adapter candle-sync pipeline (Kibana bootstrap + native incremental)
- `config_settings` — per-bot AMA and threshold config from `bots.json`

**Outputs** (per cycle, per bot):
- `gridPrice` — AMA, clamped to min/max bounds
- `weights` — `{ buy, sell }` — dynamic grid weighting
- `collateral` — target collateral ratio recommendation
- `trend` / `atr` — raw regime and volatility signals
- Trigger files when grid price delta exceeds threshold

---

## Architecture

### Relationship to Other Components

```
analysis/                    market_adapter/              bot execution
─────────────────           ──────────────────           ────────────
ama_fitting/      ──┐
(history tools)   ──├─→ [Market Analysis] ──→ [Decision Engine] ──→ bots.json ──→ dexbot.js
sensitivity/      ──┤    (current market)     (real-time rules)
spread_analysis/  ──┘
```

**Data Flow**:
1. `analysis/` produces optimization context and candidate AMA settings
2. `market_adapter/` fetches/updates LP candles (Kibana bootstrap + native incremental)
3. `market_adapter/` computes the AMA-derived grid center and runs the separate trend / ATR / collateral signal branches
4. `market_adapter/` writes state snapshots and trigger files
5. `dexbot.js` reacts to `profiles/recalculate.<botKey>.trigger` to re-center the grid

---

## Scope

### ✅ In Scope
- **Real-time Market Monitoring**: Track volatility, price action, and market regime per-bot
- **Candle Synchronization**: Keep per-bot LP candles current and pruned to AMA-required windows
- **AMA Center Calculation**: Compute AMA-based grid price with clamping
- **AMA Slope Analysis**: Compute buy/sell weight offset directly from AMA slope (trend speed and direction)
- **ATR Volatility**: Compute Average True Range for live symmetric penalty handling and diagnostics
- **Dynamic Weights**: Live adapter combines AMA trend bias + Kalman confirmation, with ATR applied as a separate symmetric penalty
- **Collateral Management**: Recommend target collateral ratio based on trend regime
- **Trigger Emission**: Create per-bot recalc trigger files when threshold is crossed
- **Gap Repair**: Detect and patch missing candle timestamps via Kibana
- **Runtime Safety**: Single-instance lock, retries/backoff, stale-data suppression

### ❌ Out of Scope
- Historical backtest optimization (→ `/analysis`)
- Direct order placement or execution (→ `dexbot.js`)
- Bot lifecycle management (start/stop/restart)
- Long-term strategy design or rule authoring

---

## Module Structure

```
market_adapter/
├── README.md
├── market_adapter.js            # Main adapter daemon: candle sync, AMA center, trigger loop
├── ama_signal_runner.js         # One-cycle JSON CLI for AMA/adapter output
├── candle_utils.js              # Candle transforms, gap detection, pruning helpers
├── interval_utils.js            # Shared interval label formatting
├── merge_lp_data.js             # CLI utility for merging exported LP candle files
├── lp_chart_core.js             # Renderer-only LP chart HTML generator
├── lp_chart_strategy_loader.js  # AMA strategy/profile resolution for LP charts
├── lp_chart_runner.js           # Shared LP chart orchestration used by scripts and npm commands
│
├── core/                        # Service layer used by the adapter loop
│   ├── market_adapter_service.js  # MarketAdapterService class — full signal pipeline
│   ├── kibana_client.js           # Low-level Kibana HTTP client
│   ├── kibana_market_candles.js   # Kibana candle fetch/transform
│   └── strategies/                # Signal and recommendation modules
│       ├── ama_slope_model.js     # computeAmaSlopeWeights(amaValues, weightVariance)
│       ├── collateral_manager.js  # adjustCollateralRatio(trend, min, max)
│       └── atr/
│           └── calculator.js      # calculateATR(candles, period)
│
├── inputs/                      # LP data acquisition tools (importable + CLI)
│   ├── kibana_source.js           # Elasticsearch LP data source
│   └── fetch_lp_data.js           # Pool-centric historical Kibana exporter
│
├── data/                        # Runtime-generated candle caches and LP exports
└── state/                       # Runtime-generated adapter state, centers, and lock file
```

Top-level files are the operator-facing entrypoints plus shared utilities.
`core/` holds the reusable runtime pipeline, and `inputs/` holds LP data acquisition tools.
`data/` and `state/` are runtime output directories, not source modules.

### LP Chart Workflow

LP chart generation is now split into a shared runner plus thin wrappers.
The user-facing entrypoint is:

- Recommended user entrypoint: `npm run lp:chart -- --data <lp-export.json>`
- Parallel ECharts experiment: `npm run lp:chart:echarts -- --data <lp-export.json>`
- Parallel uPlot experiment: `npm run lp:chart:uplot -- --data <lp-export.json>`
- Shared implementation: `market_adapter/lp_chart_runner.js`

Responsibility split:

- `scripts/generate_lp_chart.js` orchestrates the full "generate both charts" flow.
- `analysis/ama_fitting/generate_unified_comparison_chart.js` is now synthetic-only.
- `market_adapter/lp_chart_runner.js` owns LP data discovery, strategy loading, AMA calculation, output paths, HTML generation, and optional browser opening.
- `market_adapter/lp_chart_core.js` stays focused on rendering HTML only.

Typical usage:

```bash
# Generate both the market chart and the comparison chart from one LP export
npm run lp:chart -- --data analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json
```

---

## How It Works

### 1. Candle Sync

`market_adapter.js` runs per cycle and updates per-bot candles:
- **Bootstrap**: If no local cache exists, fetch from Kibana; fall back to native BitShares API
- **Incremental**: Merge incoming native trades into existing candle cache
- **Gap repair**: Detect missing candle timestamps and patch them with a targeted Kibana fetch
- **Prune**: Trim to the minimum window required for the current AMA config

### 2. AMA Center + Grid Price

For each bot, `MarketAdapterService` computes:
- **AMA value** using per-bot `ama` config (or the built-in default AMA profile, `AMA3`, when no pair-specific profile exists)
- **Center price** = AMA, clamped to configured min/max

### 3. AMA Slope Analysis

The adapter computes the slope of the AMA series over a lookback window
(`computeAmaSlopeWeights` in `core/strategies/ama_slope_model.js`).
This provides a direct, filtered measure of real market velocity, used to
classify the trend as `UP`, `DOWN`, or `NEUTRAL` and derive a weight bias.

### 4. ATR Volatility

`calculateATR(candles, MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT)` (in
`core/strategies/atr/calculator.js`) computes the ATR used by the volatility branch.
The built-in default is `14`.

`weightVariance = atr / amaPrice` — a normalized volatility ratio used as a symmetric
weight variance input.

### 5. Dynamic Weights

Dynamic weight in production combines AMA slope, Kalman confirmation, and regime gating.
ATR remains part of the live output only as a separate symmetric penalty after the
directional signal is built. The HTML research tool is a simplified trend view and
does not include that live ATR penalty branch.

In the research runner, ATR is intentionally hardcoded to `0` and `weightVariance` is
set to `0` as well. That keeps the analysis focused on the directional AMA/Kalman
signal path and prevents the live volatility penalty from contaminating the chart.

At runtime, the directional trend component is only applied when it exceeds
`DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD` (or `minOutputThreshold` via overrides).
The separate symmetric ATR shift uses `DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD`.

### Symmetric Shift

The volatility branch is intentionally separate from the directional AMA/Kalman branch.

Variable mapping:

- `atr` = `calculateATR(candles, MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT)`
- `weightVariance` = `atr / amaPrice`
- `volatilityExponent` = `MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT`
- `volatilityScaleX` = `MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT` (10x default, 1x–100x in the volatility chart)
- `volatilityThreshold` = `MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD`
- `MAX_SYMMETRIC_SHIFT` = `MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP` (default 0.5, overrideable per pair/bot via `maxVolatilityOffset`)
- `atrPeriod` = `MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT` (default 14, adjustable in the volatility research chart from 3 to 30)

Implementation shape:

```text
rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
clampedRawDelta   = clamp(rawSymmetricDelta, -MAX_SYMMETRIC_SHIFT, 0)
volatilityPenalty = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
```

The resulting `volatilityPenalty` is added to both sides after the trend term is built:

```text
effectiveSell = clamp(staticSell + trendOffset + volatilityPenalty, MIN_WEIGHT, MAX_WEIGHT)
effectiveBuy  = clamp(staticBuy  - trendOffset + volatilityPenalty, MIN_WEIGHT, MAX_WEIGHT)
```

The research chart in `analysis/analyze_volatility.js` uses the same penalty math but omits the directional trend branch.

### 6. Collateral Management

`adjustCollateralRatio(trendData, minRatio, maxRatio)` (in `core/strategies/collateral_manager.js`):
- Recommends a target collateral ratio based on trend regime
- Used to drive collateral rebalancing (adjust debt → adjust collateral → delta liquidity → reset bot)

### 7. Trigger Decision

Adapter writes `profiles/recalculate.<botKey>.trigger` when:
- AMA delta exceeds the configured percentage threshold **and**
- Candle data is not stale (`--maxStaleHours` guard)

Threshold resolution order:
1. CLI `--deltaPercent <n>` override
2. `profiles/general.settings.json` → `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`
3. Built-in default: `2.5` (%)

### 8. State Persistence

Adapter writes machine-readable state after every cycle:
- `market_adapter/state/price_adapter_state.json` — full per-bot state including `weights`, `collateral`, `trend`, `atr`
- `market_adapter/state/price_adapter_centers.json` — lightweight center snapshot

---

## Configuration

### Trigger Threshold

```json
// profiles/general.settings.json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2.5
  }
}
```

### Per-Bot AMA Settings

Bots opt in to AMA grid pricing by setting `gridPrice` to one of the AMA keywords in `profiles/bots.json`.
The AMA parameters are resolved from `profiles/market_profiles.json` (pair-matched, written by the optimizer).
If no profile exists for the pair, built-in constants are used.

```json
{
  "name": "XRP-BTS",
  "assetA": "IOB.XRP",
  "assetB": "BTS",
  "gridPrice": "ama"
}
```

Valid `gridPrice` keywords: `ama`, `ama1`, `ama2`, `ama3`, `ama4`.
`"ama"` resolves to the profile's `defaultAma` key (typically `AMA3`).
Bots with any other `gridPrice` value are ignored by the market adapter.

### AMA Center Behavior

The market adapter persists the AMA-derived center price directly. There is no
additional deviation-based price adjustment layer on top of the AMA output.

---

## Configuration Files

| File | Purpose |
|------|---------|
| `profiles/bots.json` | Active bots, symbols, pool IDs, and per-bot AMA settings |
| `profiles/general.settings.json` | Global `MARKET_ADAPTER` settings (delta threshold, etc.) |
| `profiles/market_adapter_settings.json` | Pair-level and bot-level overrides for dynamic-weight and adapter tuning |
| `profiles/price_adapter_whitelist.json` | Optional whitelist — bots not listed run in dry-run mode |
| `profiles/dynamic_weight_whitelist.json` | Optional whitelist — only listed bots receive dynamic weight payloads |
| `market_adapter/state/price_adapter_state.json` | Runtime state — candle metadata, signals, weights, collateral |
| `market_adapter/state/price_adapter_centers.json` | Lightweight center snapshot |

### Dynamic Weight Knobs

The production adapter reads the same dynamic-weight defaults as the research chart from `modules/constants.js`.
The main runtime knobs are:

- `alpha` - AMA vs Kalman blend
- `dw` - Kalman displacement weighting (default 0.5)
- `gain` - output amplitude (default 0.8)
- `maxSlopeOffset` - cap for the asymmetric trend offset
- `maxVolatilityOffset` - cap for the symmetric ATR penalty
- `absoluteThreshold` - dead-band before regime filtering is applied
- `atrPeriod` - ATR lookback used by the volatility penalty
- `volatilityExponent` - exponent for the ATR penalty
- `volatilityScaleX` - scale factor for the ATR penalty
- `volatilityThreshold` - minimum penalty before the volatility shift applies
- `kalmanSmoothPct` - raw-vs-smoothed Kalman blend (0-200; 100 = normal adaptive smoothing)
- `kalmanDispScaleMult` - displacement scale multiplier
- `kalmanDispThresholdMult` - displacement threshold multiplier
- `lookbackBars` - AMA slope lookback (default 8)
- `kalmanSmoothSpanPct` - adaptive EMA span ratio
- `signalConfirmBars` - output/signal latch confirmation bars

These values can be overridden in `profiles/market_adapter_settings.json` at the pair or bot level.

---

## Usage

### Running the Adapter

```bash
# One full sync + signal cycle (safe test)
node market_adapter/market_adapter.js --once

# Continuous daemon loop (runs every configured interval)
node market_adapter/market_adapter.js

# Custom trigger threshold
node market_adapter/market_adapter.js --deltaPercent 1.5

# View latest state snapshot
cat market_adapter/state/price_adapter_state.json
```

### AMA Signal Runner (JSON Output)

```bash
# One cycle — prints JSON for all processed bots
node market_adapter/ama_signal_runner.js

# Filter by bot name or key
node market_adapter/ama_signal_runner.js --bot XRP-BTS
node market_adapter/ama_signal_runner.js --bot xrp-bts-0 --compact
```

Output format (one entry per processed bot):

```json
{
  "ok": true,
  "updatedAt": "2026-03-01T09:01:00.000Z",
  "metrics": { "cycleMs": 4200, "botsProcessed": 1 },
  "botCount": 1,
  "bots": [
    {
      "botName": "XRP-BTS",
      "botKey": "xrp-bts-0",
      "ok": true,
      "source": "native",
      "candleCount": 720,
      "amaPrice": 1294.6,
      "deltaPercent": 1.1,
      "thresholdPercent": 1.0,
      "triggered": true,
      "triggerPath": "profiles/recalculate.xrp-bts-0.trigger",
      "weights": { "buy": 0.55, "sell": 0.45 },
      "trend": "UP"
    }
  ]
}
```

### LP Data Export (Analysis Inputs)

The pool-centric exporter lives under `market_adapter/inputs/` and can be run standalone:

```bash
# Pool-centric Kibana exporter used by analysis workflow
node market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 8760h
```

### Dry-Run Mode

By default, every bot that is **not whitelisted** runs in dry-run mode: candles and state are
fully computed and persisted, but no files that dexbot acts on are written
(`profiles/orders/<botKey>.dynamicgrid.json` and `profiles/recalculate.<botKey>.trigger`).

| Invocation | Behavior |
|---|---|
| No flags (default) | Whitelisted bots write for real; all others dry-run |
| `--dryRun` | All bots dry-run regardless of whitelist |
| `--whitelist-all` | All bots write for real regardless of whitelist |

Dry-run output is visible in the log with `[DRY RUN]` tags and `[suppressed, dry-run]` on triggered lines.

### Whitelist

```json
// profiles/price_adapter_whitelist.json
{
  "whitelist": ["xrp-bts-0", "h-bts-1"]
}
```

List bot **keys** (not names). Bots listed here write dynamicgrid and trigger files for real.
If the file is missing, all bots run in dry-run mode.

### Automated Execution (PM2)

```javascript
// In profiles/ecosystem.config.js or pm2.js
{
  name: "market-adapter",
  script: "market_adapter/market_adapter.js",
  instances: 1,
  exec_mode: "fork",
  cron_restart: "0 * * * *"  // Every hour
}
```

---

## Integration with dexbot.js

The adapter runs independently. `dexbot.js` picks up changes by:
1. Watching for `profiles/recalculate.<botKey>.trigger`
2. Re-centering the affected bot grid

The adapter does **not** edit `profiles/bots.json`, start/stop bots, or place/cancel on-chain orders.

---

## Monitoring

### Runtime State Fields

Key fields in `market_adapter/state/price_adapter_state.json`:

```
lastRunAt             - Timestamp of last completed cycle
botsProcessed         - Number of bots evaluated
cycleMs               - Cycle wall-clock duration (ms)

per-bot entries:
  lastAmaPrice        - Latest computed AMA value
  centerPrice         - Stored center (baseline for delta comparison)
  lastDeltaPercent    - Delta computed last cycle
  thresholdPercent    - Active trigger threshold
  staleData           - true if candle age exceeded maxStaleHours
  staleAgeHours       - How old the latest candle is
  triggered           - true if trigger file was written this cycle
  trend               - "UP" | "DOWN" | "NEUTRAL"
  atr                 - 14-period Average True Range value
  weightVariance      - Normalized volatility ratio (atr / amaPrice)
  weights             - { buy, sell } dynamic weight output
  collateral          - Recommended target collateral ratio
```

### Cycle Log Format

Each bot processed emits a log line like:

```
[XRP-BTS] native, candles=720, ama=1294.60000, delta=1.10%, threshold=1.00% TRIGGERED -> profiles/recalculate.xrp-bts-0.trigger trend=UP weights[buy=0.55, sell=0.45]
```

### Alert Conditions

- ⚠️ **Trigger not firing**: Check `lastDeltaPercent` vs `thresholdPercent` in state file
- ⚠️ **Stale data**: `staleData: true` — candle sync failing, check network/API access
- ⚠️ **Gap warnings**: Unresolved candle gaps after Kibana repair attempt
- 🔴 **Lock file stuck**: If `market_adapter/state/price_adapter.lock` remains after a crash, delete it manually

---

## Trigger File Format

When threshold is exceeded, the adapter writes a trigger file like:

```json
{
  "createdAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.js",
  "botName": "XRP-BTS",
  "botKey": "xrp-bts-0",
  "thresholdPercent": 0.8,
  "deltaPercent": 1.1,
  "previousCenterPrice": 1280.5,
  "newCenterPrice": 1348.32,
  "referencePrice": 1294.6,
  "rawAmaPrice": 1294.6,
  "poolId": "1.19.133"
}
```

---

## Example Workflow

```
[09:00] Adapter cycle starts — updates candles for all bots
[09:01] AMA computed, trend=UP, confidence=72
[09:01] centerPrice = 1294.6 (AMA center)
[09:01] Delta vs stored center = 1.21% — exceeds threshold (1.0%)
[09:01] weights={buy=0.57, sell=0.43}, collateral=1.62
[09:01] Adapter writes profiles/recalculate.xrp-bts-0.trigger
[09:02] dexbot consumes trigger and recalculates grid center
[10:00] Next cycle repeats with incremental native candle updates
```

---

## Troubleshooting

### Triggers not being created
1. Check `lastAmaPrice` in state file is populated
2. Compare `lastDeltaPercent` vs `thresholdPercent`
3. Check `staleData` / `staleAgeHours` — stale data suppresses triggers
4. Check lock/state files under `market_adapter/state/`

### Trigger fires too often / too rarely
1. Adjust `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT` in `profiles/general.settings.json`
2. Or pass `--deltaPercent <n>` for a one-off override
3. Inspect `lastDeltaPercent` in state to see actual computed delta

---

## Roadmap

### Phase 1 — Current ✅
- [x] Candle sync (Kibana bootstrap + native incremental)
- [x] Kibana gap repair
- [x] AMA center calculation with configurable params
- [x] Trend detection with confidence scoring
- [x] ATR-based volatility / weight variance
- [x] Dynamic buy/sell weight output
- [x] Collateral ratio recommendation (directional — execution in Phase 2)
- [x] Trigger-file emission on threshold
- [x] Extended state persistence (weights, collateral, trend, atr)
- [x] Runtime lock/retry/stale-data safety controls

### Phase 2 — Planned
- [ ] Collateral rebalancing execution (wire delta liquidity → bot reset)
- [ ] Multi-pair correlation analysis
- [ ] Hot-reload support (zero-downtime parameter updates)
- [ ] Machine learning-based regime detection

### Phase 3 — Future
- [ ] Portfolio-level optimization (balance risk across all bots)
- [ ] Cross-asset feedback loops (BTS volatility → XRP parameters)
- [ ] Seasonal pattern recognition
- [ ] Integration with external news/sentiment data

---

## References

- **Historical Analysis**: See `/analysis/ama_fitting/README.md` for parameter optimization
- **Bot Configuration**: See `profiles/bots.json` for current settings
- **DEXBot Architecture**: See root `README.md` for overall bot design
- **Claw Integration**: See `claw/docs/AI_BOT_LIBRARY_API.md` for API boundary
