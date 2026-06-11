function createTestLogger({ onLog = null, includeFundsStatus = true } = {}) {
    const logger = {
        log: typeof onLog === 'function' ? onLog : () => {},
    };
    if (includeFundsStatus) {
        (logger as any).logFundsStatus = () => {};
    }
    return logger;
}

function createSilentLogger() {
    return createTestLogger();
}

module.exports = {
    createTestLogger,
    createSilentLogger,
} as any;
