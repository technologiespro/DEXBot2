# Analysis

This directory contains research runners, chart generators, and helper modules used to inspect market behavior and tune analysis parameters.

## Subareas

- `trend_detection/` - SMA, MACD, RSI, Hurst, Kalman, and regime analysis plus the related research docs
- `ama_fitting/` - AMA fitting, synthetic comparison charts, and LP data workflows
- `bot_fitting/` - Grid parameter sweep backtests for AMA winners
- `bot_usage/` - DEXBot account discovery and Kibana query helpers
- `tradingview/` - TradingView-style chart export

## Main Entry Points

- `analyze_derivatives.js`
- `analyze_dynamic_weight.js`
- `analyze_kalman.js`
- `analyze_regime.js`
- `analyze_regime_windows.js`
- `analyze_volatility.js`

## Shared Helpers

- `price_sources.js` - unified candle source abstraction
- `trend_detection/` - shared analyzers and chart renderers for regime work
