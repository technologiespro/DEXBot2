'use strict';

const fsPromises = require('fs/promises');
const { getStorage } = require('../../modules/storage');
const storage = getStorage();
const { readJSON, safeUnlink } = require('../../modules/utils/fs_utils');
const { getProcessDiscovery } = require('../../modules/process_discovery');

function loadLockInfo(lockPath: any) {
    try {
        const parsed = readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isProcessAlive(pid: any) {
    return getProcessDiscovery().isAlive(pid);
}

function isLikelyMarketAdapterProcess(pid: any) {
    if (!getProcessDiscovery().isAlive(pid)) return false;
    const cmdline = getProcessDiscovery().readCmdline(pid);
    if (!cmdline) return false;
    return cmdline.includes('node') && /market_adapter\/market_adapter\.(?:js|ts)\b/.test(cmdline);
}

function acquireFileLockSync(lockPath: any, opts: any = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : (6 * 3600 * 1000);
    const now = Date.now();

    for (let pass = 0; pass < 2; pass++) {
        let fd: number | null = null;
        try {
            fd = storage.open(lockPath, 'wx');
            const payload = {
                pid: process.pid,
                createdAt: new Date(now).toISOString(),
            };
            storage.writeFile(fd, `${JSON.stringify(payload, null, 2)}\n`);
            const heartbeatMs = Math.max(30000, Math.floor(staleMs / 2));
            const heartbeat = setInterval(() => {
                try {
                    const ts = new Date();
                    storage.utimes(lockPath, ts, ts);
                } catch (_: any) {}
            }, heartbeatMs);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
            return { fd, lockPath, heartbeat };
        } catch (err: any) {
            if (fd !== null) {
                try { storage.close(fd); } catch (_: any) {}
            }
            if (err.code !== 'EEXIST') throw err;

            const info = loadLockInfo(lockPath);
            let stale = false;
            let stat = null;
            try {
                stat = storage.stat(lockPath);
                stale = (now - stat.mtimeMs) > staleMs;
            } catch (_: any) {
                stale = true;
            }

            const alive = isLikelyMarketAdapterProcess(Number(info.pid));
            if (stale || !alive) {
                safeUnlink(lockPath)
                continue;
            }

            throw new Error(`market adapter already running (lock: ${lockPath}, pid: ${info.pid})`);
        }
    }

    throw new Error(`cannot acquire lock: ${lockPath}`);
}

function releaseFileLockSync(lock: any) {
    if (!lock) return;
    try { if (lock.heartbeat) clearInterval(lock.heartbeat); } catch (_: any) {}
    try { if (typeof lock.fd === 'number') storage.close(lock.fd); } catch (_: any) {}
    if (lock.lockPath) safeUnlink(lock.lockPath)
}

function sleepSync(ms: any) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function acquirePathLockSync(filePath: any, opts: any = {}) {
    const lockPath = `${filePath}.lock`;
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        let fd: number | null = null;
        try {
            fd = storage.open(lockPath, 'wx');
            storage.writeFile(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
            return { fd, lockPath };
        } catch (err: any) {
            if (fd !== null) {
                try { storage.close(fd); } catch (_: any) {}
            }
            if (err.code !== 'EEXIST') throw err;
            try {
                const stat = storage.stat(lockPath);
                if (Date.now() - stat.mtimeMs > staleMs) {
                    safeUnlink(lockPath)
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

async function acquireFileLock(filePath: any, opts: any = {}) {
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
