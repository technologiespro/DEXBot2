# Trend Detection

## Available Method: AMA vs Feed Price

A Kaufman Adaptive Moving Average (KAMA) applied to market price is compared against the on-chain settlement feed price. When the smoothed market price consistently deviates from the feed, a trend signal is produced.

**Location:** `analysis/trend_detection/`

**Modules:**

| Module | Purpose |
|---|---|
| `feed_trend.js` | Single AMA vs feed price — trend direction (UP / DOWN / NEUTRAL) |
| `feed_premium.js` | Instantaneous market price vs feed price — premium / discount / fair |
| `price_ratio.js` | Price oscillation analysis relative to AMA center |
| `trend_analyzer.js` | Main interface combining all three |

**Usage:**

```javascript
const { TrendAnalyzer } = require('./analysis/trend_detection/trend_analyzer');

const analyzer = new TrendAnalyzer({
    feedTrendConfig: { erPeriod: 40, fastPeriod: 5, slowPeriod: 15, thresholdPercent: 1.0 },
    feedPremiumConfig: { deadZonePercent: 0.25 },
});

// Feed each candle close with the corresponding feed price
const result = analyzer.update(marketPrice, feedPrice);

// result.trend         — 'UP' | 'DOWN' | 'NEUTRAL'
// result.confidence    — 0-100
// result.premium       — { signal: 'PREMIUM'|'DISCOUNT'|'FAIR', percent }
// result.deviationPercent — AMA deviation from feed
```

## Premium / Discount

The premium is a raw comparison — no smoothing, no lag:

```
premium = ((market_price - feed_price) / feed_price) × 100
```

This is separate from the trend signal. A position can show a premium without a confirmed trend (noise), or a confirmed trend can exist while the instantaneous premium is small (AMA integrates history).

## Parameters

The AMA parameters (erPeriod, fastPeriod, slowPeriod) and confirmation thresholds (thresholdPercent, minBarsForConfirmation, deadZonePercent) are configurable. No specific values are prescribed as optimal — they depend on the pair, timeframe, and market conditions.

The `analysis/trend_detection/` directory includes optimization and backtesting tools for parameter evaluation.
