# Dynamic Weight Research Tool

Interactive HTML chart for researching optimal dynamic weight parameters by blending AMA slope and Kalman filter signals.

## Quick Start

```bash
# From JSON candle file (recommended)
node analysis/analyze_dynamic_weight.js \
  --source json \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json

# With custom initial parameters
node analysis/analyze_dynamic_weight.js \
  --source json \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --alpha 0.6 \
  --maxoff 0.10 \
  --clip 20
```

Output: `analysis/charts/dynamic_weight_chart.html` (open in browser)

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `market_adapter` | Data source type (`json`, `market_adapter`) |
| `--file` | — | Path to JSON candle file (implies `--source json`) |
| `--bot-key` | `XRP-BTS` | Bot key for market adapter source |
| `--chart` | `analysis/charts/dynamic_weight_chart.html` | Output HTML path |
| `--alpha` | `0.5` | Initial α blend (0 = pure Kalman, 1 = pure AMA) |
| `--maxoff` | `0.5` | Initial maxOff (UI range 0.001–0.25, log) |
| `--clip` | `10` | Initial clip percentile |
| `--quiet` | `false` | Suppress console output |

## Chart Layout

Four stacked uPlot panels with synchronized zoom/pan (scroll to zoom, drag to pan, Ctrl+0 to reset):

### Panel 1 — Log Price (36%)
- **Blue line**: Price on logarithmic y-axis
- **Gold line**: AMA3 (slow KAMA from `constants.js`, erPeriod=781) for macro trend reference
- Background shading: green = BULL signal, red = BEAR signal

### Panel 2 — AMA Slope Input (15%)
- **Orange line**: AMA3 slope percentage
- Shows the directional strength of the slow KAMA's trend movement
- Values outside the clip threshold are flattened before entering the offset formula
- Background shading: green = BULL signal, red = BEAR signal

### Panel 3 — Kalman Composite Input (19%)
- **Purple line**: Kalman velocity percentage
- **Cyan dashed line**: Kalman displacement percentage (distance from modal/fair-value price)
- Velocity measures *direction and speed* of price movement
- Displacement measures *how far price has already moved* from equilibrium

### Panel 4 — Combined Weight Output (remaining ~30%)
- Green/red fill: positive offset (sell weight > 0.5) vs negative offset (buy weight > 0.5)
- Legend shows: offset value, sell weight (S), buy weight (B)
- Interactive knobs for real-time parameter tuning

## Interactive Knobs

| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **α** | 0–1 | 0.5 | Blend ratio between AMA and Kalman channels (0 = pure Kalman, 1 = pure AMA) |
| **maxS%** | 0.05–15 | 3.0 | Logarithmic. Gear ratio: slope% at which the output saturates |
| **maxOff** | 0.001–0.25 | 0.10 | Logarithmic. Output ceiling: maximum offset the combined signal can produce |
| **clip%** | 0–50 | 10 | ⚠️ Percentile clip: filters extreme inputs (research use only, see notes below) |
| **nz%** | 0–1 | 0.15 | Neutral zone: dead-band below which offset is forced to 0 |
| **gain** | 0.1×–10× | 1.0× | Logarithmic, symmetric. Amplifies or attenuates the final output; hard-capped at ±0.5 |

## Copy / Paste Parameters

The **copy** button serializes all six knob values (α, maxS%, maxOff, clip%, nz%, gain) to JSON and writes them to both the clipboard and `localStorage`.

The **paste** button triggers the browser's native clipboard-read prompt. On accept, a confirmation popup shows the parsed values before applying them. Click **Apply** to set the knobs, **Cancel** or press **Escape** to dismiss. If the clipboard API is unavailable (e.g. `file://` URL in some browsers), it falls back to `localStorage` (same-browser copy) and then a Ctrl+V capture mode.

## Formulas

### AMA Offset
```
amaClip = clamp(amaSlope%, ±clipThreshold)    // percentile-based clip
amaOff  = clamp(amaClip / maxS% × maxOff, ±maxOff)
```

### Kalman Composite Offset
```
kalClip   = clamp(velocity%, ±clipThreshold)   // percentile-based clip
dispConf  = min(|displacement%| / md%, 1)      // displacement confidence, 0–1
momAlign  = sign(kalClip) == sign(displacement%) ? 1 : 0
kalComp   = kalClip × (1 − dw + dw × dispConf × momAlign)  // dw hardcoded to 1.0
kalOff    = clamp(kalComp / maxS% × maxOff, ±maxOff)
```

### Final Weight (per-channel normalized blend + gain)

Each channel is normalized to its own peak before blending, so α is a pure ratio knob and `maxOff` is the base amplitude. `gain` then scales the result linearly, hard-capped at ±0.5:

```
aMax  = max(|amaOff|) over all bars
kMax  = max(|kalOff|) over all bars
off   = clamp((α × (amaOff / aMax) + (1 − α) × (kalOff / kMax)) × maxOff × gain, ±0.5)
sellW = 0.5 + off
buyW  = 0.5 − off
```

## Clip Percentile Logic (EXPERIMENTAL — RESEARCH ONLY)

The `clip%` knob uses **percentile-based thresholds** computed from the actual data distribution:

- **clip = 0%**: No clipping — full raw range is passed through
- **clip = 10%**: AMA threshold = P90 of |slope%|, Kalman threshold = P90 of |vel%| — top 10% outliers are flattened
- **clip = 50%**: Thresholds = P50 (median) — only the middle 50% of values pass through unclipped

Each input gets its own threshold from its own distribution.

**NOTE**: Percentiles are computed from the full historical dataset loaded at startup. Currently unsuitable for live trading — for research use only.

## Parameter Relationships

### maxS% + maxOff

These are multiplicatively related:
- `off = clip / maxS% × maxOff` — raising `maxS%` from 3→6 has the same effect as halving `maxOff`
- `maxS%` = gear ratio (what slope% saturates the output). Logarithmic slider for fine control at small values.
- `maxOff` = output amplitude (how strong the weight offset can become)

### α (blend)
- 0 = pure Kalman (momentum + displacement composite)
- 1 = pure AMA slope
- 0.5 = equal blend

Each channel is normalized to its own peak before blending, so changing α only shifts the ratio — it does not change the output amplitude. `maxOff` is the sole amplitude control.

### nz% (neutral zone)
Values below `nz%` in absolute terms are zeroed out before the offset formula. Raises the signal floor and suppresses noise in low-momentum periods.

## Data Pipeline

```
Candle Data
├── AMA3 (slow KAMA, erPeriod=781)
│   ├── calculateAMA() → AMA3 values per bar  [price panel overlay]
│   ├── computeAmaSlopeWeights() → slope%
│   └── Percentile clip → amaClip → amaOff
│
├── Kalman Filter
│   ├── KalmanTrendAnalyzer.update() → velocity%, displacement%, signal, isReady
│   └── Percentile clip → kalClip → composite → kalOff
│
└── Normalized blend → off = (α·(amaOff/aMax) + (1−α)·(kalOff/kMax)) × maxOff
    ├── sellW = 0.5 + off
    └── buyW  = 0.5 − off
```

## Key Files

| File | Role |
|------|------|
| `analysis/analyze_dynamic_weight.js` | Runner: loads data, computes AMA + Kalman, generates chart |
| `analysis/trend_detection/dynamic_weight_chart_generator.js` | HTML generator: 4-panel uPlot chart with interactive knobs |
| `analysis/trend_detection/kalman_trend_analyzer.js` | Kalman filter with tactical/modal state tracking |
| `analysis/ama_fitting/ama.js` | Kaufman Adaptive Moving Average |
| `market_adapter/core/strategies/ama_slope_model.js` | AMA slope weight computation |
| `analysis/price_sources.js` | Unified candle data source abstraction |
