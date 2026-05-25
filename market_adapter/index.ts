/**
 * market_adapter/index.ts — Market Adapter Subsystem Entry Point
 *
 * Barrel export that consolidates the market adapter's public API.
 * Consumers can import from this index instead of targeting internal file paths.
 *
 * ===============================================================================
 * EXPORTS
 * ===============================================================================
 *
 * MAIN ADAPTER:
 * - MarketAdapterService   — Core price adapter service (core/market_adapter_service)
 * - market_adapter          — Top-level orchestrator (runOnceForAma, DEFAULTS, resolveBotCfg, etc.)
 *
 * CANDLE & INTERVAL UTILITIES:
 * - candle_utils            — Candle gap filling, merging
 * - interval_utils          — Shared interval label helper (toIntervalLabel)
 *
 * KIBANA / DATA SOURCES:
 * - kibana_client           — ES/Kibana search (kibanaSearch)
 * - kibana_market_candles   — Market candle queries (getMarketCandles, getMarketClosePrices)
 * - kibana_candles          — Lower-level Kibana document query helpers
 * - kibana_source           — LP candle data source from Kibana
 * - fetch_lp_data           — LP data fetching utilities
 *
 * AMA & STRATEGY CORE:
 * - ama                     — AMA calculation (calculateAMA, getAmaWarmupBars)
 * - ama_slope_model         — Slope weight computation
 * - regime_gate             — Regime multiplier and interpolation
 * - atr_calculator          — ATR calculation
 * - asymmetric_bounds       — Asymmetric grid bounds applyAsymmetricBounds
 * - config_normalizers      — ATR/volatility parameter normalizers
 *
 * CHARTING:
 * - lp_chart_core           — generateHTML for LP chart rendering
 * - lp_chart_runner         — LP chart orchestration (load, generate, save)
 * - lp_chart_strategy_loader — Strategy loading for charts
 *
 * UTILITIES:
 * - adapter_client          — BitShares client connection (connectClient, disconnectClient)
 * - chain                   — Market source / asset resolution helpers
 * - native_history          — Native market history normalization
 * - file_lock               — Cross-process file locking
 * - data_discovery          — LP data file discovery
 * - dynamic_grid_snapshot   — Live dynamic grid snapshot sync
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 *   const { MarketAdapterService, runOnceForAma, calculateAMA } = require('./market_adapter');
 *
 * ===============================================================================
 * NOTE
 * ===============================================================================
 *
 * CLI-only scripts (merge_lp_data, ama_signal_runner) are NOT exported here
 * since they are standalone entry points, not library modules.
 */

// ── Main adapter ───────────────────────────────────────────────────────────────
const adapter = require('./market_adapter');
const { MarketAdapterService } = require('./core/market_adapter_service');

// ── Candle / interval utils ────────────────────────────────────────────────────
const candleUtils = require('./candle_utils');
const intervalUtils = require('./interval_utils');

// ── Kibana / data sources ──────────────────────────────────────────────────────
const kibanaClient = require('./core/kibana_client');
const kibanaMarketCandles = require('./core/kibana_market_candles');
const kibanaCandles = require('./core/kibana_candles');
const kibanaSource = require('./inputs/kibana_source');
const fetchLpData = require('./inputs/fetch_lp_data');

// ── AMA & strategy core ────────────────────────────────────────────────────────
const ama = require('./core/strategies/ama');
const amaSlope = require('./core/strategies/ama_slope_model');
const regimeGate = require('./core/strategies/regime_gate');
const atrCalc = require('./core/strategies/atr/calculator');
const asymBounds = require('./core/asymmetric_bounds');
const configNormalizers = require('./core/config_normalizers');

// ── Charting ────────────────────────────────────────────────────────────────────
const lpChartCore = require('./lp_chart_core');
const lpChartRunner = require('./lp_chart_runner');
const lpChartStrategyLoader = require('./lp_chart_strategy_loader');

// ── Utilities ───────────────────────────────────────────────────────────────────
const adapterClient = require('./utils/adapter_client');
const chainUtils = require('./utils/chain');
const nativeHistory = require('./utils/native_history');
const fileLock = require('./utils/file_lock');
const dataDiscovery = require('./utils/data_discovery');
const dynamicGridSnapshot = require('./utils/dynamic_grid_snapshot');

// Note: test_helpers excluded — only consumed by test files referencing explicit paths.

export = {
    // Main adapter
    MarketAdapterService,
    ...adapter,

    // Candle / interval utils
    candle_utils: candleUtils,
    interval_utils: intervalUtils,

    // Kibana / data sources
    kibana_client: kibanaClient,
    kibana_market_candles: kibanaMarketCandles,
    kibana_candles: kibanaCandles,
    kibana_source: kibanaSource,
    fetch_lp_data: fetchLpData,

    // AMA & strategy core
    ama,
    ama_slope_model: amaSlope,
    regime_gate: regimeGate,
    atr_calculator: atrCalc,
    asymmetric_bounds: asymBounds,
    config_normalizers: configNormalizers,

    // Charting
    lp_chart_core: lpChartCore,
    lp_chart_runner: lpChartRunner,
    lp_chart_strategy_loader: lpChartStrategyLoader,

    // Utilities
    adapter_client: adapterClient,
    chain: chainUtils,
    native_history: nativeHistory,
    file_lock: fileLock,
    data_discovery: dataDiscovery,
    dynamic_grid_snapshot: dynamicGridSnapshot,
};
