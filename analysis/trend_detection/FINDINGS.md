# Trend Detection Research Findings

Consolidated findings from system evaluation and method comparison.

---

## Current Method: AMA + Feed Price

The active approach uses a single Kaufman AMA compared against the on-chain settlement feed price. For feed-anchored MPAs (HONEST.Assets), the feed is the fundamental reference — deviation from it is the signal.

**Modules:** `feed_trend.js`, `feed_premium.js`, `trend_analyzer.js`

**Properties observed in testing:**
- Reacts faster than dual AMA for MPA-specific scenarios because the feed provides a hard reference
- When market and feed move together, no false signal fires (AMA tracks feed, deviation stays under threshold)
- Choppy oscillation around feed correctly produces NEUTRAL
- Premium/discount snapshot is immediate — no lag

---

## Previous Method: Dual AMA Crossover

**Status:** Superseded by AMA + feed. File `dual_ama.js` kept for reference.

### Backtest Results (Historical — Dual AMA)

**Data:** 500 1-day candles, XRP/BTS synthetic pair (~1.4 years)
**Config:** Fast AMA (ER=50, Fast=2, Slow=15), Slow AMA (ER=20, Fast=3, Slow=30)

| Metric | Value |
|--------|-------|
| Total Trades | 6 |
| Win Rate | 50% |
| Total Return | 541.02% |
| Profit Factor | 23.70 |
| Avg Win | 188.29% |
| Avg Loss | -7.95% |

**Caveat:** 6 trades is not statistically significant. These numbers are from the dual AMA method and should not be compared directly against AMA+feed results without rerunning the backtest.

---

## Price Action Filter Test (Dual AMA era)

**Result: REJECTED** — Filter degraded performance.

| Metric | Baseline | With Filter |
|--------|----------|-------------|
| Total Return | 541.02% | 216.87% |
| Profit Factor | 23.70 | 2.68 |
| Trade Count | 6 | 90 |

Adding higher-high/higher-low confirmation created excessive micro-trades and destroyed selectivity.

---

## Alternative Methods Considered

| Method | Verdict | Reason |
|--------|---------|--------|
| MACD | Inferior | Lower profit factors than AMA approaches |
| RSI/Stochastic | Wrong tool | Designed for mean-reversion, not trend detection |
| Price Action | Rejected | Too noisy on daily candles (tested) |
| Volume Profile | Not viable | Volume data not available for these pairs |
| ML/Neural Net | Insufficient data | Need 1000+ labeled trades |

---

## Recommendations

### Active
- Run AMA+feed optimizer on fresh data to find parameters for target pairs
- Backtest with `node backtest_trend_detection.js` to validate
- Reoptimize when pair characteristics change

### Not Recommended
- Price action filter (tested, hurts performance)
- Switching to MACD/RSI (inferior for this use case)
- ML approach (insufficient training data)
