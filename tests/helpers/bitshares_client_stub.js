function installBitsharesClientStub(modulePath) {
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports: {
            BitShares: {
                subscribe() {}
            },
            waitForConnected: async () => {},
            createAccountClient: () => ({}),
            setSuppressConnectionLog() {},
            getNodeManager: () => null,
            getNodeStats: () => null,
            getNodeSummary: () => null,
            _internal: { connected: true }
        }
    };
}

module.exports = {
    installBitsharesClientStub,
};
