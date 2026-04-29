const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const { acquireFileLockSync, releaseFileLockSync } = require('../market_adapter/utils/file_lock');

function waitForFile(filePath, timeoutMs = 5000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (fs.existsSync(filePath)) {
                resolve();
                return;
            }
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`Timed out waiting for ${filePath}`));
                return;
            }
            setTimeout(tick, 25);
        };
        tick();
    });
}

function waitForExit(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for child exit')), timeoutMs);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function testLiveAdapterLockIsNotStolen() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-market-adapter-lock-'));
    const lockPath = path.join(tmpDir, 'market_adapter.lock');
    const readyPath = path.join(tmpDir, 'ready');
    const childCode = `
const fs = require('fs');
const { acquireFileLockSync, releaseFileLockSync } = require(${JSON.stringify(path.join(root, 'market_adapter/utils/file_lock'))});
const lock = acquireFileLockSync(process.argv[1], { staleMs: 60000 });
fs.writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => {
  releaseFileLockSync(lock);
  process.exit(0);
}, 2000);
`;

    const child = spawn(process.execPath, ['-e', childCode, lockPath, readyPath, 'market_adapter/market_adapter.js'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForFile(readyPath);
        assert.throws(
            () => acquireFileLockSync(lockPath, { staleMs: 60000 }),
            /market adapter already running/,
            'a live market adapter lock must not be removed by a newer process'
        );
    } finally {
        child.kill('SIGTERM');
        await waitForExit(child).catch(() => {});
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

(async () => {
    console.log('Running market adapter file lock tests');
    await testLiveAdapterLockIsNotStolen();
    console.log('market adapter file lock tests passed');
})().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
