# Credit Debt Integration Plan

This document defines the integration path for two debt workflows in DEXBot2:

- MPA borrowing from the blockchain call-order system
- Credit offer borrow and repay

The goal is to keep the bot-facing configuration simple, make policy enforcement explicit, and allow Claw to manage the same bot model without owning the business rules.

## Scope

Included:

- Per-bot debt policy configuration
- MPA borrow limits and collateral limits
- Credit offer borrow limits and max fee rate
- Auto-reborrow behavior driven by bot settings
- Runtime enforcement before signing
- Optional Claw support for reading and managing the same bot policy

Excluded:

- General market-making grid logic
- Margin call / liquidation logic
- Any new chain primitives
- `market_adapter` runtime changes
- Fee fields for MPA borrowing

## Configuration Model

Use one umbrella group on each bot entry:

- `debtPolicy`

This group contains two child objects:

- `mpa`
- `creditOffer`

Recommended shape:

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
      "autoReborrow": true
    }
  }
}
```

### Field meaning

- `allowedDebtAssets`
  - Assets the bot may borrow.
- `allowedCollateralAssets`
  - Assets the bot may post as collateral.
  - Credit offers may allow multiple collateral assets here.
  - MPA uses one active collateral asset per call-order position.
- `allowedOfferIds`
  - Credit offers the bot may use.
- `maxBorrowAmount`
  - Maximum new debt the bot may create in one action.
- `maxCollateralAmount`
  - Maximum collateral the bot may commit for an MPA call-order update.
- `minCollateralRatio`
  - Hard minimum CR floor for the bot.
- `maxCollateralRatio`
  - Hard maximum CR ceiling for the bot.
- `targetCollateralRatio`
  - Optional in-band CR target used by the MPA planner when reducing or increasing debt first and then optimizing collateral.
- `maxFeeRate`
  - Maximum fee rate permitted when accepting a credit offer.
- `autoReborrow`
  - Worker-level flag that allows a new credit offer accept after a successful repay.

## Integration Points

### 1. Bot settings loader

File:

- [`modules/bot_settings.js`](/home/alex/BTS/Git/DEXBot2/modules/bot_settings.js)

Task:

- Preserve `debtPolicy` when loading and saving bot entries.
- Do not strip nested policy objects during normalization.
- Keep the existing bot layout intact for the grid bot fields.

### 2. Bot editor

File:

- [`modules/account_bots.js`](/home/alex/BTS/Git/DEXBot2/modules/account_bots.js)

Task:

- Keep `debtPolicy` JSON-only for now.
- Preserve the block when an existing bot is edited or saved.
- Do not add dedicated editor fields until the feature leaves experimental mode.

### 3. Runtime bot config

File:

- [`modules/dexbot_class.js`](/home/alex/BTS/Git/DEXBot2/modules/dexbot_class.js)

Task:

- Pass the bot policy through the existing `this.config` object.
- Make the policy available to the worker logic without special side channels.
- If a bot has debt-specific settings, start the credit runtime from `dexbot_class.js` without any extra on/off switch.
- Leave the grid logic unchanged unless a bot explicitly enables debt behavior.

### 4. Signing policy

File:

- [`modules/credential_policy.js`](/home/alex/BTS/Git/DEXBot2/modules/credential_policy.js)

Task:

- Extend the policy validator to understand:
  - `credit_offer_accept`
  - `credit_deal_repay`
  - `credit_deal_update` if needed for future control
  - `call_order_update` for MPA borrow limits
- Update both op allow gates in the file:
  - `ALLOWED_OP_TYPES`
  - `BUILTIN_DEFAULT_POLICY.allowedOps`
- Enforce `maxFeeRate` for credit offers.
- Enforce MPA collateral and debt limits separately.
- Reject any op that exceeds the bot policy before signing.

### 5. Credit workflow runtime in DEXBot2

Files:

- [`modules/dexbot_class.js`](/home/alex/BTS/Git/DEXBot2/modules/dexbot_class.js)
- [`modules/credit_runtime.js`](/home/alex/BTS/Git/DEXBot2/modules/credit_runtime.js)
- [`modules/bot_settings.js`](/home/alex/BTS/Git/DEXBot2/modules/bot_settings.js)
- [`modules/account_bots.js`](/home/alex/BTS/Git/DEXBot2/modules/account_bots.js)
- [`modules/credential_policy.js`](/home/alex/BTS/Git/DEXBot2/modules/credential_policy.js)
- [`profiles/credit_runtime/`](/home/alex/BTS/Git/DEXBot2/profiles)

Task:

- Make the credit workflow native to DEXBot2 so it works without Claw.
- Keep it inside the bot-specific runtime, not `market_adapter`.
- Keep the bot policy attached to each running bot via `this.config`.
- Persist worker state under `profiles/credit_runtime/` with one combined file per bot.
- Track one active call-order state, multiple active credit deals, offer ids, and reborrow state in that worker file.
- Resolve both MPA and all credit deal state from chain data before repay, borrow, or reborrow.
- Keep the grid worker unchanged unless debt behavior is explicitly enabled.

### 6. Optional Claw integration

Files:

- [`claw/modules/chain_actions.js`](/home/alex/BTS/Git/DEXBot2/claw/modules/chain_actions.js)
- [`claw/modules/chain_broadcast.js`](/home/alex/BTS/Git/DEXBot2/claw/modules/chain_broadcast.js)
- [`claw/modules/short_mpa_strategy.js`](/home/alex/BTS/Git/DEXBot2/claw/modules/short_mpa_strategy.js)

Task:

- Reuse the same credit policy model when Claw needs to manage a bot.
- Keep Claw as an optional consumer of the DEXBot2 credit workflow, not the owner.
- If Claw submits credit operations later, route them through the same operation constraints and persisted bot state.
- Keep MPA borrowing on the existing call-order path.

### 7. Claw profile reader

File:

- [`claw/modules/dexbot_profiles.js`](/home/alex/BTS/Git/DEXBot2/claw/modules/dexbot_profiles.js)

Task:

- Preserve and validate `debtPolicy` in the shared bot profile model.
- Add `debtPolicy` to the known-key and nested-validation paths so it is not dropped during normalization.
- Treat Claw as a consumer of the bot policy, not the owner.
- Keep the existing market-making settings unchanged.

## Runtime Rules

### Activation rules

- Do not add a separate runtime enable/disable switch for debt behavior.
- If a bot has `debtPolicy.mpa` settings and a matching live MPA position, the MPA path is fully active.
- If a bot has `debtPolicy.creditOffer` settings and matching live credit offers or credit deals, the credit-offer path is fully active.
- The bot may evaluate both paths independently when both are present.
- `dexbot_class.js` is responsible for starting the credit runtime when the bot config contains debt-specific settings.
- The credit runtime evaluates on the bot’s 4h maintenance cadence, not on a separate always-on loop.

### MPA borrow

- Use the call-order update primitive.
- Read the live collateral ratio and feed price before planning any change.
- Follow a CR-first plan in both directions:
  - when CR is below `minCollateralRatio`, reduce debt first, then add collateral if needed
  - when CR is above `maxCollateralRatio`, increase debt first, then withdraw collateral if needed
- Use the same debt-first adjustment order as the Claw MPA docs, but keep the planner native to DEXBot2.
- Allow only the configured MPA assets and collateral assets.
- Enforce `maxBorrowAmount`, `maxCollateralAmount`, `minCollateralRatio`, `maxCollateralRatio`, and `targetCollateralRatio` when present.
- Treat `minCollateralRatio` as the absolute floor and `maxCollateralRatio` as the absolute ceiling.
- Treat `targetCollateralRatio` as the preferred operating point inside that band.
- If `targetCollateralRatio` is not set, use the midpoint between `minCollateralRatio` and `maxCollateralRatio` when both are present.
- Do not introduce fee fields.

### Credit offer borrow

- Use `credit_offer_accept`.
- Allow only configured offers, debt assets, and collateral assets.
- Derive borrow size from the resolved collateral amount and offer price.
- When a borrow amount is explicit, derive the minimum required collateral from the offer price.
- Enforce `maxBorrowAmount`.
- Enforce `maxFeeRate`.

### Credit offer repay

- Use `credit_deal_repay`.
- Repay each tracked credit deal owned by the bot.
- Do not add new fee configuration for repay beyond the chain’s required credit fee handling.
- After a successful repay, the runtime may reborrow the same deal again when `autoReborrow` is enabled and the offer is still valid.

### Credit deal discovery

- Read credit deal state from chain data before any repay or reborrow action.
- Track each active deal id, offer id, debt asset, collateral asset, and current debt amount.
- Use this state as the source of truth for the worker, not local config alone.
- Sync the discovered state into the persisted worker file under `profiles/credit_runtime/`.

### Auto reborrow

- `autoReborrow` is a bot-side rule, not an on-chain setting.
- `auto_repay` is a separate on-chain credit-deal setting and should not be confused with `autoReborrow`.
- Reborrow only after a successful repay confirmation.
- Reborrow only if the same offer and policy are still valid.
- Reborrow only if collateral and borrow ceilings still pass validation.
- Partial repay auto-reborrow defaults to the amount that was just repaid, not the full previous deal size.

## Credit Runtime API

`modules/credit_runtime.js` should stay small and bot-scoped. It should coordinate policy, chain state, and persisted worker state, but it should not own market adapter logic or signing policy.

Proposed exports:

- `initRuntime(bot)`
  - Bind the runtime to one bot instance.
  - Capture the bot config, logger, chain helpers, and profile path.
- `loadState()`
  - Read the persisted worker file under `profiles/credit_runtime/`.
  - Return an empty default state when no file exists yet.
- `refreshState()`
  - Query chain data for all current credit deals.
  - Reconcile the chain result with the persisted worker state.
- `refreshMpaState()`
  - Query the current call order, collateral ratio, and feed price for the tracked MPA position.
- `resolveTargetCr()`
  - Resolve the active CR target from policy and runtime defaults, falling back to the midpoint of `minCollateralRatio` and `maxCollateralRatio` when no target is set.
- `buildMpaPlan(position)`
  - Produce a debt-first plan that reduces debt or increases debt before collateral adjustment, depending on which side of the CR band the position is on.
- `validateMpaBorrow(request)`
  - Verify that the borrow or adjustment request satisfies the MPA policy and CR target.
- `validateBorrow(request)`
  - Check the request against `debtPolicy.creditOffer` or `debtPolicy.mpa`.
  - Return a reject reason before any signing or broadcast happens.
- `validateRepay(request)`
  - Confirm the repay targets one of the tracked active credit deals.
  - Confirm the repay stays within the bot policy.
- `shouldReborrow()`
  - Return `true` only when `autoReborrow` is enabled, the post-repay state still satisfies policy, and the offer is still available.
- `persistState(reason)`
  - Write the current runtime state back to `profiles/credit_runtime/`.
- `shutdown()`
  - Flush any pending state and stop runtime activity cleanly.

Persisted state fields:

- File layout: one JSON file per bot under `profiles/credit_runtime/` using the bot key as the file name.

- `botKey`
- `updatedAt`
- `activeDealIds`
- `activeOfferIds`
- `debtAssetId`
- `currentDebtAmount`
- `currentCollateralAmount`
- `currentCollateralRatio`
- `targetCollateralRatio`
- `minCollateralRatio`
- `maxCollateralRatio`
- `feedPrice`
- `activeCallOrderId`
- `creditDeals`
  - Array of tracked credit deal records.
- `lastBorrowRequest`
- `lastMpaAction`
- `lastRepayAt`
- `reborrowPending`

## Implementation Order

1. Extend bot config loading and validation to preserve `debtPolicy`.
2. Keep the policy block JSON-only in the editor for the experimental phase.
3. Extend the signing policy layer with the new operation constraints and op allowlists.
4. Add native DEXBot2 credit deal discovery and worker state handling.
5. Add credit operation builders and broadcast helpers.
6. Add Claw profile support so the same bot model can be managed from Claw later.

## Success Criteria

- A bot can declare one debt policy block that covers both MPA and credit offer usage.
- MPA borrow stays fee-free in the bot model.
- The bot has a hard minimum CR floor for MPA actions.
- The bot has a hard minimum and maximum CR band for MPA actions.
- Credit offers are blocked if the offered fee rate exceeds the bot’s `maxFeeRate`.
- The worker can repay and then reborrow when `autoReborrow` is enabled.
- Claw can read the same bot policy without redefining the rules.
