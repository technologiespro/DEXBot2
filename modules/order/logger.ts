// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const Format = require('./format');
const LoggerState = require('./logger_state');
const { LOGGING_CONFIG, ORDER_STATES } = require('../constants');

/**
 * modules/order/logger.js - Logger Engine
 *
 * Color-coded console logger for OrderManager with structured output and optional file logging.
 * Exports a single Logger class that manages all logging operations.
 *
 * Provides:
 * - Log levels: debug, info, warn, error with color coding
 * - Color coding for order types (buy=green, sell=red, spread=yellow, partial=blue)
 * - Color coding for order states (virtual=gray, active=green)
 * - Formatted order grid display (sample with sell/spread/buy sections)
 * - Fund status display with smart change detection
 * - Configuration-driven output (enable/disable categories)
 * - Comprehensive status summaries and grid diagnostics
 * - Optional file logging (separate logFile per logger instance)
 *
 * Configuration (LOGGING_CONFIG in constants.js):
 * - changeTracking: Smart detection of changes (only log what changed)
 * - display.colors.enabled: Force colors on/off (null = auto-detect TTY)
 * - display.fundStatus: Enable/disable fund status display
 * - display.statusSummary: Enable/disable comprehensive status summaries
 * - display.gridDiagnostics: Enable/disable detailed grid diagnostics
 *
 * Fund Structure Display:
 * - available: Free funds for new orders (chainFree - virtual - fees - reservations)
 * - total.chain: chainFree + committed.chain (on-chain balance)
 * - total.grid: committed.grid + virtual (grid allocation)
 * - virtual: VIRTUAL order sizes (reserved for future placement)
 * - committed.grid: ACTIVE order sizes (internal tracking)
 * - committed.chain: ACTIVE orders with orderId (confirmed on-chain)
 *
 * @class
 */

class Logger {
    level: string;
    config: any;
    category: string;
    quiet: boolean;
    logFile: any;
    state: any;
    levels: { debug: number; info: number; warn: number; error: number };
    colors: any;
    marketName: any;

    /**
     * Create a new Logger instance.
     * Auto-quiets console output under PM2 when PM2 log paths are configured
     * (PM2 captures stdout/stderr, so console output would duplicate file logs).
     * @param {string} [category='DEXBot'] - Logger category/prefix
     * @param {Object} [options={}] - Logger options
     * @param {boolean} [options.quiet] - Suppress console output
     * @param {boolean} [options.quietUnderPm2=true] - Auto-quiet under PM2 (default true)
     * @param {string} [options.logFile] - Optional path to log file
     * @param {string} [options.level='info'] - Log level (debug, info, warn, error)
     * @param {Object} [options.configOverride] - Override LOGGING_CONFIG
     */
    constructor(category = 'DEXBot', options = {}) {
        this.category = category;

        // Auto-quiet under PM2 when PM2 log paths are configured to prevent
        // duplicate output (PM2 captures stdout/stderr to files already).
        const isUnderPm2 = !!process.env.pm_exec_path;
        const hasPm2Logging = !!(process.env.pm_out_log_path || process.env.pm_err_log_path);
        const pm2AutoQuiet = isUnderPm2 && hasPm2Logging;
        const quietUnderPm2 = options.quietUnderPm2 !== false;

        this.quiet = options.quiet || (quietUnderPm2 && pm2AutoQuiet);
        this.logFile = options.logFile || null;
        this.level = options.level || 'info';
        this.config = options.configOverride || LOGGING_CONFIG;

        // Initialize change tracking
        this.state = new LoggerState();

        // Log levels mapping
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };

        // Only use colors if stdout is a TTY (terminal), not when piped to files
        let useColors = process.stdout.isTTY;
        if (this.config.display?.colors?.enabled === false) {
            useColors = false;
        } else if (this.config.display?.colors?.enabled === true) {
            useColors = true;
        }

        this.colors = useColors ? {
            reset: '\x1b[0m',
            buy: '\x1b[32m', sell: '\x1b[31m', spread: '\x1b[33m',
            debug: '\x1b[36m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m',
            virtual: '\x1b[90m', active: '\x1b[32m', partial: '\x1b[34m'
        } : {
            reset: '', buy: '', sell: '', spread: '',
            debug: '', info: '', warn: '', error: '',
            virtual: '', active: '', partial: ''
        };

        this.marketName = null;
    }

    /**
     * Write output to file (appends). Strips ANSI color codes.
     * Creates parent directory if needed.
     * @param {string} text - Text to write to log file
     * @private
     */
    _writeToFile(text) {
        if (!this.logFile) return;
        if (isPm2LoggingEnabled()) return;
        const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
        try {
            // Ensure directory exists
            const dir = path.dirname(this.logFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.appendFileSync(this.logFile, plainText + '\n', 'utf8');
        } catch (err: any) {
            // Silently fail on file write errors to avoid disrupting main flow
        }
    }

    /**
     * Log a message with optional timestamp and level.
     * Detects PM2 environment and disables timestamp to avoid duplication
     * (PM2 adds its own timestamp via log_date_format).
     * @param {string} message - The message to log.
     * @param {string} [level='info'] - The log level ('debug', 'info', 'warn', 'error').
     */
    log(message, level = 'info') {
        if (this.levels[level] >= this.levels[this.level]) {
            const color = this.colors[level] || '';
            // Check if running under PM2 (pm_exec_path is set by PM2)
            const isUnderPm2 = !!process.env.pm_exec_path;
            const timestamp = isUnderPm2 ? '' : new Date().toISOString();
            const timestampPart = timestamp ? `[${timestamp}] ` : '';
            const output = `${color}${timestampPart}[${level.toUpperCase()}] [${this.category}] ${message}${this.colors.reset}`;

            if (!this.quiet) {
                if (level === 'error') {
                    console.error(output);
                } else if (level === 'warn') {
                    console.warn(output);
                } else {
                    console.log(output);
                }
            }
            this._writeToFile(output);
        }
    }

    /**
     * Log at info level.
     * @param {string} msg - Message to log
     */
    info(msg) { this.log(msg, 'info'); }

    /**
     * Log at warn level.
     * @param {string} msg - Message to log
     */
    warn(msg) { this.log(msg, 'warn'); }

    /**
     * Log at error level.
     * @param {string} msg - Message to log
     */
    error(msg) { this.log(msg, 'error'); }

    /**
     * Log at debug level.
     * @param {string} msg - Message to log
     */
    debug(msg) { this.log(msg, 'debug'); }

    /**
     * Write raw output (no timestamp, no level).
     * @param {string} text - Text to write
     */
    raw(text) {
        if (!this.quiet) {
            process.stdout.write(text);
        }
        this._writeToFile(text);
    }

    /**
     * Log a sample of the order grid.
     * @param {Array<Object>} orders - The list of orders.
     * @param {number} startPrice - The market start price.
     */
    logOrderGrid(orders, startPrice) {
        const header = '\n===== ORDER GRID (SAMPLE) =====';
        let output = header + '\n';
        if (this.marketName) output += `Market: ${this.marketName} @ ${startPrice}\n`;
        output += 'Price       Slot      Type      State       Size\n';
        output += '----------------------------------------------------\n';

        if (!this.quiet) console.log(header);
        if (this.marketName && !this.quiet) console.log(`Market: ${this.marketName} @ ${startPrice}`);
        if (!this.quiet) console.log('Price       Slot      Type      State       Size');
        if (!this.quiet) console.log('----------------------------------------------------');

        const sorted = [...orders].sort((a, b) => b.price - a.price);

        // Separate by type
        const allSells = sorted.filter(o => o.type === 'sell');
        const allSpreads = sorted.filter(o => o.type === 'spread');
        const allBuys = sorted.filter(o => o.type === 'buy');

        // SELL: top 3 (highest prices, edge) + last 3 (lowest prices, next to spread)
        const sellEdge = allSells.slice(0, 3);
        const sellNearSpread = allSells.slice(-3);
        [...sellEdge, ...sellNearSpread].forEach(order => this._logOrderRow(order));

        // SPREAD: high, middle, low with gap indicators
        if (allSpreads.length > 0) {
            const highIdx = 0;
            const midIdx = Math.floor(allSpreads.length / 2);
            const lowIdx = allSpreads.length - 1;

            const high = allSpreads[highIdx];
            const mid = (allSpreads.length > 2) ? allSpreads[midIdx] : null;
            const low = allSpreads[lowIdx];

            this._logOrderRow(high);
            if (mid) {
                if (midIdx > highIdx + 1) { if (!this.quiet) console.log(''); output += '\n'; }
                this._logOrderRow(mid);
                if (lowIdx > midIdx + 1) { if (!this.quiet) console.log(''); output += '\n'; }
            } else if (lowIdx > highIdx + 1) {
                if (!this.quiet) console.log(''); output += '\n';
            }

            if (low.id !== high.id) {
                this._logOrderRow(low);
            }
        }

        // BUY: top 3 (highest prices, next to spread) + last 3 (lowest prices, edge)
        const buyNearSpread = allBuys.slice(0, 3);
        const buyEdge = allBuys.slice(-3);
        [...buyNearSpread, ...buyEdge].forEach(order => this._logOrderRow(order));

        const footer = '===============================================\n';
        if (!this.quiet) console.log(footer);
        this._writeToFile(output + footer);
    }

    /**
     * Log a single order row.
     * @param {Object} order - The order to log.
     * @private
     */
    _logOrderRow(order) {
        const typeColor = this.colors[order.type] || '';
        const stateColor = this.colors[order.state] || '';
        const price = Format.formatPrice4(order.price).padEnd(12);
        const id = (order.id || '').padEnd(10);
        const type = order.type.padEnd(10);
        const state = order.state.padEnd(12);
        const size = Format.formatAmount8(order.size);
        const output = `${price}${id}${typeColor}${type}${this.colors.reset}${stateColor}${state}${this.colors.reset}${size}`;

        if (!this.quiet) {
            console.log(output);
        }
        this._writeToFile(output);
    }

    /**
     * Print a summary of fund status for diagnostics with optional context.
     *
     * @param {OrderManager} manager - OrderManager instance to read funds from
     * @param {string} context - Optional context string (e.g., "AFTER fill", "BEFORE rotation")
     * @param {boolean} forceDetailed - Force detailed output even for non-critical events
     */
    logFundsStatus(manager, context = '', forceDetailed = false) {
        if (!manager) return;
        if (!this.config.display?.fundStatus?.enabled && !forceDetailed) return;

        const isDebugMode = this.level === 'debug';
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const headerContext = context ? ` [${context}]` : '';

        const fundState = {
            availableBuy: manager.funds?.available?.buy,
            availableSell: manager.funds?.available?.sell,
            btsFeesOwed: manager.funds?.btsFeesOwed
        };

        const isCriticalEvent = forceDetailed ||
            context.includes('fill') ||
            context.includes('order_created') ||
            context.includes('order_cancelled') ||
            context.includes('anomaly') ||
            context.includes('violation') ||
            context.includes('ERROR');

        // Use change detection: only log if funds changed
        if (this.config.changeTracking?.enabled) {
            const { isNew, changes } = this.state.detectChanges('funds', fundState);
            if (!isNew && !Object.keys(changes).length && !isCriticalEvent) {
                return;
            }
        }

        const buyPrecision = manager.config?.assetB?.precision || 8;
        const sellPrecision = manager.config?.assetA?.precision || 8;
        const availableBuy = Number.isFinite(Number(manager.funds?.available?.buy))
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const availableSell = Number.isFinite(Number(manager.funds?.available?.sell))
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const c = this.colors;
        const buy = c.buy;
        const sell = c.sell;
        const reset = c.reset;

        const output = `Funds${headerContext}: ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`;
        this.log(output.replace(/\x1b\[[0-9;]*m/g, ''), 'info');

        // Show detailed breakdown in debug mode on critical events
        if (isDebugMode && isCriticalEvent && this.config.display?.fundStatus?.showDetailed) {
            this._logDetailedFunds(manager, headerContext);
        }
    }

    /**
     * Log detailed fund breakdown (called only on critical events in debug mode).
     * @param {OrderManager} manager - Manager instance
     * @param {string} [headerContext=''] - Context label for log header
     * @private
     */
    _logDetailedFunds(manager, headerContext = '') {
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const buyPrecision = manager.config?.assetB?.precision || 8;
        const sellPrecision = manager.config?.assetA?.precision || 8;
        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        const availableBuy = Number.isFinite(Number(manager.funds?.available?.buy))
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const availableSell = Number.isFinite(Number(manager.funds?.available?.sell))
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;
        const btsFeesOwed = manager.funds?.btsFeesOwed ?? 0;

        const lines = [
            `\n${debug}=== DETAILED FUNDS STATUS${headerContext} ===${reset}`,
            `${debug}AVAILABLE:${reset}`,
            `  ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`,
            `\n${debug}CHAIN BALANCES:${reset}`,
            `  total.chain: ${buy}Buy ${Format.formatAmountByPrecision(totalChainBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(totalChainSell, sellPrecision)}${reset}`,
            `\n${debug}GRID ALLOCATIONS:${reset}`,
            `  total.grid: ${buy}Buy ${Format.formatAmountByPrecision(totalGridBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(totalGridSell, sellPrecision)}${reset}`,
            `  committed.grid: ${buy}Buy ${Format.formatAmountByPrecision(committedGridBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(committedGridSell, sellPrecision)}${reset}`,
            `  virtual (reserved): ${buy}Buy ${Format.formatAmountByPrecision(virtualBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(virtualSell, sellPrecision)}${reset}`,
            `\n${debug}COMMITTED ON-CHAIN:${reset}`,
            `  ${buy}Buy ${Format.formatAmountByPrecision(committedChainBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(committedChainSell, sellPrecision)}${reset}`,
            `\n${debug}DEDUCTIONS:${reset}`,
            `  btsFeesOwed: ${Format.formatAmount8(btsFeesOwed)} BTS${reset}\n`
        ];

        lines.forEach(line => {
            if (!this.quiet) console.log(line);
            this._writeToFile(line);
        });
    }

    /**
     * Print a comprehensive status summary using manager state.
     * @param {OrderManager} manager - The manager instance.
     * @param {boolean} forceOutput - Force output even if disabled in config
     */
    displayStatus(manager, forceOutput = false) {
        if (!manager) return;
        if (!this.config.display?.statusSummary?.enabled && !forceOutput) return;

        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.ACTIVE) || [];
        const partialOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.PARTIAL) || [];
        const virtualOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.VIRTUAL) || [];

        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const buyPrecision = manager.config?.assetB?.precision || 8;
        const sellPrecision = manager.config?.assetA?.precision || 8;

        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy))
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell))
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        const lines = [
            '\n===== STATUS =====',
            `Market: ${market}`,
            `funds.available: ${buy}Buy ${gridBuy}${reset} ${buyName} | ${sell}Sell ${gridSell}${reset} ${sellName}`,
            `total.chain: ${buy}Buy ${Format.formatAmountByPrecision(totalChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(totalChainSell, sellPrecision)}${reset} ${sellName}`,
            `total.grid: ${buy}Buy ${Format.formatAmountByPrecision(totalGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(totalGridSell, sellPrecision)}${reset} ${sellName}`,
            `virtual.grid: ${buy}Buy ${Format.formatAmountByPrecision(virtualBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(virtualSell, sellPrecision)}${reset} ${sellName}`,
            `committed.grid: ${buy}Buy ${Format.formatAmountByPrecision(committedGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(committedGridSell, sellPrecision)}${reset} ${sellName}`,
            `committed.chain: ${buy}Buy ${Format.formatAmountByPrecision(committedChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(committedChainSell, sellPrecision)}${reset} ${sellName}`,
            `Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Partial ${partialOrders.length}`,
            `Spreads: ${manager.currentSpreadCount}/${manager.targetSpreadCount}`,
        ];

        if (typeof manager.calculateCurrentSpread === 'function') {
            const spread = manager.calculateCurrentSpread();
            lines.push(`Current Spread: ${Format.formatPercent2(spread)}%`);
        }

        lines.push(`Spread Condition: ${manager.outOfSpread > 0 ? 'TOO WIDE (' + manager.outOfSpread + ')' : 'Normal'}`);

        lines.forEach(line => {
            if (!this.quiet) console.log(line);
            this._writeToFile(line);
        });
    }

    /**
     * Log detailed grid diagnostic: ACTIVE, SPREAD, PARTIAL orders and first VIRTUAL on boundary
     * @param {OrderManager} manager - Manager instance
     * @param {string} [context=''] - Context label
     * @param {boolean} [forceOutput=false] - Force output even if disabled in config
     */
    logGridDiagnostics(manager, context = '', forceOutput = false) {
        if (!manager) return;
        if (!this.config.display?.gridDiagnostics?.enabled && !forceOutput) return;

        const { ORDER_TYPES, ORDER_STATES } = require('../constants');
        const c = this.colors;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;
        const active = c.active;
        const spread = c.spread;
        const partial = c.partial;
        const virtual = c.virtual;

        const allOrders = Array.from(manager.orders?.values?.() || []).sort((a, b) => b.price - a.price);

        const activeOrders = allOrders.filter(o => o.state === ORDER_STATES.ACTIVE);
        const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY);
        const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL);

        const spreadOrders = allOrders.filter(o => o.type === ORDER_TYPES.SPREAD && o.state === ORDER_STATES.VIRTUAL);
        const partialOrders = allOrders.filter(o => o.state === ORDER_STATES.PARTIAL);

        const virtualOrders = allOrders.filter(o => o.state === ORDER_STATES.VIRTUAL && o.type !== ORDER_TYPES.SPREAD);
        const firstVirtualSell = virtualOrders.find(o => o.type === ORDER_TYPES.SELL);
        const firstVirtualBuy = virtualOrders.find(o => o.type === ORDER_TYPES.BUY);

        const ctxStr = context ? ` [${context}]` : '';
        const header = `\n${spread}=== GRID DIAGNOSTICS${ctxStr} ===${reset}`;

        const lines = [header];
        lines.push(`\n${active}ACTIVE ORDERS${reset}: ${buy}Buy=${activeBuys.length}${reset}, ${sell}Sell=${activeSells.length}${reset}`);

        if (activeBuys.length > 0) {
            lines.push(`  ${buy}BUY:${reset}  ${activeBuys.map(o => `${o.id}@${Format.formatPrice4(o.price)}`).join(', ')}`);
        }
        if (activeSells.length > 0) {
            lines.push(`  ${sell}SELL:${reset} ${activeSells.map(o => `${o.id}@${Format.formatPrice4(o.price)}`).join(', ')}`);
        }

        lines.push(`\n${spread}SPREAD PLACEHOLDERS${reset}: ${spreadOrders.length}`);
        if (spreadOrders.length > 0) {
            for (const order of spreadOrders) {
                const isBoundary = (order === firstVirtualBuy || order === firstVirtualSell);
                const boundaryMarker = isBoundary ? ' ← BOUNDARY' : '';
                lines.push(`  ${spread}${order.id}@${Format.formatPrice4(order.price)}${boundaryMarker}${reset}`);
            }
        }

        lines.push(`\n${partial}PARTIAL ORDERS${reset}: ${partialOrders.length}`);
        if (partialOrders.length > 0) {
            for (const order of partialOrders) {
                lines.push(`  ${partial}${order.id}@${Format.formatPrice4(order.price)} size=${Format.formatSizeByOrderType(order.size, order.type, manager.assets)}${reset}`);
            }
        }

        lines.push(`\n${virtual}FIRST VIRTUAL ON BOUNDARY${reset}:`);
        if (firstVirtualSell) {
            lines.push(`  ${virtual}SELL: ${firstVirtualSell.id}@${Format.formatPrice4(firstVirtualSell.price)}${reset}`);
        } else {
            lines.push(`  ${virtual}SELL: (none)${reset}`);
        }
        if (firstVirtualBuy) {
            lines.push(`  ${virtual}BUY:  ${firstVirtualBuy.id}@${Format.formatPrice4(firstVirtualBuy.price)}${reset}`);
        } else {
            lines.push(`  ${virtual}BUY:  (none)${reset}`);
        }

        lines.forEach(line => {
            if (!this.quiet) console.log(line);
            this._writeToFile(line);
        });
    }
}

/**
 * Check if the current process is running under PM2.
 * @returns {boolean} True if pm_exec_path is set
 */
function isPm2Runtime() {
    return !!process.env.pm_exec_path;
}

/**
 * Check if PM2 logging is configured (output/error log paths are set).
 * @returns {boolean} True if pm_out_log_path or pm_err_log_path is set
 */
function isPm2LoggingEnabled() {
    return !!(process.env.pm_out_log_path || process.env.pm_err_log_path);
}

/**
 * Create a Logger instance with PM2 awareness (auto-quiets under PM2).
 * The constructor already handles this by default; this function exists
 * for backward compatibility.
 * @param {string} category - Logger category/prefix
 * @param {Object} [options] - Logger options (quietUnderPm2 is consumed here)
 * @returns {Logger} Configured Logger instance
 */
function createPm2AwareLogger(category, options = {}) {
    return new Logger(category, { ...options });
}

export = Object.assign(Logger, {
    Logger,
    isPm2Runtime,
    isPm2LoggingEnabled,
    createPm2AwareLogger
});
