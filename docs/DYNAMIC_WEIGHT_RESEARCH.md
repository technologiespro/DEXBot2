# Dynamic Weight Research Tool

Interactive HTML chart for researching optimal dynamic weight parameters by blending AMA slope and Kalman filter signals.

## Quick Start

```bash
# From JSON candle file (recommended)
node analysis/analyze_dynamic_weight.js \
  --source json \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json

# With custom parameters
node analysis/analyze_dynamic_weight.js \
  --source json \
  --file market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h.json \
  --alpha 0.6 \
  --maxoff 0.4 \
  --dw 0.3 \
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
| `--maxoff` | `0.5` | Initial maxOff output ceiling |
| `--dw` | `0.4` | Initial displacement weight |
| `--clip` | `10` | Initial clip percentile |
| `--quiet` | `false` | Suppress console output |

## Chart Layout

Three stacked uPlot panels with synchronized zoom/pan (scroll to zoom, drag to pan, Ctrl+0 to reset):

### Panel 1 — AMA Slope Input
- **Orange line**: Raw AMA slope percentage
- Shows the directional strength of KAMA's trend movement
- Values outside the clip threshold are flattened before entering the offset formula
- Background shading: green = BULL signal, red = BEAR signal

### Panel 2 — Kalman Composite Input
- **Purple line**: Kalman velocity percentage  
- **Cyan dashed line**: Kalman displacement percentage (distance from modal/fair-value price)
- Velocity measures *direction and speed* of price movement
- Displacement measures *how far price has already moved* from equilibrium
- The composite formula blends these: `kalComp = vel% × (1 − dw + dw × dispConf × momAlign)`

### Panel 3 — Combined Weight Output
- Green/red fill: positive offset (sell weight > 0.5) vs negative offset (buy weight > 0.5)
- Legend shows: offset value, sell weight (S), buy weight (B)
- Interactive knobs for real-time parameter tuning

## Interactive Knobs — Core Parameters

| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **α** | 0–1 | 0.5 | Blend ratio: `off = α × amaOff + (1−α) × kalOff` |
| **maxS%** | 0.05–10 | 3.0 | Gear ratio: what slope% saturates the output |
| **maxOff** | 0–1 | 0.5 | Output ceiling: maximum offset both channels can produce |
| **dw** | 0–1 | 0.4 | Displacement weight in Kalman composite (0 = pure velocity, 1 = full modulation) |
| **nz%** | 0–1 | 0.15 | Neutral zone: dead-band where offset = 0 |

## Interactive Knobs — Experimental (Research Only)

| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **clip%** | 0–80 | 10 | ⚠️ Percentile clip: filters extreme inputs (research use only, see notes below) |

## Formulas

### AMA Offset
```
amaClip = clamp(amaSlope%, ±clipThreshold)    // percentile-based clip
amaOff  = clamp(amaClip / maxS% × maxOff, ±maxOff)
```

### Kalman Composite Offset
```
kalClip   = clamp(velocity%, ±clipThreshold)   // percentile-based clip
dispConf  = min(|displacement%| / 1.0, 1)      // 1% disp = full confidence
momAlign  = sign(kalClip) == sign(disp%) ? 1 : -0.5
kalComp   = kalClip × (1 − dw + dw × dispConf × momAlign)
kalOff    = clamp(kalComp / maxS% × maxOff, ±maxOff)
```

### Final Weight
```
off    = α × amaOff + (1 − α) × kalOff
sellW  = 0.5 + off
buyW   = 0.5 − off
```

## Clip Percentile Logic (EXPERIMENTAL — RESEARCH ONLY)

The `clip%` knob uses **percentile-based thresholds** computed from the actual data distribution:

- **clip = 0%**: No clipping — full raw range is passed through
- **clip = 10%**: AMA threshold = P90 of |slope%|, Kalman threshold = P90 of |vel%| — top 10% outliers are flattened
- **clip = 50%**: Thresholds = P50 (median) — only the middle 50% of values pass through unclipped
- **clip = 80%**: Very aggressive — only the flattest 20% of values survive

Each input gets its own threshold from its own distribution, so a clip of 10% means completely different absolute values for AMA (P90 ≈ 10.69%) vs Kalman (P90 ≈ 0.55%).

The current thresholds are shown live in the formula bar at the bottom of the output panel as you drag the knob.

**NOTE**: This feature is designed for historical data research. In production systems, percentiles would need to be computed from rolling windows. Currently unsuitable for live trading — for research use only.

## Parameter Relationships

### maxS% + maxOff (formerly amaMax + kalMax + maxS%)

These three were merged because they were multiplicatively redundant:
- `off = clip / maxS% × maxOff` — raising `maxS%` from 3→6 has the same effect as halving `maxOff`
- Single `maxS%` = gear ratio (how steep a signal saturates)
- Single `maxOff` = output volume (how strong the weight can become)

### α (blend)
- 0 = pure Kalman (momentum + displacement composite)
- 1 = pure AMA slope
- 0.5 = equal blend

### dw (displacement weight)
- 0 = pure velocity (original Kalman behavior)
- 1 = full displacement modulation (velocity only matters when displacement confirms direction)
- 0.4 (default) = gentle displacement weighting

## Data Pipeline

```
Candle Data
├── AMA (Kaufman Adaptive Moving Average)
│   ├── calculateAMA() → AMA values per bar
│   ├── computeAmaSlopeWeights() → slope%, isReady, slopeOffset
│   └── Percentile clip → amaClip → amaOff
│
├── Kalman Filter
│   ├── KalmanTrendAnalyzer.update() → velocity%, displacement%, signal, isReady
│   └── Percentile clip → kalClip → composite → kalOff
│
└── Blend → off = α·amaOff + (1−α)·kalOff
    ├── sellW = 0.5 + off
    └── buyW  = 0.5 − off
```

## Key Files

| File | Role |
|------|------|
| `analysis/analyze_dynamic_weight.js` | Runner: loads data, computes AMA + Kalman, generates chart |
| `analysis/trend_detection/dynamic_weight_chart_generator.js` | HTML generator: 3-panel uPlot chart with interactive knobs |
| `analysis/trend_detection/kalman_trend_analyzer.js` | Kalman filter with tactical/modal state tracking |
| `analysis/ama_fitting/ama.js` | Kaufman Adaptive Moving Average |
| `market_adapter/core/strategies/ama_slope_model.js` | AMA slope weight computation |
| `analysis/price_sources.js` | Unified candle data source abstraction |