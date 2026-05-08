/**
 * modules/constants.js - Configuration and Constants
 *
 * Global configuration, constants, and defaults for DEXBot2.
 * All constants are frozen to prevent accidental runtime modifications.
 * Local overrides can be loaded from profiles/general.settings.json
 *
 * ===============================================================================
 * EXPORTED CONSTANTS
 * ===============================================================================
 *
 * ENUM DEFINITIONS:
 *   1. ORDER_TYPES - Grid entry categories
 *      { SELL: 'sell', BUY: 'buy', SPREAD: 'spread' }
 *      - SELL: Orders above market price, size in base asset (assetA)
 *      - BUY: Orders below market price, size in quote asset (assetB)
 *      - SPREAD: Placeholder orders in spread zone around market price
 *
 *   2. ORDER_STATES - Order lifecycle states (affects fund tracking)
 *      { VIRTUAL: 'virtual', ACTIVE: 'active', PARTIAL: 'partial' }
 *      - VIRTUAL: Not yet on-chain, size in funds.virtual (reserved)
 *                 Also used for filled orders converted to SPREAD placeholders
 *      - ACTIVE: Placed on-chain, size in funds.committed
 *      - PARTIAL: Partially filled on-chain, mixed state
 *
 * DEFAULT CONFIGURATION (applied when not explicitly set):
 *   3. DEFAULT_CONFIG - Bot configuration defaults
 *      Price: startPrice, minPrice, maxPrice, incrementPercent, targetSpreadPercent
 *      Control: active, dryRun
 *      Trading pair: assetA, assetB
 *      Allocation: weightDistribution, botFunds, activeOrders
 *
 * TIMING PARAMETERS:
 *   4. TIMING - Operational timing constants
 *      SYNC_DELAY_MS, ACCOUNT_TOTALS_TIMEOUT_MS, MILLISECONDS_PER_SECOND
 *      BLOCKCHAIN_FETCH_INTERVAL_MIN, FILL_DEDUPE_WINDOW_MS
 *      FILL_RECORD_RETENTION_MS
 *      LOCK_TIMEOUT_MS, SYNC_LOCK_TIMEOUT_MS
 *      CONNECTION_TIMEOUT_MS, DAEMON_STARTUP_TIMEOUT_MS
 *      RUN_LOOP_DEFAULT_MS, OPEN_ORDERS_SYNC_LOOP_ENABLED, CHECK_INTERVAL_MS
 *
 * GRID & ORDER LIMITS:
 *   5. GRID_LIMITS - Grid sizing and scaling constraints
 *      MIN_SPREAD_FACTOR, MIN_SPREAD_ORDERS, MIN_ORDER_COUNT
 *      MAX_GRID_PRICES, MAX_ORDER_IDS_PER_BATCH, MAX_ROTATION_SIZE
 *      FUND_INVARIANT_PERCENT_TOLERANCE
 *      Includes GRID_COMPARISON sub-object for grid divergence metrics
 *
 *   6. INCREMENT_BOUNDS - Price increment percentage validation
 *      MIN_INCREMENT_PERCENT, MAX_INCREMENT_PERCENT
 *
 * FEE CONFIGURATION:
 *   7. FEE_PARAMETERS - Fee calculation and reservation parameters
 *      BTS_RESERVATION_MULTIPLIER, MARKET_FEE_PERCENT, TAKER_FEE_PERCENT
 *      TAKER_PERCENT_OVERRIDE, BTS_TAKER_OVERRIDE
 *
 * API & BLOCKCHAIN:
 *   8. API_LIMITS - Blockchain API call constraints
 *      MAX_ORDERS_PER_CALL, API_TIMEOUT_MS, API_RETRY_DELAY_MS
 *      MAX_API_RETRIES, HISTORICAL_SYNC_BATCH_SIZE
 *
 * FILL PROCESSING:
 *   9. FILL_PROCESSING - Fill event handling configuration
 *      FILL_ACK_WAIT_MS, FILL_TIMEOUT_MS, FILL_RETRY_ATTEMPTS
 *      Includes BATCH_LIMITS sub-object
 *
 * MARKET ADAPTER CONFIGURATION:
 *   10. MARKET_ADAPTER - Price tracking and grid recalculation trigger settings
 *       AMA_DELTA_THRESHOLD_PERCENT: % change in AMA center price that triggers grid reset
 *       DEFAULT_AMA_KEY: Default AMA profile used for `gridPrice: "ama"`
 *       AMAS: Built-in AMA1..AMA4 presets for market adapter defaults
 *       Related to bot AMA configuration (profiles/bots.json: ama.enabled, erPeriod, etc.)
 *       Stored in: profiles/general.settings.json
 *
 * MAINTENANCE & MONITORING:
 *   11. MAINTENANCE - Background maintenance task configuration
 *       HEALTH_CHECK_INTERVAL_MS, PERSISTENCE_CHECK_INTERVAL_MS
 *       LOCK_CLEANUP_INTERVAL_MS
 *
 *   12. NODE_MANAGEMENT - Multi-node health checking and failover configuration
 *       DEFAULT_NODES: List of BitShares nodes for redundancy
 *       HEALTH_CHECK_INTERVAL_MS, HEALTH_CHECK_TIMEOUT_MS, MAX_PING_MS
 *       BLACKLIST_THRESHOLD: Failures before node is blacklisted
 *       EXPECTED_CHAIN_ID: BitShares mainnet chain ID validation
 *       SELECTION_STRATEGY: Node selection algorithm (latency-based)
 *
 *   13. UPDATER - Version checking and update notification
 *       CHECK_INTERVAL_MS, REPO_URL, NOTIFICATION_MIN_LEVEL
 *
 * LOGGING CONFIGURATION:
 *   14. LOGGING_CONFIG - Structured logging configuration
 *       changeTracking: Smart change detection
 *       display.colors: TTY color support
 *       display.fundStatus, display.statusSummary, display.gridDiagnostics
 *       Categories for enabling/disabling log types
 *
 *   15. LOG_LEVEL - Current logging verbosity level
 *       Affects which messages are displayed: 'debug', 'info', 'warn', 'error'
 *
 *   16. PIPELINE_TIMING - Pipeline execution timing thresholds
 *   17. COW_PERFORMANCE - Copy-on-write grid performance settings
 *   18. REBALANCE_STATES - Rebalance lifecycle state enum
 *   19. COW_ACTIONS - Copy-on-write action type enum
 *
 * ===============================================================================
 *
 * LOCAL SETTINGS OVERRIDE:
 * Read from profiles/general.settings.json if it exists.
 * Supports overriding any exported constant with custom values.
 * Useful for development, testing, and performance tuning.
 *
 * FREEZING:
 * All exported objects are frozen at module load to prevent accidental runtime modifications.
 * This ensures constants remain truly constant throughout bot lifetime.
 *
 * ===============================================================================
 */

const { readGeneralSettings } = require('./general_settings');

function migrateDustCancelDelaySettings(gridSettings = {}) {
    const cleanGridSettings = { ...gridSettings };

    // Migrate old DUST_CANCEL_DELAY_MIN (minutes) → DUST_CANCEL_DELAY_SEC (seconds).
    if ('DUST_CANCEL_DELAY_MIN' in cleanGridSettings && !('DUST_CANCEL_DELAY_SEC' in cleanGridSettings)) {
        const oldMin = Number(cleanGridSettings.DUST_CANCEL_DELAY_MIN);
        if (Number.isFinite(oldMin)) {
            cleanGridSettings.DUST_CANCEL_DELAY_SEC = oldMin < 0 ? oldMin : oldMin * 60;
        }
    }

    delete cleanGridSettings.DUST_CANCEL_DELAY_MIN;
    return cleanGridSettings;
}

// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
// State transitions affect fund calculations in manager.recalculateFunds()
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',   // Not on-chain, size in funds.virtual; also used for fully filled orders converted to SPREAD
    ACTIVE: 'active',     // On-chain, size in funds.committed.grid (and .chain if has orderId)
    PARTIAL: 'partial'    // On-chain, partially filled order, size in funds.committed.grid (and .chain if has orderId)
});

// Rebalance lifecycle states used by COW planning/broadcast/commit pipeline.
const REBALANCE_STATES = Object.freeze({
    NORMAL: 'NORMAL',
    REBALANCING: 'REBALANCING',
    BROADCASTING: 'BROADCASTING'
});

// Canonical action labels used by grid reconciliation and batch broadcasting.
const COW_ACTIONS = Object.freeze({
    CREATE: 'create',
    CANCEL: 'cancel',
    UPDATE: 'update'
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
// These values are used when a parameter is not explicitly provided in the bot config.
let DEFAULT_CONFIG = {
    // Price configuration
    startPrice: "pool",          // Market price source: "pool" (liquidity pool), "book" (order book), or numeric value
    minPrice: "2x",               // Lower price bound: "Nx" = N times below startPrice, or numeric value
    maxPrice: "2x",               // Upper price bound: "Nx" = N times above startPrice, or numeric value
    gridPrice: null,              // Optional reference price for x-factor bounds calculation.
                                  // "pool"    = use the live pool price for the pair
                                  // "book"    = use the live order book price for the pair
                                  // "ama"/"ama1".."ama4" = use the effective center snapshot from profiles/orders/<botKey>.dynamicgrid.json
                                  // numeric   = fixed numeric value
                                  // null      = use startPrice
    incrementPercent: 0.5,        // Price step between grid levels (0.5 = 0.5% geometric spacing)
    targetSpreadPercent: 2,       // Target spread width between best buy and best sell (2 = 2%)

    // Bot control
    active: true,                 // Whether bot should actively place/manage orders
    dryRun: false,                // If true, simulate operations without blockchain transactions

    // Trading pair
    assetA: null,                 // Base asset symbol (e.g., "BTS")
    assetB: null,                 // Quote asset symbol (e.g., "USD")

    // Fund allocation
    weightDistribution: { sell: 1, buy: 1 },  // Geometric weight for order sizing (1 = ~1:2 center/outer split, 0.5 = linear)
    botFunds: { sell: "100%", buy: "100%" },      // Percentage of wallet balance to allocate ("100%" or numeric value)
    activeOrders: { sell: 20, buy: 20 },          // Number of orders to maintain closest to market on each side
};

// Timing constants used by OrderManager and helpers
let TIMING = {
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000,
    // Conversion factor: milliseconds per second
    MILLISECONDS_PER_SECOND: 1000,
    // Blockchain fetch interval: how often to refresh blockchain account values (in minutes)
    // Default: 240 minutes (4 hours). Set to 0 or non-number to disable periodic fetches.
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240,

    // Fill processing timing
    FILL_DEDUPE_WINDOW_MS: 5000,    // 5 seconds - window for deduplicating same fill events
    FILL_RECORD_RETENTION_MS: 3600000, // 1 hour - how long to keep persisted fill records
    PROCESSED_FILL_PERSIST_BATCH_MS: 250, // 250ms - coalesce processed-fill persistence writes under burst load
    PROCESSED_FILL_PERSIST_BATCH_SIZE: 25, // Flush immediately once this many processed fills are queued
    AUDIT_LOG_RETENTION_MS: 7 * 24 * 60 * 60 * 1000, // 7 days - retention window for daemon audit logs

    // Order locking timing
    // Reduced from 30s to 10s to prevent lock-based starvation under high fill rates.
    // Locks that exceed this timeout are auto-expired by _cleanExpiredLocks() to ensure
    // orders are never permanently blocked if a process crashes while holding the lock.
    // This self-healing mechanism prevents deadlocks while still protecting against races.
    LOCK_TIMEOUT_MS: 10000,  // 10 seconds - balances transaction latency with lock starvation prevention

    // Sync lock acquisition timeout - prevents indefinite lock hangs
    // Uses Promise.race() to enforce timeout on lock acquisition attempts
    SYNC_LOCK_TIMEOUT_MS: 20000,  // 20 seconds - prevents deadlocks while allowing slow operations

    // Connection and initialization timeouts
    CONNECTION_TIMEOUT_MS: 30000,  // 30 seconds - BitShares client connection establishment timeout
    DAEMON_STARTUP_TIMEOUT_MS: 60000,  // 60 seconds - Private key daemon startup timeout

    // Main loop and polling defaults
    RUN_LOOP_DEFAULT_MS: 5000,  // 5 seconds - default open-orders sync cycle delay (env override: OPEN_ORDERS_SYNC_LOOP_MS)
    OPEN_ORDERS_SYNC_LOOP_ENABLED: false,  // Preferred flag: continuous open-order watchdog sync loop
    CHECK_INTERVAL_MS: 100,  // 100 milliseconds - polling interval for connection/daemon readiness checks

    // Blockchain settle delay before follow-up structural work after a scheduled maintenance action.
    // Gives maintenance-triggered cancels/rebalances time to acquire locks, broadcast, and settle
    // before a deferred grid resync attempts more on-chain changes.
    BLOCKCHAIN_SETTLE_DELAY_MS: 6000,

    // Credit deal proactive renewal timing
    CREDIT_DEAL_CHECK_INTERVAL_MIN: 60,      // How often to check credit deal expiry (minutes)
    CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 12,  // Proactively renew deals expiring within this window

    // LOCK_REFRESH_MIN_MS: Minimum interval for refreshing order lock leases during long operations.
    // Prevents lock expiration during extended reconciliations or batch operations.
    // Default: 250ms (4 refreshes per second minimum during long operations).
    LOCK_REFRESH_MIN_MS: 250
};

// Grid limits and scaling constants
let GRID_LIMITS = {
    // MIN_SPREAD_FACTOR: Ensures spread is at least (incrementPercent × MIN_SPREAD_FACTOR) slots wide.
    // Rationale: Spread must be sufficiently wide to:
    //   1. Avoid order collision (orders too close get rejected by blockchain)
    //   2. Allow bid-ask arbitrage room (market makers profit from the spread)
    //   3. Scale proportionally to grid spacing (tighter increments need tighter spread buffer)
    //
    // Example Calculation (incrementPercent = 0.5%, targetSpread = 2%):
    //   - MIN_SPREAD_FACTOR = 2.1 → minSpread = 0.5% × 2.1 = 1.05%
    //   - But target is 2%, so final spread = max(1.05%, 2%) = 2% (target wins)
    //   - This ensures spread is at least (0.5% × 2.1) but respects user's targetSpread
    //
    // Default: 2.1 ensures 3-slot minimum gap even with tight increment (see grid.js::SPREAD_GAP_FORMULA)
    MIN_SPREAD_FACTOR: 2.1,

    // MIN_ORDER_SIZE_FACTOR: Minimum order size = blockchain_minimum × this factor.
    // Rationale: Orders smaller than blockchain minimum are rejected.
    //   - Blockchain minimum ≈ 1 satoshi (10^-8 per unit)
    //   - Float arithmetic and fee deductions can round amounts down
    //   - Safety factor = 50× ensures orders survive rounding
    // Example: If blockchainMin = 1 BTS, then minSize = 50 BTS (very conservative for mainnet)
    // This trades off efficiency (larger minimum) for reliability (never hits rounding floor)
    MIN_ORDER_SIZE_FACTOR: 50,

    // GRID_REGENERATION_PERCENTAGE: Trigger threshold for automatic grid size recalculation.
    // Formula: IF (availableFunds / allocatedCapital) × 100 ≥ threshold → regenerate
    // Rationale: After fills, free balance rises relative to allocated grid capital.
    //   - 3% = regen triggered when available funds represent ≥3% of side allocation
    //   - This allows gradual accumulation while preventing lag during high-fill periods
    //   - If threshold too low: constant regeneration (churn, fees)
    //   - If threshold too high: capital remains underutilized, grid undersized
    // Example: 20 active orders × 100 BTS each = 2000 BTS grid
    //   - availableFunds ≥ 60 BTS → (60/2000 = 3%) triggers regeneration
    //   - Allows ~3 fill-proceeds before resize (reduces churn)
    // Checked independently per side, allowing asymmetric fill patterns.
    GRID_REGENERATION_PERCENTAGE: 3,



    // PARTIAL_DUST_THRESHOLD_PERCENTAGE: Threshold for treating partially-filled orders as "dust".
    // Formula: IF (actualSize / idealSize) × 100 < threshold → dust
    // Rationale: Partially-filled orders become progressively smaller.
    //   - 5% = orders below 5% of ideal size are rotated (to restore grid symmetry)
    //   - Dust orders waste grid slots (they should be closed or brought back to ideal size)
    //   - Rotation replaces dust order with a fresh one at proper size
    //   - Detects both accidental low fills and normal fill-chain truncation
    // Example: idealSize = 100 BTS, but actual = 3 BTS → (3/100 = 3%) < 5% → dust
    //   - This order would be rotated to free the slot
    PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5,

    // DUST_CANCEL_DELAY_SEC: Seconds to wait before auto-cancelling a dust partial as fully filled.
    // When a partial order's remaining size falls below PARTIAL_DUST_THRESHOLD_PERCENTAGE,
    // it can be cancelled on-chain and its slot freed for a fresh counter-order.
    // Formula: IF (now - firstDustDetected) >= DUST_CANCEL_DELAY_SEC × 1000ms → cancel
    // Values:
    //   -1 = disabled — dust orders are never auto-cancelled
    //    0 = cancel immediately on first dust detection in the active window
    //    N = cancel after N seconds of continuous dust state (default: 30, timer resets if order recovers)
    // Example: 30 → order stays dust for 30 seconds → cancel + treat slot as fully filled
    //   - Bot then places a fresh order at proper size on the freed slot
    //   - The cancelled dust remainder is returned to the bot's free balance
    DUST_CANCEL_DELAY_SEC: 30,

    // FUND_INVARIANT_PERCENT_TOLERANCE: Allowed percentage drift in fund tracking before triggering recovery.
    // Formula: tolerance = max(precisionSlack, balance × percentTolerance)
    // Rationale: Fund tracking can drift due to:
    //   1. Float arithmetic rounding (resolved by precisionSlack, ~10^-precision)
    //   2. In-flight blockchain transactions (resolved by percentTolerance)
    //   3. Fee accumulation from multiple operations
    // Default: 0.1% (0.1%) means for 1000 BTS balance, drift up to 1 BTS is tolerated
    //   - Accounts for ~5 fill-fee events before recovery triggered
    //   - Too low: false positives (recoveries on healthy operations)
    //   - Too high: undetected drift (fund leaks)
    // Drifts larger than this tolerance trigger immediate recovery (re-sync from blockchain).
    FUND_INVARIANT_PERCENT_TOLERANCE: 0.1,

    // MIN_SPREAD_ORDERS: Minimum number of empty slots in spread zone (between best buy and best sell).
    // Rationale: Spread must be sufficiently wide to:
    //   1. Prevent order collision (blockchain rejects orders with identical price)
    //   2. Ensure market makers profit from the bid-ask difference
    //   3. Allow price movement without orders crossing each other
    // Default: 2 (at least 2 empty slots between buy and sell sides)
    // Example: Buy @ 99.9, empty, empty, Sell @ 100.1 → 2-slot spread (acceptable)
    //         Buy @ 99.9, empty, Sell @ 100.0 → 1-slot spread (too tight, rebalance triggered)
    MIN_SPREAD_ORDERS: 2,


    // Grid comparison metrics
    // Detects significant divergence between calculated (in-memory) and persisted grid state
    // after order fills and rotations
    // NOTE: Independent from MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT
    //   - RMS_PERCENTAGE: Triggers grid reset when calculated grid diverges from blockchain state
    //   - AMA_DELTA_THRESHOLD_PERCENT: Triggers grid reset when AMA center price moves significantly
    //   Both can be configured independently in profiles/general.settings.json
    GRID_COMPARISON: {
        // Metric calculation: RMS (Root Mean Square) of relative order size differences
        // Formula: RMS = √(mean of ((calculated - persisted) / persisted)²)
        // Represents the quadratic mean of relative size errors
        SUMMED_RELATIVE_SQUARED_DIFFERENCE: 'summedRelativeSquaredDiff',

        // Divergence threshold for automatic grid regeneration (RMS as percentage)
        // When compareGrids() metric exceeds this threshold, updateGridOrderSizes will be triggered
        // Set to 0 to completely disable RMS divergence checks (Issue #5: RMS Divergence Check Disabling)
        //
        // RMS Threshold Reference Table (for 5% distribution: 5% outliers, 95% perfect):
        // ┌────────────────────────────────────────────────────────┐
        // │ RMS %       │ Avg Error │ Description                 │
        // ├────────────────────────────────────────────────────────┤
        // │ 0           │ N/A       │ Disabled (no checks)        │
        // │ 4.5%        │ ~1.0%     │ Very strict                 │
        // │ 9.8%        │ ~2.2%     │ Strict                      │
        // │ 14.3%       │ ~3.2%     │ Default (balanced)          │
        // │ 20.1%       │ ~4.5%     │ Lenient                     │
        // │ 31.7%       │ ~7.1%     │ Very lenient                │
        // │ 44.7%       │ ~10%      │ Extremely lenient           │
        // └────────────────────────────────────────────────────────┘
        RMS_PERCENTAGE: 14.3
    },

    // STATE_CHANGE_HISTORY_MAX: Maximum number of state changes to retain in circular buffer.
    // Used by StateChangeLogger for tracking recent grid/fund mutations.
    // Default: 100 entries (balances memory usage with debugging utility).
    STATE_CHANGE_HISTORY_MAX: 100,

    // RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT: Relative threshold for in-memory
    // order equality checks in COW delta planning.
    // Example: 0.1 means two values are considered equal when diff < 0.1% of magnitude.
    // Note: Final blockchain update filtering still happens with integer precision checks.
    RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT: 0.1
};

// Increment percentage bounds for grid configuration
let INCREMENT_BOUNDS = {
    // Minimum increment percentage allowed (0.01%)
    MIN_PERCENT: 0.01,
    // Maximum increment percentage allowed (10%)
    MAX_PERCENT: 10,
    // Minimum increment as decimal factor (0.01% = 0.0001)
    MIN_FACTOR: 0.0001,
    // Maximum increment as decimal factor (10% = 0.10)
    MAX_FACTOR: 0.10
};

// Fee-related parameters for order operations
let FEE_PARAMETERS = {
    // BTS_RESERVATION_MULTIPLIER: Factor applied to totalTargetOrders to reserve BTS fee budget.
    // Formula: BTS reserved = totalTargetOrders × BTS_RESERVATION_MULTIPLIER
    // Rationale: Each order can be updated/cancelled during rebalancing, and each operation incurs a fee.
    //   - Conservative estimate: each order may be touched ~5 times during its lifetime
    //   - Orders get: created (1 fee), rotated (2 fees: cancel + place), updated (1 fee), cancelled (1 fee)
    //   - So ~5 fees per order is safe buffer to prevent fee starvation
    // Example: 20 active orders → 20 × 5 = 100 BTS reserved for fee operations
    // Set to 0 to disable fee reservation (not recommended for production).
    BTS_RESERVATION_MULTIPLIER: 5,
    
    // Fallback BTS fee (satoshis) when dynamic fee calculation fails.
    // Rationale: During startup or when fee API is unavailable, use this conservative estimate.
    //   - 100 satoshis = 0.00000100 BTS (typical limit order fee is 1-2 BTS on mainnet)
    //   - Using satoshi precision prevents integer division errors
    //   - Actual fees are calculated and deducted once fee API responds
    BTS_FALLBACK_FEE: 100,
    
    // MAKER_FEE_PERCENT: Percentage of base fee charged for maker orders (orders that rest in book).
    // Rationale: BitShares incentivizes providing liquidity (making orders) with lower fees.
    //   - 0.1 = 10% of the base order creation fee
    //   - Typical: 2 BTS base fee × 0.1 = 0.2 BTS charged (maker)
    //   - vs. 2 BTS for taker orders (taker: 100% of base fee)
    //   - This 10× discount encourages grid bots (primarily makers) to place orders
    MAKER_FEE_PERCENT: 0.1,
    
    // MAKER_REFUND_PERCENT: Percentage of maker fee refunded after order execution/cancellation.
    // Rationale: BitShares refunds unused maker fees when order is cancelled or fills.
    //   - 0.9 = 90% refund of the maker fee paid
    //   - Typical: Paid 0.2 BTS, get 0.18 BTS refund, net cost 0.02 BTS
    //   - Refund arrives in a separate transaction after cancellation
    //   - This incentive structure encourages taker participation (market efficiency)
    MAKER_REFUND_PERCENT: 0.9,
    
    // TAKER_FEE_PERCENT: Percentage of base fee charged for taker orders (orders that cross spread).
    // Rationale: Takers (who immediately fill) pay full fee; they consume liquidity.
    //   - 1.0 = 100% of the base order creation fee
    //   - Typical: 2 BTS base fee × 1.0 = 2 BTS charged (no refund)
    //   - Full fee covers order broadcast and execution costs
    TAKER_FEE_PERCENT: 1.0,

    // GRAPHENE_FEE_RATE_DENOM: BitShares credit-offer fee-rate denominator.
    // The on-chain fee_rate is an integer; fee percent = fee_rate / DENOM.
    // Example: fee_rate 30000 → 30000 / 1000000 = 3% flat fee at repayment.
    GRAPHENE_FEE_RATE_DENOM: 1000000,

    // DEFAULT_MAX_FEE_RATE_PER_DAY: Default maximum daily fee rate for credit offers.
    // 1/3000 ≈ 0.0003333 = 0.03333% per day = ~1% per month.
    // This provides a reasonable default cap so short-duration high-flat-fee offers
    // are rejected while long-duration low-flat-fee offers are accepted.
    DEFAULT_MAX_FEE_RATE_PER_DAY: 1 / 3000,
};

// API request limits and batch sizes for blockchain operations
let API_LIMITS = {
    // Maximum number of liquidity pools per batch request
    POOL_BATCH_SIZE: 100,
    // Maximum number of batch iterations for pool scanning (~10k total pools)
    MAX_POOL_SCAN_BATCHES: 100,
    // Depth of order book to fetch for market price derivation
    ORDERBOOK_DEPTH: 5,
    // Maximum number of limit orders per batch request
    LIMIT_ORDERS_BATCH: 100
};

// Fill processing configuration
let FILL_PROCESSING = {
    // Mode for fill processing: 'history' reads from historical fills
    MODE: 'history',
    // Operation type for fill_order blockchain operations
    OPERATION_TYPE: 4,
    // Indicator for taker (non-maker) fills
    TAKER_INDICATOR: 0,

    // Maximum fills processed per rebalance/broadcast cycle.
    // Behavior:
    // - 1..MAX_FILL_BATCH_SIZE fills -> single unified batch
    // - >MAX_FILL_BATCH_SIZE fills   -> fixed-size chunking at MAX_FILL_BATCH_SIZE
    // Set to 1 for current sequential behavior.
    MAX_FILL_BATCH_SIZE: 4
};

// Cleanup and maintenance parameters
let MAINTENANCE = {
    // Probability of running cleanup operation on any cycle (0.1 = 10%)
    CLEANUP_PROBABILITY: 0.1
};

// Node management and health checking configuration
let NODE_MANAGEMENT = {
    // Whether node failover is enabled when no explicit setting is present.
    DEFAULT_ENABLED: true,

    // Startup retry/backoff for transient BitShares connection failures.
    STARTUP_RETRY_INITIAL_DELAY_MS: 500,
    STARTUP_RETRY_MAX_DELAY_MS: 5000,
    STARTUP_REFRESH_INTERVAL_MS: 30000,
    STARTUP_CONNECT_TIMEOUT_MS: 5000,

    // Default node list (used if no config file)
    DEFAULT_NODES: [
        'wss://btsws.roelandp.nl/ws',
        'wss://cloud.xbts.io/ws',
        'wss://node.xbts.io/ws',
        'wss://public.xbts.io/ws',
        'wss://dex.iobanker.com/ws',
        'wss://api.dex.trading/',
        'wss://api.bts.mobi/ws',
        'wss://api.btslebin.com/ws'
    ],

    // Health check defaults
    HEALTH_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000,  // 4 hours
    HEALTH_CHECK_TIMEOUT_MS: 5000,      // 5 seconds per check
    MAX_PING_MS: 3000,                  // Max acceptable latency
    BLACKLIST_THRESHOLD: 3,             // Failures before blacklist
    BLACKLIST_COOLDOWN_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days before retrying blacklisted nodes

    // Expected chain ID (BitShares mainnet)
    EXPECTED_CHAIN_ID: '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8',

    // Selection strategy
    SELECTION_STRATEGY: 'latency'       // latency-based selection
};

// Pipeline timeout configuration
let PIPELINE_TIMING = {
    // TIMEOUT_MS: Maximum duration for pipeline operations before forcing maintenance.
    // Rationale: If pipeline hangs (stuck in lock, slow blockchain, etc), force a maintenance cycle.
    //   - 300000 ms = 5 minutes
    //   - Prevents infinite hangs; ensures bot recovers or logs the problem
    //   - Typical pipeline cycle completes in <100ms (unless blockchain is slow)
    //   - 5 minute timeout allows for slow network periods while still being responsive
    // When timeout is exceeded, pipeline triggers maintenance (logs, cleanup, state check).
    TIMEOUT_MS: 300000,

    // RECOVERY_RETRY_INTERVAL_MS: Minimum cooldown time between fund invariant recovery attempts.
    // Rationale: When a fund tracking invariant violation is detected:
    //   - First attempt: immediate (no wait) — try to fix quickly
    //   - Subsequent attempts: wait at least this duration — prevent tight retry loops
    //   - Prevents blockchain query spam while allowing eventual convergence
    //
    // Backoff Timeline Example (defaults):
    //   - T=0s: Violation detected → immediate recovery attempt #1
    //   - T=45s: Next violation check → still in cooldown, skip retry
    //   - T=65s: Next violation check → cooldown expired, attempt #2
    //   - T=125s: Attempt #3 (another 60s)
    //   - T=180s: Attempt #4
    //   - T=240s: Attempt #5 (max reached)
    //   - T=300s: Fill arrives → counter resets, ready for new recovery episode
    //
    // Default: 60000 ms (60 seconds) balances responsiveness with resource efficiency.
    //   - Too low (e.g., 5s): constant recovery attempts, high blockchain load
    //   - Too high (e.g., 600s): slow detection of new invariant drift, bad UX
    RECOVERY_RETRY_INTERVAL_MS: 60000,

    // MAX_RECOVERY_ATTEMPTS: Maximum recovery retry attempts before giving up.
    // Rationale: Limit total recovery effort to prevent runaway loop.
    //   - After N failed attempts, bot stops recovery until next fill/sync
    //   - This allows bot to stabilize when recovery is impossible
    //   - Example: if funds are impossible to recover, don't keep trying indefinitely
    //
    // Retry Lifecycle (defaults, MAX = 5):
    //   - Attempts 1-5: Each spaced RECOVERY_RETRY_INTERVAL_MS apart (~60s each)
    //   - Attempt 5 fails: stop retrying
    //   - Next fill or blockchain fetch (after ~1 minute): counter resets, new episode starts
    //   - Total time blocked per episode: ~5 × 60s = 5 minutes before giving up
    //
    // Special Cases:
    //   - Set to 0: unlimited retries (not recommended; can cause infinite recovery loops)
    //   - Set to 1: one-shot only (minimal recovery effort; original patch15 behavior)
    //   - Set to 5: balanced (typical value; ~5 min of effort)
    MAX_RECOVERY_ATTEMPTS: 5,

    // FEE_EVENT_DEDUP_TTL_MS: How long to remember settled fee events for deduplication.
    // Prevents the same fill from being fee-settled multiple times when
    // re-detected across sync cycles or reconnections.
    // Default: 6 hours (21600000 ms).
    FEE_EVENT_DEDUP_TTL_MS: 6 * 60 * 60 * 1000,

    // MAX_FEE_EVENT_CACHE_SIZE: Maximum number of fee events to keep in deduplication cache.
    // Prevents unbounded memory growth during extended operation with many fills.
    // When exceeded, oldest entries are evicted to 75% capacity.
    // Default: 10000 entries (~60MB worst case with long event IDs).
    MAX_FEE_EVENT_CACHE_SIZE: 10000,

    // CACHE_EVICTION_RETENTION_RATIO: Target ratio of entries to keep during cache eviction.
    // When cache exceeds max size, evict down to (maxSize × ratio) entries.
    // Default: 0.75 (75%) - evicts oldest 25% to get back to 75% capacity.
    CACHE_EVICTION_RETENTION_RATIO: 0.75,

    // RECOVERY_DECAY_FALLBACK_MS: Default decay window for recovery attempt counter (milliseconds).
    // Used when RECOVERY_RETRY_INTERVAL_MS is not configured.
    // After this idle time, recovery attempt count resets to prevent permanent exhaustion.
    // Default: 3 minutes (180000 ms).
    RECOVERY_DECAY_FALLBACK_MS: 3 * 60 * 1000
};

// Market Adapter Configuration
// Controls price tracking and grid recalculation triggers.
// See: market_adapter/market_adapter.js, modules/account_bots.js
let MARKET_ADAPTER = {
    // Default candle/runtime cadence for the standalone market adapter.
    // Keep these centralized so the adapter, logs, and tests do not drift from
    // the production 1h candle workflow.
    RUNTIME_DEFAULTS: {
        intervalSeconds: 3600,
        intervalLabel: '1h',
        pollSeconds: 3600,
        bootstrapLookbackHours: 720,
        nativeBackfillHours: 6,
        maxStaleHours: 6,
        sourceRetries: 3,
        retryDelayMs: 800,
        maxPages: 80,
        pageLimit: 100,
        minRequiredCandles: 80,
    },

    // KIBANA_REQUEST_TIMEOUT_MS: Shared per-request timeout for Kibana-backed candle fetches.
    // Used by both the standalone LP history fetcher and the live market adapter's
    // bootstrap / repair / backfill calls so long-running scans share one ceiling.
    KIBANA_REQUEST_TIMEOUT_MS: 3 * 60 * 1000,

    // KIBANA_FETCH_CHUNK_MONTHS: Default historical window size for the standalone
    // LP fetcher when it splits long requests into sequential sub-requests.
    KIBANA_FETCH_CHUNK_MONTHS: 3,

    // AMA_DELTA_THRESHOLD_PERCENT: Percentage change in AMA center price that triggers a grid reset.
    //   - When AMA price moves ±AMA_DELTA_THRESHOLD_PERCENT from the last recorded center,
    //     a recalculate.<botKey>.trigger file is written to signal grid regeneration.
    //   - Configurable per deployment via profiles/general.settings.json under MARKET_ADAPTER.
    //   - Range: 0.1 to 50.0 (enforced in account_bots.js)
    //   - Default: 2.0 (grid recalculates when market moves 2.0% from last recorded AMA center)
    AMA_DELTA_THRESHOLD_PERCENT: 2.0,

    // AMA_SLOPE_DELTA_THRESHOLD_PERCENT: Percentage change in AMA slope that can trigger a
    // grid reset when the slope delta moves far enough away from the last accepted snapshot.
    //   - Configurable per market pair and per bot via market_adapter_settings.json.
    //   - Default: 0.015 (average per-bar slope delta)
    AMA_SLOPE_DELTA_THRESHOLD_PERCENT: 0.015,

    // DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD: Minimum blended trend strength required
    // before the bot applies a directional weight shift in the asymmetrical path.
    // Higher values ignore weaker trend signals and keep weights closer to the static baseline.
    // Lower values allow smaller trend signals to affect buy/sell weighting.
    // Default is 0 so the gate stays disabled unless a market/bot override enables it.
    // nob: th% (Min Output Threshold)
    DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD: 0,

    // DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD: Minimum volatility shift required before the
    // symmetric ATR dampening actually changes the output weights.
    // Higher values ignore smaller ATR-driven adjustments.
    // Lower values let volatility influence the symmetric shift sooner.
    // (used by the volatility research tool)
    DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD: 0.1,

    // DYNAMIC_WEIGHT_CLIP_PERCENTILE: Outlier filter for unusually large AMA/Kalman moves.
    // Higher values suppress more extreme spikes before they influence dynamic weights.
    // 0 disables clipping.
    // Configurable per market or per bot via market_profiles.json or botOverrides.
    // nob: clip%
    DYNAMIC_WEIGHT_CLIP_PERCENTILE: 10,

    // DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS: Lookback window for measuring AMA trend.
    // Lower values react faster to recent price changes.
    // Higher values smooth the signal and require a more sustained move.
    // nob: lb (Lookback Bars)
    DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS: 9,

    // DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT: Average per-bar trend size that counts as "full strength" for AMA.
    // Lower values make the AMA channel reach maximum influence more easily.
    // Higher values require a stronger price move before AMA reaches full effect.
    // nob: amaS% (AMA Max Slope %)
    DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT: 0.1,

    // DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT: Trend size that counts as "full strength" for
    // the Kalman composite branch. Kept separate from the AMA slope knob so the two
    // channels can saturate independently.
    // Lower values make the Kalman channel reach maximum influence more easily.
    // Higher values require a stronger move before the Kalman branch reaches full effect.
    // nob: kalS% (Kalman Max Slope %)
    DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT: 0.75,

    // DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT: Ignore small AMA moves around flat price action.
    // Higher values create a larger neutral zone and reduce small trend reactions.
    // Lower values make the AMA channel react to smaller moves.
    // nob: nz% (Neutral Zone %)
    DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT: 0,

    // DYNAMIC_WEIGHT_ALPHA: Blend between AMA trend and Kalman trend.
    // 0 = pure Kalman, 1 = pure AMA.
    // Higher values trust AMA more, lower values trust Kalman more.
    // nob: alpha
    DYNAMIC_WEIGHT_ALPHA: 0.5,

    // DYNAMIC_WEIGHT_DW: Blend inside the Kalman signal between velocity and displacement.
    // Lower values emphasize momentum/velocity.
    // Higher values emphasize how far price has moved away from the modal baseline.
    // Default 0.5 balances velocity and displacement.
    // nob: dw (Displacement Weight)
    DYNAMIC_WEIGHT_DW: 0.5,

    // DYNAMIC_WEIGHT_GAIN: Overall strength of the blended dynamic-weight signal.
    // Higher values make dynamic weights more aggressive.
    // Lower values keep weights closer to the static baseline.
    // nob: gain
    DYNAMIC_WEIGHT_GAIN: 1.0,

    // DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP: Maximum directional offset away from neutral.
    // Overridable per market pair or per bot via market_adapter_settings.json.
    DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP: 0.5,

    // DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP: Maximum symmetric downward shift from volatility.
    // Overridable per market pair or per bot via market_adapter_settings.json.
    DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP: 0.5,

    // DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT: ATR lookback used by the live volatility penalty
    // and the volatility research chart. 14 is the standard Wilder ATR window.
    // Overridable per market pair or per bot via market_adapter_settings.json.
    DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT: 14,

    // DYNAMIC_WEIGHT_MIN_WEIGHT / MAX_WEIGHT: Final weight clamp after all adjustments.
    DYNAMIC_WEIGHT_MIN_WEIGHT: -1,
    DYNAMIC_WEIGHT_MAX_WEIGHT: 2,

    // DYNAMIC_WEIGHT_REGIME_SENSITIVITY: How strongly the regime filter dampens or preserves
    // the dynamic-weight signal.
    // 0 ignores regime filtering, 1 uses the table as-is, and higher values make bad regimes
    // suppress the signal more aggressively.
    // nob: regime
    DYNAMIC_WEIGHT_REGIME_SENSITIVITY: 1,

    // Shared Kalman tuning defaults used by both the research HTML and the live dynamic-weight
    // market adapter so both paths start from the same smoothing and echo behavior.
    DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT: 0.05,
    DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT: 0.01,
    DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT: 0.0001,
    DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT: 100,
    DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT: 1.8,
    DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT: 1.5,
    DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT: 100,
    DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT: 0,

    // Adaptive Kalman velocity smoothing budget (0-1.0)
    DYNAMIC_WEIGHT_KALMAN_SMOOTHING_BUDGET: 0.60,
    DYNAMIC_WEIGHT_KALMAN_SMOOTHING_FLOOR: 0,

    // DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT: Minimum raw regime multiplier deviation before
    // the dampening branch is allowed to reduce the output.
    DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT: 0.05,

    // DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT: Minimum Kalman displacement scale in percent.
    // This is the active Kalman displacement scale in both the HTML research tool and the
    // live directional signal path.
    // The live smoother clamps this to at least 1.0 so 0.5% displacements do not saturate
    // confidence too early.
    // Exposed in the research chart as the `dsp` control.
    DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT: 1.0,

    // DYNAMIC_WEIGHT_VOLATILITY_EXPONENT: Controls how quickly the volatility penalty ramps up.
    // Higher values delay the penalty in calm markets and make it matter more in higher volatility.
    // Lower values make the penalty start affecting weights earlier.
    // Overridable per market pair or per bot via market_adapter_settings.json.
    DYNAMIC_WEIGHT_VOLATILITY_EXPONENT: 1.0,

    // DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT: Overall strength multiplier of the ATR-based
    // volatility penalty. Higher = more aggressive shrinking of unused inventory.
    // 1-100 range; 10.0 is a recommended start that leaves orders on the book during
    // mild volatility. Increase to 20-30 if you want the bot to pull orders more
    // aggressively during volatile periods.
    // Overridable per market pair or per bot via market_adapter_settings.json.
    DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT: 10.0,

    // ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR: Maximum ratio tilt applied to min/max
    // grid bounds when the AMA slope indicates a strong trend. At full slope strength:
    //   Downtrend: minPrice divisor grows by 1+factor, maxPrice multiplier shrinks by 1-factor
    //   Uptrend:   maxPrice multiplier grows by 1+factor, minPrice divisor shrinks by 1-factor
    // This widens the bound in the trend direction and tightens the opposite side,
    // giving the grid more room when the AMA center trails price in a trend.
    // 0 disables asymmetry. Recommended range: 0.15–0.35.
    // Overridable per bot via market_adapter_settings.json.
    ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR: 0.35,

    // STALE_TAIL_THRESHOLD_CANDLES: Number of consecutive candles with an identical close
    // price that triggers pruning of the trailing tail. Prevents gap-filled synthetic candles
    // from carrying a frozen price forward indefinitely when the pool has no activity.
    // At 1h intervals, 24 = 24 hours. Overridable via cfg.staleTailThreshold.
    STALE_TAIL_THRESHOLD_CANDLES: 24,

    // HURST_CONFIG: Standard window and scales for Hurst exponent calculation.
    HURST_CONFIG: {
        window: 256,
        scales: [8, 16, 32, 64],
    },

    // PE_CONFIG: Standard parameters for Permutation Entropy calculation.
    PE_CONFIG: {
        m:      5,
        delay:  1,
        window: 54,
    },

    // HURST_ZONE_BAND: Width of the neutral Hurst zone between trending and mean-reverting regimes.
    // Higher values classify more markets as "random/unclear".
    // Lower values switch more quickly into trending or mean-reverting states.
    HURST_ZONE_BAND: 0.05,

    // PE_NODES: Signal-quality bands for permutation entropy.
    // Lower entropy means cleaner, more structured price action.
    // Higher entropy means noisier price action, where the bot should trust signals less.
    PE_NODES: [0.60, 0.725, 0.85],

    // REGIME_TABLE: Signal-strength table for combinations of market structure and noise.
    // Rows are Hurst regimes [trending, random, mean-reverting].
    // Columns are entropy regimes [structured, mixed, noisy].
    // Higher values preserve more of the dynamic-weight signal.
    // Lower values dampen the signal in unclear or hostile conditions.
    REGIME_TABLE: [
        [1.0, 0.7, 0.3],  // Trending (H > 0.5 + HURST_ZONE_BAND)
        [0.6, 0.4, 0.15], // Random
        [0.3, 0.2, 0.05], // Mean-reverting (H < 0.5 - HURST_ZONE_BAND)
    ],

    // DEFAULT_AMA_KEY: Built-in default profile for `gridPrice: "ama"` when no
    // pair-specific market_profiles entry exists.
    DEFAULT_AMA_KEY: 'AMA3',

    // AMAS: Built-in AMA presets derived from the local LP 1.19.133 fitting results.
    // These serve as stable defaults for the market adapter and can be overridden by
    // pair-specific profiles in profiles/market_profiles.json.
    AMAS: {
        AMA1: {
            name: 'AMA1 (cap 25%)',
            erPeriod: 781,
            fastPeriod: 5.2,
            slowPeriod: 93.1,
        },
        AMA2: {
            name: 'AMA2 (cap 30%)',
            erPeriod: 781,
            fastPeriod: 5.2,
            slowPeriod: 102.4,
        },
        AMA3: {
            name: 'AMA3 (cap 35%)',
            erPeriod: 781,
            fastPeriod: 5.2,
            slowPeriod: 112.7,
        },
        AMA4: {
            name: 'AMA4 (cap 40%)',
            erPeriod: 781,
            fastPeriod: 5.2,
            slowPeriod: 136.4,
        },
    },

    // AMA_CONVERGENCE_ER_AVG: Typical market Efficiency Ratio used to estimate
    // average AMA convergence rate from cold start. Lower = more conservative
    // (assumes more noise → slower convergence → more candles needed).
    // Calibrated against pool 133 1h (2023-05-07 -> 2026-05-06) — implied ER corrects for
    // Jensen's inequality (E[f(ER)] ≠ f(E[ER]) for convex f = x²).
    AMA_CONVERGENCE_ER_AVG: 0.151,

    // AMA_CONVERGENCE_EPSILON: Target fraction of initialization bias remaining
    // after convergence. 0.01 = 99 % of the initial bias has decayed.
    AMA_CONVERGENCE_EPSILON: 0.01,
};

// Logging Level Configuration
// Options:
// - 'debug': Verbose output including calculation details, API calls, and flow tracing.
// - 'info':  Standard production output. State changes (Active/Filled), keys confirmations, and errors.
// - 'warn':  Warnings (non-critical issues) and errors only.
// - 'error': Critical errors only.
let LOG_LEVEL = 'info';

// Fine-grained Logging Configuration
// Controls what gets logged at each level and which categories are enabled
// Can be overridden in profiles/general.settings.json via LOGGING_CONFIG
let LOGGING_CONFIG = {
    changeTracking: {
        enabled: true,
        ignoreMinor: {
            fundPrecision: 8,      // Ignore fund changes smaller than 0.00000001
            pricePrecision: 4      // Ignore price changes smaller than 0.0001
        }
    },
    categories: {
        fundChanges: {
            enabled: true,
            level: "debug",
            options: {
                onlyChanges: true,
                aggregateSmall: true,
                hideComponentBreakdown: true
            }
        },
        orderStateChanges: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true,
                compactFormat: true
            }
        },
        fillEvents: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true,
                aggregateFees: true
            }
        },
        boundaryEvents: {
            enabled: true,
            level: "info",
            options: {
                onlyChanges: true
            }
        },
        errorWarnings: {
            enabled: true,
            level: "warn",
            options: {
                alwaysLog: true
            }
        },
        edgeCases: {
            enabled: true,
            level: "warn",
            options: {
                alwaysLog: true
            }
        }
    },
    display: {
        gridDiagnostics: {
            enabled: false,
            showOnDemandOnly: true
        },
        fundStatus: {
            enabled: false,
            showDetailed: false,
            compactFormat: true
        },
        statusSummary: {
            enabled: false
        },
        colors: {
            enabled: "auto"
        }
    }
};

// Updater Configuration
let UPDATER = {
    // Whether the automated updater is enabled
    ACTIVE: true,
    // Hardcoded repository URL
    REPOSITORY_URL: "https://github.com/froooze/DEXBot2.git",
    // Default branch policy: 'auto' (track current), 'main', 'dev', 'test'
    BRANCH: "auto",
    // Automated update schedule using Cron format:
    // ┌────────────── minute (0 - 59)
    // │ ┌──────────── hour (0 - 23)
    // │ │ ┌────────── day of month (1 - 31)
    // │ │ │ ┌──────── month (1 - 12)
    // │ │ │ │ ┌────── day of week (0 - 6) (0 is Sunday)
    // │ │ │ │ │
    // 0 0 * * *  (Default: Daily at midnight)
    SCHEDULE: "0 0 * * *"
};

// Copy-on-Write (COW) Grid performance thresholds
let COW_PERFORMANCE = {
    MAX_REBALANCE_PLANNING_MS: 100,
    MAX_COMMIT_MS: 50,
    MAX_MEMORY_MB: 50,
    INDEX_REBUILD_THRESHOLD: 10000,
    GRID_MEMORY_WARNING: 5000,
    GRID_MEMORY_CRITICAL: 10000,

    // WORKING_GRID_BYTES_PER_ORDER: Estimated memory usage per order in working grid (bytes).
    // Used for memory profiling and warning thresholds.
    // Default: 500 bytes (includes order object, metadata, and overhead).
    WORKING_GRID_BYTES_PER_ORDER: 500
};

// --- LOCAL SETTINGS OVERRIDES ---
// Load user-defined settings from profiles/general.settings.json if it exists.
// This allows preserving settings during updates without git stashing.
const settings = readGeneralSettings({
    fallback: null,
    onError: (err, filePath) => {
        console.warn(`[WARN] Failed to load local settings from ${filePath}: ${err.message}`);
    }
});

if (settings) {
    if (settings.LOG_LEVEL) LOG_LEVEL = settings.LOG_LEVEL;

    if (settings.TIMING) {
        // Filter out comment fields (keys starting with _) before merging
        const timingSettings = Object.fromEntries(
            Object.entries(settings.TIMING).filter(([key]) => !key.startsWith('_'))
        );
        TIMING = { ...TIMING, ...timingSettings };
    }

    if (settings.GRID_LIMITS) {
        const gridSettings = settings.GRID_LIMITS;
        // Filter out comment fields before merging
        const filteredGridSettings = Object.fromEntries(
            Object.entries(gridSettings).filter(([key]) => !key.startsWith('_'))
        );
        const cleanGridSettings = migrateDustCancelDelaySettings(filteredGridSettings);

        GRID_LIMITS = {
            ...GRID_LIMITS,
            ...cleanGridSettings,
            GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON, ...(cleanGridSettings.GRID_COMPARISON || {}) }
        };
    }

    // Load expert settings (for advanced troubleshooting)
    if (settings.FILL_PROCESSING) {
        const fillSettings = Object.fromEntries(
            Object.entries(settings.FILL_PROCESSING).filter(([key]) => !key.startsWith('_'))
        );
        FILL_PROCESSING = { ...FILL_PROCESSING, ...fillSettings };
    }

    if (settings.PIPELINE_TIMING) {
        const pipelineSettings = Object.fromEntries(
            Object.entries(settings.PIPELINE_TIMING).filter(([key]) => !key.startsWith('_'))
        );
        PIPELINE_TIMING = { ...PIPELINE_TIMING, ...pipelineSettings };
    }

    if (settings.EXPERT) {
        if (settings.EXPERT.GRID_LIMITS) {
            const filteredExpertGridSettings = Object.fromEntries(
                Object.entries(settings.EXPERT.GRID_LIMITS).filter(([key]) => !key.startsWith('_'))
            );
            const expertGridSettings = migrateDustCancelDelaySettings(filteredExpertGridSettings);
            GRID_LIMITS = { ...GRID_LIMITS, ...expertGridSettings };
        }
        if (settings.EXPERT.TIMING) {
            const expertTimingSettings = Object.fromEntries(
                Object.entries(settings.EXPERT.TIMING).filter(([key]) => !key.startsWith('_'))
            );
            TIMING = { ...TIMING, ...expertTimingSettings };
        }
    }

    if (settings.DEFAULT_CONFIG) {
        DEFAULT_CONFIG = { ...DEFAULT_CONFIG, ...settings.DEFAULT_CONFIG };
    }

    if (settings.UPDATER) {
        UPDATER = { ...UPDATER, ...settings.UPDATER };
    }

    if (settings.LOGGING_CONFIG) {
        // Deep merge logging config to preserve defaults not specified in settings
        const mergeConfig = (target, source) => {
            for (const key in source) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    target[key] = { ...target[key], ...source[key] };
                    mergeConfig(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }
            return target;
        };
        LOGGING_CONFIG = mergeConfig({ ...LOGGING_CONFIG }, settings.LOGGING_CONFIG);
    }
}

// Freeze objects to prevent accidental runtime modifications
Object.freeze(ORDER_TYPES);
Object.freeze(ORDER_STATES);
Object.freeze(REBALANCE_STATES);
Object.freeze(COW_ACTIONS);
Object.freeze(TIMING);
Object.freeze(GRID_LIMITS);
Object.freeze(GRID_LIMITS.GRID_COMPARISON);
Object.freeze(INCREMENT_BOUNDS);
Object.freeze(FEE_PARAMETERS);
Object.freeze(API_LIMITS);
Object.freeze(FILL_PROCESSING);
Object.freeze(MAINTENANCE);
Object.freeze(NODE_MANAGEMENT);
Object.freeze(PIPELINE_TIMING);
Object.freeze(UPDATER);
Object.freeze(COW_PERFORMANCE);
Object.freeze(LOGGING_CONFIG);
Object.freeze(MARKET_ADAPTER.RUNTIME_DEFAULTS);
Object.freeze(MARKET_ADAPTER.AMAS.AMA1);
Object.freeze(MARKET_ADAPTER.AMAS.AMA2);
Object.freeze(MARKET_ADAPTER.AMAS.AMA3);
Object.freeze(MARKET_ADAPTER.AMAS.AMA4);
Object.freeze(MARKET_ADAPTER.AMAS);
Object.freeze(MARKET_ADAPTER);

module.exports = { ORDER_TYPES, ORDER_STATES, REBALANCE_STATES, COW_ACTIONS, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, LOGGING_CONFIG, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE, NODE_MANAGEMENT, PIPELINE_TIMING, UPDATER, COW_PERFORMANCE, MARKET_ADAPTER };
