# DEXBot2 Fallback Analysis

## Complete Fallback Categorization by Theme

### Summary
Found **35+ distinct instances** of "fallback" across the codebase, organized into 7 categories with file paths and context.

> **Note:** Line numbers are approximate — code shifts with each commit. Use the described patterns/function names to locate current positions.

⚠️ **Updates (March 2026)**:
- Numeric format precision fallback has been completely removed. Precision is now strictly validated at startup.
- Price fallback system has been removed. All price modes (`pool`, `book`, `auto`) now use strict semantics with no cross-fallback.
- Orphan order lax tolerance fallback has been removed. Orphaned chain orders that don't strictly match grid orders are no longer recovered.
- Rotation-to-creation fallback has been removed. Unmet rotations are no longer converted to placements.

---

## 1. FUND ACCOUNTING & BUDGET FALLBACK

### 1.1 Dust Resize (Available Funds)
**Category**: When resizing dust partial orders, use available funds to grow them toward ideal size.

| File | Line | Context |
|------|------|---------|
| `modules/order/grid.ts` | `_applyPartialActions` | Dust merge toward ideal size with available-funds cap |

**Behavior**: When resizing partial orders, growth is capped to available funds. If insufficient funds exist, the merge is skipped.

---

### 1.2 Fund Denominator Fallback
**Category**: When allocated funds unavailable, fallback to total on-chain balance for percentage calculations.

| File | Line | Context |
|------|------|---------|
| `modules/order/grid.ts` | ~733 | `// Denominator: side's allocated capital (or chain total fallback).` |

**Behavior**: When calculating fund utilization ratios, prefer `allocated` (configured %), but fallback to `chainTotal` (on-chain balance) if allocated is 0.

---

## 2. ORDER ROTATION & PLACEMENT FALLBACK

### ~~2.1 Rotation to Creation Conversion~~ — REMOVED (March 2026)

> This fallback was removed. Unmet rotations are no longer converted to placements. The COW architecture handles rotation failures through its abort/discard mechanism instead.

---

## 3. ASSET METADATA FALLBACK

### 3.1 Persisted Asset Fallback (Blockchain Lookup)
**Category**: When live blockchain lookup fails, fallback to persisted asset metadata from last successful load.

| File | Line | Context |
|------|------|---------|
| `modules/order/sync_engine.ts` | ~1025 | `const fetchAssetWithFallback = async (symbol, side) => { try { return await lookupAsset(BitShares, symbol); } catch (err) { if (mgr.accountOrders) { const persistedAssets = mgr.accountOrders.loadPersistedAssets(mgr.config.botKey); const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB; if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') { mgr.logger.log(\`Blockchain lookup failed for ${symbol}: ${err.message}. Using persisted fallback: id=${assetData.id}, precision=${assetData.precision}\`, 'warn'); return assetData;` |

**Behavior**: If blockchain API fails to lookup asset metadata (id, precision), fallback to persisted data from previous successful loads stored in grid state.

---

## 4. ACCOUNT & CONFIGURATION FALLBACK

### 4.1 Account Selection Fallback
**Category**: When preferred account setup fails, fallback to interactive account selection.

| File | Line | Context |
|------|------|---------|
| `modules/dexbot_class.ts` | ~1351 | `// dexbot.ts has fallback to selectAccount, bot.ts throws` |
| `modules/dexbot_class.ts` | ~1349-1359 | `catch (err) { ... if (typeof chainOrders.selectAccount === 'function') { ... } else { throw err; }` |

**Behavior**: If auto-selecting a configured preferred account fails, fallback to `selectAccount()` (interactive) if available.

---

### 4.2 Bot Configuration Name Fallback
**Category**: When finding updated bot config, fallback to index if name changed.

| File | Line | Context |
|------|------|---------|
| `modules/dexbot_class.ts` | ~2499 | `// Find this bot by name or fallback to index if name changed?` |

**Behavior**: Comment indicating potential fallback strategy if bot name is changed during runtime config refresh.

---

## 5. GENERAL SETTINGS & FILE I/O FALLBACK

### 5.1 Settings File Fallback
**Category**: When settings file unavailable or unparseable, fallback to provided default value.

| File | Line | Context |
|------|------|---------|
| `modules/general_settings.ts` | 7-16 | `function readGeneralSettings({ fallback = null, onError = null } = {}) { if (!fs.existsSync(SETTINGS_FILE)) return fallback; try { const raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); if (!raw || !raw.trim()) return fallback; return JSON.parse(raw); } catch (err) { if (typeof onError === 'function') onError(err, SETTINGS_FILE); return fallback;` |

**Behavior**: Load settings file; if file missing, empty, or invalid JSON, return `fallback` parameter (default `null`).

---

### 5.2 Module Settings Fallback
**Category**: When settings unavailable, use hardcoded defaults throughout modules.

| File | Line | Context |
|------|------|---------|
| `modules/constants.ts` | 486-487 | `fallback: null,` (in readGeneralSettings call) |
| `modules/account_bots.ts` | 123-124 | `const settings = readGeneralSettings({ fallback: null, onError: (err) => { console.error('Failed to load general settings:', err.message); } });` |
| `modules/bitshares_client.ts` | 60-65 | `const settings = readGeneralSettings({ fallback: null, onError: (err) => { console.warn('[NodeManager] Config load failed, continuing with defaults:', err.message); } });` |

**Behavior**: All module initialization uses `readGeneralSettings()` with `fallback: null`; if settings unavailable, modules continue with hardcoded defaults (e.g., default node URL).

---

## 6. TEST & UTILITY FALLBACK

### 6.1 Account Reference Fallback
**Category**: Test utility for resolving account references with explicit fallback.

| File | Line | Context |
|------|------|---------|
| `tests/test_utils.ts` | 28 | `utils.resolveAccountRef({ accountId: '1.2.345', account: 'fallback-account' }, 'explicit-account'),` |

**Behavior**: Test verifying that account resolution prefers `accountId` but falls back to `account` field.

---

### 6.2 Fee Cache Fallback in Accounting
**Category**: When fee cache lookup fails, fallback to raw proceeds without fee adjustments.

| File | Line | Context |
|------|------|---------|
| `tests/test_accounting_logic.ts` | 195-196 | `// Test: Missing fee cache must not crash fill accounting (fallback to raw proceeds) console.log(' - Testing fill accounting fee-cache fallback...');` |

**Behavior**: If fee cache is unavailable during order fill accounting, fallback to using raw fill proceeds without fee deductions.

---

### 6.3 Node Failover Fallback
**Category**: Multi-node configuration with automatic failover behavior.

| File | Line | Context |
|------|------|---------|
| `tests/test_node_failover.ts` | 8 | `- Default fallback behavior` |
| `tests/test_node_failover.ts` | 153 | `console.log('✓ Slow node fallback test passed\n');` |

**Behavior**: NodeManager automatically fails over to next configured node if current node is slow or unresponsive.

---

## 7. DOCUMENTATION REFERENCES

### 7.1 Architecture & Developer Docs
| File | Line | Context |
|------|------|---------|
| `docs/developer_guide.md` | 355 | `const fallbackPlacements = unmetRotations.map(r => ({` |
| `docs/developer_guide.md` | 1192 | `// Smart fallback: Cache miss triggers fresh scan` |
| `docs/architecture.md` | 804 | `- Maintains "State Recovery Sync" fallback` |

---

### 7.2 Format Module Documentation
| File | Line | Context |
|------|------|---------|
| `modules/order/format.ts` | 44-45 | `15. toFiniteNumber(value, defaultValue) - Convert to finite number with fallback 16. safeFormat(value, decimals, fallback) - Safely format with fallback` |
| `modules/order/format.ts` | 247-257 | `@param {string} [fallback='N/A'] - Fallback value if format fails @returns {string} Formatted value or fallback string function safeFormat(value, decimals, fallback = 'N/A') { ... return fallback;` |

---

## CHANGELOG REFERENCES (Recent Updates)

| Line | Context | Category |
|------|---------|----------|
| 18 | "fallback when `accountant.resetRecoveryState()` is unavailable" | Account Fallback |
| 86 | "Added fail-safe fallback in `_deductFeesFromProceeds()` when fee cache lookup fails" | Fee Cache Fallback |
| 132 | "trigger behavior is driven by available funds (`buyFree/sellFree`), not unused cache fallback plumbing" | Fund Accounting |
| 139 | "Extracted common account reference fallback logic" | Account Selection |
| 183 | "use `allocated` funds with `chainTotal` fallback (free + locked balance)" | Fund Denominator |
| 193 | "Dust resize operations used `chainFree` (raw on-chain balance) as fallback" | Dust Resize |
| 195 | "Replaced `chainFree` fallback with available-funds cap" | Fund Fallback |
| 346 | "Added fallback for MAX_ORDER_FACTOR in _getMaxOrderSize() with \|\| 1.1 fallback" | Grid Calculation |
| 364 | "Activate SPREAD slots at the edge (fallback if no partials available)" | Slot Selection |
| 382 | "Safety fallback for currency symbols: uses \"BASE\"/\"QUOTE\" if null" | Symbol Fallback |

| 1132 | "fallback fee (100), **maker refund ratio (10%)**" | Fee Parameters |
| 1137 | "Asset precision fallback removed - bot now enforces strict precision requirements" | Precision Strictness |
| 1228 | "Remove precision fallback defaults - halt bot if precision unavailable" | Critical Precision |
| 1229+ | "Remove inline `\|\| 8` precision fallbacks from formatting code - enforce strict precision at startup" | Critical Precision Cleanup |
| 1953 | "Added 100 BTS fallback for adequate fee reservation" | Fee Reservation |
| 2281 | "Multi-API support with graceful fallbacks" | API Resilience |
| 2290 | "Fund Fallback in Order Rotation: Added fallback to available funds when proceeds exhausted" | Rotation Fund Fallback |

---

## SUMMARY STATISTICS

**Total Instances**: 35+ (reduced after orphan lax tolerance and rotation-to-creation removal)
**Categories**: 7 primary categories (price/precision/orphan-lax/rotation fallbacks removed)
**Files Affected**: ~14 source files

### Fallback Distribution by Type:
1. **Fund Management** - 8 instances (Budget, denominator, dust resize, cache, proceeds)
2. **Asset Metadata** - 3 instances (Blockchain lookup, persisted state)
3. **Account/Config** - 4 instances (Account selection, bot name, settings)
4. **Order Operations** - ~~4~~ 3 instances (~~Rotation conversion~~, slot selection)
5. **File I/O** - 3 instances (Settings loading, parsing)
6. **Testing/Utilities** - 6 instances (Account ref, fee cache, node failover)
7. **Documentation** - 6 instances (Architecture, developer guide references)

---

## Key Patterns

### Resilience Strategy
Fallbacks are implemented at multiple layers:
- **I/O Layer**: File reads with defaults
- **Blockchain Layer**: Persisted assets, node failover
- **Financial Layer**: Fund sources, fee cache alternatives
- **Configuration Layer**: Auto → interactive account selection

**Price Derivation**: No fallback system. Each mode (`pool`, `book`, `auto`) uses strict semantics with explicit failures instead of silent fallbacks.

### Naming Convention
Most fallbacks follow consistent patterns:
- `fallback` parameter in function signatures
- `fetchAssetWithFallback()` - explicit naming
- `[fallback-<type>]` in logs
- Comments documenting fallback triggers

### Logging
All significant fallbacks are logged at WARN level with context:
```
[WARN] Blockchain lookup failed for SYMBOL: timeout. Using persisted fallback...
[WARN] Auto-selection of preferredAccount failed. Falling back to interactive selection...
```

This enables operators to monitor when fallback mechanisms are engaged and investigate underlying issues.
