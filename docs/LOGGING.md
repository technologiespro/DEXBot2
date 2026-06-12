# DEXBot2 Logging System

## Quick Start

Edit `profiles/general.settings.json` to configure logging:

```json
{
  "LOG_LEVEL": "info",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true }
    }
  }
}
```

### Enable JSON Output

```json
{
  "LOGGING_CONFIG": {
    "json": { "enabled": true }
  }
}
```

Writes JSON lines to log files alongside human-readable console output — zero impact on terminal.

---

## Architecture

All log calls go through the centralized `Logger` class (`modules/order/logger.ts`), which handles console output, batched async file writes, size-based rotation, optional JSON lines, and correlation ID tracing. Callers only interact with `logger.log()`, `logger.info()`, etc. — queueing, rotation, and I/O are internal.

```
Module → Logger.log() ──┬→ console (stdout/stderr)
                        └→ write queue → file (100ms batch)
                              + rotation (total 1.1GB budget, 10 rotated files)
                              + JSON lines (optional)
```

---

## Log Levels

| Level | Value | Default | Color | When It Appears |
|-------|-------|---------|-------|-----------------|
| **debug** | 0 | No | Cyan | Calculation details, fund change tracking |
| **info** | 1 | **Yes** | White | State changes, fills, order placement, boundary events |
| **warn** | 2 | No | Yellow | Non-critical issues, recovery attempts, edge cases |
| **error** | 3 | No | Red | Broadcast failures, sustained fill errors (10+ fails or 5min+) |
| **critical** | 4 | No | Bright red | Fill-consumer cascade (20+ fails or 15min+) — permanent fault signal |

Set `LOG_LEVEL` to `"info"` for production, `"warn"` for minimal output.

---

## Logging Categories

6 independently enablable categories:

| Category | Default Level | Default | Purpose |
|----------|--------------|---------|---------|
| **fundChanges** | debug | on | Fund balance updates in detail |
| **orderStateChanges** | info | on | Order placement, cancellation, state transitions |
| **fillEvents** | info | on | Fill processing and fund updates |
| **boundaryEvents** | info | on | Grid boundary adjustments and recovery |
| **errorWarnings** | warn | on | Critical issues, all errors and warnings |
| **edgeCases** | warn | on | Unusual conditions that don't cause errors |

### Production config (-90%)

```json
{
  "LOG_LEVEL": "warn",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": false },
      "fillEvents": { "enabled": false },
      "boundaryEvents": { "enabled": false }
    }
  }
}
```

### Debug config (full verbosity)

```json
{
  "LOG_LEVEL": "debug",
  "LOGGING_CONFIG": {
    "changeTracking": { "enabled": true },
    "categories": {
      "fundChanges": { "enabled": true },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true },
      "errorWarnings": { "enabled": true },
      "edgeCases": { "enabled": true }
    },
    "display": {
      "fundStatus": { "enabled": true, "showDetailed": true },
      "gridDiagnostics": { "enabled": false },
      "statusSummary": { "enabled": false }
    }
  }
}
```

---

## Display Features

| Feature | Default | Method | Purpose |
|---------|---------|--------|---------|
| **gridDiagnostics** | off | `logGridDiagnostics(mgr, ctx, force)` | Active/spread/partial order summary |
| **fundStatus** | off | `logFundsStatus(mgr, ctx, force)` | Detailed fund breakdown |
| **statusSummary** | off | `displayStatus(mgr, force)` | Comprehensive account/order status |

```json
{
  "LOGGING_CONFIG": {
    "display": {
      "gridDiagnostics": { "enabled": true, "showOnDemandOnly": true },
      "fundStatus": { "enabled": true, "showDetailed": true },
      "statusSummary": { "enabled": true }
    }
  }
}
```

---

## Log Rotation

```json
{
  "LOGGING_CONFIG": {
    "rotation": {
      "enabled": true,
      "maxSize": 1073741824,
      "maxFiles": 5
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable rotation |
| `maxSize` | 1.1GB | **Total** disk budget for all log files (current + rotated). Per-file limit = `maxSize / (maxFiles + 1)`. |
| `maxFiles` | `10` | Rotated files to keep; older files pruned |

Example: 1.1GB budget with 10 rotated files → each file rotates at ~100MB, max total ~1.1GB.

Under PM2, rotation is auto-suppressed — PM2 handles its own log files.

---

## JSON Structured Output

When enabled, each `log()` call writes a JSON line to the log file:

```json
{"timestamp":"2026-06-12T10:30:00.123Z","level":"INFO","category":"DEXBot","message":"Fill processed: 100 OPEN @ 0.5432","correlationId":"fill-abc-123"}
```

| Field | Always | Description |
|-------|--------|-------------|
| `timestamp` | Yes | ISO 8601 |
| `level` | Yes | Uppercase (`DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`) |
| `category` | Yes | Logger category |
| `message` | Yes | Raw message, no ANSI codes |
| `correlationId` | No | Present when `setCorrelationId()` was called |

---

## Correlation IDs

Trace a single operation (e.g. a fill) across log lines:

```typescript
logger.setCorrelationId('fill-abc-123');
```

Included in JSON output when present. Propagate to child loggers:

```typescript
const child = new Logger('Accounting', { correlationId: parent.correlationId });
```

---

## Change Detection

`LoggerState` prevents redundant logs by tracking previous values:

- Ignores fund changes < 0.00000001 (8 decimals)
- Ignores price changes < 0.0001 (4 decimals)

| Config Profile | Output Reduction | Lines/Cycle |
|---|---|---|
| Production | 90%+ | ~10 |
| Standard | 40-50% | ~100-150 |
| Debug | 0% | ~200+ |

Force output even if unchanged:

```javascript
manager.logger.logFundsStatus(manager, ctx, true)
manager.logger.displayStatus(manager, true)
```

---

## Log Tags Reference

Prefix tags used in log messages to help operators identify event types:

| Tag | Module | Example |
|-----|--------|---------|
| `[FILL-BATCH]` | `dexbot_class.ts` | Batch sizing, processing, and broadcast |
| `[RECOVERY]` | `accounting.ts` | Recovery attempts and resets |
| `[ORPHAN-FILL]` | `dexbot_class.ts` | Double-credit prevention for stale orders |
| `[HARD-ABORT]` | `dexbot_class.ts` | Illegal state during batch processing |
| `[COOLDOWN]` | `dexbot_class.ts` | Maintenance cooldown after abort |
| `[STALE-CANCEL]` | `dexbot_class.ts` | Fast-path recovery for single operations |
| `[REMAINDER]` | `grid.ts` | Unallocated remainder accuracy |
| `[FILL-QUEUE]` | `dexbot_class.ts` | Fill consumer health and backoff |

---

## FAQ**
- Standard config: 40-50%
- Production config: 90%+
- Debug config: 0% (all logs)

**Q: Do I need to change my code?**
No. All existing `logger.log()` calls work unchanged.

**Q: How is config loaded?**
Defaults in `modules/constants.ts` → deep merged with `profiles/general.settings.json` → frozen (immutable).

**Q: Can I customize logging per bot?**
Not yet. Global only via `general.settings.json`.

**Q: What about PM2?**
The logger auto-detects PM2 and suppresses file writes (PM2 captures stdout/stderr). File rotation is also suppressed under PM2.

**Q: Are log lines lost on crash?**
Queued-but-unwritten lines could be lost. Critical errors go to stderr immediately (PM2 captures those). Queue drains every 100ms. Call `flush()` on shutdown.
