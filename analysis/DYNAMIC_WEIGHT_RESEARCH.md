# Dynamic Weight Research Tool

Interactive HTML chart for researching optimal dynamic weight parameters by blending AMA slope and Kalman filter signals, gated by Hurst Exponent and Permutation Entropy regime detection.

## Signal design rationale

### AMA slope

The AMA's Efficiency Ratio (`ER = net price change / sum of bar-by-bar changes`) adapts its smoothing speed to market conditions. In a choppy pool `ER ≈ 0` and the AMA barely moves; in a trend `ER ≈ 1` and it tracks price closely. Taking the slope of the AMA therefore produces a signal that is already noise-filtered at the source — a near-zero slope genuinely means sideways, not oscillation that happened to average out. The neutral zone (`neutralZonePct`) dead-bands any remaining micro-slope residuals, which is all the additional filtering needed.

### Kalman filter

The Kalman filter is a state estimator: it separates true price and velocity from measurement noise via its R and Q parameters rather than smoothing over it. Running two filters at different Q values gives two orthogonal signals:

- **Velocity** (tactical filter, high Q): direction and speed of price right now — responsive to inflections without reacting to wicks.
- **Displacement** (modal filter, very low Q): how far price has moved from the long-run equilibrium ("center of gravity") — captures extension, not just momentum direction.

Velocity and displacement carry different information and are kept in separate chart panels. The `dispWeight` knob only adds displacement confidence when the two signals agree on direction.

### Hurst Exponent

Estimates the long-memory property of the price series via Rescaled Range (R/S) analysis over a rolling window of 256 bars with scales `[8, 16, 32, 64]`.

| H value | Regime | Meaning |
|---|---|---|
| H > 0.55 | TRENDING | Returns are persistent — trends continue |
| H ≈ 0.5 | RANDOM | No memory — random walk |
| H < 0.45 | MEAN_REVERTING | Returns are anti-persistent — reversals dominate |

**Algorithm**: for each scale τ, partition the log-return window into non-overlapping chunks of length τ, compute the average R/S (Rescaled Range) per chunk, then OLS-fit `log(avgRS)` vs `log(τ)` — the slope is the Hurst exponent.

**Role in the tool**: Hurst is one axis of the regime multiplier matrix (see [Regime Multiplier](#regime-multiplier)). It is a research overlay — it is visualized but not yet hardwired into the bot's weight logic.

**Warmup**: requires 256 bars before `isReady = true`.

### Permutation Entropy

Measures market disorder by counting ordinal (rank-order) patterns in a rolling window of 54 bars, with embedding dimension `m=5` and delay `1`.

| Normalized PE | Regime | Meaning |
|---|---|---|
| PE < 0.60 | STRUCTURED | Price movement is ordered — signals are trustworthy |
| 0.60–0.85 | MIXED | Partial structure |
| PE > 0.85 | NOISE | Maximum disorder — no reliable edge |

**Algorithm**: for each position `i` in the window, extract the rank-order of `[price[i], price[i+1], ..., price[i+m-1]]` as an ordinal pattern key. Compute Shannon entropy over the distribution of all `m! = 120` possible patterns, normalized by `log(m!)` to give PE ∈ [0, 1].

**Role in the tool**: PE is the second axis of the regime multiplier matrix. It complements Hurst — Hurst identifies trend persistence, PE identifies signal quality. Together they gate the output amplitude.

**Warmup**: requires 58 bars (`window + (m-1) * delay`) before `isReady = true`.

### Regime Multiplier

Hurst and PE are combined into a single regime multiplier via bilinear interpolation over a 3×3 lookup table:

```
                PE < 0.60     PE 0.725     PE > 0.85
                (Structured)  (Mixed)      (Noise)
H > 0.55  →    1.5           1.1          0.7
H 0.45–0.55 →  0.8           0.5          0.2
H < 0.45  →    0.6           0.3          0.1
```

Best case (trending + structured): multiplier = **1.5×** — weight signal is amplified.
Worst case (mean-reverting + noisy): multiplier = **0.1×** — weight signal is nearly silenced.

The `regi` (regime sensitivity) knob raises the multiplier to a power: `finalMult = baseMult ^ sensitivity`. At sensitivity = 1.0 (default), the table is used as-is. Higher sensitivity exaggerates regime differences; lower sensitivity flattens them toward 1.0.

## Quick Start

```bash
# From JSON candle file
node analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json

# With custom initial parameters
node analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --alpha 0.6 \
  --gain 0.10 \
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
| `--dw` | `1.0` | Initial displacement weight (0 = pure velocity, 1 = full displacement) |
| `--lb` | `72` | Initial lookback bars (4-256) for AMA slope calculation |
| `--gain` | `0.5` | Initial gain multiplier |
| `--clip` | `10` | Initial clip percentile |
| `--quiet` | `false` | Suppress console output |

## Chart Layout

Four stacked uPlot panels with synchronized zoom/pan (scroll to zoom, drag to pan, Ctrl+0 to reset):

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
- **Purple line**: Kalman velocity percentage (tactical filter)
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
| **dw** | 0–1 | 1.0 | Displacement weight: how much Kalman displacement influences the composite signal |

### Slope Calculation
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **nz%** | 0–1 | 0.15 | Neutral zone: dead-band below which offset is forced to 0 |
| **lb** | 4–256 | 72 | Logarithmic. Lookback bars for AMA slope calculation |
| **maxS%** | 0.05–20 | 3.0 | Logarithmic. Gear ratio: slope% at which the output saturates |
| **clip%** | 0–55 | 10 | Percentile clip: filters extreme inputs (0 = off) |

### Output Controls
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **gain** | 0.001–3.0 | 0.5 | Logarithmic. Amplitude multiplier on normalized blend |
| **regi** | 0–2 | 0.0 | Regime sensitivity: exponent applied to Hurst+PE multiplier |

## Copy / Paste Parameters

The **copy** button serializes all knob values (α, dw, lb, maxS%, gain, clip%, nz%, regi) to JSON and writes them to both the clipboard and `localStorage`.

The **paste** button first checks `localStorage` for parameters from a previous copy in the same browser session. If none found, it prompts for Ctrl+V input. A confirmation popup shows the parsed values before applying them. Click **Apply** to set the knobs, **Cancel** or press **Escape** to dismiss.

## Formulas

### AMA Offset
```
amaClip = clamp(amaSlope%, ±clipThreshold)    // percentile-based clip
amaOff  = clamp(amaClip / maxS% × gain, ±gain)
```

### Kalman Composite Offset
```
kalClip   = clamp(velocity%, ±clipThreshold)   // percentile-based clip
dispConf  = min(|displacement%| / md%, 1)      // displacement confidence, 0–1
momAlign  = sign(kalClip) == sign(displacement%) ? 1 : 0
kalComp   = kalClip × (1 − dw + dw × dispConf × momAlign)
kalOff    = clamp(kalComp / maxS% × gain, ±gain)
```

### Regime Multiplier
```
baseMult  = bilinear(REGIME_TABLE, H, PE)      // 0.1–1.5 depending on regime
finalMult = baseMult ^ regimeSensitivity        // power scaling via regi knob
```

### Final Weight (per-channel normalized blend + gain)

Each channel is normalized to its own peak before blending, so α is a pure ratio knob. Gain scales the result linearly, hard-capped at ±0.5:

```
aMax  = max(|amaOff|) over all bars
kMax  = max(|kalOff|) over all bars
rawOff = (α × (amaOff / aMax) + (1 − α) × (kalOff / kMax)) × gain
off   = clamp(rawOff × finalMult, ±0.5)
sellW = 0.5 + off
buyW  = 0.5 − off
```

## Parameter Relationships

### maxS% + gain

These are multiplicatively related:
- `off = clip / maxS% × gain` — raising `maxS%` from 3→6 has the same effect as halving `gain`
- `maxS%` = gear ratio (what slope% saturates the output)
- `gain` = output amplitude (how strong the weight offset can become)

### α (blend)
- 0 = pure Kalman (momentum + displacement composite)
- 1 = pure AMA slope
- 0.5 = equal blend

Each channel is normalized to its own peak before blending, so changing α only shifts the ratio — it does not change the output amplitude. Gain is the sole amplitude control.

### nz% (neutral zone)
Values below `nz%` in absolute terms are zeroed out before the offset formula.

### dw (displacement weight)
Controls how much the Kalman displacement (distance from equilibrium) influences the composite signal:
- `dw = 0`: Pure velocity — only direction and speed matter
- `dw = 1`: Full displacement weighting — adds confidence when velocity and displacement agree on direction
- Only active when `momAlign = 1` (velocity and displacement have same sign)

Formula: `kalComp = clippedV × (1 − dw + dw × dispConf × momAlign)`

### lb (lookback bars)
Number of bars to look back when computing AMA slope:
- `lb = 4`: Very short-term, highly responsive to recent price action
- `lb = 72` (default): ~3 days of hourly candles, balanced responsiveness
- `lb = 256`: ~10 days of hourly candles, very stable but slower to react

Lower values = more noise, faster reaction. Higher values = smoother signals, more lag.

### regi (regime sensitivity)
- 0 = regime multiplier is always 1.0 (Hurst+PE ignored)
- 1 = default table values used as-is
- 2 = regime differences are squared (strong gating effect)

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
│   └── bilinear(REGIME_TABLE, H, PE) ^ regimeSensitivity → finalMult
│
└── Normalized blend × regime gate
    rawOff = (α·(amaOff/aMax) + (1−α)·(kalOff/kMax)) × gain
    off    = clamp(rawOff × finalMult, ±0.5)
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
