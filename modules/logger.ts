'use strict';

/**
 * modules/logger.ts - Centralized Logger Hub
 *
 * Auto-selects between the full Node Logger (with file I/O) and a minimal
 * browser-safe Logger (console only) based on environment detection.
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
 *   - correlationId: {string} Optional correlation ID for request tracing
 */

const { isBrowser } = require('./env');

if (isBrowser()) {
    const levelValues: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };

    class BrowserLogger {
        level: string;
        quiet: boolean;
        category: string;
        levels: Record<string, number>;
        colors: Record<string, string>;

        constructor(category = 'DEXBot', options: any = {}) {
            this.category = category;
            this.level = options.level || 'info';
            this.quiet = options.quiet ?? !!options.logFile;
            this.levels = levelValues;
            this.colors = {
                reset: '', buy: '', sell: '', spread: '',
                debug: '', info: '', warn: '', error: '', critical: '',
                virtual: '', active: '', partial: ''
            };
        }

        log(message: string, level = 'info') {
            if (this.levels[level] >= this.levels[this.level] && !this.quiet) {
                const ts = new Date().toISOString();
                console.log(`[${ts}] [${level.toUpperCase()}] [${this.category}] ${message}`);
            }
        }

        debug(message: string) { this.log(message, 'debug'); }
        info(message: string) { this.log(message, 'info'); }
        warn(message: string) { this.log(message, 'warn'); }
        error(message: string) { this.log(message, 'error'); }
        critical(message: string) { this.log(message, 'critical'); }
        flush() { return Promise.resolve(); }
        setMarketName() {}
        logFunds() {}
        logGridDiagnostics() {}
    }

    module.exports = BrowserLogger;
} else {
    module.exports = require('./order/logger');
}
