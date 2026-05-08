# TradingView HTML Exporter

This exporter generates a standalone HTML chart in the `analysis/charts/` folder using the local `uPlot`-based TradingView-style renderer.

## What It Produces

- Log-scale price chart
- Candle timeframe buttons: `1h`, `4h`, `1d`, `1w`
- SMA overlay
- AMA overlay with explicit `erPeriod`, `fastPeriod`, and `slowPeriod` inputs
- VWMA overlay
- Bottom volume panel
- Crosshair legend with current candle values

## Quick Start

Generate the default chart from the bundled LP 1h JSON file:

```bash
npm run analysis:tradingview
```

This writes:

```text
analysis/charts/tradingview_chart.html
```

## Direct CLI Usage

```bash
node analysis/tradingview/analyze_tradingview.js \
  --file <path-to-lp-candles.json> \
  --chart analysis/charts/tradingview_chart.html
```

Example using market adapter LP data:

```bash
node analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/lp/<pair-folder>/lp_pool_<id>_<interval>.json \
  --chart analysis/charts/tradingview_chart.html
```

## Input Format

The exporter accepts candle data in either of these shapes:

- Array rows: `[timestamp_ms, open, high, low, close, volume]`
- Object rows: `{ time|timestamp|ts, open, high, low, close, volume }`

If you pass a raw JSON file, the runner normalizes the candles before rendering.

## Getting Blockchain Data

Use the market adapter LP exporter to pull blockchain-backed candles before generating the HTML:

```bash
node market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h
```

That writes a JSON file under `market_adapter/data/lp/` which you can then pass to the TradingView exporter.

For manual pool discovery, use `--pool`, `--precA`, and `--precB` instead of `--bot`.

## CLI Flags

- `--file <path>`: candle JSON input file
- `--chart <path>`: output HTML file
- `--title <text>`: chart title
- `--sma-period <n>`: SMA period, default `500`
- `--ama-er-period <n>`: AMA ER period, default `781`
- `--ama-fast-period <n>`: AMA fast period, default `5.2`
- `--ama-slow-period <n>`: AMA slow period, default `112.7`
- `--price-scale <log|linear>`: price axis scale, default `log`
- `--no-sma`: disable SMA
- `--no-ama`: disable AMA
- `--no-vwap`: disable VWMA
- `--vwap-bars <n>`: rolling VWMA window, default `500`
- `--quiet`: suppress progress logs

## Notes

- The chart uses `uPlot` from the CDN in the generated HTML.
- The displayed indicators are computed from the 1h base candles and then sampled onto the selected timeframe.
- The current volume-weighted overlay is a rolling `VWMA`, not a session-reset VWAP.
- SMA is disabled by default.
- VWMA is disabled by default.
- AMA is auto-enabled when the bot has `gridPrice: "ama"` (or ama1-4), otherwise disabled by default.
- AMA settings priority: bot-specific `ama` object > market profile > constants (112.7).
- The AMA controls start with the bot-specific AMA, then pair-specific entry from `profiles/market_profiles.json` when available, falling back to AMA3 values from `modules/constants.js`.
- The AMA `Reset` button restores the HTML defaults, not the browser-stored overrides.
- Indicator, timeframe, and scale changes are persisted in browser `localStorage` for the generated HTML.
- The price axis defaults to log base `10`, with a toolbar switch for `Log` / `Linear`.
- If you regenerate the HTML and then open it later, the browser still needs access to the `uPlot` CDN unless you inline or bundle the library.

## Typical Workflow

1. Pick or generate a candle JSON file.
2. Run `npm run analysis:tradingview` or call the runner directly.
3. Open `analysis/charts/tradingview_chart.html` in a browser.
4. Use the timeframe buttons and indicator controls at the top of the page.
