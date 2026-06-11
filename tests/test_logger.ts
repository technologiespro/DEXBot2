const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
console.log('Running logger tests');

const Logger = require('../modules/order/index').logger;
const { createPm2AwareLogger } = require('../modules/logger');

// Capture console output by stream
let captured: any[] = [];
let capturedWarn: any[] = [];
let capturedError: any[] = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args) => { captured.push(args.join(' ')); };
console.warn = (...args) => { capturedWarn.push(args.join(' ')); };
console.error = (...args) => { capturedError.push(args.join(' ')); };

const logger = new Logger('Test', { level: 'debug' });
logger.marketName = 'TEST/PAIR';

// Should log when level is debug (and info > debug)
logger.log('hello world', 'info');
logger.log('debug message', 'debug');
logger.log('warning message', 'warn');
logger.log('error message', 'error');

// logOrderGrid should print header and market
const sampleOrders = [ { price: 100, type: 'buy', state: 'virtual', size: 1 }, { price: 200, type: 'sell', state: 'virtual', size: 2 } ];
logger.logOrderGrid(sampleOrders, 150);

// Test logFundsStatus and displayStatus using a small manager-like stub
const mgrStub = {
	marketName: 'TEST/PAIR',
	config: { assetA: 'BASE', assetB: 'QUOTE', market: 'TEST/PAIR' },
	funds: { available: { buy: 1.2345, sell: 2.3456 }, committed: { buy: 0.5, sell: 0.25 }, total: { buy: 10, sell: 20 } },
	currentSpreadCount: 2,
	targetSpreadCount: 3,
	outOfSpread: 0,
	getOrdersByTypeAndState: (type, state) => {
		if (state === 'active') return [1,2];
		if (state === 'partial') return [1];
		if (state === 'virtual') return [1,2,3,4];
		return [];
	},
	calculateCurrentSpread: () => 3.1415
};

logger.logFundsStatus(mgrStub, '', true);  // Force display for testing (forceDetailed=true)
logger.displayStatus(mgrStub, true);  // Force display for testing (forceOutput=true)

// Restore console.log
console.log = origLog;
console.warn = origWarn;
console.error = origError;

// Assertions
const joined = captured.join('\n');
assert(joined.includes('hello world'), 'should include the info message');
assert(joined.includes('debug message'), 'should include debug message');
assert.strictEqual(capturedWarn.length, 1, 'warn messages should use console.warn');
assert(capturedWarn[0].includes('warning message'), 'warn stream should include warning message');
assert.strictEqual(capturedError.length, 1, 'error messages should use console.error');
assert(capturedError[0].includes('error message'), 'error stream should include error message');
assert(joined.includes('ORDER GRID') || joined.includes('ORDER GRID'), 'should include ORDER GRID header');
assert(joined.includes('TEST/PAIR'), 'should include market name in grid');
// Ensure funds are displayed in the output
assert(joined.includes('funds.available') || joined.includes('Available'), 'should include available funds label');
assert(joined.includes('total.chain') || joined.includes('total.grid'), 'should include total funds labels');

const originalPmExecPath = process.env.pm_exec_path;
const originalPmOutLogPath = process.env.pm_out_log_path;
const originalPmErrLogPath = process.env.pm_err_log_path;
process.env.pm_exec_path = 'pm2';
process.env.pm_out_log_path = '/tmp/dexbot-test.log';
assert.strictEqual(createPm2AwareLogger('default').quiet, true, 'PM2-aware logger should auto-quiet when PM2 log paths are configured');
assert.strictEqual(createPm2AwareLogger('verbose', { quietUnderPm2: false }).quiet, false, 'PM2 quieting can be disabled with quietUnderPm2=false');

const pm2DirectLogFile = path.join(os.tmpdir(), `dexbot-logger-pm2-${process.pid}.log`);
try { fs.unlinkSync(pm2DirectLogFile); } catch (err) {}
const pm2Logger = new Logger('pm2-direct-file', { logFile: pm2DirectLogFile, quietUnderPm2: false, quiet: false });
let pm2Captured: any[] = [];
console.log = (...args) => { pm2Captured.push(args.join(' ')); };
pm2Logger.info('pm2 stdout should remain visible');
console.log = origLog;
assert(pm2Captured.some((line) => line.includes('pm2 stdout should remain visible')), 'PM2 logger should still emit stdout for PM2 capture');
assert(!pm2Captured.some((line) => /\d{4}-\d{2}-\d{2}T/.test(line)), 'PM2 logger should not add its own timestamp');
assert.strictEqual(fs.existsSync(pm2DirectLogFile), false, 'direct logger file writes should be suppressed when PM2 log paths are active');

if (originalPmExecPath === undefined) delete process.env.pm_exec_path;
else process.env.pm_exec_path = originalPmExecPath;
if (originalPmOutLogPath === undefined) delete process.env.pm_out_log_path;
else process.env.pm_out_log_path = originalPmOutLogPath;
if (originalPmErrLogPath === undefined) delete process.env.pm_err_log_path;
else process.env.pm_err_log_path = originalPmErrLogPath;

console.log('logger tests passed');
