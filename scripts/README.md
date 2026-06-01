# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.ts`
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and restart PM2
node dexbot update
```
*Note: Protects your `profiles/` directory and logs all changes to `profiles/logs/update.log`.*

### Fix Environment Paths
**File:** `create-bot-symlinks.sh`
**Purpose:** Create convenience root-level symlinks to profile data.
```bash
# Creates logs -> profiles/logs and orders -> profiles/orders
bash scripts/create-bot-symlinks.sh
```

---

## 🧹 CLEANING & RESET (DANGER ZONE)

### Wipe Logs
**File:** `clear-logs.sh`
**Purpose:** Delete all bot `.log` files, including `profiles/logs/market_adapter.log`.
```bash
# IRREVERSIBLE: Deletes all files in profiles/logs/*.log, including market_adapter.log
bash scripts/clear-logs.sh
```

### Wipe Orders
**File:** `clear-orders.sh`
**Purpose:** Delete all persistent order state files.
```bash
# IRREVERSIBLE: Deletes all files in profiles/orders/*
bash scripts/clear-orders.sh
```

### Wipe Orders + Logs
**File:** `clear-all.sh`
**Purpose:** Delete order state files and `.log` files in one confirmed operation.
```bash
# IRREVERSIBLE: Deletes profiles/orders/* and profiles/logs/*.log, including market_adapter.log
bash scripts/clear-all.sh
```

### Reset Settings
**File:** `reset-settings.sh`
**Purpose:** Delete the three settings files and restore built-in defaults on next run.
```bash
# IRREVERSIBLE: Deletes profiles/general.settings.json, profiles/market_profiles.json,
# and profiles/market_adapter_settings.json
bash scripts/reset-settings.sh
```

---

## 📊 DIAGNOSTICS & VALIDATION

### Configuration Audit
**File:** `validate_bots.ts`
**Purpose:** Check `bots.json` for schema errors or missing required fields.
```bash
# Validate both example and live bot configurations
tsx scripts/validate_bots.ts
```

### Market Adapter Whitelist Generation
**File:** `generate_market_adapter_whitelist.ts`
**Purpose:** Generate `profiles/market_adapter_whitelist.json` from bots whose `gridPrice` uses AMA mode.
```bash
# Rewrite the whitelist from profiles/bots.json
npm run market-adapter:whitelist

# Rewrite the whitelist with dynamicWeight disabled for AMA bots
tsx scripts/generate_market_adapter_whitelist.ts --no-dynamic-weight

# Rewrite the whitelist with asymmetricBounds disabled for AMA bots
tsx scripts/generate_market_adapter_whitelist.ts --no-asymmetric-bounds

# Disable both dynamicWeight and asymmetricBounds
tsx scripts/generate_market_adapter_whitelist.ts --no-dynamic-weight --no-asymmetric-bounds

# Print the generated JSON without writing it
tsx scripts/generate_market_adapter_whitelist.ts --dry-run
```

### Grid Divergence Audit
**File:** `divergence-calc.ts`
**Purpose:** Measure the "drift" between in-memory grid and disk state using RMS divergence metric.
```bash
# Calculates RMS Error (Default threshold is 14.3%)
# RMS quadratically penalizes large errors - see docs/README.md for threshold interpretation
tsx scripts/divergence-calc.ts
```
**Reference:** RMS threshold explanation in [root README GRID RECALCULATION section](../README.md#-automatic-grid-recalculation-via-threshold-detection)

### Grid Trading Analysis
**File:** `analyze-orders.ts`
**Purpose:** Analyze grid trading metrics and order distribution patterns.
```bash
# Analyzes spread accuracy, geometric consistency, and fund distribution
tsx scripts/analyze-orders.ts
```

**File:** `sync-version.ts`
**Purpose:** Keep DEXBot2-owned package and plugin manifests aligned to the root `package.json` version.
```bash
# Check that package-lock.json and Claw manifests match root package.json
npm run version:check

# Rewrite aligned manifests from root package.json
npm run version:sync
```
**Reference:** Runtime code reads `APP_VERSION` from `modules/constants.ts`, which imports the root package version.

---

## 🔍 GIT & DEVELOPMENT WORKFLOW

### Interactive Git Changes Monitor
**File:** `git-viewer.sh`
**Purpose:** Interactive monitor for uncommitted, committed, and pushed changes.
```bash
# Launch interactive git changes viewer with fzf search
bash scripts/git-viewer.sh
```

**Features**:
- View uncommitted (working tree) changes
- View committed (staged) changes
- View pushed vs. remote-tracking changes
- Smart auto-refresh (1s for local, 15s for remote)
- Fuzzy search with `fzf` for finding files
- Toggle between full file view and diff-only view

**Usage**:
```bash
# Press 'u' to toggle uncommitted changes
# Press 'c' to toggle committed changes
# Press 'p' to toggle pushed status
# Press 's' to search with fzf
# Press 'f' to toggle full file view
# Press 'q' to quit
```

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
Tests run with native Node `assert` — no test framework needed. See [tests/README.md](../tests/README.md) for details.

---

## 🌳 BRANCH SYNCHRONIZATION

### Synchronize test → dev → main
**File:** `pmain.sh` (also: `npm run pmain`)
**Purpose:** Sync local test branch through dev to main remote.
```bash
# Push test → dev → main
bash scripts/pmain.sh
# OR
npm run pmain
```

### Synchronize test → dev
**File:** `pdev.sh` (also: `npm run pdev`)
**Purpose:** Sync local test branch to dev remote.
```bash
# Push test → dev
bash scripts/pdev.sh
# OR
npm run pdev
```

### Synchronize local test → origin/test
**File:** `ptest.sh` (also: `npm run ptest`)
**Purpose:** Push local test branch to remote.
```bash
# Push test to origin/test
bash scripts/ptest.sh
# OR
npm run ptest
```

---

## ⚡ CONVENIENCE WRAPPERS

The following scripts allow you to call `dexbot` commands directly from the `scripts/` directory:

| Wrapper | Target Command | Usage |
|:---|:---|:---|
| `scripts/bots` | `node dexbot bots` | `./scripts/bots` |
| `scripts/keys` | `node dexbot keys` | `./scripts/keys` |
| `scripts/dexbot` | `node dexbot` | `./scripts/dexbot <cmd>` |
| `scripts/pm2` | `tsx pm2.ts` | `./scripts/pm2` |

---

## 📦 NPM SCRIPTS

| Command | Purpose |
|:---|:---|
| `npm run ptest` | Sync local test → origin/test |
| `npm run pdev` | Sync local test → dev |
| `npm run pmain` | Sync local test → dev → main |
| `npm test` | Run full test suite (100+ test cases) |

---

## 📈 CHART GENERATION

### LP Chart
**File:** `generate_lp_chart.ts`
**Purpose:** Generate the standard uPlot LP chart output.
```bash
# Generate the default LP chart flow
npm run lp:chart -- --data <lp-export.json>
```

### Local LP Comparison Chart
**File:** `analysis/ama_fitting/generate_unified_comparison_chart.ts`
**Purpose:** Generate the local LP comparison chart from an LP candle export.
**Output:** `analysis/charts/lp_chart_<interval>_UNIFIED_COMPARISON.html`
```bash
# Generate the local LP comparison chart
npm run ama:chart:lp-local -- --data <lp-export.json>
```

### Derivative Trend Analysis
**File:** `analysis/analyze_derivatives.ts`
**Purpose:** Generate the derivative analysis report.
```bash
# Generate the derivative analysis report
npm run analysis:derivatives -- --source json --file <file.json>
```

---

## 📚 DOCUMENTATION REFERENCES

For understanding the systems these scripts interact with:
- **Module Architecture**: See [root README 📦 Modules section](../README.md#-modules)
- **Copy-on-Write Pattern**: See [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md) for rebalancing architecture
- **Fund Accounting**: See [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Grid Divergence**: See [docs](../docs/README.md) for RMS threshold explanations
- **Logging System**: See [docs/LOGGING.md](../docs/LOGGING.md) for log configuration and levels

---

## ⌨️ TERMINAL PRODUCTIVITY

Boost your workflow by adding these aliases to your `~/.bashrc` or `~/.zshrc`:

```bash
# DEXBot2 Shortcuts
alias dbu='node dexbot update'
alias dbc='bash scripts/clear-logs.sh'
alias dbr='bash scripts/clear-orders.sh'
alias dba='bash scripts/clear-all.sh'
alias dbv='tsx scripts/validate_bots.ts'
alias dbd='tsx scripts/divergence-calc.ts'
```

---

## 💡 PRO-TIPS FOR TERMINAL USERS

**Monitor live updates while running a script:**
```bash
# Tail the update log in a separate pane
tail -f profiles/logs/update.log
```

**Run a specific bot dry-run from the CLI:**
```bash
# Force a clean start for 'my-bot'
bash scripts/clear-orders.sh && BOT_NAME=my-bot node dexbot start
```
