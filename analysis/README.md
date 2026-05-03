# Analysis

This directory contains research runners, chart generators, and helper modules used to inspect market behavior and tune analysis parameters. All output is interactive HTML charts — not used in production.

All runners write self-contained HTML to `charts/`. These files are regenerated on each run and are not committed.

## Data Prerequisites

Most runners expect LP candle JSON files under `market_adapter/data/lp/`. To fetch fresh data:

```bash
# Via the market adapter LP exporter (recommended for blockchain-backed candles)
node market_adapter/inputs/fetch_lp_data.js --bot T-BTS --interval 1h --lookback 26280h

# Via the analysis fetcher (uses Kibana source directly)
node analysis/ama_fitting/fetch_lp_candles.js --pool 1.19.133 \
  --assetA IOB.XRP --assetAId 1.3.3926 --assetAPrecision 4 \
  --assetB BTS     --assetBId 1.3.0    --assetBPrecision 5
```

See [ama_fitting/README.md](ama_fitting/README.md) for full fetch options and data format.

## Subareas

- `trend_detection/` - SMA, MACD, RSI, Hurst, Kalman, regime, and dynamic-weight analysis plus research docs
- `ama_fitting/` - AMA fitting, synthetic comparison charts, and LP data workflows
- `bot_fitting/` - Grid parameter sweep backtests for AMA winners
- `bot_usage/` - DEXBot account discovery and Kibana query helpers
- `tradingview/` - TradingView-style chart export
- `charts/` - Generated HTML chart output (not committed, regenerated on each run)

## Main Entry Points

### Derivative Signals (`analyze_derivatives.js`)

SMA/MACD/RSI signal analyzer. Produces a multi-panel HTML chart showing BULL/BEAR/NEUTRAL/OVERBOUGHT/OVERSOLD interpretation states with entry bias metadata.

```bash
# Recommended 1h setup
node analysis/analyze_derivatives.js \
  --source json \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --sma 500 --fast-sma 100 \
  --macd-fast 48 --macd-slow 104 --macd-signal 36 --macd-min-hist 0.02 \
  --rsi 96 --rsi-extreme 90 --rsi-zone 10 \
  --interp-confirm 3 --interp-hold 3 \
  --trend-filter --trend-filter-min-bars 3
```

Full signal documentation: [SIGNAL_DOCUMENTATION.md](trend_detection/SIGNAL_DOCUMENTATION.md)

### Dynamic Weight Research (`analyze_dynamic_weight.js`)

Interactive 4-panel chart blending AMA slope and Kalman filter signals, gated by Hurst Exponent and Permutation Entropy regime detection. Knobs for α, gain, clip%, nz%, and more.

```bash
node analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --alpha 0.6 --gain 0.25 --clip 20
```

Full research docs: [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md)

### Kalman Analysis (`analyze_kalman.js`)

Standalone Kalman filter chart with tactical/modal state tracking — velocity and displacement as separate orthogonal signals.

```bash
node analysis/analyze_kalman.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
```

### Regime Analysis (`analyze_regime.js`, `analyze_regime_windows.js`)

Hurst Exponent and Permutation Entropy regime classification. `analyze_regime.js` shows the standard regime chart; `analyze_regime_windows.js` explores different window configurations.

### Volatility Analysis (`analyze_volatility.js`)

ATR-based symmetric volatility penalty research. Uses the same math as the production volatility penalty without any directional component.

```bash
node analysis/analyze_volatility.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
```

## Subarea Details

### `trend_detection/`

Shared analyzers and chart renderers for regime work. Contains the core signal engines behind the runner scripts above.

**Research docs:**
- [SIGNAL_DOCUMENTATION.md](trend_detection/SIGNAL_DOCUMENTATION.md) — full derivative signal layer reference (SMA, MACD, RSI decision tree, every flag, entry bias metadata)
- [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md) — AMA+Kalman blend with Hurst/PE regime gating, formula reference, knob guide

**Modules:**

| Module | Purpose |
|--------|---------|
| `derivative_analyzer.js` | SMA/MACD/RSI signal engine with confirmation, hysteresis, and gates |
| `dynamic_weight_chart_generator.js` | 4-panel uPlot chart with interactive knobs for dynamic weight tuning |
| `kalman_trend_analyzer.js` | Kalman filter with tactical (velocity) and modal (displacement) states |
| `kalman_velocity_smoothing.js` | Adaptive EMA smoothing for Kalman velocity (kf/kfd/kdt/kfs knobs) |
| `kalman_chart_generator.js` | Kalman signal chart generator |
| `hurst_analyzer.js` | Hurst Exponent via R/S analysis (rolling 256-bar window) |
| `permutation_entropy_analyzer.js` | Permutation Entropy via ordinal pattern counting (m=5, window=54) |
| `volatility_chart_generator.js` | ATR volatility / symmetric shift chart generator |
| `regime_chart_generator.js` | Regime classification chart generator |

**Tests:** `tests/test_kalman_trend.js`, `tests/test_kalman_velocity_smoothing.js`

```bash
node analysis/trend_detection/tests/test_kalman_trend.js
node analysis/trend_detection/tests/test_kalman_velocity_smoothing.js
```

**Local deps:** Run `npm install` inside `trend_detection/` for chart-generator dev dependencies (`package.json`).

### `ama_fitting/`

AMA parameter optimization and comparison tools.

| Script | Purpose |
|--------|---------|
| `ama.js` | Kaufman Adaptive Moving Average implementation |
| `optimizer_high_resolution.js` | AMA parameter optimizer (erPeriod, fast/slow bounds) |
| `generate_unified_comparison_chart.js` | AMA comparison chart across multiple parameter sets |
| `analyze_ama_price_changes.js` | AMA price-change analysis |
| `fetch_lp_candles.js` | LP candle data fetcher |

**Local deps:** Run `npm install` inside `ama_fitting/` if you need the optimizer's worker-thread dependencies (`package.json`).

### `bot_fitting/`

Parameter sweep backtests that simulate grid fills for the AMA winners from `ama_fitting/`. Optimizes spread, increment, and max/min ratio for each AMA strategy.

| Script | Purpose |
|--------|---------|
| `backtest_bot_fitting.js` | Lightweight sweep across spread / increment / ratio with basic risk scoring |
| `backtest_ama_sweep.js` | Persistent grid simulation with fixed-chain-price mechanics, reposition thresholds, and worker-thread parallelization |
| `shared_utils.js` | Candle normalization and shared backtest utilities |

```bash
node analysis/bot_fitting/backtest_bot_fitting.js \
  --data market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json
```

```bash
node analysis/bot_fitting/backtest_ama_sweep.js \
  --data market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --spread 4:16:1 --increment 0.5:4:0.25
```

Details: [bot_fitting/README.md](bot_fitting/README.md)

### `bot_usage/`

| Script | Purpose |
|--------|---------|
| `discover_bot_accounts.js` | Discover DEXBot accounts on-chain |
| `kibana_bot_queries.js` | Kibana query helpers for bot activity |

### `tradingview/`

| Script | Purpose |
|--------|---------|
| `analyze_tradingview.js` | TradingView chart analysis runner |
| `tradingview_uplot_chart_generator.js` | TradingView-style uPlot chart generator |

## Shared Helpers

| File | Purpose |
|------|---------|
| `price_sources.js` | Unified candle source abstraction (`json`, `market_adapter`) |
| `derivative_chart_generator.js` | HTML chart renderer for `analyze_derivatives.js` (multi-panel derivative signal chart) |
| `chart_utils.js` | Shared chart rendering utilities |
| `cli_utils.js` | CLI argument parsing helpers |
| `math_utils.js` | Shared math utilities |

## npm Script Shortcuts

| Script | Command |
|--------|---------|
| `npm run analysis:derivatives` | `node analysis/analyze_derivatives.js` |
| `npm run analysis:tradingview` | `node analysis/tradingview/analyze_tradingview.js` |
| `npm run ama:chart:lp-local` | `node analysis/ama_fitting/generate_unified_comparison_chart.js` |

All three accept `--` forwarded flags (e.g. `npm run analysis:tradingview -- --file <path>`).

## Related Docs

- [Market Adapter README](../market_adapter/README.md) — live AMA pricing, grid triggers, dynamic weights, and recalc triggers
- [DEXBot2 Tuning Cheat Sheet](../docs/DEXBOT2_TUNING_CHEAT_SHEET.md) — grid tuning reference for live bots
