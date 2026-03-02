# Market Adapter

## Overview

The **Market Adapter** is a runtime candle-sync and AMA signal layer for live bots.

**Core Purpose**: Bridge historical analysis (`/analysis`) and live operations by keeping fresh LP candles, computing AMA-based market center values, and emitting deterministic signals/triggers.

---

## Architecture

### Relationship to Other Components

```
analysis/                    market_adapter/              bot execution
─────────────────           ──────────────────           ────────────
ama_fitting/      ──┐
(history tools)   ──├─→ [Market Analysis] ──→ [Decision Engine] ──→ bots.json ──→ dexbot.js
sensitivity/      ──┤    (current market)     (real-time rules)
spread_analysis/  ──┘
```

**Data Flow**:
1. **analysis/** produces optimization context and candidate AMA settings
2. **market_adapter/** fetches/updates LP candles (Kibana bootstrap + native incremental)
3. **market_adapter/** computes per-bot AMA center and threshold deltas
4. **market_adapter/** writes state snapshots and trigger files
5. **dexbot.js** can react to `profiles/recalculate.<botKey>.trigger`

---

## Scope

### Responsibilities

#### ✅ In Scope
- **Real-time Market Monitoring**: Track current volatility, price action, and market regime
- **Candle Synchronization**: Keep per-bot LP candles current and pruned to AMA-required windows
- **Signal Calculation**: Compute AMA center values and deviation thresholds
- **Trigger Emission**: Create per-bot recalc trigger files when thresholds are crossed
- **Runtime Safety**: Single-instance lock, retries/backoff, stale-data suppression
- **State Management**: Persist machine-readable adapter state and center snapshots

#### ❌ Out of Scope
- Historical backtest optimization (that's `/analysis`)
- Direct order placement or execution (that's `dexbot.js`)
- Bot lifecycle management (start/stop/restart)
- Long-term strategy design or rule creation

---

## Configuration Structure

### Trigger Threshold

The delta threshold that governs when the adapter emits a recalc trigger is resolved in this order:

1. CLI `--deltaPercent <n>` override
2. `profiles/general.settings.json` → `MARKET_ADAPTER.DELTA_THRESHOLD_PERCENT`
3. Built-in default: `1` (%)

```json
// profiles/general.settings.json
{
  "MARKET_ADAPTER": {
    "DELTA_THRESHOLD_PERCENT": 1
  }
}
```

### Per-Bot AMA Settings

Each bot can define its own AMA calculation in `profiles/bots.json` under `ama`.
If missing, the built-in defaults (`erPeriod: 90, fastPeriod: 10, slowPeriod: 100`) are used.

```json
{
  "name": "XRP-BTS",
  "assetA": "IOB.XRP",
  "assetB": "BTS",
  "ama": {
    "enabled": true,
    "erPeriod": 10,
    "fastPeriod": 2,
    "slowPeriod": 30
  }
}
```

---

## Module Structure

```
market_adapter/
├── README.md
├── price_adapter.js             # Main candle-sync + center tracking loop
├── core/price_adapter_service.js # Extracted adapter service logic (no CLI)
├── ama_signal_runner.js         # One-cycle JSON AMA outputs
├── kibana_source.js             # Elasticsearch LP data source
├── blockchain_source.js         # Native BitShares data source
├── candle_utils.js              # Trade/candle helpers
├── fetch_lp_data.js             # Pool-centric historical export
├── kibana_api.js                # Kibana trade inspector/exporter
├── native_api.js                # Native trade inspector/exporter
├── chart_lp_prices.js           # Plotly chart generator
├── data/                        # Candle caches and exports
└── state/                       # Adapter runtime state files
```

---

## How It Works

### 1. Candle Sync

`price_adapter.js` runs per cycle and updates per-bot candles:
- Bootstrap from Kibana if local cache is missing
- Then incrementally merge native LP history
- Prune to the minimum window required by current AMA settings

### 2. AMA Center Calculation

For each processed bot, adapter computes:
- Latest AMA value (per-bot `ama` config, or defaults)
- Optional AMA comparison presets
- Delta between current AMA and stored center

### 3. Trigger Decision

Adapter emits `profiles/recalculate.<botKey>.trigger` when:
- AMA delta exceeds configured percentage threshold
- Data is not stale (`--maxStaleHours` guard)

Threshold resolution order:
1. CLI `--deltaPercent` override
2. `profiles/general.settings.json` → `MARKET_ADAPTER.DELTA_THRESHOLD_PERCENT`
3. Built-in default `1` (%).

### 4. State Persistence + JSON Signals

Adapter writes:
- `market_adapter/state/price_adapter_state.json`
- `market_adapter/state/price_adapter_centers.json`

JSON consumer output is available via:
- `node market_adapter/ama_signal_runner.js`

---

## Integration Points

### Input: Market Data Sources
- **Candle history**: Bootstrapped from Kibana, then incrementally from native BitShares API
- **LP trade history**: Fetched via `kibana_source.js` / `blockchain_source.js`

### Input: Analysis Results
- **Optimal parameter sets**: From `analysis/ama_fitting/OPTIMIZATION_RESULTS.md`
- **Sensitivity data**: From `analysis/ama_fitting/SENSITIVITY_REPORT.md`
- **Regime-specific tuning**: From `analysis/ama_fitting/QUICK_REFERENCE.md`

### Output: Runtime State + Triggers
- **State snapshots**: `market_adapter/state/price_adapter_state.json`
- **Center snapshots**: `market_adapter/state/price_adapter_centers.json`
- **Trigger files**: `profiles/recalculate.<botKey>.trigger`
- **JSON signal output**: `ama_signal_runner.js` stdout

### Integration with dexbot.js
- dexbot can react to `recalculate.<botKey>.trigger`
- `price_adapter` does not modify `profiles/bots.json`

---

## Decision Rules

### When to Trigger Recalc

A recalc trigger is emitted when:
1. AMA center delta exceeds threshold
2. Latest candle is not stale
3. Bot is active and has valid pair/pool context

### What This Adapter Does Not Change

- It does **not** edit `profiles/bots.json`
- It does **not** start/stop bots
- It does **not** place/cancel on-chain orders directly

---

## Configuration Files

### `profiles/bots.json`

Input source for active bots, symbols, optional pool IDs, and optional per-bot AMA settings.

### `market_adapter/state/price_adapter_whitelist.json`

Optional filter restricting which active bots are processed.

### `market_adapter/state/price_adapter_state.json`

Primary runtime state file with per-bot candle metadata, AMA values, thresholds, and cycle metrics.

### `market_adapter/state/price_adapter_centers.json`

Lightweight center snapshot for quick inspection.

---

## Usage

### Manual Invocation

Run the adapter manually to test or force an update:

```bash
# One full sync cycle + trigger evaluation
node market_adapter/price_adapter.js --once

# One full sync cycle + JSON AMA output
node market_adapter/ama_signal_runner.js

# View latest adapter state snapshot
cat market_adapter/state/price_adapter_state.json
```

### LP Data Export (Analysis Inputs)

Canonical LP export scripts:

```bash
# Kibana LP trades (long history) + optional candle export
node market_adapter/kibana_api.js --pool 133 --hours 8760 --saveCandles --interval 1h --csv

# Native BitShares LP trades (node-retained history) + optional candle export
node market_adapter/native_api.js --pool 133 --hours 72 --saveCandles --interval 1h --csv

# Existing pool-centric Kibana exporter used by analysis workflow
node market_adapter/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 8760h
```

### Price Adapter (Standalone)

Runs independently from dexbot, keeps 1h candles fresh, tracks a separate
AMA-based market center, and creates per-bot grid reset trigger files when the
delta threshold is exceeded.

```bash
# One cycle (safe test)
node market_adapter/price_adapter.js --once

# Continuous daemon loop
node market_adapter/price_adapter.js

# Custom trigger threshold (percent)
node market_adapter/price_adapter.js --deltaPercent 1.5
```

State and outputs:
- `market_adapter/data/price_adapter_<botKey>_1h.json`
- `market_adapter/state/price_adapter_state.json`
- `market_adapter/state/price_adapter_centers.json`
- Trigger on threshold: `profiles/recalculate.<botKey>.trigger`

Optional whitelist:
- file: `market_adapter/state/price_adapter_whitelist.json`
- format:

```json
{
  "bots": ["XRP-BTS", "xrp-bts-0"]
}
```

If whitelist exists and has entries, only matching bot `name` or `botKey` is processed.

### AMA Signal Runner (JSON Output)

Runs one candle sync cycle (same candle update flow as `price_adapter.js`) and
prints structured AMA outputs per bot.

```bash
# Run one cycle and print JSON for all processed bots
node market_adapter/ama_signal_runner.js

# Filter by bot name or botKey
node market_adapter/ama_signal_runner.js --bot XRP-BTS
node market_adapter/ama_signal_runner.js --bot xrp-bts-0 --compact
```

Output format (one entry per processed bot):

```json
{
  "ok": true,
  "updatedAt": "2026-03-01T09:01:00.000Z",
  "metrics": { "cycleMs": 4200, "botsProcessed": 1 },
  "botCount": 1,
  "bots": [
    {
      "botName": "XRP-BTS",
      "botKey": "xrp-bts-0",
      "ok": true,
      "source": "native",
      "candleCount": 720,
      "amaPrice": 1294.6,
      "deltaPercent": 1.1,
      "thresholdPercent": 1.0,
      "triggered": true,
      "triggerPath": "profiles/recalculate.xrp-bts-0.trigger",
      "reason": "price_adapter_delta_threshold"
    }
  ]
}
```

### Per-Bot AMA Settings

See [Configuration Structure](#configuration-structure) for the AMA config format.

Notes:
- `lookbackHours` is controlled by runtime sync flags (`--bootstrapHours`, `--nativeBackfillHours`), not per-bot AMA
- AMA params are passed directly to `calculateAMA(closes, params)`
- If `ama` is missing, built-in defaults apply (`erPeriod: 90, fastPeriod: 10, slowPeriod: 100`)
- To test per-bot AMA output for one bot:

```bash
node market_adapter/ama_signal_runner.js --bot XRP-BTS
```

### Automated Execution

Schedule via PM2 or cron to run continuously:

```bash
# In pm2.js, add:
{
  name: "market-adapter",
  script: "market_adapter/price_adapter.js",
  instances: 1,
  exec_mode: "fork",
  cron_restart: "0 * * * *"  // Every hour
}
```

### Integration with dexbot

The adapter runs independently; dexbot picks up changes by:
1. Watching for `profiles/recalculate.<botKey>.trigger`
2. Re-centering/recalculating the affected bot grid

---

## Monitoring

### Runtime State

The adapter writes state after each cycle. Key fields in `market_adapter/state/price_adapter_state.json`:

```
lastRunAt         - Timestamp of last completed cycle
botsProcessed     - Number of bots evaluated
cycleMs           - Cycle wall-clock duration
per-bot entries:
  lastAmaPrice    - Latest computed AMA value
  centerPrice     - Stored center (baseline for delta)
  lastDeltaPercent- Delta computed last cycle
  thresholdPercent- Active trigger threshold
  staleData       - true if candle age exceeded maxStaleHours
  staleAgeHours   - How old the latest candle is
  triggered       - true if trigger file was written this cycle
```

### Alert Conditions

- ⚠️ **Trigger not firing**: Check `lastDeltaPercent` vs `thresholdPercent` in state file
- ⚠️ **Stale data**: `staleData: true` means candle sync is failing — check network/API access
- 🔴 **Lock file stuck**: If `price_adapter.lock` is present after a crash, delete it manually

---

## Example Workflow

### Scenario: AMA Delta Trigger

```
[09:00] Adapter runs cycle and updates candles
[09:01] Latest AMA computed from synced candle cache
[09:01] Delta vs stored center exceeds threshold
[09:01] Adapter writes profiles/recalculate.<botKey>.trigger
[09:02] dexbot consumes trigger and recalculates grid center
[10:00] Next cycle repeats with incremental native updates
```

---

## File Format: Trigger Payload

When threshold is exceeded, adapter writes a trigger file like:

```json
{
  "createdAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/price_adapter.js",
  "botName": "XRP-BTS",
  "botKey": "xrp-bts-0",
  "reason": "price_adapter_delta_threshold",
  "thresholdPercent": 0.8,
  "deltaPercent": 1.1,
  "previousCenterPrice": 1280.5,
  "newCenterPrice": 1294.6,
  "poolId": "1.19.133"
}
```

---

## Future Enhancements

### Phase 1 (Current)
- [x] Candle sync (Kibana bootstrap + native incremental)
- [x] Per-bot AMA center calculation
- [x] Trigger-file emission on threshold
- [x] Runtime lock/retry/stale-data safety controls

### Phase 2 (Extended)
- [ ] Machine learning-based regime detection (vs rules-based)
- [ ] Multi-pair correlation analysis
- [ ] Predictive parameter selection (forecast next regime)
- [ ] A/B testing framework (test new rules safely)
- [ ] Hot-reload support (zero-downtime parameter updates)

### Phase 3 (Advanced)
- [ ] Portfolio-level optimization (balance risk across all bots)
- [ ] Cross-asset feedback loops (BTS volatility → adjust XRP parameters)
- [ ] Seasonal pattern recognition
- [ ] Integration with external news/sentiment data

---

## Troubleshooting

### Triggers not being created
1. Verify latest AMA is computed (`lastAmaPrice` in state file)
2. Check threshold (`thresholdPercent`) vs `lastDeltaPercent`
3. Check stale data guard (`staleData`, `staleAgeHours`)
4. Check lock/state files under `market_adapter/state/`

### Trigger fires too often / too rarely
1. Adjust `MARKET_ADAPTER.DELTA_THRESHOLD_PERCENT` in `profiles/general.settings.json`
2. Or pass `--deltaPercent <n>` on the CLI for a one-off override
3. Check `lastDeltaPercent` in state to see what delta is actually being computed

---

## References

- **Historical Analysis**: See `/analysis/ama_fitting/README.md` for parameter optimization details
- **Bot Configuration**: See `profiles/bots.json` for current settings
- **DEXBot Architecture**: See root `README.md` for overall bot design
- **Security**: Adaptation rules should be reviewed before deployment

---

## Contact / Contributing

For issues, enhancements, or questions about market adaptation rules, open an issue or PR with:
1. Current market conditions (volatility, regime)
2. Proposed rule or fix
3. Expected impact and testing results
