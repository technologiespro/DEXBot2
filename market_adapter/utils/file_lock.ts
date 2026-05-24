// @ts-nocheck
'use strict';

const fs = require('fs');
const fsPromises = require('fs/promises');

function loadLockInfo(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_: any) {
        return false;
    }
}

function isLikelyMarketAdapterProcess(pid) {
    if (!isProcessAlive(pid)) return false;
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        return cmdline.includes('node') && cmdline.includes('market_adapter/market_adapter.js');
    } catch (_: any) {
        return false;
    }
}

function acquireFileLockSync(lockPath, opts = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : (6 * 3600 * 1000);
    const now = Date.now();

    for (let pass = 0; pass < 2; pass++) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            const payload = {
                pid: process.pid,
                createdAt: new Date(now).toISOString(),
            };
            fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            const heartbeatMs = Math.max(30000, Math.floor(staleMs / 2));
            const heartbeat = setInterval(() => {
                try {
                    const ts = new Date();
                    fs.utimesSync(lockPath, ts, ts);
                } catch (_: any) {}
            }, heartbeatMs);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
            return { fd, lockPath, heartbeat };
        } catch (err: any) {
            if (err.code !== 'EEXIST') throw err;

            const info = loadLockInfo(lockPath);
            let stale = false;
            let stat = null;
            try {
                stat = fs.statSync(lockPath);
                stale = (now - stat.mtimeMs) > staleMs;
            } catch (_: any) {
                stale = true;
            }

            const alive = isLikelyMarketAdapterProcess(Number(info.pid));
            if (stale || !alive) {
                try { fs.unlinkSync(lockPath); } catch (_: any) {}
                continue;
            }

            throw new Error(`market adapter already running (lock: ${lockPath}, pid: ${info.pid})`);
        }
    }

    throw new Error(`cannot acquire lock: ${lockPath}`);
}

function releaseFileLockSync(lock) {
    if (!lock) return;
    try { if (lock.heartbeat) clearInterval(lock.heartbeat); } catch (_: any) {}
    try { if (typeof lock.fd === 'number') fs.closeSync(lock.fd); } catch (_: any) {}
    try { if (lock.lockPath) fs.unlinkSync(lock.lockPath); } catch (_: any) {}
}

function sleepSync(ms) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function acquirePathLockSync(filePath, opts = {}) {
    const lockPath = `${filePath}.lock`;
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, 'utf8');
            return { fd, lockPath };
        } catch (err: any) {
            if (err.code !== 'EEXIST') throw err;
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > staleMs) {
                    try { fs.unlinkSync(lockPath); } catch (_: any) {}
                    continue;
                }
            } catch (_: any) {
                continue;
            }
            sleepSync(retryMs);
        }
    }

    throw new Error(`Could not acquire lock on ${filePath} within ${timeoutMs}ms`);
}

async function acquireFileLock(filePath, opts = {}) {
    const lockPath = `${filePath}.lock`;
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
        try {
            await fsPromises.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return async () => {
                await fsPromises.unlink(lockPath).catch(() => {});
            };
        } catch (err: any) {
            if (err.code !== 'EEXIST') throw err;
            try {
                const stat = await fsPromises.stat(lockPath);
                if (Date.now() - stat.mtimeMs > staleMs) {
                    try {
                        await fsPromises.unlink(lockPath);
                        await fsPromises.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
                        return async () => {
                            await fsPromises.unlink(lockPath).catch(() => {});
                        };
                    } catch {
                        // Another writer beat us — fall through and retry
                    }
                    continue;
                }
            } catch {
                continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    throw new Error(`Could not acquire lock on ${filePath} within 5000ms`);
}

export = {
    acquireFileLockSync,
    releaseFileLockSync,
    acquirePathLockSync,
    acquireFileLock,
};
