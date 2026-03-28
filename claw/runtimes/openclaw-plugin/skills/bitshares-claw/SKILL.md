---
name: bitshares-claw
description: Use the native BitShares Claw tools registered by the local OpenClaw plugin for market snapshots, HONEST context, MPA planning, and explicit order execution.
---

# BitShares Claw

Use the native `bitshares-claw` plugin tools when the user asks about BitShares automation, DEXBot2 profiles, HONEST assets, MPA borrowing, or order management.

## Safety

- Prefer read and plan tools before execute tools.
- Treat order placement, cancellation, debt adjustment, and settlement as approval-required actions.
- Keep signing and credentials inside DEXBot2.

## Workflow

- Start with `claw_manifest`, `claw_runtime`, `claw_profile_context`, `claw_market_snapshot`, `claw_account_snapshot`, or `claw_open_orders`.
- For HONEST assets, use `claw_honest_context`, `claw_honest_pair`, and `claw_honest_price`.
- For margin workflows, use `claw_build_open_short_plan`, `claw_build_take_profit_plan`, or `claw_build_close_short_plan` before execute tools.
