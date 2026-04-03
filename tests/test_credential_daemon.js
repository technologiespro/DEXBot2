const assert = require('assert');
const fs = require('fs');

console.log('Running credential daemon tests');

const chainKeys = require('../modules/chain_keys');
const {
    createCredentialDaemonController,
} = require('../modules/launcher/credential_daemon');
const {
    createPasswordBootstrapServer,
    fetchBootstrapPassword,
} = require('../modules/launcher/credential_bootstrap');

async function testWaitsForExistingDaemon() {
    const originalIsDaemonReady = chainKeys.isDaemonReady;
    let ready = true;
    chainKeys.isDaemonReady = () => ready;

    try {
        const controller = createCredentialDaemonController({ pollIntervalMs: 10 });
        const startedAt = Date.now();

        setTimeout(() => {
            ready = false;
        }, 30);

        const exitCode = await controller.waitForManagedDaemon();
        const elapsed = Date.now() - startedAt;

        assert.strictEqual(exitCode, 0, 'waitForManagedDaemon should resolve cleanly for an existing daemon');
        assert.ok(elapsed >= 20, `waitForManagedDaemon should wait for daemon shutdown, elapsed=${elapsed}ms`);
    } finally {
        chainKeys.isDaemonReady = originalIsDaemonReady;
    }
}

async function testBootstrapPasswordTransfer() {
    let bootstrap;
    try {
        bootstrap = await createPasswordBootstrapServer({ password: 'test-secret', timeoutMs: 1000 });
    } catch (error) {
        if (error && error.code === 'EPERM') {
            console.log('Skipping bootstrap socket integration test under sandbox restrictions');
            return;
        }
        throw error;
    }

    try {
        assert.ok(fs.existsSync(bootstrap.credentialEnv.DEXBOT_CRED_BOOTSTRAP_SOCKET), 'bootstrap socket should exist before transfer');

        const password = await fetchBootstrapPassword({
            socketPath: bootstrap.credentialEnv.DEXBOT_CRED_BOOTSTRAP_SOCKET,
            timeoutMs: 1000,
        });

        assert.strictEqual(password, 'test-secret', 'bootstrap client should receive the original password');
        await bootstrap.waitForTransfer();
        assert.ok(!fs.existsSync(bootstrap.credentialEnv.DEXBOT_CRED_BOOTSTRAP_SOCKET), 'bootstrap socket should be removed after transfer');
    } finally {
        if (bootstrap) bootstrap.close();
    }
}

(async () => {
    await testWaitsForExistingDaemon();
    await testBootstrapPasswordTransfer();
    console.log('credential daemon tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
