# Bug-Fix Audit: v0.7.5 → HEAD

**Period:** 2026-05-29 → 2026-06-11 (13 days)
**Total commits:** 105
**Total individual bug fixes:** 155 (across 68 of 105 commits)

---

## Executive Summary

Counting by commit subject prefix ("55 `fix:` commits") undercounts the actual number of bugs corrected by **~2.8×**. Multi-fix commits are the norm — several contain 5–8 distinct defects — and bugs are also fixed in `refactor:`, `feat:`, `chore:`, and `docs:` commits.

| Metric | Value |
|--------|-------|
| `fix:`-prefixed commits | 55 |
| Non-`fix:` commits containing fixes | 13 |
| **Individual bug fixes (diff-level)** | **155** |
| Fixes per `fix:` commit (avg) | ~1.5 |
| Fixes per fix-containing commit (avg) | ~2.3 |

---

## Breakdown by Conventional Commit Type

| Type | Commits | Individual Bug Fixes | % of Total Fixes |
|------|--------:|--------------------:|:----------------:|
| `fix:` | 55 | ~116 | 75% |
| `refactor:` | 5 | 20 | 13% |
| `chore:` | 1 | 3 | 2% |
| `feat:` | 4 | 4 | 3% |
| `docs:` | 3 | 12 | 8% |

---

## Fix Category Breakdown

| Category | Count | % | Description |
|----------|------:|---|-------------|
| **LOGIC** | 58 | 37% | Algorithm/control-flow defects (stale flag placement, wrong guard conditions, missing state initialization, wrong comparison) |
| **DATA** | 13 | 8% | Wrong persisted state, stale snapshots, missing config defaults, false defaults |
| **TEST** | 13 | 8% | Wrong assertions, missing `await`, stale test expectations, uncovered paths |
| **PERF** | 12 | 8% | Unnecessary/duplicate work (redundant fund recalc, reconnection churn, RPM waste) |
| **UX** | 12 | 8% | CLI interaction defects (wrong exit codes, missing summaries, ambiguous commands) |
| **DOCS** | 11 | 7% | Stale labels, non-chronological history, wrong references, missing entries |
| **CRASH** | 9 | 6% | Unhandled errors, shutdown hangs, signal handler leaks, descriptor leaks |
| **UI** | 7 | 5% | Wrong colors, unreadable display, inconsistent formatting |
| **RACE** | 7 | 5% | Fill/order-batch races, supervisor timing, command-ordering races |
| **BUILD** | 7 | 5% | Stale dist, broken references, wrong entrypoint detection |
| **SEC** | 2 | 1% | Foreign daemon takeover, masked input redraw leak |
| **TYPO** | 1 | <1% | Variable name typo (`staleStaleFlags`) |

---

## Top 10 Most Bug-Dense Commits

| SHA | Subject | Bugs |
|-----|---------|:----:|
| `b49d051` | resolve pipeline self-blocking, stale flags, docs label, and additional bugs | **8** |
| `2f34341` | harden native reconnect and shutdown handling | **8** |
| `f722579` | harden COW uncertainty-recovery and orphan-cancel paths | **6** |
| `5617fbc` | align unlock-start delete and monolithic controls | **6** |
| `c09176a` | centralize BUILD_DIR and add source-mode runtime support | **6** |
| `f3e0656` | sweep stale version references, file renames, hardcoded paths | **6** |
| `930870e` | smooth structural grid recovery | **5** |
| `b9dbe36` | harden unlock-start launcher — ownership, error routing, docs | **4** |
| `e6e114a` | clean up leaked signal handlers and harden unlock-start error paths | **4** |
| `c60e7ac` | block COW creates on missing chainOrderId and unmatched grid drift | **4** |

---

## Complete Commit Inventory

### fix: (55 commits, ~116 individual fixes)

| # | SHA | Subject | Fixes | Key bug types |
|---|-----|---------|:-----:|---------------|
| 1 | `ccaf14e` | remove @ts-nocheck, enable gradual strict typing | 2 | TEST (wrong assertions) |
| 2 | `fe82fa2` | align Claw HMAC recovery with main path | 1 | LOGIC (missing SIGHUP) |
| 3 | `598cb32` | recover stale HMAC sessions, suppress zero-budget shortfalls | 2 | LOGIC (HMAC retry, budget gate) |
| 4 | `8de5586` | remove dead anyRotations assertions from test | 1 | TEST (stale assertions) |
| 5 | `eaf3258` | resolve remaining pipeline-blocking stale flag risks | 2 | LOGIC (flag clear placement) |
| 6 | `a01b00b` | remove dead anyRotations, deduplicate fund recalc | 2 | PERF (redundant recalc) |
| 7 | `b49d051` | resolve pipeline self-blocking, stale flags, docs label | **8** | LOGIC×4, PERF×2, DOCS, TYPO |
| 8 | `1a59b37` | color remaining launcher success lines | 2 | UX (missing color) |
| 9 | `3e68aba` | polish launcher output wording and colors | 2 | UX (bot count, scannability) |
| 10 | `73fa79d` | carry forward quiet orderbook candles | 1 | LOGIC (stale snapshots) |
| 11 | `2c8b9b9` | clean up analyze-order dynamic weight display | 2 | UI (redundant output, wrong grey) |
| 12 | `d48cb0c` | show AMA adapter status without dynamic weights | 1 | LOGIC (null return) |
| 13 | `e8188a4` | gate dynamic weights on AMA whitelist | 3 | LOGIC×2, UI |
| 14 | `1a9a9b5` | refresh AMA dynamic grid snapshots every cycle | 1 | LOGIC (stale snapshots) |
| 15 | `b32a869` | default whitelist dynamic weights off | 2 | DATA, UX (npm forwarding) |
| 16 | `820592b` | preserve market adapter whitelist entries | 1 | DATA (overwrite) |
| 17 | `93538d0` | make unlock monolithic startup idempotent | 2 | UX, PERF |
| 18 | `2e87acf` | show equal dynamic weights in white instead of grey | 1 | UI (wrong grey) |
| 19 | `a366418` | reorder version history chronologically | 1 | DOCS (ordering) |
| 20 | `8af8317` | darken active sell color | 1 | UI (readability) |
| 21 | `de6c134` | tune AMA reset and asymmetry defaults | 2 | DATA (threshold/slope) |
| 22 | `201d0a3` | keep key manager startup quiet | 1 | UX (log pollution) |
| 23 | `d3ad915` | avoid duplicate build during update install | 1 | PERF (double build) |
| 24 | `5ab9be6` | preserve masked terminal input editing | 1 | SEC (clear-text redraw) |
| 25 | `1969cec` | eliminate doubled NodeManager log output | 1 | LOGIC (side-effect init) |
| 26 | `1549ab5` | lighten terminal color palette | 1 | UI (dim colors) |
| 27 | `631b612` | integrate 5 post-tag commits into changelog | 1 | DOCS (missing entries) |
| 28 | `0ebe075` | detect and remove foreign credential daemons in unlock | 1 | SEC (socket takeover) |
| 29 | `8d55db6` | harden market adapter watchdog locks | 2 | LOGIC (stale lock, .ts detection) |
| 30 | `f722579` | harden COW uncertainty-recovery and orphan-cancel | **6** | LOGIC×6 |
| 31 | `05d7d3c` | rebuild updater bundle before restart | 2 | BUILD, LOGIC |
| 32 | `377846d` | recover uncertain credential broadcasts safely | 2 | CRASH, LOGIC |
| 33 | `4d90885` | harden grid reconciliation recovery paths | 3 | LOGIC×3 |
| 34 | `c60e7ac` | block COW creates on missing chainOrderId | **4** | LOGIC×4 |
| 35 | `2f34341` | harden native reconnect and shutdown handling | **8** | PERF×4, RACE, LOGIC, CRASH×2 |
| 36 | `2f1d3f9` | guard post-reset spread correction with chain sync | 1 | LOGIC (stale local state) |
| 37 | `f19cc51` | reconcile live orders on runtime drift | 1 | LOGIC (missing sync) |
| 38 | `62fc990` | defer fill processing during order batches | 1 | RACE (fill-vs-batch) |
| 39 | `1ef1787` | make launcher wrappers work without dist builds | 1 | CRASH (missing dist) |
| 40 | `7579fe9` | improve unlock status runtime summary | 1 | UI (verbose display) |
| 41 | `930870e` | smooth structural grid recovery | **5** | LOGIC×2, RACE, DATA, PERF |
| 42 | `41087cd` | avoid listing credential daemon on restarts | 1 | UX (misleading list) |
| 43 | `a9d8db4` | list runtime services in unlock control summaries | 1 | UX (missing services) |
| 44 | `8b26c53` | restart market adapter during unlock updates | 2 | LOGIC, RACE |
| 45 | `1acd25c` | restart legacy unlock wrappers after update | 1 | LOGIC (wrong entrypoint) |
| 46 | `71da709` | remove node pm2 reload wrapper | 1 | TEST (missing quiet:false) |
| 47 | `37f675b` | clean dist before build | 1 | BUILD (stale artifacts) |
| 48 | `5617fbc` | align unlock-start delete and monolithic controls | **6** | LOGIC×2, RACE×2, DATA×2 |
| 49 | `b204170` | restart monolithic runtime after updates | 4 | LOGIC×2, UX, DATA |
| 50 | `09bf18b` | improve monolithic status reporting | 3 | DATA×3 |
| 51 | `3a0f465` | prevent unnecessary bot restart + PM2 double-reload | 2 | LOGIC×2 |
| 52 | `4af92bf` | remove redundant `control` subcommand | 1 | UX (bot name parsing) |
| 53 | `9013b76` | correct unmarked AMA slope percent default | 1 | TEST (wrong expectation) |
| 54 | `b9dbe36` | harden unlock-start launcher | **4** | LOGIC×2, BUILD, CRASH |
| 55 | `e6e114a` | clean up leaked signal handlers | **4** | CRASH×3, RACE |

### refactor: containing fixes (5 commits, ~20 fixes)

| SHA | Subject | Fixes | Detail |
|-----|---------|:-----:|--------|
| `e199c6b` | DRY duplicated code | 2 | BUILD (TS7006), TEST (duplicate declaration) |
| `89aad0a` | deduplicate, harden error handling | 3 | LOGIC (silent catches, unreturned values) |
| `c09176a` | centralize BUILD_DIR | **6** | TEST×5 (wrong await, lazy init, hang, CI skip, regex) |
| `70c5839` | deduplicate chain-sync-fill pipeline | 1 | LOGIC (duplicate error logging) |
| `ecc1c8d` | remove deprecated patterns | 3 | BUILD×3 (broken refs, wrong script, hardcoded paths) |

### chore: containing fixes (1 commit, 3 fixes)

| SHA | Subject | Fixes | Detail |
|-----|---------|:-----:|--------|
| `50ee8fa` | cleanup audit findings | 3 | CRASH (fd leak), LOGIC (CEX throw), PERF (rate limiting) |

### feat: containing fixes (4 commits, 4 fixes)

| SHA | Subject | Fixes | Detail |
|-----|---------|:-----:|--------|
| `c264026` | v0.7.17 release | 3 | TEST (type mismatch), DATA×2 (stale `market`→`book`) |
| `49fcca6` | rename dexbot start to test | 1 | UX (bare stop targeted whole runtime) |
| `83f9052` | add debtOnly MPA flag | 1 | LOGIC (missing typeFilter) |
| `48e6bd7` | unify unlock-start startup | 1 | LOGIC (argv ignored) |

### docs: containing fixes (3 commits, 12 fixes)

| SHA | Subject | Fixes | Detail |
|-----|---------|:-----:|--------|
| `a97623e` | fix stale references | 1 | DOCS (multiple stale refs) |
| `f3e0656` | sweep stale references | **6** | DOCS×6 (version, renames, paths, counts, duplicates) |
| `47ca88f` | comprehensive doc sweep | 1 | DOCS (stale refs across 20 files) |
| `89b2645` | remove stale dexbot test ref | 1 | DOCS |
| `0c63cbc` | clarify dexbot start | 1 | DOCS |
| `0813a39` | clarify unlock as recommended | 1 | DOCS |

---

## Files Most Frequently Touched by Bug Fixes

| File | Fixes | Common issue |
|------|:-----:|-------------|
| `modules/dexbot_class.ts` | ~18 | Pipeline flags, fill/order race, COW guards, fund recalc |
| `unlock.ts` / `unlock-start.ts` | ~14 | Signal handler leaks, daemon ownership, status reporting |
| `modules/order/sync_engine.ts` | ~8 | Stale flags, orphan matching, drift sync |
| `modules/order/manager.ts` | ~6 | Pipeline signals, pending broadcasts, COW state |
| `modules/constants.ts` | ~5 | Default tuning, timing parameters |
| `modules/order/grid.ts` | ~5 | Sizing context, ratio divergence, recalc dedup |
| `modules/bitshares_client.ts` | ~4 | Reconnect, failover, doubled log |
| `modules/chain_orders.ts` | ~4 | HMAC recovery, cancel recording, batch signing |
| `modules/dexbot_maintenance_runtime.ts` | ~4 | Stale flags, RMS resync, drift reconcile |
| `modules/order/utils/order.ts` | ~4 | Price correction cleanup, missing params |
| `scripts/analyze-orders.ts` | ~4 | Dynamic weight display, AMA status, colors |

---

## Methodology

Each of the 105 commits in the range `v0.7.5..HEAD` was analyzed by reading its full `git show` diff. Each hunk was classified as:

- **Bug fix** — code that was defective and causing incorrect behavior, crashes, or data corruption
- **Feature** — additive functionality not fixing a defect
- **Refactor** — structural change with no behavioral impact
- **Docs** — documentation-only change
- **Test** — test changes (only counted as a fix if the test itself was wrong)

Multi-fix commits were decomposed into individual defects by logical change unit (e.g., a commit fixing "stale flags" at 3 independent locations = 3 fixes).

---

## Key Risk Areas

1. **Pipeline self-blocking** (~12 fixes) — stale boolean flags (`_gridSidesUpdated`, `_batchRetryInFlight`) could permanently block order processing. The most common systemic bug pattern.

2. **COW (Copy-on-Write) integrity** (~14 fixes) — broadcast race conditions, missing chainOrderId handling, orphan cancel prioritization, and persistence guard gaps in the CoW order pipeline.

3. **Uncertain broadcast recovery** (~4 fixes) — credential daemon timeouts left the bot unsure whether CREATE operations reached the chain, risking duplicate orders or lost operations.

4. **Signal handler / shutdown** (~6 fixes) — leaked handlers, non-idempotent shutdown, unguarded polling intervals causing hangs on exit.

5. **Test bugs** (13 fixes) — wrong assertions, missing `await`, lazy initialization not triggered, reflecting the complexity of testing blockchain-dependent async code.

Generated: 2026-06-11
