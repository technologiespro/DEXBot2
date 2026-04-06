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
 *   const logger = new Logger('PriceAdapter', { logFile: './logs/price_adapter.log' });
 *   logger.info('Processing bot');
 *
 *   // Quiet mode (for tests)
 *   const logger = new Logger('Test', { quiet: true });
 *
 * Constructor Options:
 *   - category: {string} Logger prefix (e.g., 'DEXBot', 'PriceAdapter')
 *   - quiet: {boolean} Suppress console output (default false)
 *   - logFile: {string} Path to optional log file (appends output)
 *   - level: {string} Log level: 'debug', 'info', 'warn', 'error' (default 'info')
 *   - configOverride: {Object} Override LOGGING_CONFIG from constants
 */

module.exports = require('./order/logger');
