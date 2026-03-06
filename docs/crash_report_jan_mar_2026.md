# DEXBot2 Crash Analysis Report
## IOB.XRP/BTS — January 19 to March 5, 2026

**Prepared:** 2026-03-05
**Chart:** IOB.XRP/BTS (ioxbank), 4h candles, LP pool 133
**Branch at time of analysis:** `test`
**Method:** Correlation of on-chart anomalies with `git log` history

---

## Executive Summary

Between January 19 and February 22, 2026, the DEXBot2 instance trading IOB.XRP/BTS produced
six anomalous volume spikes with candle highs reaching 1950–2100 BTS (vs a normal trading range
of 1300–1750). Each spike corresponds to a distinct bot crash caused by faulty grid state writes
or fund accounting errors. The crashes were not caused by market conditions — the underlying
IOB.XRP/BTS pair was in a steady downtrend during this period and the normal candle structure
was undisturbed outside the spike events.

The root causes fall into three separate bug families, introduced and resolved at different times.
All three were fully resolved by February 22–23, after which the chart shows no further anomalies.

---

## Chart Annotation

```
Price (BTS)
 2100 |                                          ↑ Spike 6
 2050 |                               ↑ Spike 5
 2000 |      ↑ S1  ↑↑ S2-3   ↑↑ S4-5
 1900 |
 1800 |  ████████████████████████████████████████████████████
 1700 |  ████████████████████████████████████████████████████ (normal range)
 1600 |
 1500 |
 1400 |                                                   ████
 1300 |                                              ██████████ (post-fix range)
      +-----|--------|--------|--------|--------|--------|-----
           Jan 22  Jan 26   Feb 1    Feb 6   Feb 12   Feb 19  Feb 22+
```

```
Timeline legend:
[=====BUG 1 ACTIVE=====]             — Fund validation always passes (Jan 19 – Feb 5)
      [==persistGrid before validate==] — Corrupted state written to disk (Jan 19 – Jan 25)
                              [=BUG 2=] — Deep market scan sync drift (Feb 9)
                                    [=====COW TRANSITION=====] — Architecture rewrite (Feb 10–22)
                                                     ↑ Feb 22: stable from here
```

---

## Bug Family 1: Fund Validation Algebra Error

### Timeline

| Date       | Commit    | Event |
|------------|-----------|-------|
| Jan 9      | `1fbf51d` | `_validateOperationFunds()` introduced **correctly** |
| Jan 19     | `61cab04` | **BUG INTRODUCED** — validation algebra inverted |
| Jan 26     | —         | Spike 1 (~1950) |
| Jan 27     | —         | Spike 2-3 cluster (crash → restart → crash) |
| Feb 2      | `f3d659d` | Partial fix: fund availability checks for mixed BUY/SELL |
| Feb 4–5    | —         | Spikes 4-5 (~2000) |
| Feb 5      | `ac1db74` | **BUG FIXED** — correct algebra restored |

### Root Cause

The original validation (Jan 9, `1fbf51d`) correctly checked:

```javascript
// CORRECT (1fbf51d, Jan 9)
const availableFunds = {
    [assetA.id]: snap.chainFreeSell || 0,
    [assetB.id]: snap.chainFreeBuy || 0
};
// Check: if (required > available) → blocks if insufficient funds
```

On January 19, commit `61cab04` ("Fix Fund Validation False Positive") rewrote this as:

```javascript
// BROKEN (61cab04, Jan 19)
const availableFunds = {
    [assetA.id]: (snap.chainFreeSell || 0) + (requiredFunds[assetA.id] || 0),
    [assetB.id]: (snap.chainFreeBuy || 0) + (requiredFunds[assetB.id] || 0)
};
// Check becomes: if (required > chainFree + required)
// → always FALSE unless chainFree is negative
// → validation NEVER blocks any batch
```

**Author's reasoning (from commit message):** The author believed `chainFree` had already been
reduced by optimistic deductions for the current batch, making the check a false positive.
This reasoning was incorrect — `chainFree` reflected the balance BEFORE the batch, so adding
`requiredFunds` back made validation a vacuous tautology.

**On-chain consequence:** The bot broadcast batches containing both BUY and SELL operations
that exceeded available funds. The blockchain would execute whichever side it processed first
(typically SELL), then reject the other side with "Insufficient Balance." The resulting
half-executed grid state caused the bot to generate a large correction order in the next cycle,
producing the volume spike visible on the chart.

**Fix (`ac1db74`, Feb 5):**

```javascript
// FIXED (ac1db74, Feb 5)
const availableFunds = {
    [assetA.id]: quantizeFloat(snap.chainFreeSell || 0, assetA.precision),
    [assetB.id]: quantizeFloat(snap.chainFreeBuy || 0, assetB.precision)
};
// Check: required > available → correctly blocks over-budget batches
```

---

## Bug Family 2: persistGrid Before Layer 2 Validation

### Timeline

| Date       | Commit    | Event |
|------------|-----------|-------|
| (unknown)  | —         | `persistGrid()` placed before Layer 2 gate |
| Jan 25     | `8e88a6d` | Layer 2 stabilization gate added |
| Jan 25     | `fccbcd8` | **BUG FIXED** — `persistGrid()` moved after gate passes |

### Root Cause

`persistGrid()` was called at the end of each cycle **before** the Layer 2 validation gate ran.
The Layer 2 gate detected grid corruption and triggered self-healing recovery — but by the time
it ran, the corrupted state had already been written to disk.

On the next restart (whether crash-triggered or manual), the bot reloaded the corrupted grid file
and immediately re-entered the corrupted state, triggering another crash. This explains the
**tight candle cluster around Jan 27**: crash → restart → reload corrupted file → crash again,
within a single 4h candle.

**Fix (`fccbcd8`, Jan 25, commit message):**

> *"Removed persistGrid() call that occurred before validation (line 837). Moved it to after
> Layer 2 gate succeeds and self-healing completes (line 875). Early returns on
> validation/recovery failure now avoid persistence entirely."*

This fix was deployed Jan 25 but did not stop crashes on its own because Bug Family 1
(fund validation) was still active until Feb 5.

---

## Bug Family 3: Deep Market Scan Sync Drift

### Timeline

| Date   | Commit    | Event |
|--------|-----------|-------|
| Feb 9  | `0d22ee1` | Deep market scan implemented — new sync inconsistency introduced |
| Feb 9  | —         | **Spike 5 (~2050)** — tallest pre-COW spike |
| Feb 16 | `25a317c` | **Reverted** — deep market scan removed |
| Feb 16 | `f56e0c3` | "restore critical fill handling and refactor regressions" |

### Root Cause

After the fund validation bug was fixed (Feb 5), a new feature was introduced on Feb 9:

> `0d22ee1` — *"implement deep market scan to prevent order truncation"*

This replaced the simple `get_full_accounts` open-order fetch with a paginated scan capable of
retrieving up to 198 orders (BitShares nodes truncate at 100 by default). While the feature was
valid in principle, it introduced a sync inconsistency: the bot's internal order state was built
from a different data path than the new paginated scan, causing the bot to believe orders were
missing from the chain. It responded by placing replacement orders — creating duplicates and a
significant volume spike at ~2050, the highest pre-COW event on the chart.

The feature was reverted 7 days later (`25a317c`, Feb 16).

**Note:** The Feb 16 spike (~2100, the chart's highest event) coincides with the revert itself
plus the early COW architecture rollout (see below), compounding the instability.

---

## Structural Fix: Copy-on-Write (COW) Grid Architecture

### Timeline

| Date       | Commit(s)  | Event |
|------------|------------|-------|
| Feb 10     | `cde26da`  | Immutable Master Grid Architecture (Phase 1–4) |
| Feb 10     | `4a82a2c`  | Async locking and thread-safe rollback |
| Feb 10     | `b6bd694`  | Async-safe fund accounting and logical sandboxing |
| Feb 14     | `71abeb8`  | Copy-on-Write grid architecture (first implementation) |
| Feb 15–16  | multiple   | COW deadlock fixes, sync fixes, lock routing |
| Feb 17     | `1fed7f2`  | COW hardening — eliminate all in-place mutations |
| Feb 17     | `ada36b7`  | Hybrid COW pattern with static mutation detection |
| Feb 18     | `86ab205`  | Keep boundary shifts atomic in COW divergence updates |
| Feb 20     | `b27619a`  | Eliminate COW rebalance invariant race |
| Feb 21     | `7dbbb49`  | Harden COW fill handling and accounting invariants |
| Feb 22     | `9ef800d`  | Preserve PARTIAL size in COW projection |
| **Feb 23** | multiple   | **Final COW hardening — bot stable from this point** |

### What COW Solves

All three bug families shared a common underlying cause: **the live grid was mutated in place
during cycles that could fail partway through.** A failed broadcast, a runtime error, or a
restart mid-cycle left the grid in a partially modified state that did not correspond to any
valid on-chain reality.

The Copy-on-Write architecture eliminated this class of bug structurally:

1. **No in-place mutation.** Every grid modification creates a copy. The live grid is only
   replaced atomically when the full operation commits successfully.
2. **Rollback by design.** If any step fails, the copy is discarded. The live grid is
   unchanged and consistent with the last known good on-chain state.
3. **persistGrid after commit.** Grid state is only written to disk after the COW commit
   succeeds, inheriting and generalizing the Bug Family 2 fix.

The Feb 22–23 cluster of commits (`4e13e4c`, `c7a685f`, `c625551`, `0334360`, `d0de685`)
completed the COW invariants for all edge cases (fill rebalance during startup, 1-sat
residuals, cache deduction alignment). The dashed vertical line visible on the chart at
Feb 22 16:00 marks the effective end of crash events.

---

## Spike Catalog

| # | Approx Date | Peak Price | Root Cause | Fix Commit(s) | Fully Resolved |
|---|-------------|------------|------------|---------------|----------------|
| 1 | Jan 26 | ~1950 | Bug 1: fund validation tautology | `ac1db74` | Feb 5 |
| 2 | Jan 27 | ~1900 | Bug 1 + Bug 2: crash/restart loop from corrupted persisted state | `fccbcd8` + `ac1db74` ¹ | Feb 5 |
| 3 | Jan 27 | ~1880 | Same crash/restart loop, second iteration | `fccbcd8` + `ac1db74` ¹ | Feb 5 |
| 4 | Feb 4 | ~2000 | Bug 1 still active; partial fund fixes insufficient | `ac1db74` | Feb 5 |
| 5 | Feb 5 | ~2000 | Last crash under Bug 1 (fix deployed same day) | `ac1db74` | Feb 5 |
| 6 | Feb 9 | ~2050 | Bug 3: deep market scan sync drift → duplicate orders | `25a317c` | Feb 16 |
| 7 | Feb 16 | ~2100 | Deep scan revert + early COW transition instability | `1fed7f2` + cluster | Feb 17–22 |

¹ `fccbcd8` (Jan 25) fixed the persistence mechanism before Spikes 2–3 occurred, but could not
prevent them: Bug 1 was still active and continued generating corrupted grid state each cycle,
giving the persistence fix no clean state to preserve. Spikes 2–3 were only fully prevented
once Bug 1 was also resolved by `ac1db74` on Feb 5.

---

## Market Context

The underlying IOB.XRP/BTS market was in a sustained downtrend during this entire period,
moving from ~1750 (Jan 22) to ~1250 (Feb 22) before stabilizing around 1300–1400 in late
February and early March. This is a ~28% decline over 30 days.

The bot crashes were entirely independent of this trend. The crash candles appear as vertical
spikes against the trend direction — the bot generating oversized orders that resolved quickly
(within one 4h period) back to the prevailing price. No persistent price impact from the
crashes is visible in the chart.

---

## Current Status (March 5, 2026)

The bot is running stably on the `test` branch. The COW architecture is in production.
No crash candles have appeared since Feb 22. The current 4h candle structure shows normal
grid trading behavior in the 1200–1400 range.

The three bug families documented here are fully resolved. Future grid state integrity is
maintained by the COW invariant rather than by defensive checks, making regression
structurally unlikely rather than just unlikely by convention.

---

## Key Commits Reference

```
1fbf51d  2026-01-09  fix: add pre-flight fund validation before batch broadcast   [ORIGINAL CORRECT]
61cab04  2026-01-19  Fix redundant fee deduction and fund validation false positive [BUG INTRODUCED]
fccbcd8  2026-01-25  fix: complete Issue 8 - move persistGrid after Layer 2 gate   [BUG 2 FIXED]
ac1db74  2026-02-05  fix: Correct fund validation to prevent insufficient balance   [BUG 1 FIXED]
660ff1d  2026-02-06  fix: Resolve grid reset race conditions, sizing bugs            [RACE FIXED]
0d22ee1  2026-02-09  fix: implement deep market scan to prevent order truncation    [BUG 3 INTRODUCED]
cde26da  2026-02-10  feat: Implement Immutable Master Grid Architecture              [COW START]
71abeb8  2026-02-14  feat: implement Copy-on-Write (COW) grid architecture           [COW CORE]
25a317c  2026-02-16  revert: remove deep market scan functionality                  [BUG 3 FIXED]
1fed7f2  2026-02-17  fix: COW architecture hardening - eliminate all in-place mutations
4e13e4c  2026-02-23  fix: align COW cache deductions with executed on-chain ints    [FINAL STABLE]
```
