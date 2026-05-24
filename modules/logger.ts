'use strict';

/**
 * modules/logger.js - Centralized Logger Hub
 *
 * Re-exports the comprehensive Logger from modules/order/logger.js as the centralized
 * logging system for all components (bot operations, market adapter, diagnostics, etc.).
 *
 * Usage:
 *   // Bot operation logging (console only)
 *   const Logger = require('./modules/logger');
 *   const logger = new Logger('MyComponent');
 *   logger.info('Starting bot');
 *
 *   // Market adapter / dryrun logging (to separate file)
 *   const logger = new Logger('MarketAdapter', { logFile: './logs/market_adapter.log' });
 *   logger.info('Processing bot');
 *
 *   // Quiet mode (for tests)
 *   const logger = new Logger('Test', { quiet: true });
 *
 * Constructor Options:
 *   - category: {string} Logger prefix (e.g., 'DEXBot', 'MarketAdapter')
 *   - quiet: {boolean} Suppress console output (default false)
 *   - logFile: {string} Path to optional log file (appends output)
 *   - level: {string} Log level: 'debug', 'info', 'warn', 'error' (default 'info')
 *   - configOverride: {Object} Override LOGGING_CONFIG from constants
 */

export = require('./order/logger');
