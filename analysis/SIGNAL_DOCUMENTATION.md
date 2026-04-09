# Signal & Indicator Documentation

## Overview

The analysis engine computes trend direction and reversal signals from multiple independent
indicators. All calculations are performed on rolling candle data (default: 1h intervals).

---

## Indicators

### SMA — Simple Moving Average

**What it measures:** Direction of the slow trend.

**Formula:**
```
SMA[t] = mean(price[t-period+1 .. t])
```

**Derivative (direction signal):**
```
d(SMA)/dt = SMA[t] - SMA[t-1]
  > 0 → UP
  < 0 → DOWN
  = 0 → NEUTRAL
```

**Parameters:**
| Flag | Default | Description |
|------|---------|-------------|
| `--sma N` | 800 | Rolling window in bars |

**Characteristics:** Maximum lag, minimum noise. SMA(500) on 1h candles = 500-hour (~21-day)
memory. Best for identifying macro regime, not reversals.

---

### fastSMA — Fast Simple Moving Average

**What it measures:** Direction of the short-term trend.

Same formula as SMA, shorter period. Reacts faster but produces more false signals.

**Parameters:**
| Flag | Default | Description |
|------|---------|-------------|
| `--fast-sma N` | off | Rolling window in bars |

**Typical usage:** `--sma 500 --fast-sma 100` gives a slow macro view (500h) alongside
a faster short-term view (100h ≈ 4 days).

---

### MACD — Moving Average Convergence Divergence

**What it measures:** Momentum — whether the trend is accelerating or decelerating.
Designed for detecting trend reversals before the price MA turns.

**Formula:**
```
MACD line  = EMA(fast) - EMA(slow)          [normalized as % of price]
Signal line = EMA(signalPeriod) of MACD line
Histogram   = MACD line - Signal line
```

**Normalization:** All values are divided by the current price and multiplied by 100
(`value / price × 100`) so the scale is consistent regardless of absolute price level.

**Parameters:**
| Flag | Default | Hourly equivalent |
|------|---------|-------------------|
| `--macd-fast N` | 12 | 48 (≈ 2 days) |
| `--macd-slow N` | 26 | 104 (≈ 4 days) |
| `--macd-signal N` | 9 | 36 (≈ 1.5 days) |
| `--macd-min-hist F` | 0 | Minimum histogram magnitude to register bull/bear |

> **Note:** Default MACD periods (12, 26, 9) were designed for **daily candles**.
> On hourly data multiply by ~24. Use `--macd-fast 48 --macd-slow 104 --macd-signal 36`
> as the hourly equivalent.

**Interpretation:**
- `Histogram > 0` → bullish momentum
- `Histogram < 0` → bearish momentum
- `Histogram growing` → momentum strengthening
- `Histogram shrinking` → momentum fading (early reversal warning)
- `MACD line crosses above Signal line` → bullish crossover
- `MACD line crosses below Signal line` → bearish crossover
- `MACD line crosses above zero` → trend turning bullish (medium-term)
- `MACD line crosses below zero` → trend turning bearish (medium-term)

---

### RSI — Relative Strength Index

**What it measures:** Whether the asset is overbought or oversold relative to recent
price movement. Useful for identifying exhaustion points where reversals are likely.

**Formula (Wilder smoothing):**
```
Change  = price[t] - price[t-1]
AvgGain = (AvgGain × (period-1) + max(Change, 0)) / period
AvgLoss = (AvgLoss × (period-1) + max(-Change, 0)) / period
RSI     = 100 - (100 / (1 + AvgGain / AvgLoss))
```

**Parameters:**
| Flag | Default | Hourly equivalent |
|------|---------|-------------------|
| `--rsi N` | 14 | 96 (≈ 4 days) |

> **Note:** RSI(14) on daily candles = 14 days. On hourly data use `--rsi 96` for
> a 4-day equivalent, or `--rsi 168` for a weekly equivalent.

**Zones** (default thresholds, configurable via `--rsi-zone` and `--rsi-extreme`):
| RSI | Zone |
|-----|------|
| > 90 (`--rsi-extreme`) | OVERBOUGHT — potential reversal down |
| 60–90 (`50 + --rsi-zone`) | BULL zone |
| 40–60 (dead zone) | NEUTRAL / counter-trend modifier |
| 10–40 (`50 - --rsi-zone`) | BEAR zone |
| < 10 (`100 - --rsi-extreme`) | OVERSOLD — potential reversal up |

> RSI no longer hard-gates the base signal. It acts as a confidence modifier:
> RSI in counter-trend territory downgrades BULL→BULL_WEAK or BEAR→BEAR_WEAK.
> RSI at extremes (OB/OS) overrides the signal entirely.

---

## Signal (Interpretation)

The Signal panel combines MACD and RSI into a single directional state using 8 optimizations.

### Signal States

| State | Color | Meaning |
|-------|-------|---------|
| `BULL` | Green (strong) | Confirmed bullish — all conditions aligned |
| `BULL_WEAK` | Green (dim) | Bullish but at least one weakening condition present |
| `OVERBOUGHT` | Amber | Bull conditions met but RSI > `--rsi-extreme` — exhaustion risk |
| `BEAR` | Red (strong) | Confirmed bearish — all conditions aligned |
| `BEAR_WEAK` | Red (dim) | Bearish but at least one weakening condition present |
| `OVERSOLD` | Teal | Bear conditions met but RSI < `100 - --rsi-extreme` — exhaustion risk |
| `NEUTRAL` | None | Mixed or unconfirmed signals |

---

### Optimization 1 — Confirmation Bars

`BULL` and `BEAR` states require N consecutive bars before being confirmed.
Prevents single-bar spikes from registering as signals.

```
Raw BULL for >= --interp-confirm consecutive bars → confirmed BULL
Otherwise → NEUTRAL
```

OVERBOUGHT, OVERSOLD, BULL_WEAK, BEAR_WEAK are immediate (no confirmation required).

**Flag:** `--interp-confirm N` (default 3)

---

### Optimization 2 — MACD Histogram Magnitude Filter

A minimum absolute histogram value filters out near-zero noise around the zero-line.

```
hist >  --macd-min-hist → histBull
hist < --macd-min-hist  → histBear
|hist| <= --macd-min-hist → NEUTRAL (noise zone)
```

**Flag:** `--macd-min-hist F` (default 0.02)

Increase to ignore more marginal histogram readings. Too large a value will suppress
legitimate early signals.

---

### Optimization 3 — MACD Line Slope

The slope of the MACD line itself (not the histogram) is tracked as an independent
confirming factor. A rising MACD line signals accelerating bullish momentum even when the
histogram has started to shrink, preventing premature weak downgrades.

```
macdLine[t] - macdLine[t-1] > 0  → macdLineRising   (supports BULL, suppresses weak)
macdLine[t] - macdLine[t-1] < 0  → macdLineFalling  (supports BEAR, suppresses weak)
```

No flag — always active when MACD is enabled.

---

### Optimization 4 — MACD Histogram Momentum (coupled with line slope)

Two conditions required for MACD-based weak downgrade:

```
histWeakening AND !macdLineRising   → BULL_WEAK
histWeakening AND !macdLineFalling  → BEAR_WEAK
```

- Histogram must be shrinking
- MACD line slope must not be compensating (not rising for bull, not falling for bear)

> Note: MACD signal line crossover is not used here because `histogram = MACD line − Signal line`,
> so when histogram is positive, `macdLine > macdSig` is always true — the signal line position
> carries no additional information beyond the histogram sign itself.

---

### Optimization 5 — Dual MACD Zero-Line Confirmation

For a full `BULL`, histogram and MACD line should agree on zero-line side. If histogram
is positive but MACD line is still below zero and not recovering, it is an unconfirmed
early reversal.

```
histBull AND macdBelowZero AND !macdLineRising   → BULL_WEAK
histBear AND macdAboveZero AND !macdLineFalling  → BEAR_WEAK
```

If `macdLineRising` is true (line recovering toward zero), the signal is allowed to be
full BULL — the recovery trajectory is sufficient confirmation.

---

### Optimization 6 — RSI as Confidence Modifier (direction-aware)

RSI acts as a confidence modifier using both absolute level and direction.

**Counter-trend downgrade (standalone):**
```
BULL + RSI < (50 - rsi-zone) AND RSI not rising  → BULL_WEAK
BEAR + RSI > (50 + rsi-zone) AND RSI not falling → BEAR_WEAK
```

RSI direction is key: if RSI is in counter-trend territory but recovering (rising while
below threshold in a BULL phase), the divergence is fading — no downgrade applied.
Only a persistent and worsening divergence triggers WEAK.

**Extreme exit (highest priority, overrides everything):**
```
BULL + RSI > --rsi-extreme         → OVERBOUGHT
BEAR + RSI < (100 - --rsi-extreme) → OVERSOLD
```

**Flags:** `--rsi-zone N` (default 10), `--rsi-extreme N` (default 90)

---

### Optimization 7 — Signal Hysteresis

Once in a confirmed `BULL` or `BEAR` state, a downgrade must persist for N bars before
being applied. Prevents single-candle fluctuations from interrupting a confirmed trend.

```
BULL → anything else: new state must hold >= --interp-hold bars before switching
BEAR → anything else: new state must hold >= --interp-hold bars before switching
```

OVERBOUGHT and OVERSOLD always bypass hysteresis — they apply immediately.

**Flag:** `--interp-hold N` (default 3)

---

### Optimization 8 — Trend Filter (MA gate)

Counter-trend signals are suppressed using the fastest available MA direction.
Uses fastSMA if present, otherwise falls back to SMA.

```
fastSMA rising  (sustained >= N bars) + (BEAR or BEAR_WEAK)  → NEUTRAL
fastSMA falling (sustained >= N bars) + (BULL or BULL_WEAK)  → NEUTRAL
```

The gate only opens after the MA has been trending in the same direction for **N consecutive bars**.
A single-bar uptick (common noise) no longer trips the filter — the trend must be sustained.

OVERBOUGHT and OVERSOLD bypass this filter — they always fire regardless of MA direction.

**Flags:** `--trend-filter` (default off), `--trend-filter-min-bars N` (default 3)

---

### Optimization 9 — Macro Regime Gate

When both fastSMA and SMA(slow) are present and point in **opposite directions**, a full
`BULL` or `BEAR` signal is capped to `WEAK`. The two MAs must agree on the macro regime
before a confirmed directional signal is allowed.

```
fastSMA DOWN + SMA(slow) UP   → BEAR capped to BEAR_WEAK
fastSMA UP   + SMA(slow) DOWN → BULL capped to BULL_WEAK
```

**Why this matters:** The primary trend filter (Opt 8) suppresses signals that go against the
fast MA — but if fastSMA ticks down for a few bars while the slow SMA is firmly rising, a BEAR
can pass through (fastSMA aligned with BEAR). The macro gate catches this: a short-term dip
against a sustained macro uptrend is not confirmation of a bear regime.

Both MAs must be sustained for `--trend-filter-min-bars` before the gate fires.
OVERBOUGHT and OVERSOLD bypass this gate.

Only active when `--trend-filter` is enabled and both `--sma` and `--fast-sma` are set.

---

### Optimization 10 — Price vs Fast MA Cross-Check (N-bar Commitment)

When `--fast-sma` is present, price position relative to fastSMA acts as a structural validity
check on full BULL/BEAR signals. **N-bar commitment requirement** ensures sustained price position:

```
BULL requires:   price > fastSMA for ≥ N consecutive bars
BEAR requires:   price < fastSMA for ≥ N consecutive bars
```

If commitment bars not met, signal is downgraded to WEAK.

**Examples:**
- `--opt10-commitment 1`: loose, BULL fires if price just above MA (current bar)
- `--opt10-commitment 2`: moderate (default), requires 2-bar confirmation
- `--opt10-commitment 3`: strict, requires 3 sustained bars above/below
- `--opt10-commitment 5`: very strict, requires 5-bar sustained position

**Why this matters:** Single-bar wicks can trigger signals. Requiring sustained position
distinguishes genuine breakouts/breakdowns from price noise. Also fixes a timing bug where
the previous implementation used stale price data.

Only active when `--trend-filter` is enabled and `--fast-sma` is set.

**Flag:** `--opt10-commitment N` (default 2) — any positive integer, higher = more conservative

---

### Optimization 11 — Momentum Gate

When Optimization 8 suppresses a signal to NEUTRAL due to macro regime conflict, the Momentum Gate
can restore it to WEAK if MACD and RSI **both diverge from SMA(500) direction** for N sustained bars.

```
SMA UP  + MACD (histogram < 0) for >= N bars + RSI < 35 for >= N bars  → BEAR_WEAK (restored)
SMA DOWN + MACD (histogram > 0) for >= N bars + RSI > 65 for >= N bars  → BULL_WEAK (restored)
```

This catches true reversals 20–30 bars earlier without removing the SMA(500) anchor:
- Opt 8 suppresses the signal initially (SMA(500) still points other direction)
- But if momentum has *already* turned (MACD + RSI diverge), the early reversal is real
- Gate restores signal to WEAK to catch it early

**Why this matters:** SMA lag is a feature for filtering noise, but real reversals broadcast early
signals via MACD/RSI. The Momentum Gate lets you act on those early signals without trusting them
fully (only WEAK, not full BULL/BEAR). Downstream gates (Opt 9, 10) still apply for confirmation.

Both MACD and RSI must diverge to prevent false overrides (prevents ~60% of false signals from single-indicator noise).

**Flags:** `--momentum-gate` (default off), `--momentum-gate-bars N` (default 3),
`--momentum-gate-rsi-zone F` (default 35 = must be below 35 or above 65)

---

### Signal Decision Tree

```
|hist| <= macd-min-hist                                     → NEUTRAL

MACD histogram > macd-min-hist (BULL candidate):
  ├── RSI > rsi-extreme?                                    → OVERBOUGHT  [immediate, bypasses trend filter]
  ├── RSI < (50-zone) AND RSI not rising?                   → BULL_WEAK   [RSI divergence]
  ├── histBull AND macdBelowZero AND !macdLineRising?        → BULL_WEAK   [dual MACD unconfirmed]
  ├── histWeakening AND !macdLineRising?                    → BULL_WEAK   [MACD fading]
  └── else, >= interp-confirm bars [hold >= interp-hold]    → BULL

MACD histogram < -macd-min-hist (BEAR candidate):
  ├── RSI < (100-extreme)?                                  → OVERSOLD    [immediate, bypasses trend filter]
  ├── RSI > (50+zone) AND RSI not falling?                  → BEAR_WEAK   [RSI divergence]
  ├── histBear AND macdAboveZero AND !macdLineFalling?       → BEAR_WEAK   [dual MACD unconfirmed]
  ├── histWeakening AND !macdLineFalling?                   → BEAR_WEAK   [MACD fading]
  └── else, >= interp-confirm bars [hold >= interp-hold]    → BEAR

Trend filter (--trend-filter):
  fastSMA rising  (>= trend-filter-min-bars) + BEAR/BEAR_WEAK  → NEUTRAL
  fastSMA falling (>= trend-filter-min-bars) + BULL/BULL_WEAK  → NEUTRAL

Momentum gate (--momentum-gate, requires --macd + --rsi + --sma):
  SMA UP   + MACD histogram < 0 (>= momentum-gate-bars) + RSI < gate-rsi-zone (>= bars) + signal=NEUTRAL  → BEAR_WEAK
  SMA DOWN + MACD histogram > 0 (>= momentum-gate-bars) + RSI > (100-gate-rsi-zone) (>= bars) + signal=NEUTRAL  → BULL_WEAK

Macro regime gate (--trend-filter, requires both --sma and --fast-sma):
  fastSMA DOWN + SMA UP  (both sustained)  + BEAR               → BEAR_WEAK
  fastSMA UP   + SMA DOWN (both sustained) + BULL               → BULL_WEAK

Price vs fast MA cross-check (--trend-filter + --fast-sma, tightened):
  BULL + (price < fastSMA now OR price < fastSMA prev bar)     → BULL_WEAK
  BEAR + (price > fastSMA now OR price > fastSMA prev bar)     → BEAR_WEAK
```

---

## Parameter Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--sma N` | 800 | Slow SMA period |
| `--fast-sma N` | off | Fast SMA period |
| `--alma N` | off | ALMA period |
| `--alma-offset F` | 0.85 | ALMA lag offset (0–1) |
| `--alma-sigma F` | 6 | ALMA bell width |
| `--lrs N` | off | Linear Regression Slope period |
| `--kama-er N` | off | KAMA efficiency ratio period (enables KAMA) |
| `--kama-fast N` | 2 | KAMA fast EMA constant |
| `--kama-slow N` | 300 | KAMA slow EMA constant |
| `--macd` | off | Enable MACD with defaults |
| `--macd-fast N` | 12 | MACD fast EMA period |
| `--macd-slow N` | 26 | MACD slow EMA period |
| `--macd-signal N` | 9 | MACD signal EMA period |
| `--macd-min-hist F` | 0.02 | Minimum histogram magnitude to register signal (noise filter) |
| `--trend-filter` | off | Suppress signals that contradict the fastest available MA direction |
| `--trend-filter-min-bars N` | 3 | Minimum consecutive bars MA must be trending before gate activates |
| `--opt10-commitment N` | 2 | Optimization 10: consecutive bars price must stay beyond fastSMA for signal (1=loose, 2+=strict) |
| `--momentum-gate` | off | Enable Momentum Gate override for suppressed signals |
| `--momentum-gate-bars N` | 3 | Minimum consecutive bars MACD+RSI must diverge from SMA before gate fires |
| `--momentum-gate-rsi-zone F` | 35 | RSI threshold for divergence (must be < N or > 100-N) |
| `--rsi N` | off | Enable RSI with period N |
| `--interp-confirm N` | 3 | Confirmation bars for BULL/BEAR signal |
| `--interp-hold N` | 3 | Bars a downgrade must hold before being applied (hysteresis) |
| `--rsi-zone N` | 10 | Dead zone / counter-trend modifier threshold (±offset from 50) |
| `--rsi-extreme N` | 90 | Extreme level (overbought >N, oversold <100-N) |
| `--confirm N` | 3 | Bars required for MA trend confirmation |
| `--source` | market_adapter | Data source: `json`, `market_adapter`, `kibana` |
| `--pair` | XRP-BTS | Trading pair (market_adapter source) |
| `--file PATH` | — | JSON file path (json source) |
| `--chart FILE` | derivative_chart.html | Output HTML path |

### Recommended Settings for 1h Candles

```bash
# Current tuned defaults — balanced noise, trend-filtered, direction-aware RSI
node analysis/analyze_derivatives.js \
  --sma 500 --fast-sma 100 \
  --macd-fast 48 --macd-slow 104 --macd-signal 36 --macd-min-hist 0.02 \
  --rsi 96 --rsi-extreme 90 --rsi-zone 10 \
  --interp-confirm 3 --interp-hold 3 \
  --trend-filter

# Slow / low noise — macro view only
node analysis/analyze_derivatives.js \
  --sma 800 \
  --macd-fast 72 --macd-slow 156 --macd-signal 54 --macd-min-hist 0.02 \
  --rsi 168 --rsi-extreme 90 --rsi-zone 10 \
  --interp-confirm 3 --interp-hold 3 \
  --trend-filter

# Fast / more signals — higher noise
node analysis/analyze_derivatives.js \
  --sma 200 --fast-sma 50 \
  --macd-fast 24 --macd-slow 52 --macd-signal 18 --macd-min-hist 0.01 \
  --rsi 48 --rsi-extreme 90 --rsi-zone 10 \
  --interp-confirm 2 --interp-hold 2 \
  --trend-filter
```
