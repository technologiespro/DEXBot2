const assert = require('assert');

const adapterPath = require.resolve('../market_adapter/utils/adapter_client');
const nativePath = require.resolve('../modules/bitshares-native');

async function main() {
    const originalNativeEntry = require.cache[nativePath];
    const originalFlag = process.env.DEXBOT_NATIVE_CHAIN;
    let connectArg = null;
    let disconnectCalls = 0;

    process.env.DEXBOT_NATIVE_CHAIN = '1';
    delete require.cache[adapterPath];
    require.cache[nativePath] = {
        id: nativePath,
        filename: nativePath,
        loaded: true,
        exports: {
            createReadOnlyClient: () => ({
                connect: async (nodes) => {
                    connectArg = Array.isArray(nodes) ? nodes.slice() : nodes;
                },
                disconnect: () => {
                    disconnectCalls += 1;
                },
                db: async () => null,
                history: async () => null,
                getNodeUrl: () => null,
                isConnected: () => false,
                setNodes: () => {},
                getNodes: () => [],
            }),
        },
    } as any;

    try {
        const adapter = require('../market_adapter/utils/adapter_client');
        const testNodes = ['wss://node-a.example/ws', 'wss://node-b.example/ws'];

        await adapter.connectClient(testNodes);
        assert.deepStrictEqual(connectArg, testNodes, 'native adapter should forward the caller node list to the read-only client');

        adapter.disconnectClient();
        assert.strictEqual(disconnectCalls, 1, 'disconnect should propagate to the native read-only client');

        console.log('adapter client native tests passed');
    } finally {
        delete require.cache[adapterPath];
        if (originalNativeEntry) {
            require.cache[nativePath] = originalNativeEntry;
        } else {
            delete require.cache[nativePath];
        }
        if (originalFlag === undefined) {
            delete process.env.DEXBOT_NATIVE_CHAIN;
        } else {
            process.env.DEXBOT_NATIVE_CHAIN = originalFlag;
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
