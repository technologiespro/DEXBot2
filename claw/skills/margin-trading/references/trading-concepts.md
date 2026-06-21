# Trading Concepts

## Positions

### Short Position

Betting that the MPA price (in BTS terms) will decrease.

**Lifecycle:**

1. **Borrow** — Issue MPA debt against BTS collateral (`call_order_update` with positive debt and collateral deltas). Collateral ratio must be in the green zone (CR >= 1.7).
2. **Sell** — Place a limit order selling the borrowed MPA for BTS. As a maker order this incurs 0% fee on HONEST.Assets.
3. **Cover** — Later, buy back the MPA at a lower price to repay the debt.
4. **Close** — Repay the debt (`call_order_update` with negative debt delta) and release the collateral.

Profit comes from the difference between the sell price and the buyback price, denominated in BTS.

**Available operations (claw bridge):**

| Step | Command | Broadcast |
|---|---|---|
| Plan open | `build-open-short-plan` | No |
| Execute open | `open-short-bts` | Yes — borrows + places sell order |
| Plan take-profit | `build-take-profit-plan` | No |
| Execute take-profit | `take-profit-bts` | Yes — places buy order to cover |
| Plan close | `build-close-short-plan` | No |
| Execute close | `close-short-bts` | Yes — repays debt, releases collateral |

### Long Position

Betting that the MPA price (in BTS terms) will increase.

**Lifecycle:**

1. **Buy** — Place a limit order buying the MPA with BTS. As a maker order this incurs 0% fee on HONEST.Assets.
2. **Hold** — Wait for price to move in your favor.
3. **Sell** — Sell the MPA back for BTS at a higher price.

No borrowing or collateral is required for a long position — it is a spot buy.

**Available operations (claw bridge):**

| Step | Command | Broadcast |
|---|---|---|
| Buy | `create-limit-order` | Yes |
| Sell | `create-limit-order` | Yes |
| Modify | `update-limit-order` | Yes |
| Cancel | `cancel-limit-order` | Yes |

## Collateral Management

An open debt position can be adjusted without closing it:

| Action | Command | Effect |
|---|---|---|
| Add collateral | `adjust-mpa-collateral` (positive delta) | Increases CR, reduces liquidation risk |
| Remove collateral | `adjust-mpa-collateral` (negative delta) | Decreases CR, frees BTS |
| Increase debt | `borrow-mpa` | Issues more MPA, decreases CR |
| Repay partial | `repay-mpa` | Reduces debt, increases CR |

Adjustments change the collateral ratio — the position must remain in the green zone (CR >= 1.7). See `references/position-management.md` for CR zones.

## Position Queries

| Query | Command | Returns |
|---|---|---|
| On-chain debt position | `mpa-position` | Debt amount, collateral, CR, feed price |
| Account balances | `account-snapshot` | All balances and open orders |
| Open limit orders | `open-orders` | Active orders with amounts and prices |
| Market state | `market-snapshot` | Order book, ticker, global properties |

## Settlement and Margin Calls

If the collateral ratio drops below MCR (1.4 for HONEST.Assets), the position becomes subject to a margin call. The protocol will match the position against limit orders to cover the debt.

Force settlement allows any holder to settle their MPA at the feed price, subject to settlement delay and offset parameters configured by the asset issuer.

## Batch Operations

Multiple operations can be combined into a single atomic transaction using `execute-batch`. This is useful for simultaneously opening a position and placing a take-profit order, or adjusting multiple positions at once.
