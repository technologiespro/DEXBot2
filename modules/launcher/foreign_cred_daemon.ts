const fs = require('fs');
const path = require('path');
const { safeUnlink } = require('../utils/fs_utils');

/**
 * Foreign credential daemon detection.
 *
 * The launcher can end up reusing a credential daemon that was NOT started
 * by the current `node unlock` invocation. The readiness probe
 * (`isDaemonReady` / `isDaemonResponsive`) only checks that the socket is
 * answering, so a leftover daemon from a previous run, an old PM2 entry, or
 * a manually-spawned daemon can silently satisfy that probe — and the
 * launcher then skips the master password prompt.
 *
 * This module exposes the helper we use to detect and clean up that case.
 * Ownership is tracked via a PID file written by the launcher; the live
 * socket owner is discovered through /proc/net/unix. If the two disagree
 * the helper kills the foreign daemon, removes the orphan runtime files,
 * and lets the caller fall through to the normal "prompt for master
 * password" path.
 */

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function readCredentialSocketInode(socketPath) {
    if (!socketPath) return 0;
    try {
        const lines = fs.readFileSync('/proc/net/unix', 'utf8').split('\n');
        for (const line of lines) {
            if (!line) continue;
            // /proc/net/unix columns:
            //   0: Num (kernel pointer)
            //   1: RefCount
            //   2: Protocol
            //   3: Flags
            //   4: Type
            //   5: St
            //   6: Inode
            //   7: Path (optional, may be empty for kernel-internal sockets)
            //
            // We MUST compare the Path column exactly — using line.includes
            // here could match a longer socket path that happens to embed
            // our socket path as a substring, and the helper would then
            // SIGTERM the wrong PID.
            const parts = line.trim().split(/\s+/);
            if (parts.length < 7) continue;
            const path = parts[7] || '';
            if (path !== socketPath) continue;
            const inode = Number(parts[6]);
            if (Number.isInteger(inode) && inode > 0) return inode;
        }
    } catch (_) {}
    return 0;
}

function findCredentialSocketOwnerPid(socketPath, isLikelyProcess) {
    const inode = readCredentialSocketInode(socketPath);
    if (!inode) return 0;
    const target = `socket:[${inode}]`;

    let pids = [];
    try {
        pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    } catch (_) {
        return 0;
    }

    for (const pidStr of pids) {
        const fdDir = `/proc/${pidStr}/fd`;
        let fds = [];
        try { fds = fs.readdirSync(fdDir); } catch (_) { continue; }
        for (const fd of fds) {
            let link;
            try { link = fs.readlinkSync(`${fdDir}/${fd}`); } catch (_) { continue; }
            if (link === target) {
                const pid = Number(pidStr);
                if (Number.isInteger(pid) && pid > 0) {
                    if (typeof isLikelyProcess === 'function' && !isLikelyProcess(pid)) continue;
                    return pid;
                }
            }
        }
    }
    return 0;
}

function readOwnedCredentialDaemonPid(pidFile, isLikelyProcess) {
    if (!pidFile) return 0;
    let raw;
    try { raw = fs.readFileSync(pidFile, 'utf8'); } catch (_) { return 0; }
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        safeUnlink(pidFile)
        return 0;
    }
    if (!isPidAlive(pid)) {
        safeUnlink(pidFile)
        return 0;
    }
    if (typeof isLikelyProcess === 'function' && !isLikelyProcess(pid)) {
        safeUnlink(pidFile)
        return 0;
    }
    return pid;
}

async function stopPid(pid, timeoutMs = 5000) {
    if (!isPidAlive(pid)) return true;
    try {
        process.kill(pid, 'SIGTERM');
    } catch (err) {
        if (err && err.code === 'ESRCH') return true;
        throw err;
    }

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
        process.kill(pid, 'SIGKILL');
    } catch (err) {
        if (!err || err.code !== 'ESRCH') throw err;
    }
    return !isPidAlive(pid);
}

/**
 * Detect and clean up a credential daemon that is listening on our socket
 * but was NOT started by the current unlock session.
 *
 * Parameters
 * ----------
 * @param {Object} options
 * @param {string} options.socketPath - Path to the credential daemon's
 *   Unix socket (e.g. `$XDG_RUNTIME_DIR/dexbot2/dexbot-cred-daemon.sock`).
 * @param {string} options.readyFilePath - Path to the daemon's ready
 *   marker file.
 * @param {string} options.pidFile - Path to the ownership PID file the
 *   launcher writes when it starts a daemon.
 * @param {(pid: number) => boolean} options.isLikelyProcess - Returns true
 *   when the PID is a credential-daemon process.
 * @param {boolean} [options.verbose=true] - Log when a foreign daemon is
 *   found.
 *
 * @returns {Promise<boolean>} true when a foreign daemon was removed.
 */
async function ensureNoForeignCredentialDaemon({
    socketPath,
    readyFilePath,
    pidFile,
    isLikelyProcess,
    verbose = true,
}: {
    socketPath?: string;
    readyFilePath?: string;
    pidFile?: string;
    isLikelyProcess?: (pid: number) => boolean;
    verbose?: boolean;
} = {}) {
    if (!socketPath || !readyFilePath) return false;
    const socketExists = fs.existsSync(socketPath);
    const readyExists = fs.existsSync(readyFilePath);

    // Nothing on disk: nothing to clean, nothing to kill.
    if (!socketExists && !readyExists) return false;

    // Orphan ready file with no socket behind it (e.g. a previous launch
    // crashed after writing the ready marker but before binding the
    // socket, or someone manually deleted the socket). Treat as stale.
    if (!socketExists && readyExists) {
        safeUnlink(readyFilePath);
        return false;
    }

    // socketExists is true from here on. Probe the kernel and compare with
    // our ownership record. We deliberately do NOT require the ready
    // marker: a foreign daemon may be holding the socket after the ready
    // file was removed (e.g. by a previous unlock that did not own the
    // daemon). If we skip this case the controller will unlink the
    // socket and start a new daemon, leaving the old one orphaned in
    // memory with a live socket to nobody.
    const ownedPid = readOwnedCredentialDaemonPid(pidFile, isLikelyProcess);
    const liveOwnerPid = findCredentialSocketOwnerPid(socketPath, isLikelyProcess);

    if (ownedPid > 0 && liveOwnerPid === ownedPid) {
        return false;
    }

    if (liveOwnerPid > 0) {
        if (verbose) {
            // eslint-disable-next-line no-console
            console.warn(
                `[unlock] Detected foreign credential daemon (PID ${liveOwnerPid}) on ${socketPath} ` +
                `not started by this launcher — removing it to force a fresh master password prompt.`
            );
        }
        await stopPid(liveOwnerPid);
        safeUnlink(socketPath);
        safeUnlink(readyFilePath);
        return true;
    }

    // No live owner but the socket file is still on disk (e.g. left over
    // by a crashed daemon). Clean it up so the controller's own
    // removeStaleDaemonFiles does not have to deal with the wreckage.
    safeUnlink(socketPath);
    if (readyExists) safeUnlink(readyFilePath);
    return false;
}

module.exports = {
    ensureNoForeignCredentialDaemon,
    findCredentialSocketOwnerPid,
    readCredentialSocketInode,
    readOwnedCredentialDaemonPid,
    stopPid,
};
