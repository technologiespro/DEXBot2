const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

console.log('Running credential runtime path tests');

const runtime = require('../modules/credential_runtime');
const { ensureDir } = require('../modules/utils/fs_utils');

function testDefaultPathsUseProfilesRun() {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const originalRuntimeDir = process.env.DEXBOT_CRED_RUNTIME_DIR;
    const originalSocket = process.env.DEXBOT_CRED_DAEMON_SOCKET;
    const originalReady = process.env.DEXBOT_CRED_DAEMON_READY_FILE;
    const root = path.resolve(__dirname, '..');
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.DEXBOT_CRED_RUNTIME_DIR;
    delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
    delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;

    try {
        const runtimeDir = runtime.getCredentialRuntimeDir({ root });
        assert.strictEqual(runtimeDir, path.join(root, 'profiles', 'run'));
        assert.strictEqual(
            runtime.getCredentialSocketPath({ root }),
            path.join(root, 'profiles', 'run', 'dexbot-cred-daemon.sock')
        );
        assert.strictEqual(
            runtime.getCredentialReadyFilePath({ root }),
            path.join(root, 'profiles', 'run', 'dexbot-cred-daemon.ready')
        );
    } finally {
        if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = originalXdg;
        if (originalRuntimeDir === undefined) delete process.env.DEXBOT_CRED_RUNTIME_DIR;
        else process.env.DEXBOT_CRED_RUNTIME_DIR = originalRuntimeDir;
        if (originalSocket === undefined) delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
        else process.env.DEXBOT_CRED_DAEMON_SOCKET = originalSocket;
        if (originalReady === undefined) delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;
        else process.env.DEXBOT_CRED_DAEMON_READY_FILE = originalReady;
    }
}

function testXdgRuntimeOverride() {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const originalRuntimeDir = process.env.DEXBOT_CRED_RUNTIME_DIR;
    const originalSocket = process.env.DEXBOT_CRED_DAEMON_SOCKET;
    const originalReady = process.env.DEXBOT_CRED_DAEMON_READY_FILE;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-xdg-'));
    const xdgRuntimeDir = path.join(baseDir, 'xdg-runtime');

    ensureDir(xdgRuntimeDir);
    process.env.XDG_RUNTIME_DIR = xdgRuntimeDir;
    delete process.env.DEXBOT_CRED_RUNTIME_DIR;
    delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
    delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;

    try {
        assert.strictEqual(runtime.getCredentialRuntimeDir(), path.join(xdgRuntimeDir, 'dexbot2'));
        assert.strictEqual(runtime.getCredentialSocketPath(), path.join(xdgRuntimeDir, 'dexbot2', 'dexbot-cred-daemon.sock'));
        assert.strictEqual(runtime.getCredentialReadyFilePath(), path.join(xdgRuntimeDir, 'dexbot2', 'dexbot-cred-daemon.ready'));
    } finally {
        if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = originalXdg;
        if (originalRuntimeDir === undefined) delete process.env.DEXBOT_CRED_RUNTIME_DIR;
        else process.env.DEXBOT_CRED_RUNTIME_DIR = originalRuntimeDir;
        if (originalSocket === undefined) delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
        else process.env.DEXBOT_CRED_DAEMON_SOCKET = originalSocket;
        if (originalReady === undefined) delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;
        else process.env.DEXBOT_CRED_DAEMON_READY_FILE = originalReady;
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

function testEnsureRuntimeDirUsesPrivatePermissions() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-test-'));
    const runtimeDir = path.join(baseDir, 'run');

    try {
        const resolved = runtime.ensureCredentialRuntimeDirSync({ runtimeDir });
        assert.strictEqual(resolved, runtimeDir);
        assert.ok(fs.existsSync(runtimeDir), 'runtime directory should be created');
        if (process.platform !== 'win32') {
            const mode = fs.statSync(runtimeDir).mode & 0o777;
            assert.strictEqual(mode, 0o700, 'runtime directory should use private permissions');
        }
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

async function testSecurePathChecksRecognizePrivateFilesAndSockets() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-secure-'));
    const runtimeDir = path.join(baseDir, 'run');
    const socketPath = path.join(baseDir, 'daemon.sock');
    const filePath = path.join(baseDir, 'ready.file');

    try {
        runtime.ensureCredentialRuntimeDirSync({ runtimeDir });
        assert.ok(
            runtime.isPrivatePathSecure(runtimeDir, { expectedType: 'dir', requiredMode: 0o700 }),
            'runtime dir should pass the private-path check'
        );

        fs.writeFileSync(filePath, 'ready', { mode: 0o600 });
        assert.ok(
            runtime.isPrivatePathSecure(filePath, { expectedType: 'file', requiredMode: 0o600 }),
            'ready file should pass the private-path check'
        );

        let server;
        try {
            server = net.createServer();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(socketPath, resolve);
            });
            try {
                fs.chmodSync(socketPath, 0o600);
            } catch (err) { }

            assert.ok(
                runtime.isPrivatePathSecure(socketPath, { expectedType: 'socket', requiredMode: 0o600 }),
                'daemon socket should pass the private-path check'
            );
        } catch (error) {
            if (error && error.code === 'EPERM') {
                console.log('Skipping socket security test under sandbox restrictions');
                return;
            }
            throw error;
        } finally {
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
        }
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

function testInvalidXdgRuntimeFallsBackToProfilesRun() {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const originalRuntimeDir = process.env.DEXBOT_CRED_RUNTIME_DIR;
    const originalSocket = process.env.DEXBOT_CRED_DAEMON_SOCKET;
    const originalReady = process.env.DEXBOT_CRED_DAEMON_READY_FILE;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-fallback-'));
    const root = path.join(baseDir, 'project-root');
    const invalidXdg = path.join(baseDir, 'missing', 'runtime');

    delete process.env.DEXBOT_CRED_RUNTIME_DIR;
    delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
    delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;
    process.env.XDG_RUNTIME_DIR = invalidXdg;

    try {
        const expectedRuntimeDir = path.join(root, 'profiles', 'run');
        assert.strictEqual(
            runtime.getCredentialRuntimeDir({ root }),
            expectedRuntimeDir,
            'invalid XDG runtime directories should fall back to profiles/run'
        );
        assert.strictEqual(
            runtime.ensureCredentialRuntimeDirSync({ root }),
            expectedRuntimeDir,
            'runtime directory creation should also use the fallback path'
        );
        assert.ok(fs.existsSync(expectedRuntimeDir), 'fallback runtime directory should be created');
    } finally {
        if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = originalXdg;
        if (originalRuntimeDir === undefined) delete process.env.DEXBOT_CRED_RUNTIME_DIR;
        else process.env.DEXBOT_CRED_RUNTIME_DIR = originalRuntimeDir;
        if (originalSocket === undefined) delete process.env.DEXBOT_CRED_DAEMON_SOCKET;
        else process.env.DEXBOT_CRED_DAEMON_SOCKET = originalSocket;
        if (originalReady === undefined) delete process.env.DEXBOT_CRED_DAEMON_READY_FILE;
        else process.env.DEXBOT_CRED_DAEMON_READY_FILE = originalReady;
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

function testRootBypassesOwnerCheck() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-root-bypass-'));
    const testFile = path.join(baseDir, 'test.key');

    try {
        fs.writeFileSync(testFile, 'test', { mode: 0o600 });

        const originalGetuid = process.getuid;

        // Non-root uid different from file owner should throw
        process.getuid = () => 9999;
        assert.throws(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600 }),
            /Unexpected owner/,
            'non-root uid should reject mismatched owner'
        );

        // Root (uid 0) should bypass owner check entirely
        process.getuid = () => 0;
        assert.doesNotThrow(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600 }),
            'root should bypass owner check'
        );

        // requireOwner: false should also bypass
        process.getuid = () => 9999;
        assert.doesNotThrow(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600, requireOwner: false }),
            'requireOwner: false should bypass owner check'
        );

        process.getuid = originalGetuid;
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

(async () => {
    testDefaultPathsUseProfilesRun();
    testXdgRuntimeOverride();
    testEnsureRuntimeDirUsesPrivatePermissions();
    await testSecurePathChecksRecognizePrivateFilesAndSockets();
    testInvalidXdgRuntimeFallsBackToProfilesRun();
    testRootBypassesOwnerCheck();

    console.log('credential runtime path tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
