'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildScopedChildEnv } = require('./child_env');
const { MARKET_ADAPTER } = require('../constants');
const { resolveProjectRoot, buildRuntimeScriptPath } = require('./runtime_entry');

const DEFAULT_CODE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = resolveProjectRoot(DEFAULT_CODE_ROOT);
const DEFAULT_STATE_DIR = path.join(DEFAULT_ROOT, 'market_adapter', 'state');
const DEFAULT_LOCK_FILE = path.join(DEFAULT_STATE_DIR, 'market_adapter.lock');
const DEFAULT_SCRIPT = buildRuntimeScriptPath(DEFAULT_CODE_ROOT, ['market_adapter', 'market_adapter']);
const DEFAULT_STALE_LOCK_MS = (
    MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000 +
    MARKET_ADAPTER.WATCHDOG_DEFAULTS.staleLockGraceMs
);

function loadLockInfo(lockPath: string): any {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_: any) {
        return false;
    }
}

function isLikelyMarketAdapterProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!isProcessAlive(pid)) return false;
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        return cmdline.includes('node') && /market_adapter\/market_adapter\.(?:js|ts)\b/.test(cmdline);
    } catch (_: any) {
        return false;
    }
}

function isLockStale(lockPath = DEFAULT_LOCK_FILE, staleAfterMs = DEFAULT_STALE_LOCK_MS, isAdapterProcess = isLikelyMarketAdapterProcess): boolean {
    try {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        // Runtime startup may remove malformed locks so a new owned process can acquire the file.
        if (!Number.isInteger(pid) || pid <= 0) return true;
        if (!isAdapterProcess(pid)) return true;
        const mtimeMs = fs.statSync(lockPath).mtimeMs;
        if ((Date.now() - mtimeMs) > staleAfterMs) {
            return !isAdapterProcess(pid);
        }
        return false;
    } catch (_: any) {
        return false;
    }
}

function isLikelyAdapterRunning(lockPath = DEFAULT_LOCK_FILE) {
    try {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        return isLikelyMarketAdapterProcess(pid);
    } catch (_: any) {
        return false;
    }
}

function waitForChildExit(child: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!child) {
            resolve(0);
            return;
        }

        child.once('error', reject);
        child.once('close', (code: any) => resolve(code));
    });
}

function createMarketAdapterRuntime({
    root = DEFAULT_ROOT,
    script = DEFAULT_SCRIPT,
    lockFile = DEFAULT_LOCK_FILE,
    spawnFn = spawn,
    buildEnv = buildScopedChildEnv,
} = {}) {
    let child: any = null;
    let childExitPromise: any = null;
    const desiredBots = new Set();

    function isOwnedChildRunning() {
        return !!(child && !child.killed && child.exitCode == null && child.signalCode == null);
    }

    function getActiveCount() {
        return desiredBots.size;
    }

    function getLockInfo() {
        return loadLockInfo(lockFile);
    }

    function isRunningExternally() {
        return isLikelyAdapterRunning(lockFile);
    }

    async function startOwnedProcess() {
        if (isOwnedChildRunning()) {
            return { running: true, owned: true, started: false };
        }

        if (isLockStale(lockFile)) {
            try { fs.unlinkSync(lockFile); } catch (_) {}
        }

        if (isRunningExternally()) {
            return { running: true, owned: false, external: true, started: false };
        }

        const nodeArgs = script.endsWith('.ts') ? ['--import', 'tsx', script] : [script];
        const spawnedChild = spawnFn(process.execPath, nodeArgs, {
            cwd: root,
            env: buildEnv(),
            stdio: 'inherit',
        });
        child = spawnedChild;
        childExitPromise = waitForChildExit(spawnedChild).catch(() => 0).finally(() => {
            if (child === spawnedChild) {
                child = null;
                childExitPromise = null;
            }
        });

        return { running: true, owned: true, started: true };
    }

    async function stopOwnedProcess() {
        if (!child || child.killed) {
            child = null;
            childExitPromise = null;
            return { running: false, stopped: false };
        }

        try {
            child.kill('SIGTERM');
        } catch (_: any) {}

        await Promise.race([
            childExitPromise || waitForChildExit(child).catch(() => 0),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);

        if (child && child.exitCode == null) {
            try {
                child.kill('SIGKILL');
            } catch (_: any) {}
        }

        child = null;
        childExitPromise = null;
        return { running: false, stopped: true };
    }

    async function syncBot(botId: string, shouldRun: boolean): Promise<any> {
        if (!botId) {
            throw new Error('botId is required');
        }

        if (shouldRun) {
            desiredBots.add(botId);
            return startOwnedProcess();
        }

        desiredBots.delete(botId);
        if (desiredBots.size === 0) {
            return stopOwnedProcess();
        }

        return {
            running: isOwnedChildRunning(),
            owned: isOwnedChildRunning(),
            started: false,
        };
    }

    async function releaseBot(botId: string): Promise<any> {
        if (botId) {
            desiredBots.delete(botId);
        }

        if (desiredBots.size === 0) {
            return stopOwnedProcess();
        }

        return {
            running: isOwnedChildRunning(),
            owned: isOwnedChildRunning(),
            stopped: false,
        };
    }

    function getStatus() {
        return {
            activeBotCount: getActiveCount(),
            botIds: [...desiredBots],
            hasOwnedChild: isOwnedChildRunning(),
            ownedPid: child?.pid || null,
            runningExternally: isRunningExternally(),
            lockInfo: getLockInfo(),
        };
    }

    async function shutdown() {
        desiredBots.clear();
        return stopOwnedProcess();
    }

    return {
        getStatus,
        releaseBot,
        shutdown,
        syncBot,
    };
}

let sharedRuntime: any = null;

function getSharedMarketAdapterRuntime(options = {}) {
    if (!sharedRuntime) {
        sharedRuntime = createMarketAdapterRuntime(options);
    }
    return sharedRuntime;
}

function resetSharedMarketAdapterRuntime() {
    sharedRuntime = null;
}

export = {
    createMarketAdapterRuntime,
    getSharedMarketAdapterRuntime,
    isLikelyAdapterRunning,
    isLikelyMarketAdapterProcess,
    isLockStale,
    isProcessAlive,
    loadLockInfo,
    resetSharedMarketAdapterRuntime,
    waitForChildExit,
};
