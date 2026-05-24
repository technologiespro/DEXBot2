/**
 * @file DEXBot2 Central Type Definitions
 *
 * Single source of truth for all domain types across the codebase.
 * Every @typedef uses JSDoc syntax, which is parsed by TypeScript
 * during migration and by IDEs for autocomplete in plain JS.
 *
 * Where possible, types align with the BitShares C++ protocol headers
 * at https://github.com/bitshares/bitshares-core
 *
 * ============================================================
 * STRING LITERAL ENUMS
 * ============================================================
 */

/**
 * @typedef {'sell'|'buy'|'spread'} OrderType
 * Side/role of a grid order slot.
 * - sell: quote asset is sold (base received)
 * - buy: base asset is sold (quote received)
 * - spread: neutral slot between buy/sell regions
 */

/**
 * @typedef {'virtual'|'active'|'partial'} OrderState
 * Lifecycle state of a grid order.
 * - virtual: not placed on blockchain
 * - active: on-chain, fully sized
 * - partial: on-chain, partially filled
 */

/**
 * @typedef {'NORMAL'|'REBALANCING'|'BROADCASTING'} RebalanceState
 * Pipeline rebalance lifecycle.
 */

/**
 * @typedef {'create'|'cancel'|'update'} CowActionType
 * Copy-on-Write action discriminant.
 */

/**
 * @typedef {'perBar'|'window'} AmaSlopePercentMode
 * AMA slope percentage calculation mode.
 */

/**
 * @typedef {'immediate'|'batched'|'manual'} ProcessedFillPersistenceMode
 * How processed fills are persisted.
 */

/**
 * @typedef {'no_auto_repayment'|'only_full_repayment'|'allow_partial_repayment'} CreditDealAutoRepay
 * Credit deal auto-repayment policy.
 */

/**
 * @typedef {'pool'|'book'|'ama'|'ama1'|'ama2'|'ama3'|'ama4'|number|null} GridPriceSource
 * Price reference source for grid center calculation.
 */

/**
 * @typedef {'pool'|'book'|number} StartPriceSource
 * Bot start price source.
 */

/**
 * @typedef {0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|48|49|50|51|52|53|54|55|56|57|58|59|60|61|62|63|64|65|66|67|68|69|70|71|72|73|74|75|76|77} OperationTypeId
 * Blockchain operation type IDs matching the fc::static_variant index.
 * See graphene/protocol/operations.hpp for the canonical list.
 *
 * Key values used by DEXBot:
 *   1  = limit_order_create
 *   2  = limit_order_cancel
 *   3  = call_order_update
 *   4  = fill_order (VIRTUAL)
 *   69 = credit_offer_create
 *   70 = credit_offer_delete
 *   71 = credit_offer_update
 *   72 = credit_offer_accept
 *   73 = credit_deal_repay
 *   74 = credit_deal_expired (VIRTUAL)
 *   77 = limit_order_update
 */

/*
 * ============================================================
 * PRIMITIVE BLOCKCHAIN TYPES
 * ============================================================
 */

/**
 * @typedef {Object} Asset
 * An amount of a specific blockchain asset.
 * Matches graphene::protocol::asset (asset.hpp:31-38).
 * @property {number} amount - Integer amount in satoshis (blockchain precision)
 * @property {string} asset_id - Blockchain asset ID, e.g. "1.3.0"
 */

/**
 * @typedef {Object} Price
 * Exchange ratio between two assets.
 * Matches graphene::protocol::price (asset.hpp:108-114).
 * @property {Asset} base - Base asset (being sold)
 * @property {Asset} quote - Quote asset (being purchased)
 */

/**
 * @typedef {Object} PriceFeed
 * Market parameters for margin positions (bitasset feeds).
 * Matches graphene::protocol::price_feed.
 * @property {Price} settlement_price - Forced settlement price
 * @property {Price} core_exchange_rate - CORE exchange rate for fee pool
 * @property {number} maintenance_collateral_ratio - MCR (fixed point, denominator 1000)
 * @property {number} maximum_short_squeeze_ratio - MSSR
 */

/*
 * ============================================================
 * BLOCKCHAIN ORDER STRUCTURES
 * ============================================================
 */

/**
 * @typedef {Object} ChainLimitOrder
 * Raw limit order as returned by the blockchain API.
 * @property {string} id - On-chain object ID, e.g. "1.7.12345"
 * @property {string} seller - Account ID of the order creator
 * @property {number} for_sale - Integer amount for sale
 * @property {Object} sell_price - Price definition
 * @property {Asset} sell_price.base - Base asset
 * @property {Asset} sell_price.quote - Quote asset
 * @property {string} expiration - ISO date string
 * @property {string} [delegated_fee_asset_id]
 * @property {string} [created]
 */

/**
 * @typedef {Object} ParsedChainOrder
 * Normalized order parsed from a chain order object.
 * @property {string} orderId - On-chain order ID
 * @property {number} price - Human-readable float price
 * @property {'buy'|'sell'} type - Inferred order side
 * @property {number} size - Human-readable float size
 */

/**
 * @typedef {Object} FillOperationData
 * Raw fill data from a fill_order_operation (op[1]).
 * Matches graphene::protocol::fill_order_operation (market.hpp:206-233).
 * @property {string} order_id - ID of the order that was filled
 * @property {string} account_id - Account ID of the order owner
 * @property {Asset} pays - What the order paid
 * @property {Asset} receives - What the order received
 * @property {Asset} fee - Fee paid
 * @property {Price} fill_price - Fill price at execution
 * @property {boolean} is_maker - Whether this side was the maker
 */

/**
 * @typedef {Object} FillEvent
 * Raw fill event from blockchain subscription or history query.
 * @property {string} id - History entry ID, e.g. "1.11.xxxxx"
 * @property {number} block_num - Block number where fill occurred
 * @property {[number, FillOperationData]} op - [operation_type, operation_data]
 */

/*
 * ============================================================
 * OPERATION BUILDERS
 * ============================================================
 */

/**
 * @typedef {Object} LimitOrderCreateOp
 * limit_order_create operation builder.
 * Matches graphene::protocol::limit_order_create_operation (market.hpp:72-111).
 * @property {Asset} fee
 * @property {string} seller - Account ID
 * @property {Asset} amount_to_sell
 * @property {Asset} min_to_receive
 * @property {string} expiration - ISO date
 * @property {boolean} fill_or_kill
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} LimitOrderUpdateOp
 * limit_order_update operation builder.
 * Matches graphene::protocol::limit_order_update_operation (market.hpp:117-136).
 * @property {Asset} fee
 * @property {string} seller - Account ID
 * @property {string} order - Order ID to update
 * @property {Price} [new_price]
 * @property {Asset} [delta_amount_to_sell]
 * @property {string} [new_expiration]
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} LimitOrderCancelOp
 * limit_order_cancel operation builder.
 * Matches graphene::protocol::limit_order_cancel_operation (market.hpp:145-157).
 * @property {Asset} fee
 * @property {string} fee_paying_account
 * @property {string} order - Order ID to cancel
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} CallOrderUpdateOp
 * call_order_update operation builder.
 * Matches graphene::protocol::call_order_update_operation (market.hpp:171-197).
 * @property {Asset} fee
 * @property {string} funding_account
 * @property {Asset} delta_collateral
 * @property {Asset} delta_debt
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} AssetSettleOp
 * asset_settle operation builder.
 * @property {Asset} fee
 * @property {string} account
 * @property {Asset} amount
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} TransferOp
 * transfer operation builder.
 * @property {Asset} fee
 * @property {string} from
 * @property {string} to
 * @property {Asset} amount
 * @property {Object} [memo]
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} CreditOfferCreateOp
 * credit_offer_create operation.
 * @property {Asset} fee
 * @property {string} owner_account
 * @property {string} asset_type - Asset ID being offered
 * @property {number} balance - Available amount in satoshis
 * @property {number} fee_rate - Fee rate denominator GRAPHENE_FEE_RATE_DENOM
 * @property {number} max_duration_seconds
 * @property {number} min_deal_amount
 * @property {boolean} enabled
 * @property {number} auto_disable_time - Unix timestamp
 * @property {Object} acceptable_collateral - Map of asset_id -> Price
 * @property {Object} acceptable_borrowers - Map of account_id -> max_amount
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} CreditOfferAcceptOp
 * credit_offer_accept operation.
 * @property {Asset} fee
 * @property {string} borrower
 * @property {string} offer_id
 * @property {Asset} borrow_amount
 * @property {Asset} collateral
 * @property {number} max_fee_rate
 * @property {number} min_duration_seconds
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} CreditDealRepayOp
 * credit_deal_repay operation.
 * @property {Asset} fee
 * @property {string} account
 * @property {string} deal_id
 * @property {Asset} repay_amount
 * @property {Asset} credit_fee
 * @property {Object} [extensions]
 */

/**
 * @typedef {Object} CreatedOperation
 * A blockchain operation with name+data for the signing client.
 * @property {string} op_name - Operation type name, e.g. 'limit_order_create'
 * @property {Object} op_data - Operation-type-specific payload
 */

/*
 * ============================================================
 * CHAIN / BROADCAST RESULT TYPES
 * ============================================================
 */

/**
 * @typedef {Object} BroadcastResult
 * Result of a blockchain transaction broadcast.
 * @property {boolean} success
 * @property {*} [raw] - Raw blockchain response
 * @property {Array} [operation_results]
 */

/**
 * @typedef {Object} CreateOrderResult
 * @property {boolean} [success]
 * @property {boolean} [dryRun]
 * @property {Object} [params]
 * @property {boolean} [skipped] - Amounts rounded to 0
 * @property {*} [raw]
 * @property {Array} [operation_results]
 */

/**
 * @typedef {Object} CancelOrderResult
 * @property {boolean} success
 * @property {string} orderId
 * @property {boolean} verified
 * @property {boolean} [verifiedAfterFailure]
 * @property {*} [raw]
 * @property {Array} [operation_results]
 */

/**
 * @typedef {Object} BatchExecutionResult
 * @property {boolean} success
 * @property {*} raw
 * @property {Array} operation_results
 */

/**
 * @typedef {Object} DaemonExecutionResult
 * @property {boolean} success
 * @property {*|null} raw
 * @property {Array} operation_results
 */

/**
 * @typedef {Object} OnChainBalances
 * @property {string} assetId
 * @property {string} symbol
 * @property {number} precision
 * @property {number} freeRaw - Blockchain integer
 * @property {number} lockedRaw - Blockchain integer
 * @property {number} free - Human-readable float
 * @property {number} locked - Human-readable float
 * @property {number} total - Human-readable float
 */

/*
 * ============================================================
 * DOMAIN: ORDER (DISCRIMINATED UNION)
 * ============================================================
 */

/**
 * @typedef {Object} OrderBase
 * Fields common to all order state variants.
 * @property {string} id - Grid slot identifier, e.g. "slot-0"
 * @property {number} price - Geometric price level (float)
 * @property {OrderType} type - buy / sell / spread
 * @property {OrderState} state - virtual / active / partial
 * @property {number} size - Order amount (float)
 * @property {string|null} orderId - On-chain order ID, null/"" when virtual
 * @property {OrderType} [committedSide] - Persisted side hint for spread orders
 * @property {Object} [rawOnChain] - Cached blockchain integer sizes
 * @property {number} [rawOnChain.for_sale]
 * @property {boolean} [isDustRefill] - Flag for dust refill orders
 * @property {Object} [metadata] - Arbitrary metadata
 * @property {number} [gridIndex] - Index for order comparison equality
 * @property {number} [idealSize] - Target-calculated geometric ideal size
 * @property {string} [sideHint] - Legacy side hint for fallback resolution
 */

/**
 * @typedef {OrderBase & {state: 'virtual', orderId: null|''}} VirtualOrder
 * Off-chain order slot — not placed on blockchain.
 */

/**
 * @typedef {OrderBase & {state: 'active', orderId: string, size: number}} ActiveOrder
 * On-chain order at full size.
 */

/**
 * @typedef {OrderBase & {state: 'partial', orderId: string, size: number}} PartialOrder
 * On-chain order that has been partially filled (size < original).
 */

/**
 * @typedef {VirtualOrder|ActiveOrder|PartialOrder} Order
 * Discriminated union of all order lifecycle states.
 * Spread orders must always be VIRTUAL with size=0.
 * ACTIVE/PARTIAL orders must always have a non-empty orderId.
 */

/**
 * @typedef {Object} FilledOrder
 * Order extended with fill event metadata.
 * @property {number} blockNum - Block number of the fill
 * @property {string} historyId - History entry ID
 * @property {boolean} isMaker - Whether this was the maker side
 * @property {boolean} [isPartial] - Present when partial fill
 * @property {number} [filledSize] - Filled amount (partial fills only)
 * @property {boolean} [isDelayedRotationTrigger]
 */

/**
 * @typedef {Object} FilledPortion
 * Partial fill result from sync engine.
 * @property {number} size - Actual filled amount
 * @property {true} isPartial

 * @property {number} blockNum
 * @property {string} historyId
 * @property {boolean} isMaker
 */

/**
 * @typedef {Object} OrderValidationError
 * @property {string} code - Error code identifier
 * @property {string} message - Human-readable error message
 * @property {boolean} [isFatal]
 * @property {Object} [autoCorrect] - Suggested auto-correction values
 */

/**
 * @typedef {Object} OrderValidationWarning
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {Object} OrderValidationResult
 * @property {boolean} isValid
 * @property {OrderValidationError[]} errors
 * @property {OrderValidationWarning[]} warnings
 * @property {Order|null} normalizedOrder
 */

/**
 * @typedef {Object} PersistenceValidationResult
 * @property {boolean} isValid
 * @property {string|null} reason
 */

/*
 * ============================================================
 * DOMAIN: GRID
 * ============================================================
 */

/**
 * @typedef {Object} GridConfig
 * Configuration passed to createOrderGrid.
 * @property {number} startPrice - Market price / grid center
 * @property {number} minPrice - Lower price bound
 * @property {number} maxPrice - Upper price bound
 * @property {number} incrementPercent - Geometric step percentage (e.g. 0.5 = 0.5%)
 * @property {number} targetSpreadPercent - Target spread width percentage
 * @property {{sell: number, buy: number}} activeOrders - Window size per side
 * @property {{sell: (string|number), buy: (string|number)}} botFunds - "100%" or numeric
 * @property {{sell: number, buy: number}} weightDistribution - Fund allocation ratio
 * @property {GridPriceSource} [gridPrice]
 */

/**
 * @typedef {Object} GridOrderSlot
 * A single slot in the grid before role assignment.
 * @property {string} id
 * @property {number} price
 * @property {OrderType|null} type - Assigned by assignGridRoles
 * @property {'virtual'} state - Always VIRTUAL initially
 * @property {0} size - Always 0 initially
 */

/**
 * @typedef {Object} GridCreationResult
 * @property {GridOrderSlot[]} orders
 * @property {number} boundaryIdx
 * @property {{buy: number, sell: number}} initialSpreadCount
 */

/**
 * @typedef {Object} GridPricingContext
 * Result of grid price initialization.
 * @property {number} gridPrice
 * @property {number} gridPriceOffsetPct
 * @property {number} offsetAdjustedStartPrice
 * @property {number} startPrice
 * @property {number|string} configuredMinPrice
 * @property {number|string} configuredMaxPrice
 * @property {number|null} rangeScalingFactor
 */

/**
 * @typedef {Object} SizingContext
 * @property {number} budget
 * @property {number} precision
 * @property {Object} config
 */

/**
 * @typedef {Object} GridComparisonResult
 * @property {{metric: number, updated: boolean}} buy
 * @property {{metric: number, updated: boolean}} sell
 * @property {number} totalMetric
 */

/**
 * @typedef {Object} DivergenceResult
 * @property {boolean} needsUpdate
 * @property {{updated: boolean, ratio: boolean, rms: boolean, metric: number}} buy
 * @property {{updated: boolean, ratio: boolean, rms: boolean, metric: number}} sell
 * @property {'buy'|'sell'|'both'} orderType
 */

/**
 * @typedef {Object} SpreadCorrectionResult
 * @property {Order[]} ordersToPlace
 * @property {Array<{partialOrder: Order, newSize: number}>} ordersToUpdate
 */

/**
 * @typedef {Object} DustCheckResult
 * @property {boolean} buyDust
 * @property {boolean} sellDust
 * @property {Order[]} buyDustOrders
 * @property {Order[]} sellDustOrders
 */

/**
 * @typedef {Object} SideUpdateFlags
 * @property {boolean} buyUpdated
 * @property {boolean} sellUpdated
 */

/**
 * @typedef {Object} SpreadCheckResult
 * @property {number} ordersPlaced
 * @property {number} partialsMoved
 */

/*
 * ============================================================
 * DOMAIN: FUNDS / ACCOUNTING
 * ============================================================
 */

/**
 * @typedef {Object} SideFunds
 * Per-side fund amounts.
 * @property {number} sell
 * @property {number} buy
 */

/**
 * @typedef {Object} BotFunds
 * Complete fund tracking state from Accountant.
 * @property {SideFunds} chainFree - Free balance on blockchain
 * @property {SideFunds} allocated - Allocated to grid
 * @property {SideFunds} committed - Locked in active orders
 * @property {SideFunds} virtual - Reserved for virtual orders
 * @property {number} btsFeesOwed - Unpaid BTS fees
 */

/**
 * @typedef {Object} AccountTotals
 * Raw account balance totals from blockchain.
 * @property {number|null} buy - Total BUY asset balance
 * @property {number|null} sell - Total SELL asset balance
 * @property {number|null} buyFree - Free BUY (not in any order)
 * @property {number|null} sellFree - Free SELL (not in any order)
 */

/**
 * @typedef {Object} BalanceAdjustment
 * @property {'buy'|'sell'} orderType - Which side was affected
 * @property {number} delta - Change amount
 * @property {string} operation - Operation name, e.g. 'fill-pays', 'fill-receives'
 */

/**
 * @typedef {Object} TargetGridValidation
 * @property {boolean} isValid
 * @property {{buy: number, sell: number}} shortfall
 * @property {{requiredBuy: number, requiredSell: number, totalBuy: number, totalSell: number}} details
 */

/**
 * @typedef {Object} ChainFundsSnapshot
 * @property {number} chainTotalBuy
 * @property {number} chainTotalSell
 * @property {number} allocatedBuy
 * @property {number} allocatedSell
 */

/*
 * ============================================================
 * DOMAIN: COPY-ON-WRITE (COW)
 * ============================================================
 */

/**
 * @typedef {Object} CowCreateAction
 * @property {'create'} type
 * @property {string} id - Grid slot ID
 * @property {Order} order
 */

/**
 * @typedef {Object} CowCancelAction
 * @property {'cancel'} type
 * @property {string} id - Grid slot ID
 * @property {string} orderId - Blockchain order ID
 * @property {string} [reason]
 */

/**
 * @typedef {Object} CowUpdateAction
 * @property {'update'} type
 * @property {string} id - Source grid slot ID (surplus slot)
 * @property {string} orderId - Existing blockchain order ID
 * @property {string} newGridId - Target grid slot ID (hole)
 * @property {number} newSize
 * @property {number} newPrice
 * @property {Order} order
 * @property {boolean} isRotation
 */

/**
 * @typedef {CowCreateAction|CowCancelAction|CowUpdateAction} CowAction
 * Discriminated union of all COW delta actions.
 */

/**
 * @typedef {Object} DeltaAction
 * Simplified delta action from buildDelta.
 * @property {'create'|'cancel'|'update'} type
 * @property {string} id
 * @property {Order} [order]
 * @property {string} [orderId]
 * @property {Order} [prevOrder]
 */

/**
 * @typedef {Object} StateUpdate
 * Modified order fields after a COW action.
 * @property {string} id
 * @property {'virtual'} [state] - For creates, forces VIRTUAL
 * @property {null} [orderId] - For creates, clears orderId
 * @property {'spread'} [type] - For cancels, converts to spread
 * @property {0} [size] - For cancels, zeros size
 * @property {number} [size] - For updates, new size
 */

/**
 * @typedef {Object} ActionSummary
 * @property {number} total
 * @property {number} creates
 * @property {number} cancels
 * @property {number} updates
 */

/**
 * @typedef {Object} CowRebalanceSuccessResult
 * @property {CowAction[]} actions
 * @property {StateUpdate[]} stateUpdates
 * @property {boolean} hadRotation
 * @property {WorkingGrid} workingGrid
 * @property {GridIndexes} workingIndexes
 * @property {number} workingBoundary
 * @property {number} planningDuration
 * @property {false} aborted
 */

/**
 * @typedef {Object} CowRebalanceAbortedResult
 * @property {[]} actions
 * @property {[]} stateUpdates
 * @property {false} hadRotation
 * @property {null} workingGrid
 * @property {null} workingIndexes
 * @property {null} workingBoundary
 * @property {0} planningDuration
 * @property {true} aborted
 * @property {string} reason
 */

/**
 * @typedef {CowRebalanceSuccessResult|CowRebalanceAbortedResult} CowRebalanceResult
 * Result of a COW rebalance evaluation.
 */

/**
 * @typedef {Object} ReconcileResult
 * @property {CowAction[]} actions
 * @property {false} aborted
 * @property {number} boundaryIdx
 * @property {ActionSummary} summary
 */

/**
 * @typedef {Object} CommitEvalResult
 * @property {boolean} canCommit
 * @property {string} [reason]
 * @property {'error'|'warn'|'debug'} [level]
 */

/**
 * @typedef {Object} DriftCheckResult
 * @property {boolean} isValid
 * @property {number} driftBuy
 * @property {number} driftSell
 * @property {number} allowedDriftBuy
 * @property {number} allowedDriftSell
 * @property {string|null} reason
 */

/**
 * @typedef {Object} FundValidationResult
 * @property {boolean} isValid
 * @property {string|null} reason
 * @property {Array<{asset: string, required: number, available: number, deficit: number}>} shortfalls
 * @property {{buyInt: number, sellInt: number, buy: number, sell: number}} required
 * @property {{buy: number, sell: number}} available
 */

/**
 * @typedef {Object} BootstrapResult
 * @property {boolean} hadDrift
 * @property {DriftCheckResult|null} driftInfo
 */

/*
 * ============================================================
 * DOMAIN: WORKING GRID / INDEXES
 * ============================================================
 */

/**
 * @typedef {Object} WorkingGrid
 * Copy-on-Write working copy of the master grid.
 * @property {Map<string, Order>} grid - The working order map
 * @property {Set<string>} modified - Tracked modified order IDs
 * @property {number} baseVersion - Master version at clone time
 * @property {boolean} _stale - Stale flag
 * @property {string|null} _staleReason
 * @property {GridIndexes|null} _indexes - Lazy-built indexes
 */

/**
 * @typedef {Object} GridIndexes
 * Helper index sets for fast order lookups.
 * @property {Set<string>} virtual
 * @property {Set<string>} active
 * @property {Set<string>} partial
 * @property {Set<string>} filled
 * @property {Set<string>} buy
 * @property {Set<string>} sell
 * @property {Set<string>} spread
 */

/**
 * @typedef {Object} MemoryStats
 * @property {number} size - Grid size
 * @property {number} modified - Modified count
 * @property {number} estimatedBytes - Estimated memory usage
 */

/**
 * @typedef {Object} IndexValidationResult
 * @property {boolean} valid
 * @property {string[]} errors
 */

/*
 * ============================================================
 * DOMAIN: STRATEGY / TARGET GRID
 * ============================================================
 */

/**
 * @typedef {Object} TargetGridEntry
 * A strategy-calculated target for a grid slot.
 * @property {string} id
 * @property {number} price
 * @property {OrderType} type
 * @property {number} size
 * @property {number} idealSize - Target geometric ideal size
 * @property {OrderState} state - ACTIVE if size>0, VIRTUAL if 0
 * @property {OrderType} [committedSide]
 */

/*
 * ============================================================
 * DOMAIN: SYNC ENGINE
 * ============================================================
 */

/**
 * @typedef {Object} SyncResult
 * Result from syncFromOpenOrders.
 * @property {Order[]} filledOrders - Orders that completed
 * @property {Order[]} updatedOrders - All modified orders
 * @property {PriceCorrectionEntry[]} ordersNeedingCorrection - Orders with price slippage
 */

/**
 * @typedef {Object} FillHistoryResult
 * Result from syncFromFillHistory.
 * @property {Order[]} filledOrders
 * @property {Order[]} updatedOrders
 * @property {boolean} partialFill
 * @property {boolean} [requiresOpenOrdersSync] - When fillKey was missing
 */

/**
 * @typedef {Object} SynchronizeResult
 * @property {Order[]} newOrders
 * @property {PriceCorrectionEntry[]} ordersNeedingCorrection
 */

/**
 * @typedef {Object} PriceCorrectionEntry
 * @property {Order} gridOrder
 * @property {string} chainOrderId
 * @property {number} expectedPrice
 * @property {number} actualPrice
 * @property {number} size
 * @property {'buy'|'sell'} type
 * @property {boolean} [typeMismatch]
 * @property {boolean} [isSurplus]
 * @property {string} [sideUpdated]
 */

/**
 * @typedef {Object} ChainCreateOrderData
 * @property {string} gridOrderId
 * @property {string} chainOrderId
 * @property {boolean} isPartialPlacement
 * @property {string} [expectedType]
 * @property {number} fee
 * @property {boolean} [skipAccounting]
 */

/**
 * @typedef {Object} ChainCancelOrderData
 * @property {string} orderId
 * @property {boolean} [clearSize]
 */

/*
 * ============================================================
 * DOMAIN: STATE MANAGER / PIPELINE
 * ============================================================
 */

/**
 * @typedef {Object} SignalEntry
 * @property {string} id
 * @property {string} context
 * @property {string} message
 * @property {number} at - Timestamp
 */

/**
 * @typedef {Object} AccountingFailureSignal
 * @property {'ACCOUNTING_COMMITMENT_FAILED'} code
 * @property {'buy'|'sell'} side
 * @property {number} amount
 * @property {string} context
 * @property {number} at
 */

/**
 * @typedef {Object} GridRegenSideState
 * @property {boolean} armed
 * @property {number} lastTriggeredAt
 */

/**
 * @typedef {Object} RebalanceState
 * @property {RebalanceState} state
 * @property {WorkingGrid|null} currentWorkingGrid
 */

/**
 * @typedef {Object} RecoveryState
 * @property {number} attemptCount
 * @property {number} lastAttemptAt
 * @property {boolean} inFlight
 * @property {number} lastFailureAt
 */

/**
 * @typedef {Object} StateManagerState
 * @property {RebalanceState} rebalance
 * @property {RecoveryState} recovery
 * @property {{buy: GridRegenSideState, sell: GridRegenSideState}} gridRegen
 * @property {{isBootstrapping: boolean}} bootstrap
 * @property {{isBroadcasting: boolean}} broadcast
 * @property {{lastIllegalState: SignalEntry|null, lastAccountingFailure: AccountingFailureSignal|null}} signals
 * @property {{blockedSince: number|null, recoveryAttempted: boolean}} pipeline
 */

/**
 * @typedef {Object} Metrics
 * @property {number} fundRecalcCount
 * @property {{buy: number, sell: number}} invariantViolations
 * @property {number} lockAcquisitions
 * @property {number} lockContentionSkips
 * @property {number} spreadRoleConversionBlocked
 * @property {number} lastSyncDurationMs
 * @property {number} metricsStartTime
 * @property {StateManagerState} state
 * @property {number} currentTime
 */

/**
 * @typedef {Object} PipelineHealth
 * @property {boolean} isBlocked
 * @property {number} blockedDurationMs
 * @property {boolean} hasStalled
 * @property {boolean} recoveryAttempted
 * @property {number} correctionsPending
 * @property {number} gridSidesUpdated
 */

/**
 * @typedef {Object} PipelineEmptyResult
 * @property {boolean} isEmpty
 * @property {string[]} reasons
 */

/**
 * @typedef {Object} PipelineSignals
 * @property {number} [incomingFillQueueLength]
 * @property {number} [shadowLocks]
 * @property {boolean} [batchInFlight]
 * @property {boolean} [retryInFlight]
 * @property {boolean} [recoveryInFlight]
 * @property {boolean} [broadcasting]
 */

/**
 * @typedef {Object} OrderUpdateOptions
 * @property {boolean} [skipAccounting]
 * @property {number} [fee]
 */

/**
 * @typedef {Object} CommitOptions
 * @property {boolean} [skipRecalc]
 */

/**
 * @typedef {Object} CowComparePrecisions
 * @property {number} buyPrecision
 * @property {number} sellPrecision
 * @property {number} priceRelativeTolerance
 */

/*
 * ============================================================
 * DOMAIN: STARTUP RECONCILE
 * ============================================================
 */

/**
 * @typedef {Object} StartupGridAction
 * @property {boolean} shouldRegenerate
 * @property {boolean} hasActiveMatch
 * @property {boolean} resumedByPrice
 * @property {number} matchedCount
 */

/**
 * @typedef {Object} PriceMatchResumeResult
 * @property {boolean} resumed
 * @property {number} matchedCount
 */

/**
 * @typedef {Object} StartupReconcileSideResult
 * @property {number} chainCount
 */

/**
 * @typedef {Object} StartupUpdateBatchResult
 * @property {boolean} executed
 * @property {number} prepared
 * @property {boolean} skipped
 */

/**
 * @typedef {Object} StartupSequentialUpdateResult
 * @property {number} executed
 * @property {number} skipped
 * @property {number} failed
 */

/*
 * ============================================================
 * DOMAIN: FILL PROCESSING / RUNTIME
 * ============================================================
 */

/**
 * @typedef {Object} ReplaySafeFillResult
 * @property {'applied'|'duplicate'|'missing_key'|'error'} status
 * @property {string|null} fillKey
 * @property {boolean} [usedFallbackKey]
 * @property {Error} [error]
 */

/**
 * @typedef {Object} SyntheticFill
 * Synthetic fill event from dust cancel / rotation triggers.
 * @property {boolean} isPartial
 * @property {boolean} [isDelayedRotationTrigger]
 * @property {number} [dustCancelTriggeredAt]
 * @property {boolean} [dustRecoveredFromChain]
 */

/**
 * @typedef {Object} BotsConfigSnapshot
 * @property {boolean} exists
 * @property {string|null} fingerprint - SHA1 hex
 * @property {Object} [config] - Parsed bots.json
 * @property {BotConfigEntry[]} activeBots
 * @property {boolean} needsMarketAdapter
 */

/**
 * @typedef {Object} DynamicWeightRefreshResult
 * @property {boolean} applied
 * @property {'static'|'dynamic'} source
 * @property {{sell: number, buy: number}|null} weightDistribution
 * @property {string|null} [snapshotUpdatedAt]
 */

/**
 * @typedef {Object} GridResyncMetadata
 * @property {boolean} shouldRefreshCenterPrice
 * @property {string} centerRefreshContext
 * @property {string} centerRefreshLabel
 * @property {string} resetSource
 * @property {*} [payload]
 */

/**
 * @typedef {Object} GridResyncOptions
 * @property {boolean} refreshCenterPrice
 * @property {string} [centerRefreshContext]
 * @property {string} [centerRefreshLabel]
 * @property {string} [resetSource]
 */

/**
 * @typedef {Object} DustCancelResult
 * @property {number} cancelledCount
 * @property {{abortedForIllegalState: boolean, abortedForAccountingFailure: boolean}|null} batchResult
 */

/**
 * @typedef {Object} MarketAdapterSyncResult
 * @property {boolean} changed
 * @property {boolean} required
 * @property {boolean} running
 * @property {boolean} started
 * @property {boolean} stopped
 * @property {'direct'|'pm2'} mode
 * @property {boolean} [skipped]
 * @property {string} [reason]
 * @property {string} [error]
 */

/**
 * @typedef {Object} MarketAdapterReleaseResult
 * @property {boolean} released
 * @property {'direct'|'pm2'} mode
 * @property {string} [reason]
 * @property {string} [context]
 */

/*
 * ============================================================
 * DOMAIN: ASSET INFO
 * ============================================================
 */

/**
 * @typedef {Object} AssetInfo
 * @property {string} id - Blockchain asset ID, e.g. "1.3.0"
 * @property {string} symbol - Human-readable symbol, e.g. "BTS"
 * @property {number} precision - Decimal places, e.g. 5
 */

/**
 * @typedef {Object} AssetsPair
 * @property {AssetInfo} assetA - Base asset
 * @property {AssetInfo} assetB - Quote asset
 */

/*
 * ============================================================
 * DOMAIN: CONFIGURATION
 * ============================================================
 */

/**
 * @typedef {Object} BotConfigEntry
 * Single bot entry from bots.json.
 * @property {string} name
 * @property {boolean} active
 * @property {boolean} dryRun
 * @property {string} preferredAccount
 * @property {string} assetA
 * @property {string} assetB
 * @property {StartPriceSource} startPrice
 * @property {number|string} minPrice - "Nx" multiplier or numeric
 * @property {number|string} maxPrice - "Nx" multiplier or numeric
 * @property {number} incrementPercent
 * @property {number} targetSpreadPercent
 * @property {{sell: number, buy: number}} weightDistribution
 * @property {{sell: (string|number), buy: (string|number)}} botFunds
 * @property {{sell: number, buy: number}} activeOrders
 * @property {GridPriceSource} gridPrice
 * @property {number} [gridPriceOffsetPct]
 * @property {DebtPolicy} [debtPolicy]
 */

/**
 * @typedef {Object} DEXBotConfig
 * Merged bot configuration with runtime-derived fields.
 * @property {string} botKey
 * @property {number} [botIndex]
 * @property {string} name
 * @property {boolean} active
 * @property {boolean} dryRun
 * @property {string} preferredAccount
 * @property {string} assetA
 * @property {string} assetB
 * @property {StartPriceSource} startPrice
 * @property {number|string} minPrice
 * @property {number|string} maxPrice
 * @property {number} incrementPercent
 * @property {number} targetSpreadPercent
 * @property {{sell: number, buy: number}} weightDistribution
 * @property {{sell: (string|number), buy: (string|number)}} botFunds
 * @property {{sell: number, buy: number}} activeOrders
 * @property {GridPriceSource} gridPrice
 * @property {number} [gridPriceOffsetPct]
 * @property {BotAmaConfig} [ama]
 * @property {DebtPolicy} [debtPolicy]
 * @property {Object} [marketAdapterSettings]
 * @property {Object} [TIMING]
 */

/**
 * @typedef {Object} BotAmaConfig
 * AMA preset overrides per bot.
 * @property {boolean} enabled
 * @property {number} erPeriod
 * @property {number} fastPeriod
 * @property {number} slowPeriod
 * @property {number} erSmoothPeriod
 */

/**
 * @typedef {Object} DebtPolicy
 * Credit offer / lending configuration for a bot.
 * @property {DebtPolicyLendingEntry[]} lending
 */

/**
 * @typedef {Object} DebtPolicyLendingEntry
 * @property {'creditOffer'} type
 * @property {string} asset
 * @property {string} collateralAsset
 * @property {number} ratio
 * @property {boolean} renewOnly
 * @property {number} maxCollateralRatio
 * @property {number} maxFeeRatePerDay
 * @property {boolean} autoReborrow
 * @property {number} autoRepay
 * @property {string[]} allowedOfferIds
 */

/**
 * @typedef {Object} BotsFile
 * @property {BotConfigEntry[]} bots
 */

/**
 * @typedef {Object} GeneralSettings
 * @property {string} [LOG_LEVEL]
 * @property {Object} [GRID_LIMITS]
 * @property {Object} [TIMING]
 * @property {Object} [UPDATER]
 * @property {Object} [MARKET_ADAPTER]
 * @property {Object} [LOGGING_CONFIG]
 * @property {Object} [NATIVE_CLIENT]
 * @property {Object} [FILL_PROCESSING]
 * @property {Object} [PIPELINE_TIMING]
 * @property {Object} [DEFAULT_CONFIG]
 */

/*
 * ============================================================
 * DOMAIN: KEY MANAGEMENT
 * ============================================================
 */

/**
 * @typedef {Object} KeysFile
 * @property {number} vaultVersion
 * @property {string} vaultSalt - Hex-encoded salt
 * @property {string} vaultVerifier - Hex-encoded HMAC verifier
 * @property {string} [masterPasswordHash] - Legacy v1
 * @property {Object<string, {encryptedKey: string}>} accounts
 */

/**
 * @typedef {Object} VaultSecret
 * @property {'dexbot-vault-secret'} kind
 * @property {number} version
 * @property {string} vaultKeyHex
 */

/**
 * @typedef {Object} SessionSecret
 * @property {'dexbot-session-secret'} kind
 * @property {number} version
 * @property {string} sessionSaltHex
 * @property {string} vaultKeyHex
 */

/**
 * @typedef {Object} DaemonSigningToken
 * @property {'dexbot-daemon-signing-token'} kind
 * @property {string} accountName
 * @property {string} socketPath
 * @property {string|null} sessionId
 * @property {string|null} botHmacSecret
 */

/**
 * @typedef {Object} KeyValidationResult
 * @property {boolean} valid
 * @property {string} [reason]
 */

/*
 * ============================================================
 * DOMAIN: MARKET ADAPTER
 * ============================================================
 */

/**
 * @typedef {Object} MarketAdapterConfig
 * @property {number} pollSeconds
 * @property {number} deltaThresholdPercent
 * @property {number} amaSlopeDeltaThresholdPercent
 * @property {number} intervalSeconds
 * @property {number} bootstrapLookbackHours
 * @property {number} nativeBackfillHours
 * @property {number} maxStaleHours
 * @property {number} sourceRetries
 * @property {number} retryDelayMs
 * @property {number} kibanaRequestTimeoutMs
 * @property {boolean} metricsJson
 * @property {boolean} quiet
 * @property {boolean} dryRun
 * @property {boolean} whitelistAll
 * @property {number} maxPages
 * @property {number} pageLimit
 * @property {boolean} once
 * @property {number} maxNativeGapFillCandles
 * @property {number} staleTailThreshold
 * @property {{lookbackBars: number, maxSlopePct: number, neutralZonePct: number}} amaSlope
 * @property {{maxSlopePct: number}} kalmanSlope
 * @property {number} atrPeriod
 * @property {Function} [onTrigger]
 */

/**
 * @typedef {Object} AmaSlopeSnapshot
 * @property {number} slopePct - Raw AMA slope percentage
 * @property {number} amaSlopeGated - Clipped slope
 * @property {number} rawSlopeOffset
 * @property {number} maxSlopeOffset
 * @property {number} slopeRatio - 0..1 normalized
 * @property {'UP'|'DOWN'|'NEUTRAL'} trend
 * @property {1|-1|0} direction
 * @property {number} [smoothedSlopePct]
 * @property {number} [regimeMultiplier]
 * @property {string} [trendLabel]
 * @property {string} [amaSlopePercentMode]
 */

/**
 * @typedef {Object} DynamicWeightsPayload
 * @property {boolean} isReady
 * @property {{sell: number, buy: number}} [effectiveWeights]
 * @property {Object} [meta]
 * @property {number} [meta.finalOffset]
 * @property {number} [meta.slopeOffset]
 * @property {number} [meta.maxSlopeOffset]
 * @property {string} [meta.trend]
 * @property {number} [meta.signalStrength]
 * @property {number} [meta.atr]
 * @property {number} [meta.volatilityPenalty]
 * @property {string} [profile]
 */

/**
 * @typedef {Object} GridPriceOffsetPlan
 * @property {'UP'|'DOWN'|'NEUTRAL'} trend
 * @property {number|null} rawSlopeOffset
 * @property {number|null} maxSlopeOffset
 * @property {number} slopeRatio - 0..1
 * @property {number} targetSpreadPercent
 * @property {number} maxGridPriceOffsetPct
 * @property {number} gridPriceOffsetPct - Final signed offset
 */

/**
 * @typedef {Object} BotState
 * Per-bot state in market_adapter_state.json.
 * @property {string} botName
 * @property {string} botKey
 * @property {'pool'|'book'|null} marketSource
 * @property {'market'|'fixed'|null} priceMode
 * @property {string|null} lastCycleSource
 * @property {string|null} lastCycleAt
 * @property {boolean} pendingClosedCandle
 * @property {string|null} lastTriggerSuppressedReason
 * @property {string|null} poolId
 * @property {string|null} candleFile
 * @property {number} candleCount
 * @property {number} analysisCandleCount
 * @property {number} kibanaGapRepairCount
 * @property {number} kibanaBackfillCount
 * @property {number} unresolvedGapCount
 * @property {number[]} nativeRecentTradeSequences
 * @property {number|null} nativeLastTradeTs
 * @property {number|null} nativeOverlapCount
 * @property {number|null} nativePagesFetched
 * @property {number|null} lastCandleTs
 * @property {number|null} rawLastCandleTs
 * @property {number|null} lastClosedCandleTs
 * @property {number|null} gridCenterPrice
 * @property {number|null} centerPrice
 * @property {number|null} amaCenterPrice
 * @property {{erPeriod: number, fastPeriod: number, slowPeriod: number, erSmoothPeriod: number}|null} amaConfig
 * @property {number|null} atr
 * @property {number|null} weightVariance
 * @property {DynamicWeightsPayload|null} weights
 * @property {{sell: number, buy: number}|null} effectiveWeights
 * @property {*} collateralRecommendation
 * @property {AmaSlopeSnapshot|null} amaSlope
 * @property {number|null} amaSlopeDeltaPercent
 * @property {number|null} amaSlopeThresholdPercent
 * @property {number} rawKeepCount
 * @property {number} analysisKeepCount
 * @property {number} amaWarmupBars
 * @property {boolean} staleData
 * @property {number|null} staleAgeHours
 * @property {boolean} [dynamicWeightWhitelisted]
 * @property {boolean} [gridRangeScalingWhitelisted]
 * @property {boolean} [dynamicWeightReady]
 * @property {string|null} [dynamicWeightProfile]
 * @property {boolean} [dynamicWeightApplied]
 * @property {boolean} [hasExplicitBaseWeights]
 */

/**
 * @typedef {Object} ProcessBotResult
 * Result of a single bot cycle in market_adapter_service.
 * @property {boolean} ok
 * @property {string[]} dryRunMessages
 * @property {string} source
 * @property {'pool'|'book'} marketSource
 * @property {number} intervalSeconds
 * @property {number} candleCount
 * @property {number} analysisCandleCount
 * @property {number} rawKeepCount
 * @property {number} analysisKeepCount
 * @property {number} amaWarmupBars
 * @property {number} kibanaGapRepairCount
 * @property {number} kibanaBackfillCount
 * @property {number} unresolvedGapCount
 * @property {number[]} nativeRecentTradeSequences
 * @property {number|null} nativeLastTradeTs
 * @property {number|null} nativeOverlapCount
 * @property {number|null} nativePagesFetched
 * @property {number|null} amaPrice
 * @property {number|null} previousCenterPrice
 * @property {number|null} deltaPercent
 * @property {number|null} thresholdPercent
 * @property {number|null} referencePrice
 * @property {Array} amaComparison
 * @property {boolean} triggered
 * @property {string|null} triggerPath
 * @property {boolean} staleData
 * @property {number|null} staleAgeHours
 * @property {string|null} triggerCallbackError
 * @property {string|null} triggerSuppressedReason
 * @property {DynamicWeightsPayload|null} weights
 * @property {*} collateralRecommendation
 * @property {AmaSlopeSnapshot|null} amaSlope
 * @property {number|null} amaSlopeDeltaPercent
 * @property {number|null} amaSlopeThresholdPercent
 * @property {boolean} dynamicWeightWhitelisted
 * @property {boolean} gridRangeScalingWhitelisted
 * @property {boolean} dynamicWeightReady
 * @property {string|null} dynamicWeightProfile
 * @property {boolean} dynamicWeightApplied
 * @property {boolean} hasExplicitBaseWeights
 * @property {string|null} poolId
 * @property {string} candleFile
 * @property {number|null} lastCandleTs
 * @property {number|null} rawLastCandleTs
 * @property {number|null} lastClosedCandleTs
 * @property {number|null} lastClosedCandleClose
 * @property {number} centerPrice
 * @property {{erPeriod: number, fastPeriod: number, slowPeriod: number, erSmoothPeriod: number}} amaConfig
 * @property {number|null} atr
 * @property {number|null} weightVariance
 * @property {boolean} pendingClosedCandle
 * @property {string} [reason] - Present when ok === false
 */

/**
 * @typedef {[number, number, number, number, number, number]} Candle
 * OHLCV candle tuple: [timestamp_ms, open, high, low, close, volume]
 */

/**
 * @typedef {Object} TriggerFilePayload
 * @property {string} createdAt - ISO timestamp
 * @property {string} source
 * @property {string} botName
 * @property {string} botKey
 * @property {number} [price]
 * @property {number} [amaPrice]
 * @property {number} [previousCenterPrice]
 * @property {number} [deltaPercent]
 * @property {number} [thresholdPercent]
 * @property {string} [dynamicGridPath]
 */

/**
 * @typedef {Object} DynamicGridSnapshot
 * @property {number} gridCenterPrice
 * @property {number} centerPrice
 * @property {number} amaCenterPrice
 * @property {'perBar'} amaSlopePercentMode
 * @property {string} updatedAt
 * @property {string} source
 * @property {AmaSlopeSnapshot} [amaSlope]
 * @property {AmaSlopeSnapshot} [gridRangeScalingAmaSlope]
 * @property {number} [gridPriceOffsetPct]
 * @property {number} [amaSlopeDeltaPercent]
 * @property {number} [amaSlopeThresholdPercent]
 * @property {DynamicWeightsPayload} [dynamicWeights]
 * @property {string} [lastGridResetAt]
 * @property {string} [lastGridResetSource]
 */

/**
 * @typedef {Object} CenterSnapshot
 * @property {string} updatedAt
 * @property {Object<string, CenterSnapshotBotEntry>} bots
 */

/**
 * @typedef {Object} CenterSnapshotBotEntry
 * @property {string} botName
 * @property {number} gridCenterPrice
 * @property {number} centerPrice
 * @property {number|null} amaCenterPrice
 * @property {string|null} lastGridResetAt
 * @property {string|null} lastGridResetSource
 * @property {number|null} lastAmaPrice
 * @property {number|null} lastDeltaPercent
 * @property {number|null} amaSlopeDeltaPercent
 * @property {number|null} amaSlopeThresholdPercent
 * @property {string} amaSlopePercentMode
 * @property {*} gridRangeScalingAmaSlope
 * @property {*} weights
 * @property {*} effectiveWeights
 * @property {*} collateralRecommendation
 * @property {*} amaSlope
 * @property {*} atr
 */

/*
 * ============================================================
 * DOMAIN: PROCESSED FILL STORE
 * ============================================================
 */

/**
 * @typedef {Object} ProcessedFillStoreConfig
 * @property {number} [batchMs]
 * @property {number} [batchSize]
 * @property {Function} [warn]
 */

/*
 * ============================================================
 * DOMAIN: DEXBot CLASS
 * ============================================================
 */

/**
 * @typedef {Object} DEXBotMetrics
 * @property {number} fillsProcessed
 * @property {number} fillProcessingTimeMs
 * @property {number} batchesExecuted
 * @property {number} lockContentionEvents
 * @property {number} maxQueueDepth
 */

/**
 * @typedef {Object} DEXBotState
 * @property {Object} config
 * @property {string|null} account
 * @property {string|null} accountId
 * @property {*} privateKey
 * @property {*} manager
 * @property {*} accountOrders
 * @property {Map} _recentlyQueuedFills
 * @property {Map} _recentlyProcessedFills
 * @property {Map} _pendingProcessedFillWrites
 * @property {Array} _incomingFillQueue
 * @property {Map} _staleCleanedOrderIds
 * @property {DEXBotMetrics} _metrics
 * @property {boolean} _shuttingDown
 * @property {boolean} _batchInFlight
 * @property {boolean} _batchRetryInFlight
 * @property {boolean} _recoverySyncInFlight
 * @property {number} _maintenanceCooldownCycles
 * @property {number} _lastGridActivityAt
 * @property {Map} _dustSinceMap
 * @property {boolean} _mainLoopActive
 */

/*
 * ============================================================
 * DOMAIN: ACCOUNT ORDERS (PERSISTENCE)
 * ============================================================
 */

/**
 * @typedef {Object} SerializedGridEntry
 * @property {string|null} id
 * @property {string|null} type
 * @property {string|null} state
 * @property {number} price
 * @property {number} size
 * @property {string} orderId - Empty string when no orderId
 */

/**
 * @typedef {Object} BotMeta
 * @property {string} key
 * @property {string|null} name
 * @property {string|null} assetA
 * @property {string|null} assetB
 * @property {boolean} active
 * @property {number|null} index
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} PerBotStorage
 * @property {BotMeta} meta
 * @property {SerializedGridEntry[]} grid
 * @property {number} btsFeesOwed
 * @property {number|null} boundaryIdx
 * @property {AssetsPair|null} assets
 * @property {Object|null} debugInputs
 * @property {Object<string, number>} processedFills - fillKey -> timestamp
 * @property {string} createdAt
 * @property {string} lastUpdated
 */

/**
 * @typedef {Object} DBAssetBalances
 * @property {{active: number, virtual: number}} assetA
 * @property {{active: number, virtual: number}} assetB
 * @property {{key: string, name: string|null, assetA: string|null, assetB: string|null}} meta
 */

/*
 * ============================================================
 * DOMAIN: GRACEFUL SHUTDOWN
 * ============================================================
 */

/**
 * @typedef {Object} CleanupHandler
 * @property {string} name
 * @property {Function} handler
 */

/**
 * @typedef {Object} ShutdownState
 * @property {CleanupHandler[]} cleanupHandlers
 * @property {boolean} shutdownInProgress
 */

/*
 * ============================================================
 * DOMAIN: CREDIT RUNTIME
 * ============================================================
 */

/**
 * @typedef {Object} CreditDeal
 * Blockchain credit deal object.
 * @property {string} id - Deal ID
 * @property {string} offer_id - Credit offer ID
 * @property {string} borrower - Account ID
 * @property {Asset} borrow_amount
 * @property {Asset} collateral
 * @property {number} fee_rate
 * @property {number} expiration - Timestamp
 * @property {number} auto_repay - Auto-repay policy code
 */

/**
 * @typedef {Object} CreditOffer
 * Blockchain credit offer object.
 * @property {string} id
 * @property {string} owner_account
 * @property {string} asset_type
 * @property {number} balance - Available in satoshis
 * @property {number} fee_rate
 * @property {number} max_duration_seconds
 * @property {number} min_deal_amount
 * @property {boolean} enabled
 * @property {number} auto_disable_time
 * @property {Object<string, Price>} acceptable_collateral
 * @property {Object<string, number>} acceptable_borrowers
 */

/*
 * ============================================================
 * DOMAIN: NODE MANAGER
 * ============================================================
 */

/**
 * @typedef {Object} NodeHealth
 * @property {string} url
 * @property {boolean} connected
 * @property {number} latency - Ping latency in ms
 * @property {number} lastChecked - Timestamp
 * @property {number} failCount - Consecutive failure count
 * @property {number} [blacklistedUntil] - Timestamp if blacklisted
 */

/*
 * ============================================================
 * DOMAIN: CHAIN KEYS CRYPTO
 * ============================================================
 */

/**
 * @typedef {Object} DaemonRequest
 * @property {'private-key'|'probe-account'} type
 * @property {string} accountName
 */

/**
 * @typedef {Object} DaemonPrivateKeyResponse
 * @property {boolean} success
 * @property {string} [privateKey]
 * @property {string} [error]
 */

/**
 * @typedef {Object} DaemonProbeResponse
 * @property {boolean} success
 * @property {string} [sessionId]
 * @property {string} [error]
 */

/*
 * ============================================================
 * DOMAIN: UTILITIES
 * ============================================================
 */

/**
 * @typedef {Object} CreateOrderArgs
 * @property {number} amountToSell - Integer blockchain units
 * @property {string} sellAssetId
 * @property {number} minToReceive - Integer blockchain units
 * @property {string} receiveAssetId
 */

/**
 * @typedef {Object} OrderComparisonOptions
 * @property {Object} [precisions]
 * @property {number|string|null} [precisions.buyPrecision]
 * @property {number|string|null} [precisions.sellPrecision]
 * @property {number|string|null} [precisions.defaultPrecision]
 * @property {number} [precisions.priceRelativeTolerance]
 */

/**
 * @typedef {Object} OutsideInPairGroupAccessors
 * @property {Function} [isValid]
 * @property {Function} getType
 * @property {Function} getPrice
 */

/*
 * ============================================================
 * DOMAIN: AMA / KALMAN / SIGNALS
 * ============================================================
 */

/**
 * @typedef {Object} AmaPreset
 * @property {string} name
 * @property {number} erPeriod
 * @property {number} fastPeriod
 * @property {number} slowPeriod
 */

/**
 * @typedef {Object} MarketAdapterRuntimeDefaults
 * @property {number} intervalSeconds
 * @property {string} intervalLabel
 * @property {number} pollSeconds
 * @property {number} bootstrapLookbackHours
 * @property {number} nativeBackfillHours
 * @property {number} maxStaleHours
 * @property {number} sourceRetries
 * @property {number} retryDelayMs
 * @property {number} maxPages
 * @property {number} pageLimit
 * @property {number} minRequiredCandles
 */

export = {};
