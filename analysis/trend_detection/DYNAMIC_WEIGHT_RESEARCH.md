# Dynamic Weight Research Tool

Interactive HTML chart for researching optimal dynamic weight parameters by blending AMA slope and Kalman filter signals, gated by Hurst Exponent and Permutation Entropy regime detection.

## Signal design rationale

### AMA slope

The AMA's Efficiency Ratio (`ER = net price change / sum of bar-by-bar changes`) adapts its smoothing speed to market conditions. In a choppy pool `ER ≈ 0` and the AMA barely moves; in a trend `ER ≈ 1` and it tracks price closely. Taking the slope of the AMA therefore produces a signal that is already noise-filtered at the source — a near-zero slope genuinely means sideways, not oscillation that happened to average out. The neutral zone (`neutralZonePct`) dead-bands any remaining micro-slope residuals, which is all the additional filtering needed.

### Kalman filter

The Kalman filter is a state estimator: it separates true price and velocity from measurement noise via its R and Q parameters rather than smoothing over it. Running two filters at different Q values gives two orthogonal signals:

- **Velocity** (tactical filter, high Q): direction and speed of price right now — responsive to inflections without reacting to wicks.
- **Displacement** (modal filter, very low Q): how far price has moved from the long-run equilibrium ("center of gravity") — captures extension, not just momentum direction.

The chart now also carries an adaptive `velocityFilteredPct` series that low-passes the tactical velocity more aggressively when displacement is close to equilibrium. That keeps the fast reaction in trends, but trims the whipsaw you see in sideways chop.

Velocity and displacement carry different information and are kept in separate chart panels. The `dispWeight` knob only adds displacement confidence when the two signals agree on direction.

### ATR handling

The research runner intentionally sets `atr = 0` and `weightVariance = 0` for the AMA/Kalman chart so the tool isolates the directional signal path. In production, ATR is not part of the Kalman estimator; it is applied later as a separate symmetric volatility penalty in the live adapter.

That split keeps the research chart aligned with the trend-confirmation logic while avoiding any double-counting of volatility in the Kalman branch.

### Symmetric volatility shift

The symmetric penalty is documented and implemented as a separate branch, not as part of the Kalman filter itself.

Variables used by the live and research implementations:

- `weightVariance` = `atr / amaPrice`
- `volatilityExponent` = power applied to the variance
- `volatilityScaleX` = penalty multiplier in x-factor units (10x default, 1x–100x in the volatility chart)
- `volatilityThreshold` = minimum absolute shift before the penalty is allowed through
- `MAX_SYMMETRIC_SHIFT` / `DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP` = default cap on the downward shift (overrideable in live settings)

Formula:

```text
rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
clampedRawDelta   = clamp(rawSymmetricDelta, -MAX_SYMMETRIC_SHIFT, 0)
symmetricDelta    = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
```

Live application:

```text
effectiveSell = clamp(staticSell + trendOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT)
effectiveBuy  = clamp(staticBuy  - trendOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT)
```

The dedicated volatility research chart in `analysis/analyze_volatility.js` uses the same `weightVariance → symmetricDelta` math, but with no directional trend component.

### Hurst Exponent

Estimates the long-memory property of the price series via Rescaled Range (R/S) analysis over a rolling window of 256 bars with scales `[8, 16, 32, 64]`.

| H value | Regime | Meaning |
|---|---|---|
| H > 0.55 | TRENDING | Returns are persistent — trends continue |
| H ≈ 0.5 | RANDOM | No memory — random walk |
| H < 0.45 | MEAN_REVERTING | Returns are anti-persistent — reversals dominate |

**Algorithm**: for each scale τ, partition the log-return window into non-overlapping chunks of length τ, compute the average R/S (Rescaled Range) per chunk, then OLS-fit `log(avgRS)` vs `log(τ)` — the slope is the Hurst exponent.

**Role in the tool**: Hurst is one axis of the regime multiplier matrix (see [Regime Multiplier](#regime-multiplier)). Gates the AMA+Kalman blend in production when `regimeSensitivity > 0`.

**Warmup**: requires 256 bars before `isReady = true`.

### Permutation Entropy

Measures market disorder by counting ordinal (rank-order) patterns in a rolling window of 54 bars, with embedding dimension `m=5` and delay `1`.

| Normalized PE | Regime | Meaning |
|---|---|---|
| PE < 0.60 | STRUCTURED | Price movement is ordered — signals are trustworthy |
| 0.60–0.85 | MIXED | Partial structure |
| PE > 0.85 | NOISE | Maximum disorder — no reliable edge |

**Algorithm**: for each position `i` in the window, extract the rank-order of `[price[i], price[i+1], ..., price[i+m-1]]` as an ordinal pattern key. Compute Shannon entropy over the distribution of all `m! = 120` possible patterns, normalized by `log(m!)` to give PE ∈ [0, 1].

**Role in the tool**: PE is the second axis of the regime multiplier matrix. It complements Hurst — Hurst identifies trend persistence, PE identifies signal quality. Together they gate the applied directional offset.

**Warmup**: requires 58 bars (`window + (m-1) * delay`) before `isReady = true`.

### Regime Multiplier

Hurst and PE are combined into a single regime multiplier via bilinear interpolation over a 3×3 lookup table:

```
                PE < 0.60     PE 0.725     PE > 0.85
                (Structured)  (Mixed)      (Noise)
H > 0.55  →    1.0           0.7          0.3
H 0.45–0.55 →  0.6           0.4          0.15
H < 0.45  →    0.3           0.2          0.05
```

Best case (trending + structured): multiplier = **1.0** (full signal). Unclear situations < 1.0 to dampen signal.

The `regi` (regime sensitivity) knob raises the multiplier to a power: `finalMult = baseMult ^ sensitivity`. At sensitivity = 1.0 (default), the table is used as-is. Higher sensitivity exaggerates regime differences; lower sensitivity flattens them toward 1.0.

**Dampen-only**: the multiplier is clamped to a maximum of 1.0. Regime can only reduce the signal — it never amplifies above what the blended channels and output clamp already allow. This was found to perform better in practice: letting a "good" regime boost the signal over-commits when the signal is already at its natural peak.

## Quick Start

```bash
# From JSON candle file
node analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json

# With custom initial parameters
node analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --alpha 0.6 \
  --gain 0.25 \
  --clip 20
```

Output: `analysis/charts/dynamic_weight_chart.html` (open in browser)

**Note**: Hurst requires 256 bars and PE requires 58 bars before their regime signals become active. The first portion of the chart will show the full weight without regime gating.

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `market_adapter` | Data source type (`json`, `market_adapter`) |
| `--file` | — | Path to JSON candle file (implies `--source json`) |
| `--bot-key` | `XRP-BTS` | Bot key for market adapter source |
| `--chart` | `analysis/charts/dynamic_weight_chart.html` | Output HTML path |
| `--alpha` | `0.5` | Initial α blend (0 = pure Kalman, 1 = pure AMA) |
| `--dw` | `0.50` | Initial displacement weight (0 = pure velocity, 1 = full displacement) |
| `--lb` | `8` | Initial lookback bars (1-32) for AMA slope calculation |
| `--gain` | `1.0` | Initial gain multiplier |
| `--clip` | `10` | Initial clip percentile |
| `--quiet` | `false` | Suppress console output |

## Chart Layout

Four stacked uPlot panels with synchronized zoom/pan (scroll to zoom, drag to pan, Ctrl+0 to reset):

All panels share aligned vertical time grid lines, and the bottom output panel shows the readable date axis so the visible time frame stays obvious while zooming and panning.

### Panel 1 — Log Price (34%)
- **Blue line**: Price on logarithmic y-axis
- **Gold line**: AMA3 (slow KAMA from `constants.js`, erPeriod=781) for macro trend reference
- Background shading: green = BULL signal, red = BEAR signal

### Panel 2 — AMA Slope Input (14%)
- **Orange line**: AMA3 slope percentage
- Shows the directional strength of the slow KAMA's trend movement
- Values outside the clip threshold are flattened before entering the offset formula
- Background shading mirrors the output signal direction

### Panel 3 — Kalman Composite Input (21%)
- **Purple line**: Kalman velocity percentage, adaptively smoothed in sideways regimes
- **Cyan dashed line**: Kalman displacement percentage (modal filter — distance from fair-value price)
- Velocity measures *direction and speed* of price movement
- Displacement measures *how far price has already moved* from equilibrium

### Panel 4 — Combined Weight Output (remaining ~31%)
- Green/red fill: positive offset (sell weight > 0.5) vs negative offset (buy weight > 0.5)
- Legend shows: offset value, sell weight (S), buy weight (B)
- Interactive knobs for real-time parameter tuning
- Weight amplitude is scaled by the Hurst+PE regime multiplier on each bar

## Interactive Knobs

### Blend Controls
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **α** | 0–1 | 0.5 | Blend ratio between AMA and Kalman channels (0 = pure Kalman, 1 = pure AMA) |
| **dw** | 0–1 | 0.5 | Displacement weight: how much Kalman displacement influences the composite signal |

### Kalman Smoothing
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **kf** | 0–200 | 100 | Sideways-regime Kalman smoothing blend (0 = raw velocity, 100 = current adaptive smoothing, 200 = stronger smoothing) |
| **kfd** | 1–3x | 1.80x | Displacement scale multiplier for the adaptive smoothing confidence ramp |
| **dsp** | 0.25–4x | 1.00x | Minimum displacement scale floor used by the Kalman confidence ramp |
| **kdt** | 0.25–3x | 1.50x | Displacement threshold multiplier for when the adaptive EMA starts to loosen |
| **kfs** | 20–200% | 100% | Adaptive EMA span ratio |
| **cf** | 0–5 | 0 | Signal confirmation bars for the latched/raw signal overlay |

### Slope Calculation
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **nz%** | 0–1 | 0.00 | Neutral zone: dead-band below which offset is forced to 0 |
| **lb** | 1–32 | 9 | Logarithmic. Lookback bars for AMA slope calculation |
| **amaS%** | 0.05–5 | 0.75 | Logarithmic. Gear ratio for AMA slope saturation |
| **kalS%** | 0.05–1.5 | 0.75 | Logarithmic. Gear ratio for Kalman composite saturation |
| **clip%** | 0–55 | 10 | Percentile clip: filters extreme inputs (0 = off) |

### Output Controls
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **th%** | 0–0.5 | 0.00 | Minimum pre-gain blended output required before the signal is allowed through |
| **gain** | 0.5–2.0 | 1.0 | Logarithmic. Amplitude multiplier on the clamp-normalized blend |
| **regi** | 0–2 | 1.0 | Regime sensitivity: exponent applied to Hurst+PE multiplier |

## Copy / Paste Parameters

The **copy** button serializes all knob values (α, dw, kf, kfd, dsp, kdt, kfs, cf, lb, amaS%, kalS%, th%, gain, clip%, nz%, regi) to JSON and writes them to both the clipboard and `localStorage`.

The **paste** button first checks `localStorage` for parameters from a previous copy in the same browser session. If none found, it prompts for Ctrl+V input. A confirmation popup shows the parsed values before applying them. Click **Apply** to set the knobs, **Cancel** or press **Escape** to dismiss.

## Formulas

### AMA Offset
```
amaClip = clamp(amaSlope%, ±clipThreshold)    // percentile-based clip
amaOff  = clamp(amaClip / amaS% × outputClamp, ±outputClamp)
```

### Kalman Composite Offset
```
kalClip   = clamp(velocity%, ±clipThreshold)   // percentile-based clip
dispConf  = min(|displacement%| / md%, 1)      // displacement confidence, 0–1
momAlign  = sign(kalClip) == sign(displacement%) ? 1 : 0
kalComp   = kalClip × (1 − dw + dw × dispConf × momAlign)
kalOff    = clamp(kalComp / kalS% × outputClamp, ±outputClamp)
```

### Adaptive EMA
```
smoothingBudget = 0.60
smoothingFloor   = 0
smoothingSpan    = smoothingBudget × clamp(kfs / 100, 0.2, 2.0)
trendConfidence  = clamp(|displacement%| / (kdt × kfd), 0, 1)
smoothingAlpha   = min(smoothingBudget, smoothingFloor + (smoothingSpan × trendConfidence))
velocityFiltered = EMA(rawVelocity, smoothingAlpha)
```

Behavior:
- `kf = 0` returns the raw Kalman velocity
- `kf = 100` uses the current adaptive EMA result
- `kf > 100` pushes further toward the adaptive signal than the base blend alone, up to 200

### dsp (minimum displacement scale)
```
dispScale = max(dsp, 1.0)   // live adapter floor; research chart lets you sweep the raw value
dispConf  = min(|displacement%| / dispScale, 1)
```

Behavior:
- Smaller `dsp` values make displacement confidence saturate faster
- Larger `dsp` values require more displacement before the Kalman branch is treated as fully confident
- The research chart exposes `dsp` as an interactive knob so you can explore this saturation point directly
- The live adapter still clamps `dsp` to at least `1.0` for production stability

### Latched Signal
```
echoDir = sign(rawSignal) when rawSignal is bullish/bearish else 0
latchedSignal = hold(echoDir, cf)
```

Behavior:
- `cf = 0` disables latching and shows the raw signal directly
- `cf = 1` flips immediately on the first opposite echo direction
- higher `cf` requires more consecutive opposite bars before the latched signal changes
- neutral/equilibrium bars keep the current latched state and do not clear a pending reversal

### Echoed Output
```
rawOff   = combined AMA/Kalman output
echoOff  = hold(rawOff direction, cf)
```

Behavior:
- `cf = 0` disables output echo and shows the raw output directly
- `cf > 0` holds the last output direction/value until the opposite output is confirmed
- neutral output bars keep the current echoed output state

### Regime Multiplier
```
baseMult  = bilinear(REGIME_TABLE, H, PE)      // 0.05–1.0 depending on regime
rawMult   = baseMult ^ regimeSensitivity        // power scaling via regi knob
finalMult = min(rawMult, 1.0)                  // dampen-only: regime never amplifies
```

### Final Weight (clamp-normalized blend + gain)

Each channel is normalized by the configured output clamp before blending, so α stays a pure ratio knob. The dead-band is applied to that pre-gain blended shape first; `gain` then scales the surviving signal linearly at the end, while the clamp guides still show where the runtime cap sits:

```
cap            = configured channel clamp
channelNorm    = max(|cap|, ε)
blendedOff     = (α × (amaOff / channelNorm) + (1 − α) × (kalOff / channelNorm))
gatedOff       = |blendedOff × finalMult| < minOutputThreshold ? 0 : (blendedOff × finalMult)
off            = gatedOff × gain
sellW = 0.5 + off
buyW  = 0.5 − off
```

The research chart intentionally plots the unclamped `off` series so moves above the runtime cap stay visible. The clamp guides still show where the live adapter would stop applying additional directional offset.

`th%` maps to `minOutputThreshold`. It is applied after the AMA/Kalman blend and regime multiplier, but before `gain`, so it controls which small blended moves are zeroed out rather than how the remaining moves are scaled.

## Parameter Relationships

### amaS% / kalS% + maxSlopeOffset + gain

These knobs have separate jobs:
- `amaS%` = gear ratio for how quickly AMA slope reaches full directional strength
- `kalS%` = gear ratio for how quickly the Kalman composite reaches full directional strength
- `maxSlopeOffset` / `outputClamp` = channel clamp used to normalize the AMA and Kalman rails
- `gain` = final output scale after the blended shape has already been decided

### α (blend)
- 0 = pure Kalman (momentum + displacement composite)
- 1 = pure AMA slope
- 0.5 = equal blend

Each channel is normalized to the same clamp before blending, so changing α shifts the ratio between AMA and Kalman without changing their relative scale. Gain then scales that already-decided shape linearly, without changing where the chart gates to zero.

### nz% (neutral zone)
Values below `nz%` in absolute terms are zeroed out before the offset formula.

### dw (displacement weight)
Controls how much the Kalman displacement (distance from equilibrium) influences the composite signal:
- Default: `dw = 0.50`
- `dw = 0`: Pure velocity — only direction and speed matter
- `dw = 1`: Full displacement weighting — adds confidence when velocity and displacement agree on direction
- Only active when `momAlign = 1` (velocity and displacement have same sign)

Formula: `kalComp = clippedV × (1 − dw + dw × dispConf × momAlign)`

### lb (lookback bars)
Number of bars to look back when computing AMA slope:
- `lb = 4`: Very short-term, highly responsive to recent price action
- `lb = 1` (default): ~1 hour of hourly candles, very responsive and least smoothed
- `lb = 32`: ~1.3 days of hourly candles, stable but slower to react

Lower values = more noise, faster reaction. Higher values = smoother signals, more lag.

### regi (regime sensitivity)
- 0 = regime multiplier is always 1.0 (Hurst+PE ignored)
- 1 = default table values used as-is
- 2 = regime differences are squared (strong gating effect)

Regime is **dampen-only**: the multiplier is capped at 1.0 regardless of sensitivity. A favorable regime (trending + structured) passes the signal through unchanged; an unfavorable regime reduces it.

### Regime Table (Custom Configuration)

The 3×3 regime multiplier table can be customized per-market or per-bot:

```json
{
  "marketAdapterSettings": {
    "regimeTable": [
      [1.0, 0.7, 0.3],
      [0.6, 0.4, 0.15],
      [0.3, 0.2, 0.05]
    ]
  }
}
```

**Default Table:**
|  | PE<0.60 (Structured) | PE 0.725 (Mixed) | PE>0.85 (Noise) |
|--|---------------------|------------------|-----------------|
| **H>0.55** (Trending) | 1.0 | 0.7 | 0.3 |
| **H 0.45-0.55** (Random) | 0.6 | 0.4 | 0.15 |
| **H<0.45** (Mean-Rev) | 0.3 | 0.2 | 0.05 |

Best case (trending + structured) = 1.0 (full signal). Unclear situations reduce the offset.

## Data Pipeline

```
Candle Data
├── AMA3 (slow KAMA, erPeriod=781)
│   ├── calculateAMA() → AMA3 values per bar  [price panel overlay]
│   ├── computeAmaSlopeWeights() → slope%
│   └── Percentile clip → amaClip → amaOff
│
├── Kalman Filter (tactical + modal)
│   ├── KalmanTrendAnalyzer.update() → velocity%, displacement%, signal, isReady
│   └── Percentile clip → kalClip → composite → kalOff
│
├── Hurst Exponent  (window=256, scales=[8,16,32,64])
│   └── HurstAnalyzer.update() → hurst, regime            [regime multiplier axis]
│
├── Permutation Entropy  (m=5, delay=1, window=54)
│   └── PermutationEntropyAnalyzer.update() → normalizedEntropy, regime  [regime multiplier axis]
│
├── Regime Multiplier
│   └── min(bilinear(REGIME_TABLE, H, PE) ^ regimeSensitivity, 1.0) → finalMult  [dampen-only]
│
└── Normalized blend × regime multiplier
    blendedOff = (α·(amaOff / cap) + (1−α)·(kalOff / cap))
    gatedOff   = |blendedOff × finalMult| < minOutputThreshold ? 0 : (blendedOff × finalMult)
    off        = gatedOff × gain
    ├── sellW = 0.5 + off
    └── buyW  = 0.5 − off
```

## Key Files

| File | Role |
|------|------|
| `analysis/analyze_dynamic_weight.js` | Runner: loads data, computes all signals, generates chart |
| `analysis/trend_detection/dynamic_weight_chart_generator.js` | HTML generator: 4-panel uPlot chart with interactive knobs |
| `analysis/trend_detection/kalman_trend_analyzer.js` | Kalman filter with tactical/modal state tracking |
| `analysis/trend_detection/hurst_analyzer.js` | Hurst Exponent via R/S analysis (rolling 256-bar window) |
| `analysis/trend_detection/permutation_entropy_analyzer.js` | Permutation Entropy via ordinal pattern counting |
| `analysis/trend_detection/regime_defaults.js` | Shared Hurst + PE config (window sizes, scales) |
| `analysis/ama_fitting/ama.js` | Kaufman Adaptive Moving Average |
| `market_adapter/core/strategies/ama_slope_model.js` | AMA slope weight computation |
| `analysis/price_sources.js` | Unified candle data source abstraction |

## Runtime Notes

### Min-output threshold (`DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD`, default 0)

After the final blended trend offset is computed, if `|finalOff| < minOutputThreshold` the trend component is suppressed and treated as `0`.
The symmetric volatility penalty is still applied independently. This means the bot can still receive a volatility-only weight adjustment even when the trend signal is below threshold. The payload flag `isReady` is only `false` when neither a trend offset nor a volatility penalty is active.

The research chart now exposes this gate as the `th%` knob, so chart tuning and runtime overrides use the same threshold concept.

The runtime default is `0`, which disables the gate unless a market or bot override sets a higher threshold.

Can be overridden per-market or per-bot via `minOutputThreshold` in `marketAdapterSettings`.
