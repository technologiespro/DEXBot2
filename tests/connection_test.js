'use strict';

const RUN_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
const CONNECT_TIMEOUT_MS = Number(process.env.BITSHARES_CONNECTION_TEST_TIMEOUT_MS) || 5000;

function formatError(error) {
    return error && error.message ? error.message : String(error);
}

function createRejectionGuard() {
    let rejectGuard;
    const guard = new Promise((_, reject) => {
        rejectGuard = reject;
    });

    const handler = (reason) => {
        rejectGuard(reason instanceof Error ? reason : new Error(formatError(reason)));
    };

    process.on('unhandledRejection', handler);

    return {
        guard,
        cleanup() {
            process.off('unhandledRejection', handler);
        }
    };
}

async function testConnection() {
    if (!RUN_LIVE_TEST) {
        console.log('Skipping live BitShares connection test.');
        console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
        return;
    }

    const { BitShares, waitForConnected } = require('../modules/bitshares_client');

    console.log('Testing BitShares connection with btsdex (shared client)...');

    const rejectionGuard = createRejectionGuard();

    try {
        await Promise.race([
            waitForConnected(CONNECT_TIMEOUT_MS),
            rejectionGuard.guard
        ]);

        console.log('Connected to BitShares API');

        const globalProps = await BitShares.db.get_dynamic_global_properties();
        console.log('Dynamic global properties retrieved');
        console.log('Head block number:', globalProps.head_block_number);

        const btsAsset = await BitShares.assets.bts;
        console.log('BTS asset retrieved');
        console.log('BTS precision:', btsAsset.precision);

        console.log('All connection tests passed!');
    } catch (error) {
        console.error('Connection test failed:', formatError(error));
        process.exitCode = 1;
        return;
    } finally {
        rejectionGuard.cleanup();
    }
}

testConnection().catch((error) => {
    console.error('Connection test failed:', formatError(error));
    process.exitCode = 1;
});
