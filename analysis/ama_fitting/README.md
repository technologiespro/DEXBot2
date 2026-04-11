# AMA Fitting

Tooling to fit AMA parameters (ER, Fast, Slow) against real LP pool candle data
and export the results into `profiles/market_profiles.json` for the market adapter.

---

## Workflow Overview

```
1. fetch_lp_candles.js   →   data/<pool>_1h.json
2. optimizer_high_resolution.js   →   optimization_results_*.json
                                  →   profiles/market_profiles.json  (auto-updated)
3. generate_unified_comparison_chart.js   →   chart_*.html  (visual review)
```

---

## Step 1 — Fetch LP Candles

`fetch_lp_candles.js` fetches bidirectional LP swap data from Kibana and saves
a full uncut candle file. Uses the same `kibana_source` as the market adapter
bootstrap (gaps filled via `candle_utils.fillCandleGaps`), but without pruning.

**Known asset details:**

| Asset        | Symbol       | Object ID  | Precision |
|--------------|--------------|------------|-----------|
| IOB.XRP      | IOB.XRP      | 1.3.3926   | 4         |
| BTS          | BTS          | 1.3.0      | 5         |
| HONEST.MONEY | HONEST.MONEY | —          | —         |

**XRP-BTS pool (3 years):**
```bash
node analysis/ama_fitting/fetch_lp_candles.js \
  --pool 1.19.133 \
  --assetA IOB.XRP --assetAId 1.3.3926 --assetAPrecision 4 \
  --assetB BTS     --assetBId 1.3.0    --assetBPrecision 5 \
  --hours 26280
```

Output: `analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--pool` | required | Pool ID (e.g. `1.19.133` or just `133`) |
| `--assetA` | required | Asset A symbol |
| `--assetAId` | required | Asset A object ID (e.g. `1.3.3926`) |
| `--assetAPrecision` | required | Asset A precision |
| `--assetB` | required | Asset B symbol |
| `--assetBId` | required | Asset B object ID |
| `--assetBPrecision` | required | Asset B precision |
| `--hours` | `26280` | Lookback hours (26280 = 3 years) |
| `--out` | auto | Output filename (placed in `data/` if not absolute) |

---

## Step 2 — Run the Optimizer

`optimizer_high_resolution.js` runs a parallel geometric grid search over
ER × Fast × Slow combinations. Produces four AMA winners (AMA1–AMA4) using
different distance-cap quantiles, writes results to a JSON file, and
**auto-updates `profiles/market_profiles.json`** with the winning parameters.

**Run on the fetched LP data:**
```bash
node analysis/ama_fitting/optimizer_high_resolution.js \
  --data analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json
```

**Default search ranges:**

| Param | Min  | Max  | Sampling | Quantum |
|-------|------|------|----------|---------|
| ER    | 50   | 500  | 40 geometric points | 1 |
| Fast  | 1    | 10   | 40 geometric points | 0.01 |
| Slow  | 500  | 5000 | 40 geometric points | 1 |

Override ranges via CLI:
```bash
node analysis/ama_fitting/optimizer_high_resolution.js \
  --data analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json \
  --erMin 100 --erMax 600 \
  --slowMin 800 --slowMax 6000
```

**Override AMA cap quantiles:**
```bash
  --ama1Cap 0.65  --ama2Cap 0.55  --ama3Cap 0.45  --ama4Cap 0.40
```

**AMA objectives:**

| Key  | Distance cap quantile | Character |
|------|-----------------------|-----------|
| AMA1 | 0.70 | Most responsive, largest swing |
| AMA2 | 0.60 | Balanced |
| AMA3 | 0.50 | Slow, smooth — **default for market adapter** |
| AMA4 | 0.45 | Most conservative |

**Outputs:**
- `analysis/ama_fitting/optimization_results_<datafile>.json` — full results
- `profiles/market_profiles.json` — updated with new AMA parameters per pair

**Boundary check:** If a winner lands on the edge of the search range, the
optimizer warns you. Widen the affected range and re-run.

---

## Step 3 — Visual Review (optional)

```bash
node analysis/ama_fitting/generate_unified_comparison_chart.js \
  --data analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json
```

Output: `analysis/ama_fitting/lp_chart_pool_133.html`

Open in a browser to compare all four AMA overlays against the candlestick price.

---

## How market_profiles.json is used

After the optimizer runs, `profiles/market_profiles.json` is updated with the
new AMA1–AMA4 parameters for the pair. The market adapter reads this file at
startup and uses the pair-matched profile instead of the built-in constants
defaults. No restart required — takes effect on the next market adapter cycle.

---

## Data file format

```json
{
  "meta": {
    "pool": "1.19.133",
    "assetA": { "id": "1.3.3926", "precision": 4, "symbol": "IOB.XRP" },
    "assetB": { "id": "1.3.0",    "precision": 5, "symbol": "BTS" },
    "intervalSeconds": 3600,
    "lookbackHours": 26280,
    "candleCount": 26280
  },
  "candles": [
    [timestamp_ms, open, high, low, close, volume_A],
    ...
  ]
}
```
