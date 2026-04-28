# MPA and Credit Usage

DEXBot2 supports native BitShares debt workflows through the bot-level `debtPolicy` config block. Each lending item declares its own collateral asset, and the runtime groups items by collateral to compute independent distributions.

## Configuration Format

Add `debtPolicy` to a bot entry in `profiles/bots.json`.

```json
{
  "name": "credit-bot-1",
  "preferredAccount": "my-account",
  "assetA": "BTS",
  "assetB": "HONEST.USD",
  "active": true,
  "debtPolicy": {
    "maxCollateralAmount": "80%",
    "lending": [
      {
        "asset": "HONEST.USD",
        "collateralAsset": "BTS",
        "type": "mpa",
        "ratio": 1,
        "maxBorrowAmount": 1000,
        "maxCollateralAmount": 5000,
        "minCollateralRatio": 2.0,
        "maxCollateralRatio": 2.5,
        "targetCollateralRatio": 2.2
      },
      {
        "asset": "HONEST.CNY",
        "collateralAsset": "BTS",
        "type": "creditOffer",
        "ratio": 1,
        "maxBorrowAmount": 1000,
        "maxCollateralRatio": 2.5,
        "maxFeeRatePerDay": 0.05,
        "autoReborrow": true,
        "autoRepay": 2
      }
    ]
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `lending` | `array` | Non-empty array of lending items. Each item maps a debt asset to a debt type and collateral asset. |

### Lending Item Fields

Every item in `lending` must have:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `asset` | `string` | Yes | The debt asset symbol or ID (e.g. `"HONEST.USD"`). |
| `collateralAsset` | `string` | Yes | The collateral asset for this item (e.g. `"BTS"`). Multiple items may share the same collateral asset. |
| `type` | `string` | Yes | Either `"mpa"` (BitShares MPA call order) or `"creditOffer"` (credit offer deal). |
| `ratio` | `number` | No | Output weight for this asset. Defaults to `1`. See **Collateral Distribution** below. |

#### MPA-Specific Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetCollateralRatio` | `number` | No | Preferred operating CR. If omitted, midpoint of min/max is used. |
| `minCollateralRatio` | `number` | No | Hard minimum CR floor. If CR drops below this, debt is reduced first. |
| `maxCollateralRatio` | `number` | No | Hard maximum CR ceiling. If CR rises above this, debt is increased first. |
| `maxBorrowAmount` | `number` | No | **Fixed** total debt ceiling. The planner will not increase total debt above this. Must be a positive number (not a percentage). |
| `maxCollateralAmount` | `number \| string` | No | Total collateral ceiling for this MPA position. May be an absolute amount or a percentage. |

#### Credit-Offer-Specific Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxCollateralRatio` | `number` | **Yes** | Maximum effective collateral ratio allowed when accepting a credit offer. |
| `maxBorrowAmount` | `number` | No | **Fixed** total debt ceiling across all active credit deals for this asset. Must be a positive number (not a percentage). |
| `maxCollateralAmount` | `number \| string` | No | Total collateral ceiling for credit deals. May be absolute or percentage. |
| `maxFeeRatePerDay` | `number` | No | Maximum acceptable daily fee rate. Defaults to `1/3000` (~0.033% per day). |
| `autoReborrow` | `boolean` | No | If `true`, the bot reborrows from the same offer after repayment. |
| `autoRepay` | `number` | No | On-chain credit deal auto-repay mode: `0`, `1`, or `2`. |
| `allowedOfferIds` | `string[]` | No | Whitelist of credit offer object IDs the bot may accept. |

### Global Fields

| Field | Type | Description |
|-------|------|-------------|
| `maxCollateralAmount` | `number \| string` | **Global** collateral cap across all lending items. Resolved against the full collateral base (on-chain balance + committed collateral). May be absolute or percentage (e.g. `"80%"`). |

There is no separate enable switch. If `debtPolicy.lending` is present, non-empty, and every item has a valid `collateralAsset`, the credit runtime loads for that bot.

## Collateral Distribution

The runtime calculates the required collateral for each `lending` item **backwards from the desired debt output ratio**. The `ratio` field controls the proportion of debt value (not collateral) each item receives.

### Formulas

```
MPA weight_i    = ratio_i * feedPrice_i * targetCR_i
Credit weight_i = (ratio_i * maxCR_i) / conversionRate_i
C_total         = min(availableCollateral, globalMaxCollateral)
C_i             = C_total * weight_i / sum(all weights)
```

- **MPA**: `feedPrice_i` is the current settlement feed price (collateral per debt asset). The runtime discovers it from the chain and caches it per position.
- **Credit**: `conversionRate_i` is the offer's `acceptable_collateral` price (debt asset per collateral unit). The runtime discovers it from existing deals or `allowedOfferIds`.
- **Fallback**: If the price cannot be discovered, the runtime falls back to `weight = ratio * targetCR` and logs a warning.
- `ratio` is the user's output proportion. A `ratio` of `1` is the default. Equal ratios produce **equal economic debt value** across all lending items, regardless of price or CR differences.

### Examples

**Two assets, equal ratio:**
```json
"lending": [
  { "asset": "USD", "type": "mpa", "ratio": 1, "targetCollateralRatio": 2.0 },
  { "asset": "CNY", "type": "mpa", "ratio": 1, "targetCollateralRatio": 2.0 }
]
```
Both weights are `1 * 2.0 = 2.0`. Collateral is split **50:50**.

**Two assets, 80 % output on USD:**
```json
"lending": [
  { "asset": "USD", "type": "mpa", "ratio": 0.8, "targetCollateralRatio": 2.0 },
  { "asset": "CNY", "type": "mpa", "ratio": 1,   "targetCollateralRatio": 2.0 }
]
```
USD weight = `0.8 * 2.0 = 1.6`, CNY weight = `1.0 * 2.0 = 2.0`. USD receives a proportionally smaller share, leaving more collateral unallocated for safety.

**Three assets, equal ratio:**
```json
"lending": [
  { "asset": "USD", "type": "mpa", "ratio": 1, "targetCollateralRatio": 2.0 },
  { "asset": "CNY", "type": "mpa", "ratio": 1, "targetCollateralRatio": 2.0 },
  { "asset": "EUR", "type": "mpa", "ratio": 1, "targetCollateralRatio": 2.0 }
]
```
All weights are equal. Collateral is split **1/3 : 1/3 : 1/3**.

## Runtime Timing

Credit and MPA maintenance are separated from periodic grid checks. DEXBot2 starts a dedicated credit watchdog interval during bot startup.

Timing defaults live in `modules/constants.js`:

```json
{
  "TIMING": {
    "CREDIT_DEAL_CHECK_INTERVAL_MIN": 60,
    "CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS": 12
  }
}
```

- `CREDIT_DEAL_CHECK_INTERVAL_MIN`: how often the credit watchdog runs.
- `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`: how far before `latest_repay_time` the bot proactively repays and reborrows a credit deal.

Set `CREDIT_DEAL_CHECK_INTERVAL_MIN` to `0` or a negative value to disable the watchdog.

## MPA Maintenance

The MPA planner reads the live call order for each `type: "mpa"` lending item before making changes:

- If CR is below `minCollateralRatio`, it **reduces debt first**, then adds collateral if needed.
- If CR is above `maxCollateralRatio`, it **increases debt first**, then withdraws collateral if allowed.
- If `targetCollateralRatio` is not set, the runtime uses the midpoint of the min/max band.
- After any successful CR adjustment, the bot requests a grid reset so order sizing reflects the new capital base.
- The `maxBorrowAmount` ceiling only prevents additional debt from going above the configured total; it does not block debt reduction.
- `maxBorrowAmount` must be a **fixed positive number** (percentages are not allowed).

The runtime does not create arbitrary debt outside the configured asset and CR limits.

## Credit Offer Maintenance

For each `type: "creditOffer"` lending item, the runtime:

- Discovers active credit deals on-chain.
- Validates deals against the per-item policy (`maxCollateralRatio`, `maxFeeRatePerDay`, `allowedOfferIds`, etc.).
- Proactively repays deals nearing expiration (within `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`).
- Reborrows from the same offer when `autoReborrow` is enabled, using the **full assigned collateral budget**.
- Ensures `auto_repay` on-chain matches the policy's `autoRepay` setting.

### Amount Cap Semantics

| Policy | Field | Scope |
|--------|-------|-------|
| MPA | `maxBorrowAmount` | **Total debt ceiling** — the planner will not let the call order's total debt exceed this value. |
| MPA | `maxCollateralAmount` | **Total collateral ceiling** — the planner will not let the call order's total collateral exceed this value. Withdrawals are still allowed. |
| Credit | `maxBorrowAmount` | **Total debt ceiling** — the runtime will not accept a deal that would push total credit debt for the asset above this value. |
| Credit | `maxCollateralAmount` | **Total collateral ceiling** — the runtime will not accept a deal that would push total credit collateral for the asset above this value. |

`maxBorrowAmount` is always a **fixed number** (no percentages). `maxCollateralAmount` may be a fixed number or a percentage.

### Credit Deal Renewal

The watchdog checks active credit deals discovered on-chain.

When a deal's `latest_repay_time` is within `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`, the runtime attempts to:

1. Repay the deal.
2. Reborrow from the same offer when `autoReborrow` is enabled, using the full `assignedCollateralBudget` for that asset.
3. Preserve configured `autoRepay` intent for the resulting deal update flow.

If inline reborrow cannot be built safely, the runtime stores a deferred reborrow request in `profiles/credit_runtime/<botKey>.json` and retries later after refreshing chain state.

### Important Distinction

- `autoReborrow` is a **DEXBot2 behavior**. After a successful repay, the bot may accept the same offer again if policy and offer state still pass validation.
- `autoRepay` maps to the **BitShares credit deal** `auto_repay` mode. It is not the same thing as `autoReborrow`.

## LP-Backed Credit Collateral

Credit offers may accept liquidity-pool share assets as collateral. Before accepting an offer, DEXBot2:

1. Resolves the LP pool for the share asset.
2. Reads pool balances and share supply.
3. Computes the collateral value from the underlying reserves.
4. Converts that value into the debt asset denomination.
5. Rejects the borrow if the effective ratio exceeds the lending item's `maxCollateralRatio`.

If pool lookup, supply lookup, or valuation cannot be resolved, the runtime fails closed and does not sign the borrow.

## State Files

The runtime persists one state file per bot:

```text
profiles/credit_runtime/<botKey>.json
```

The file tracks discovered chain state and pending work, including:

- `positions` — per-asset state map (debtAssetId -> positionState)
- active MPA call-order state per position
- active credit deal IDs per position
- current debt and collateral amounts per position
- `assignedCollateralBudget` per position
- pending reborrow requests
- last MPA action per position
- last grid reset request
- last repay timestamp
- debt snapshot across all assets

Treat this file as runtime state, not primary configuration. The source of truth for enabled policy is still `profiles/bots.json`.

## Operational Notes

- Keep `debtPolicy` narrow. Only list assets and offers the bot is allowed to use.
- Use conservative CR bands. `minCollateralRatio` is a hard safety floor, not a target.
- Keep `maxFeeRatePerDay` explicit for credit offers.
- Do not confuse credit-offer collateral ratio with MPA call-order CR. They are validated in separate paths.
- After editing `profiles/bots.json`, restart or reload the bot so the runtime picks up the new policy.
- Review `profiles/credit_runtime/<botKey>.json` when diagnosing pending reborrow or renewal behavior.

## Related Files

- `modules/credit_runtime.js`: debt workflow executor
- `modules/dexbot_class.js`: runtime startup and watchdog lifecycle
- `modules/bot_settings.js`: `debtPolicy` validation
- `modules/credential_policy.js`: signing constraints for credit and call-order operations
- `tests/test_credit_runtime.js`: credit runtime behavior coverage
- `tests/test_multi_asset_distribution.js`: collateral distribution and multi-asset state coverage
