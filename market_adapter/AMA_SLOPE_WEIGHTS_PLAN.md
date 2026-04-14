# AMA Slope — Weight Adjustment Integration Plan

**Status:** Design / not yet implemented  
**Scope:** Replace current signal-based trend detection (TrendAnalyzer) with a direct
AMA-slope-derived buy/sell weight offset

---

## 1. Goal

Adjust `buy`/`sell` order weights in proportion to **how fast the AMA is currently
moving**, while staying immune to short-term price flicker. The offset is computed
directly from the AMA slope — no confidence tiers, no multi-indicator alignment.

---

## 2. Problem with the current approach

`market_adapter_service.js` strategy section (lines 194–214) runs:

```
candles → TrendAnalyzer → DerivativeAnalyzer
                           ├─ SMA(500) slow + SMA(100) fast: trend direction from SMA derivative
                           ├─ MACD(12,26,9): momentum filter
                           └─ RSI(14): exhaustion / counter-trend filter
          → { trend, confidence, isReady }
          → computeDynamicWeights
          → adjustCollateralRatio
```

Issues:
- SMA(500) needs 500 candles before `isReady = true`. At 1h intervals that is ~21 days
  of warm-up every time the adapter resets. During that window weights stay at neutral
  baseline.
- "Confidence" is derived from the derivative of a heavily smoothed line, not from the
  actual price move magnitude.
- MACD and RSI are signal-layer indicators. They can fire on noise if the underlying
  candles are volatile, because they are computed independently of the AMA's
  noise-suppression logic.
- `trendService.reset()` is called on every poll cycle (line 199), replaying the full
  candle history each time.

---

## 3. Core concept — AMA slope as weight driver

The AMA (Kaufman's Adaptive Moving Average, `analysis/ama_fitting/ama.js`) already
solves the flicker problem through its **Efficiency Ratio**:

```
ER = |net price change over erPeriod bars| / sum(|each bar's change|)

Choppy market : price oscillates → large denominator, small numerator → ER ≈ 0 → AMA barely moves
Trending market: price moves directionally → numerator ≈ denominator → ER ≈ 1 → AMA tracks price
```

Default AMA parameters (`DEFAULT_AMA_KEY = 'AMA3'`, from `modules/constants.js`):

```
erPeriod  = 781   (shared by AMA1–AMA4)
fastPeriod = 5.2
slowPeriod = 112.7
```

With `erPeriod = 781` at 1h candles the AMA needs ~781 bars (~32.5 days) before it
stabilises. Any movement reflected in the AMA is by definition substantial and
filtered of noise.

**The slope of the AMA series over a lookback window is therefore a direct, filtered
measure of real market velocity:**

```
slopePct = (amaValues[N-1] - amaValues[N-1-lookbackBars]) / amaValues[N-1-lookbackBars] × 100
```

- Positive slope → AMA rising → market trending up
- Negative slope → AMA falling → market trending down
- Near-zero slope → choppy / sideways

---

## 4. Two independent weight factors

The final weights are the sum of two orthogonal adjustments applied on top of
`BASELINE_WEIGHT (0.5)`:

```
sellW = baseline + slopeOffset + symmetricDelta
buyW  = baseline - slopeOffset + symmetricDelta
```

- **`slopeOffset`** — asymmetric, driven by AMA slope (trend direction + speed)
- **`symmetricDelta`** — symmetric, driven by ATR volatility (market noise level)

Both are additive and independent. Each factor is bounded by the same constant:

```
MAX_OFFSET_FROM_NEUTRAL = 0.5   // module-level constant, not configurable per bot
```

This is a structural limit on how far weights can deviate from baseline (0.5),
regardless of how reactive the config params make the model. It is **not** exposed
in `opts` or in `amaSlope` config — it does not belong to market-reading tuning.
Weight clamps (`MIN_WEIGHT = -0.5`, `MAX_WEIGHT = 1.5`) are applied to the final sum.

---

## 4a. Factor 1 — Slope offset (asymmetric)

No confidence tiers. The slope percentage is mapped linearly to a signed offset,
bounded by `MAX_OFFSET_FROM_NEUTRAL`:

```
slopeOffset = clamp(slopePct / maxSlopePct, -1, 1) × MAX_OFFSET_FROM_NEUTRAL
```

Rationale: when AMA rises fast, price is moving toward sell orders (away from buy
orders) → add weight to sell side, subtract from buy side.
When AMA falls fast, the reverse applies.

Configurable parameters (market-reading tuning only):

| Parameter        | Default | Meaning                                           |
|------------------|---------|---------------------------------------------------|
| `lookbackBars`   | 72      | 72 h (3 days) at 1h interval                     |
| `maxSlopePct`    | 3.0     | slope % at which offset saturates at ±MAX_OFFSET  |
| `neutralZonePct` | 0.15    | slope magnitude below which offset = 0            |

`neutralZonePct` dead-bands micro-slope noise near zero.
`MAX_OFFSET_FROM_NEUTRAL` (0.5) is a module constant — not in config.

---

## 4b. Factor 2 — Volatility symmetric delta

Source: `weightVariance = ATR(14) / amaPrice` (already computed in the service).

```
volFactor      = 1 - clamp(weightVariance / maxVolatilityThreshold, 0, 1)
symmetricDelta = (volFactor × 2 - 1) × MAX_OFFSET_FROM_NEUTRAL
```

`volFactor` maps ATR/price to [0, 1]. The formula then scales it to
`[−MAX_OFFSET_FROM_NEUTRAL, +MAX_OFFSET_FROM_NEUTRAL]`, centred at 0 (baseline
unchanged) when `volFactor = 0.5`.

| `weightVariance`                        | `volFactor` | `symmetricDelta` | both weights (neutral slope) |
|-----------------------------------------|-------------|------------------|------------------------------|
| 0 (no movement)                         | 1.0         | +0.50            | 1.00  (concentrate near market) |
| `maxVolatilityThreshold / 2` (mid-vol)  | 0.5         |  0.00            | 0.50  (baseline)             |
| ≥ `maxVolatilityThreshold` (high vol)   | 0.0         | −0.50            | 0.00  (spread flat)          |

Rationale:
- **Low volatility** → price oscillating tightly → orders near market fill reliably
  → concentrate both sides toward market (increase both weights toward 1.0).
- **High volatility** → price ranging widely → orders near market at risk of being
  swept in a single spike → thin both sides (decrease toward 0.0).

Configurable parameter (market-reading tuning only):

| Parameter               | Default | Meaning                                           |
|-------------------------|---------|---------------------------------------------------|
| `maxVolatilityThreshold`| 0.03    | ATR/price ratio at which symmetricDelta = −MAX_OFFSET |

`MAX_OFFSET_FROM_NEUTRAL` (0.5) is a module constant — not in config.

### Combined example table (neutral slope = slopeOffset 0)

| ATR/price | symmetricDelta | sellW | buyW  |
|-----------|----------------|-------|-------|
| 0.00      | +0.50          | 1.00  | 1.00  |
| 0.015     |  0.00          | 0.50  | 0.50  |
| 0.03      | −0.50          | 0.00  | 0.00  |

### Combined example table (uptrend, slopeOffset = +0.33)

| ATR/price | symmetricDelta | sellW | buyW  |
|-----------|----------------|-------|-------|
| 0.00      | +0.50          | 1.33  → 1.33 | 0.17 |
| 0.015     |  0.00          | 0.83  | 0.17  |
| 0.03      | −0.50          | −0.17 → 0.00 | −0.33 → 0.00 |

*(clamped to MIN_WEIGHT = −0.5 / MAX_WEIGHT = 1.5)*

---

## 5. Output interface

`computeAmaSlopeWeights` returns:

```js
{
  sellW:          number,              // final sell weight (baseline + slopeOffset + symmetricDelta, clamped)
  buyW:           number,              // final buy weight  (baseline - slopeOffset + symmetricDelta, clamped)
  slopeOffset:    number,              // asymmetric offset  [-MAX_OFFSET_FROM_NEUTRAL, +MAX_OFFSET_FROM_NEUTRAL]
  symmetricDelta: number,              // symmetric delta    [-MAX_OFFSET_FROM_NEUTRAL, +MAX_OFFSET_FROM_NEUTRAL]
  slopePct:       number,              // raw AMA slope in percent
  confidence:     number,              // 0–100, derived: |slopeOffset| / MAX_OFFSET × 100
  trend:          'UP'|'DOWN'|'NEUTRAL',  // derived from slope sign
  isReady:        boolean
}
```

`confidence` is derived mechanically from `slopeOffset` magnitude — it is not an
independent input, but it lets `adjustCollateralRatio` and `computeSlotFillProbabilities`
consume the result without signature changes.

---

## 6. New file

**`market_adapter/core/strategies/ama_slope_model.js`**

Module-level constants (not in opts):

```js
const { MARKET_ADAPTER } = require('../../../modules/constants');

const MAX_OFFSET_FROM_NEUTRAL = 0.5;  // structural cap for both factors
const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;
// = 781  (shared by AMA1–AMA4; used for isReady warm-up guard)
```

Pure function, no class, no state. Signature:

```js
/**
 * @param {number[]} amaValues        Full AMA series (output of calculateAMA)
 * @param {number}   weightVariance   ATR(14) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]           Market-reading tuning only — no offset bounds here
 * @param {number}   [opts.lookbackBars=72]             Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=3.0]             Slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=0.15]         Dead-band around zero slope
 * @param {number}   [opts.maxVolatilityThreshold=0.03] ATR/price ratio = full high-vol state
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @returns {{ sellW, buyW, slopeOffset, symmetricDelta, slopePct, confidence, trend, isReady }}
 */
function computeAmaSlopeWeights(amaValues, weightVariance, opts = {}) { ... }

module.exports = { computeAmaSlopeWeights, MAX_OFFSET_FROM_NEUTRAL };
```

Internal steps:

1. Guard: `amaValues.length < erPeriod + lookbackBars + 1` → `{ isReady: false, sellW: 0.5, buyW: 0.5, slopeOffset: 0, symmetricDelta: 0, slopePct: 0, confidence: 0, trend: 'NEUTRAL' }`.
2. `last = amaValues[N-1]`, `past = amaValues[N-1-lookbackBars]`.
3. `slopePct = (last - past) / past × 100`.
4. Slope factor: if `|slopePct| < neutralZonePct` → `slopeOffset = 0`, `trend = 'NEUTRAL'`.  
   Else: `slopeOffset = clamp(slopePct / maxSlopePct, -1, 1) × MAX_OFFSET_FROM_NEUTRAL`, `trend = slopePct > 0 ? 'UP' : 'DOWN'`.
5. Derive confidence from offset magnitude (used by collateral and slot fill):  
   `confidence = Math.round(Math.abs(slopeOffset) / MAX_OFFSET_FROM_NEUTRAL * 100)`.  
   Range: 0 (flat/neutral) → 100 (fully saturated slope). No external input required.
6. Volatility factor: `volFactor = 1 - clamp(weightVariance / maxVolatilityThreshold, 0, 1)`.  
   `symmetricDelta = (volFactor × 2 - 1) × MAX_OFFSET_FROM_NEUTRAL`.
7. `sellW = clamp(0.5 + slopeOffset + symmetricDelta, -0.5, 1.5)`.
8. `buyW  = clamp(0.5 - slopeOffset + symmetricDelta, -0.5, 1.5)`.
9. Round `sellW`, `buyW`, `slopeOffset`, `symmetricDelta` to 2 decimal places.
10. Return `{ sellW, buyW, slopeOffset, symmetricDelta, slopePct, confidence, trend, isReady: true }`.

No class instantiation, no loop, no state. Idempotent.

---

## 7. Changes to `market_adapter_service.js`

### 7a. Imports — add, remove

Remove:
```js
const { TrendAnalyzer } = require('../../analysis/trend_detection/trend_analyzer');
```

Add:
```js
const { computeAmaSlopeWeights } = require('./strategies/ama_slope_model');
const { calculateAMA } = require('../../analysis/ama_fitting/ama');
```

Remove:
```js
const { computeDynamicWeights } = require('./strategies/dynamic_weights');
```

(`computeDynamicWeights` is replaced by the direct offset application below. Keep the
file for now — `computeSlotFillProbabilities` is still used.)

### 7b. Constructor — remove per-bot TrendAnalyzer map

Remove:
```js
this.trendServices = new Map();
```

Remove method `_getTrendService(botKey)` entirely.

### 7c. `processBot` — strategy section (current lines 191–214)

**Replace** lines 191–214:

```js
// 1. AMA series (used for price reference and slope-based weight offset)
const closes = nextCandles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);
const amaValues = calculateAMA(closes, botAma);

// amaPrice replaces separate calcAmaPrice call
const amaPrice = amaValues.length > 0 ? amaValues[amaValues.length - 1] : null;

// 2. ATR — volatility input for symmetric weight factor
const atr = calculateATR(nextCandles, 14);
const weightVariance = amaPrice > 0 ? (atr / amaPrice) : 0;

// 3. Slope + volatility → weights
//    slopeOffset (asymmetric) + symmetricDelta (volatility) combined in one call
const slopeCfg = cfg.amaSlope || {};
const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

// 4. Collateral Strategy — uses derived confidence (proportional to slope magnitude)
const collateral = adjustCollateralRatio(slopeResult, 1.5, 2.0);
```

`slopeResult` already has the shape `{ trend, confidence, isReady }` that
`adjustCollateralRatio` expects. No wrapper object needed.

The weights object returned to the result is built directly from `slopeResult`:

```js
const weights = {
    sell: slopeResult.sellW,
    buy:  slopeResult.buyW,
    profile: slopeResult.isReady
        ? (slopeResult.trend === 'NEUTRAL' ? 'flat' : 'slope')
        : 'static',
    meta: {
        source:         'ama_slope',
        trend:          slopeResult.trend,
        confidence:     slopeResult.confidence,
        slopePct:       slopeResult.slopePct,
        slopeOffset:    slopeResult.slopeOffset,
        symmetricDelta: slopeResult.symmetricDelta,
        isReady:        slopeResult.isReady,
    },
};
```

### 7d. Result object — add slope meta

In the `processBot` return value, replace the current `weights` field structure and
add:

```js
amaSlope: {
    trend:          slopeResult.trend,
    confidence:     slopeResult.confidence,
    slopePct:       slopeResult.slopePct,
    slopeOffset:    slopeResult.slopeOffset,
    symmetricDelta: slopeResult.symmetricDelta,
    weightVariance,                            // ATR/price — home for this value
    isReady:        slopeResult.isReady,
},
```

---

## 8. Configuration additions

### `market_adapter_settings.json` — globals section

```json
"amaSlope": {
  "lookbackBars":           72,
  "maxSlopePct":            3.0,
  "neutralZonePct":         0.15,
  "maxVolatilityThreshold": 0.03
}
```

`MAX_OFFSET_FROM_NEUTRAL` (0.5) is a module constant in `ama_slope_model.js`.
It is intentionally absent from config — the weight offset bound is structural and
should not vary per bot, pair, or deployment.

These become the defaults. Any pair or bot override section can add its own
`"amaSlope"` block following the existing three-tier resolution (bot override →
pair setting → global default).

**Example pair-level override** (less reactive pair, wider neutral zone, more vol tolerance):
```json
"marketAdapterSettings": {
  "amaSlope": {
    "neutralZonePct":         0.3,
    "maxSlopePct":            5.0,
    "maxVolatilityThreshold": 0.05
  }
}
```

**Example bot-level override** (shorter lookback, faster reaction):
```json
"botOverrides": {
  "XRP-BTS-Aggressive": {
    "amaSlope": {
      "lookbackBars":   36,
      "neutralZonePct": 0.1
    }
  }
}
```

All four config keys tune **how the market is read** (slope sensitivity, vol sensitivity,
lookback horizon). The **weight bound** (`MAX_OFFSET_FROM_NEUTRAL`) is a module constant
and is therefore absent from all override blocks.

---

## 9. What is removed

| Item | Location | Reason |
|------|----------|--------|
| `TrendAnalyzer` import | `market_adapter_service.js` | Replaced by `computeAmaSlopeWeights` |
| `_getTrendService(botKey)` method | `market_adapter_service.js` | Stateful per-bot analyzer no longer needed |
| `this.trendServices = new Map()` | `MarketAdapterService` constructor | — |
| `trendService.reset()` + replay loop | `processBot` strategy section | Replaced |
| `computeDynamicWeights` call | `processBot` strategy section | Weights built directly from slope offset |
| `confidence` field | all outputs | Replaced by `slopePct` + `slopeOffset` |
| `analysis/trend_detection/trend_analyzer.js` | *(keep for now)* | May be used elsewhere; deprecate separately |
| `analysis/trend_detection/derivative_analyzer.js` | *(keep for now)* | Same |

---

## 10. Impact on downstream consumers

| Consumer | Change required |
|----------|----------------|
| `adjustCollateralRatio` | None — `slopeResult` already matches `{ trend, confidence, isReady }`; confidence is now derived from slope magnitude (0–100) rather than hardcoded to 0 |
| `computeSlotFillProbabilities` | None — receives `slopeResult.trend` and `slopeResult.confidence`; both are now properly populated |
| ATR / `weightVariance` | None — computed before the slope call; stored in `amaSlope` result field only |
| `calcAmaComparison` | None — still called separately, unchanged |
| Grid reset trigger | None — triggered by `deltaPercent` threshold, not trend |
| Tests in `test_price_adapter_service.js` | Replace `calcAmaPrice` single-value mock with `calculateAMA` series mock returning ≥ `erPeriod + lookbackBars + 1` values; remove `trendService` mocks |

---

## 11. Readiness and edge cases

**Not enough candles** (`isReady = false`):  
`sellW` and `buyW` return `BASELINE_WEIGHT (0.5)` — neutral, no bias.

**Flat AMA** (ER ≈ 0, zero-activity pool):  
`slopePct ≈ 0` → inside neutral zone → `slopeOffset = 0` → both weights at baseline.

**Very slow slope inside neutral zone**:  
`|slopePct| < neutralZonePct (0.15%)` → treated as flat. Prevents weight jitter on
micro-movements of a nearly-frozen AMA.

**Scale parameter units**:  
`lookbackBars` is always in candle count, not hours. Works for any `intervalSeconds`
without conversion.

---

## 12. Implementation order

1. Write `market_adapter/core/strategies/ama_slope_model.js` (pure function, no deps).
2. Write unit tests for `computeAmaSlopeWeights` covering: not-ready (array shorter
   than `erPeriod + lookbackBars + 1`), neutral zone, positive slope (partial, full
   saturation), negative slope, clamp behaviour; low/mid/high `weightVariance` at
   neutral slope; combined slope + volatility cases; confidence derivation.
3. Extend config resolution in `market_adapter.js` to pass `cfg.amaSlope` through.
4. Update `market_adapter_service.js` — swap imports, remove `trendServices` map,
   replace strategy step 1, re-use `amaValues` tail as `amaPrice`.
5. Update `test_price_adapter_service.js` — replace `calcAmaPrice` single-value mock
   with a series-returning `calculateAMA` mock.
6. Add `amaSlope` block to `profiles/market_adapter_settings.json` globals.
7. Manual smoke test: run market adapter against live XRP/BTS candles, verify
   `amaSlope` field appears in output and weights shift correctly during a known
   trend period in the candle history.
