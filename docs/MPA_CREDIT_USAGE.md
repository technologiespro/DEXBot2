# MPA and Credit Usage

DEXBot2 supports native BitShares debt workflows through the bot-level `debtPolicy` config block:

- MPA call-order maintenance through `debtPolicy.mpa`
- Credit offer accept, repay, renewal, and auto-reborrow through `debtPolicy.creditOffer`

The runtime is implemented in `modules/credit_runtime.js`. It is started automatically for any bot that has a `debtPolicy` block.

## Configuration

Add `debtPolicy` to a bot entry in `profiles/bots.json`.

```json
{
  "name": "credit-bot-1",
  "preferredAccount": "my-account",
  "assetA": "BTS",
  "assetB": "HONEST.USD",
  "active": true,
  "debtPolicy": {
    "mpa": {
      "allowedDebtAssets": ["HONEST.USD"],
      "allowedCollateralAssets": ["BTS"],
      "maxBorrowAmount": 1000,
      "maxCollateralAmount": 25000,
      "minCollateralRatio": 2.0,
      "maxCollateralRatio": 2.5,
      "targetCollateralRatio": 2.2
    },
    "creditOffer": {
      "allowedOfferIds": ["1.18.42"],
      "allowedDebtAssets": ["HONEST.USD"],
      "allowedCollateralAssets": ["BTS", "HONEST.LP"],
      "maxBorrowAmount": 1000,
      "maxFeeRate": 30000,
      "maxCollateralRatio": 2.5,
      "autoReborrow": true,
      "autoRepay": 2
    }
  }
}
```

There is no separate enable switch. If `debtPolicy` is present, the credit runtime loads for that bot.

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

## MPA Policy

`debtPolicy.mpa` controls BitShares call-order maintenance.

| Field | Meaning |
| --- | --- |
| `allowedDebtAssets` | MPA assets the bot may borrow. |
| `allowedCollateralAssets` | Collateral assets the bot may use. For HONEST MPAs this is usually `BTS`. |
| `maxBorrowAmount` | Maximum total debt allowed. The planner will not increase the call order's total debt above this ceiling. Fixed number only. |
| `maxCollateralAmount` | Maximum total collateral allowed for the MPA call order. May be an absolute amount or a percentage of the current collateral amount. |
| `minCollateralRatio` | Hard minimum CR floor. |
| `maxCollateralRatio` | Hard maximum CR ceiling. |
| `targetCollateralRatio` | Preferred operating CR inside the min/max band. |

The MPA planner reads the live call order before making changes:

- If CR is below `minCollateralRatio`, it reduces debt first, then adds collateral if needed.
- If CR is above `maxCollateralRatio`, it increases debt first, then withdraws collateral if allowed.
- If `targetCollateralRatio` is not set, the runtime uses the midpoint of the min/max band.
- After any successful CR adjustment, the bot requests a grid reset so order sizing reflects the new capital base.
- The `maxBorrowAmount` ceiling only prevents additional debt from going above the configured total; it does not block debt reduction.

The runtime does not create arbitrary debt outside the configured asset and CR limits.

## Credit Offer Policy

`debtPolicy.creditOffer` controls BitShares credit-offer usage.

| Field | Meaning |
| --- | --- |
| `allowedOfferIds` | Credit offer object ids the bot may accept. |
| `allowedDebtAssets` | Assets the bot may borrow from credit offers. |
| `allowedCollateralAssets` | Assets the bot may post as credit collateral. |
| `maxBorrowAmount` | Maximum total borrowed amount allowed across all active credit deals. Optional. Fixed number only. |
| `maxCollateralAmount` | Maximum total collateral amount allowed across all active credit deals. Optional. May be an absolute amount or a percentage of the full collateral base. |
| `maxFeeRatePerDay` | Maximum acceptable **daily** fee rate. The bot calculates this from the offer's flat `fee_rate` and `max_duration_seconds`. Example: `0.001` = 0.1% per day. Defaults to `1/3000` (~0.033% per day, or ~1% per month). |
| `maxCollateralRatio` | Maximum effective collateral ratio allowed for the accept operation. |
| `autoReborrow` | Bot-side rule to reborrow after a confirmed repay. |
| `autoRepay` | On-chain credit deal auto-repay mode: `0`, `1`, or `2`. |

Either amount cap may be omitted. `maxBorrowAmount` must be numeric. `maxCollateralAmount` can be numeric or percentage, and the runtime resolves percentage caps against the full collateral base for the asset, including on-chain balance, limit orders, MPA collateral, and credit-deal collateral.

**Amount cap semantics**

| Policy | Field | Scope |
| --- | --- | --- |
| `mpa` | `maxBorrowAmount` | **Total debt ceiling** — the planner will not let the call order's total debt exceed this value. |
| `mpa` | `maxCollateralAmount` | **Total collateral ceiling** — the planner will not let the call order's total collateral exceed this value. Withdrawals are still allowed. |
| `creditOffer` | `maxBorrowAmount` | **Total debt ceiling** — the runtime will not accept a deal that would push the total credit debt for the asset above this value. |
| `creditOffer` | `maxCollateralAmount` | **Total collateral ceiling** — the runtime will not accept a deal that would push the total credit collateral for the asset above this value. |

Important distinction:

- `autoReborrow` is a DEXBot2 behavior. After a successful repay, the bot may accept the same offer again if policy and offer state still pass validation.
- `autoRepay` maps to the BitShares credit deal `auto_repay` mode. It is not the same thing as `autoReborrow`.

## Credit Deal Renewal

The watchdog checks active credit deals discovered on-chain.

When a deal's `latest_repay_time` is within `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`, the runtime attempts to:

1. Repay the deal.
2. Reborrow from the same offer when `autoReborrow` is enabled.
3. Preserve configured `autoRepay` intent for the resulting deal update flow.

If inline reborrow cannot be built safely, the runtime stores a deferred reborrow request in `profiles/credit_runtime/<botKey>.json` and retries later after refreshing chain state.

## LP-Backed Credit Collateral

Credit offers may accept liquidity-pool share assets as collateral. Before accepting an offer, DEXBot2:

1. Resolves the LP pool for the share asset.
2. Reads pool balances and share supply.
3. Computes the collateral value from the underlying reserves.
4. Converts that value into the debt asset denomination.
5. Rejects the borrow if the effective ratio exceeds `creditOffer.maxCollateralRatio`.

If pool lookup, supply lookup, or valuation cannot be resolved, the runtime fails closed and does not sign the borrow.

## State Files

The runtime persists one state file per bot:

```text
profiles/credit_runtime/<botKey>.json
```

The file tracks discovered chain state and pending work, including:

- active MPA call-order state
- active credit deal ids
- active offer ids
- current debt and collateral amounts
- pending reborrow requests
- last MPA action
- last grid reset request
- last repay timestamp

Treat this file as runtime state, not primary configuration. The source of truth for enabled policy is still `profiles/bots.json`.

## Operational Notes

- Keep `debtPolicy` narrow. Only list assets and offers the bot is allowed to use.
- Use conservative CR bands. `minCollateralRatio` is a hard safety floor, not a target.
- Keep `maxFeeRate` explicit for credit offers.
- Do not confuse credit-offer collateral ratio with MPA call-order CR. They are validated in separate paths.
- After editing `profiles/bots.json`, restart or reload the bot so the runtime picks up the new policy.
- Review `profiles/credit_runtime/<botKey>.json` when diagnosing pending reborrow or renewal behavior.

## Related Files

- `modules/credit_runtime.js`: debt workflow executor
- `modules/dexbot_class.js`: runtime startup and watchdog lifecycle
- `modules/bot_settings.js`: `debtPolicy` validation
- `modules/credential_policy.js`: signing constraints for credit and call-order operations
- `tests/test_credit_runtime.js`: credit runtime behavior coverage
- `tests/test_dexbot_credit_wiring.js`: watchdog and runtime wiring coverage
