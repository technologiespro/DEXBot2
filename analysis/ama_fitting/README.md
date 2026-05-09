# AMA Fitting

Tooling to fit AMA parameters (ER, Fast, Slow) against real LP pool candle data.
The optimizer writes result JSON by default and can explicitly export the chosen
parameters into `profiles/market_profiles.json` for the market adapter.

---

## Workflow Overview

```
1. fetch_lp_candles.js   →   market_adapter/data/<pool>_1h.json
2. optimizer_high_resolution.js   →   optimization_results_*.json
                                  →   profiles/market_profiles.json  (only with --write-profiles)
3. scripts/generate_lp_chart.js   →   market chart + comparison chart  (visual review)
   - LP chart: `npm run lp:chart -- --data <lp-export.json>`
   - Local LP comparison alias: `npm run ama:chart:lp-local -- --data <lp-export.json>`
```

---

## Step 1 — Fetch LP Candles

`fetch_lp_candles.js` fetches bidirectional LP swap data from Kibana and saves
a full uncut candle file. Uses the same `kibana_source` as the market adapter
bootstrap (gaps filled via `candle_utils.fillCandleGaps`), but without pruning.

**Known asset details:**

| Asset        | Symbol       | Object ID  | Precision |
|--------------|--------------|------------|-----------|
| `<ASSET_A>`        | `<ASSET_A>`        | `<asset_a_id>`   | `<n>`         |
| `<ASSET_B>`          | `<ASSET_B>`          | `<asset_b_id>`      | `<n>`         |
| `<ASSET_C>` | `<ASSET_C>` | —          | —         |

**`<ASSET_A>`/`<ASSET_B>` pool (3 years):**
```bash
node analysis/ama_fitting/fetch_lp_candles.js \
  --pool 1.19.133 \
  --assetA <ASSET_A> --assetAId <asset_a_id> --assetAPrecision <n> \
  --assetB <ASSET_B>     --assetBId <asset_b_id>    --assetBPrecision <n> \
  --hours 26280
```

Output: `market_adapter/data/lp/<pair_folder>/lp_pool_<poolShort>_<interval>.json` (interval-dependent)

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--pool` | required | Pool ID (e.g. `1.19.133` or just `133`) |
| `--assetA` | required | Asset A symbol |
| `--assetAId` | required | Asset A object ID (e.g. `<asset_a_id>`) |
| `--assetAPrecision` | required | Asset A precision |
| `--assetB` | required | Asset B symbol |
| `--assetBId` | required | Asset B object ID |
| `--assetBPrecision` | required | Asset B precision |
| `--hours` | `26280` | Lookback hours (26280 = 3 years) |
| `--out` | auto | Output filename (placed in `market_adapter/data/` if not absolute) |

---

## Step 2 — Run the Optimizer

`optimizer_high_resolution.js` runs a parallel geometric grid search over
ER × Fast × Slow combinations. Produces four AMA winners (AMA1–AMA4) using
different distance-cap quantiles and writes results to a JSON file.

By default this does **not** update runtime market-adapter profiles. Add
`--write-profiles` when you intentionally want the fitted parameters exported
to `profiles/market_profiles.json`.

**Run on the fetched LP data:**
```bash
node analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

**Export winners to the market adapter profile file:**
```bash
node analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --write-profiles
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
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --erMin 100 --erMax 600 \
  --slowMin 800 --slowMax 6000
```

**AMA fitting caps:**

These are the active defaults used by the optimizer:

```bash
--ama1Cap 0.25  --ama2Cap 0.30  --ama3Cap 0.35  --ama4Cap 0.40
```

| Key  | Distance cap quantile | Character |
|------|-----------------------|-----------|
| AMA1 | 0.25 | Tightest fit, most reactive |
| AMA2 | 0.30 | Balanced |
| **AMA3** | 0.35 | Default |
| AMA4 | 0.40 | Widest fit, most conservative |

**Inventory price range guidance:**

Use an inventory range that sits above the fitted cap so the market maker has
room to absorb normal noise without widening the book too much.

An optimized AMA plus the recommended buffer table is intended to provide a
relatively safe operating range for extreme market conditions while still
preserving reasonable inventory turnover.

- Safe buffer: `+10%` to `+15%` above the fitted cap
- Borderline: `+20%`
- Overkill: `+25%+`

| AMA  | Fitted cap | Safe inventory range | Borderline | Overkill |
|------|-----------:|----------------------:|-----------:|---------:|
| AMA1 | 25% | 35% to 40% | 45% | 50%+ |
| AMA2 | 30% | 40% to 45% | 50% | 55%+ |
| **AMA3** | 35% | 45% to 50% | 55% | 60%+ |
| AMA4 | 40% | 50% to 55% | 60% | 65%+ |

**Outputs:**
- `analysis/ama_fitting/optimization_results_<datafile>.json` — full results
- `profiles/market_profiles.json` — updated with new AMA parameters per pair only when `--write-profiles` is used

**Boundary check:** If a winner lands on the edge of the search range, the
optimizer warns you. Widen the affected range and re-run.

---

## Step 3 — Visual Review (optional)

Recommended entrypoint:

```bash
npm run lp:chart -- \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

This generates both:
- `analysis/charts/lp_AMA_chart_pool_133.html` — market-adapter style LP chart
- `analysis/charts/lp_chart_1h_UNIFIED_COMPARISON.html` — unified comparison chart, with the interval derived from LP metadata

Under the hood, LP-data chart generation now delegates into the shared runner in
`market_adapter/lp_chart_runner.js`. The analysis script keeps only:
- the local LP comparison mode used for analysis-only review

Local LP comparison entrypoint:

```bash
npm run ama:chart:lp-local -- \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

Open the generated HTML in a browser to compare all four AMA overlays against the candlestick price.

---

## How market_profiles.json is used

When the optimizer is run with `--write-profiles`, `profiles/market_profiles.json`
is updated with the new AMA1–AMA4 parameters for the pair. The market adapter
reads this file at startup and uses the pair-matched profile instead of the
built-in constants defaults. No restart required — takes effect on the next
market adapter cycle.

---

## Data file format

```json
{
  "meta": {
    "pool": "1.19.133",
    "assetA": { "id": "<asset_a_id>", "precision": <n>, "symbol": "<ASSET_A>" },
    "assetB": { "id": "<asset_b_id>",    "precision": <n>, "symbol": "<ASSET_B>" },
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
