# Trend Detection System

Feed-anchored trend detection for MPAs using AMA vs settlement feed price.

## Overview

The system detects trends by comparing a Kaufman Adaptive Moving Average (AMA) of the market price against the on-chain settlement feed price. For feed-anchored assets like HONEST.Assets, the feed is the fundamental reference — sustained deviation from it indicates a real trend.

Two components:
- **FeedTrend** — Single AMA smooths market price, compared against feed → trend direction (UP / DOWN / NEUTRAL)
- **FeedPremium** — Instantaneous market price vs feed → premium / discount / fair (no smoothing)

PriceRatio provides oscillation context for grid-width decisions.

## Quick Start

```javascript
const { TrendAnalyzer } = require('./analysis/trend_detection/trend_analyzer');

const analyzer = new TrendAnalyzer({
    feedTrendConfig: {
        erPeriod: 40,
        fastPeriod: 5,
        slowPeriod: 15,
        thresholdPercent: 1.0,
    },
    feedPremiumConfig: { deadZonePercent: 0.25 },
});

// Feed each candle close with the corresponding feed price
const result = analyzer.update(marketPrice, feedPrice);

if (result.isReady) {
    console.log(result.trend);            // 'UP' | 'DOWN' | 'NEUTRAL'
    console.log(result.confidence);       // 0-100
    console.log(result.premium.signal);   // 'PREMIUM' | 'DISCOUNT' | 'FAIR'
    console.log(result.premium.percent);  // e.g. +1.3 or -0.8
}
```

### Status Checks

```javascript
analyzer.isUptrend()     // boolean — confirmed uptrend
analyzer.isDowntrend()   // boolean — confirmed downtrend
analyzer.isNeutral()     // boolean — no confirmed trend
```

## Architecture

```
analysis/trend_detection/
├── feed_trend.js            # Single AMA vs feed price — trend direction
├── feed_premium.js          # Market price vs feed — premium/discount (instant)
├── price_ratio.js           # Price oscillation analysis
├── trend_analyzer.js        # Main interface — USE THIS
├── dual_ama.js              # Legacy: dual AMA crossover (kept for reference)
├── tests/
│   └── test_trend_analyzer.js
├── optimizer_trend_detection.js   # Parameter optimization
├── backtest_trend_detection.js    # Backtest simulation
├── generate_trend_chart.js        # Visualization (uses legacy dual AMA chart)
├── fetch_1day_candles.js          # Fetch market data
└── data/                          # Generated candle data
```

## Trend Confirmation

A trend is confirmed when:
1. AMA deviates from feed by more than the threshold (default 1%)
2. Deviation sustained for 3+ consecutive bars
3. AMA has warmed up (erPeriod + 1 candles)

## Premium / Discount

The premium is instantaneous — no smoothing, no lag:

```
premium = ((market_price - feed_price) / feed_price) * 100
```

Positive = market above feed (MPA overvalued). Negative = market below feed (MPA undervalued).

The dead zone (default 0.25%) prevents noise signals when market is near the peg.

## Optimization Workflow

```bash
# 1. Fetch fresh candle data
node fetch_1day_candles.js

# 2. Find optimal AMA parameters
node optimizer_trend_detection.js

# 3. Backtest the best configuration
node backtest_trend_detection.js

# 4. Review backtest_report_trend_1day.txt
```

The optimizer tests combinations of erPeriod, fastPeriod, slowPeriod, and thresholdPercent. A synthetic feed price (50-period SMA) approximates the feed-anchored behavior during backtesting.

## Configuration

| Parameter | Default | Purpose |
|---|---|---|
| `erPeriod` | 40 | AMA efficiency ratio lookback |
| `fastPeriod` | 5 | AMA fast smoothing constant |
| `slowPeriod` | 15 | AMA slow smoothing constant |
| `thresholdPercent` | 1.0 | Min AMA-vs-feed deviation to trigger |
| `minBarsForConfirmation` | 3 | Bars the signal must hold |
| `deadZonePercent` | 0.25 | Premium dead zone (FeedPremium) |

No specific values are prescribed as optimal. Run the optimizer to evaluate for your pair and timeframe.

## Testing

```bash
node analysis/trend_detection/tests/test_trend_analyzer.js
```
