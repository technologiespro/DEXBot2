#!/usr/bin/env node
/**
 * credential-daemon.js - Secure Private Key Server
 *
 * DEXBot credential daemon for multi-bot private key management.
 * Enables bot processes to request pre-decrypted keys via Unix socket.
 * Keeps the derived vault secret in RAM so key updates remain visible while the daemon runs.
 *
 * ===============================================================================
 * DAEMON OPERATION
 * ===============================================================================
 *
 * STARTUP:
 * 1. Prompts for master password ONCE at startup
 * 2. Authenticates with profiles/keys.json
 * 3. Re-wraps the decrypted account cache with a random session secret
 * 4. Keeps the derived vault secret and session cache in RAM during operation
 * 5. Listens on Unix socket for credential requests
 * 6. Services private key requests from bot processes
 *
 * COMMUNICATION:
 * - Socket: profiles/run/dexbot-cred-daemon.sock (or $DEXBOT_CRED_RUNTIME_DIR, or $XDG_RUNTIME_DIR/dexbot2/)
 * - Ready file: profiles/run/dexbot-cred-daemon.ready (or $DEXBOT_CRED_RUNTIME_DIR, or $XDG_RUNTIME_DIR/dexbot2/)
 * - Startup timeout: 60 seconds (DAEMON_STARTUP_TIMEOUT_MS)
 * - Windows 10+: Supported; earlier Windows not supported
 *
 * REQUEST FORMAT:
 *   {"type": "private-key", "accountName": "account-name"}
 *
 * RESPONSE FORMAT:
 *   Success:  {"success": true, "privateKey": "5K..."}
 *   Failure:  {"success": false, "error": "Error message"}
 *
 * ===============================================================================
 * SECURITY BENEFITS
 * ===============================================================================
 *
 * - Master password prompt only once (at daemon startup)
 * - Individual bot processes have no access to the derived vault secret
 * - No persisted raw password in environment variables or config files
 * - Private keys never written to disk unencrypted
 * - Centralized key management
 * - Unix socket provides process-level isolation
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * Direct:
 *   node credential-daemon.js
 *
 * Via PM2 (recommended):
 *   npm run pm2:unlock-start
 *   or: node dexbot.js pm2
 *
 * Bot processes then access keys automatically via socket connection.
 *
 * ===============================================================================
 */

process.umask(0o077);

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const chainKeys = require('./modules/chain_keys');
const { TIMING, NODE_MANAGEMENT } = require('./modules/constants');
const { readGeneralSettings } = require('./modules/general_settings');
const { orderNodesForSettings } = require('./modules/node_health_cache');
const credentialPolicy = require('./modules/credential_policy');
const BitSharesLib = require('btsdex');
const { execSync } = require('child_process');
const {
    assertPrivatePathSecurity,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialRuntimeDir,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const {
    buildSessionAccountCache,
    loadDaemonPrivateKey,
} = require('./modules/credential_session_cache');
const { fetchBootstrapPassword } = require('./modules/launcher/credential_bootstrap');
const { normalizeBootstrapCredential } = require('./modules/launcher/credential_secret');
const Logger = require('./modules/logger');
const daemonLogger = new Logger('credential-daemon');

// Platform check - Unix sockets require Unix-like systems or Windows 10+
const platform = os.platform();
if (platform === 'win32') {
    const release = os.release();
    const majorVersion = parseInt(release.split('.')[0], 10);
    if (majorVersion < 10) {
        daemonLogger.error('Credential daemon requires Windows 10 or later');
        daemonLogger.error('On older Windows, use: node bot.js <bot-name> with interactive prompt');
        process.exit(1);
    }
}

const RUNTIME_DIR = getCredentialRuntimeDir({ root: __dirname });
const SOCKET_PATH = getCredentialSocketPath({ root: __dirname, runtimeDir: RUNTIME_DIR });
const READY_FILE = getCredentialReadyFilePath({ root: __dirname, runtimeDir: RUNTIME_DIR });

let vaultSecret = null;
let sessionSecret = null;
let sessionAccountKeys = new Map();
let server = null;
let daemonShuttingDown = false;

// Policy layer and session management
let policyConfig = null;
let activeSessions = new Map(); // sessionId → { accountName, createdAt }
let auditLogPath = null;
let auditLogQueue = Promise.resolve();

function debugLog(message, err = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    daemonLogger.error(`[credential-daemon][debug] ${message}${suffix}`);
}

function formatFatalReason(reason) {
    if (!reason) return 'unknown';
    if (reason instanceof Error) return reason.stack || reason.message;
    if (typeof reason === 'object') {
        try {
            return JSON.stringify(reason);
        } catch (_) {
            return String(reason);
        }
    }
    return String(reason);
}

function registerProcessDiagnostics() {
    process.on('uncaughtException', (err) => {
        daemonLogger.error(`[credential-daemon] Uncaught exception: ${formatFatalReason(err)}`);
        shutdown(1, 'uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        daemonLogger.error(`[credential-daemon] Unhandled rejection: ${formatFatalReason(reason)}`);
        shutdown(1, 'unhandledRejection');
    });

    process.on('exit', (code) => {
        daemonLogger.log?.(`[credential-daemon] Process exiting with code ${code}`);
    });
}

/**
 * Policy and session management helpers
 */

function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function purgeExpiredSessions() {
    const ttl = (policyConfig && policyConfig.sessionTtlMs) || 86400000;
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.createdAt > ttl) {
            activeSessions.delete(id);
        }
    }
}

function checkSessionValid(accountName, sessionId) {
    purgeExpiredSessions();
    if (!sessionId) {
        return false;
    }
    const session = activeSessions.get(sessionId);
    return session && session.accountName === accountName;
}

function queueAuditLogWork(work) {
    auditLogQueue = auditLogQueue
        .then(() => Promise.resolve().then(work))
        .catch((err) => {
            debugLog('Audit log operation failed', err);
        });
    return auditLogQueue;
}

function performAuditLogPrune() {
    return new Promise((resolve) => {
        if (!auditLogPath) {
            resolve();
            return;
        }

        fs.readFile(auditLogPath, 'utf8', (err, data) => {
            if (err || !data.trim()) {
                resolve();
                return;
            }

            const cutoff = Date.now() - TIMING.AUDIT_LOG_RETENTION_MS;
            const lines = data.split('\n').filter(line => {
                if (!line.trim()) return false;
                try {
                    const entry = JSON.parse(line);
                    return new Date(entry.timestamp).getTime() > cutoff;
                } catch {
                    return false;
                }
            });

            fs.writeFile(auditLogPath, lines.join('\n') + '\n', (writeErr) => {
                if (writeErr) debugLog('Audit log prune failed', writeErr);
                resolve();
            });
        });
    });
}

function pruneAuditLog() {
    return queueAuditLogWork(() => performAuditLogPrune());
}

function appendAuditLog(entry) {
    if (!auditLogPath) return;
    const line = JSON.stringify(entry) + '\n';
    return queueAuditLogWork(() => new Promise((resolve) => {
        fs.appendFile(auditLogPath, line, (err) => {
            if (err) {
                debugLog('Audit log write failed', err);
                resolve();
                return;
            }

            performAuditLogPrune().finally(resolve);
        });
    }));
}

async function resolveVaultSecret() {
    const envSecret = process.env.DAEMON_PASSWORD;
    if (envSecret) {
        delete process.env.DAEMON_PASSWORD;
        daemonLogger.log?.('[credential-daemon] Resolving vault secret from direct daemon environment');
        return normalizeBootstrapCredential(envSecret);
    }

    const bootstrapSocket = process.env.DEXBOT_CRED_BOOTSTRAP_SOCKET;
    delete process.env.DEXBOT_CRED_BOOTSTRAP_SOCKET;

    if (bootstrapSocket) {
        daemonLogger.log?.(`[credential-daemon] Resolving vault secret from one-shot bootstrap socket: ${bootstrapSocket}`);
        try {
            const secret = await fetchBootstrapPassword({ socketPath: bootstrapSocket });
            daemonLogger.log?.('[credential-daemon] Bootstrap secret transfer completed');
            return normalizeBootstrapCredential(secret);
        } catch (err) {
            daemonLogger.error(
                `[credential-daemon] Bootstrap secret transfer failed: ${err.message}.`
            );
            if (!process.stdin || !process.stdin.isTTY) {
                // Stale DEXBOT_CRED_BOOTSTRAP_SOCKET persisted by PM2 from a
                // previous launcher run.  Delete the PM2 app entry to stop the
                // restart loop, then exit.
                daemonLogger.error(
                    '[credential-daemon] No TTY available for interactive fallback. ' +
                    'Removing stale PM2 app entry to stop restart loop.'
                );
                try {
                    execSync('pm2 delete dexbot-cred', { stdio: 'ignore', timeout: 5000 });
                } catch (_) {
                    // pm2 may not be installed or already deleted — proceed
                }
                daemonLogger.error(
                    '[credential-daemon] Restart the unlock flow with: node pm2 restart dexbot-cred'
                );
                process.exit(1);
            }
            daemonLogger.log?.('[credential-daemon] Falling back to interactive authentication.');
        }
    }

    daemonLogger.log?.('[credential-daemon] Resolving vault secret from interactive authentication');
    return chainKeys.authenticate();
}

function removeSecureStaleFile(filePath, expectedType) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    // Intentionally throws rather than silently cleaning up: if the path fails
    // the security check (wrong owner, wrong permissions, or a symlink) we must
    // not remove it — doing so could mask an attack. The caller is expected to
    // surface the error and abort daemon startup.
    assertPrivatePathSecurity(filePath, {
        expectedType,
        requiredMode: 0o600,
    });

    fs.unlinkSync(filePath);
}

async function loadCurrentPrivateKey(accountName) {
    return loadDaemonPrivateKey(accountName, {
        vaultSecret,
        sessionAccountKeys,
        sessionSecret,
    });
}

async function executeOperationsWithClient(client, operations) {
    const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
    if (ops.length === 0) {
        return { success: true, operation_results: [], raw: null };
    }

    if (client.initPromise) {
        await client.initPromise;
    }

    if (typeof client.newTx !== 'function') {
        throw new Error('Signing client does not support newTx()');
    }

    const tx = client.newTx();
    for (const op of ops) {
        if (!op || !op.op_name || !op.op_data) {
            throw new Error('Each operation requires op_name and op_data');
        }
        if (typeof tx[op.op_name] !== 'function') {
            throw new Error(`Transaction builder does not support ${op.op_name}`);
        }
        tx[op.op_name](op.op_data);
    }

    const result = await tx.broadcast();
    const operationResults =
        (result && Array.isArray(result.operation_results) && result.operation_results) ||
        (result && result.trx && Array.isArray(result.trx.operation_results) && result.trx.operation_results) ||
        (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
        [];

    return {
        success: true,
        raw: result,
        operation_results: operationResults,
    };
}

async function broadcastWithRetry(accountName, privateKey, broadcastFn) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (!BitSharesLib.chain) await BitSharesLib.connect();
        const client = new BitSharesLib(accountName, privateKey, 'BTS');
        await client.initPromise;
        try {
            return await broadcastFn(client);
        } catch (err) {
            if (attempt === 2) throw err;
            debugLog(`Broadcast failed (attempt ${attempt}), reconnecting: ${err.message}`);
            try { await BitSharesLib.disconnect(); } catch (_) {}
            BitSharesLib.connectPromise = undefined;
            BitSharesLib.chain = undefined;
        }
    }
}

/**
 * Refresh the BitShares node list from the health cache.
 * Ensures the daemon isn't stuck on stale nodes if they fail during long uptime.
 */
function refreshNodeList() {
    const settings = readGeneralSettings({ fallback: null });
    const nodeSettings = settings?.NODES;
    const nodeManagerEnabled = nodeSettings?.enabled ?? NODE_MANAGEMENT.DEFAULT_ENABLED;

    if (nodeManagerEnabled) {
        try {
            const bestNodes = orderNodesForSettings(settings);
            if (bestNodes && bestNodes.length > 0) {
                BitSharesLib.node = bestNodes;
                daemonLogger.log?.(`[credential-daemon] Node list refreshed: using best ${bestNodes.length} nodes from cache.`);
            }
        } catch (err) {
            daemonLogger.warn?.(`[credential-daemon] Failed to refresh node list: ${err.message}`);
        }
    }
}

function getCredentialDaemonNodeRefreshIntervalMs(settings) {
    const configured = settings?.NODES?.credentialDaemonRefreshIntervalMs
        ?? settings?.NODES?.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS
        ?? NODE_MANAGEMENT.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS;
    return Number.isFinite(configured) && configured > 0
        ? configured
        : NODE_MANAGEMENT.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS;
}

/**
 * Initialize daemon: authenticate and start listening
 */
async function initialize() {
    try {
        // Check if profiles/keys.json exists
        const keysPath = path.join(__dirname, 'profiles', 'keys.json');
        if (!fs.existsSync(keysPath)) {
            throw new Error('profiles/keys.json not found. Please run: node dexbot.js keys');
        }

        // Accept a one-shot bootstrap secret when launched by a wrapper,
        // otherwise prompt once interactively.
        vaultSecret = await resolveVaultSecret();
        const accountsData = chainKeys.loadAccounts();
        const sessionState = buildSessionAccountCache(accountsData, vaultSecret, {
            onDecryptError: (accountName, err) => {
                debugLog(`Skipping account '${accountName}' — decryption failed: ${err.message}`);
            },
        });
        sessionAccountKeys = sessionState.cache;
        sessionSecret = sessionState.sessionSecret;
        if (accountsData && typeof accountsData === 'object') {
            accountsData.accounts = null;
        }

        // Load policy config
        const policyConfigPath = path.join(__dirname, 'profiles', 'daemon-policies.json');
        policyConfig = credentialPolicy.loadRequiredPolicyConfig(policyConfigPath);

        // Set audit log path
        const auditLogDir = path.join(__dirname, 'profiles', 'logs');
        if (!fs.existsSync(auditLogDir)) {
            try {
                fs.mkdirSync(auditLogDir, { recursive: true });
            } catch (err) {
                debugLog(`Failed to create audit log directory ${auditLogDir}: ${err.message}`);
            }
        }
        auditLogPath = path.join(auditLogDir, 'daemon-audit.jsonl');

        // Apply configured node list so the daemon uses the same
        // nodes as bot processes (when node management is enabled),
        // without instantiating NodeManager (which was crashing the
        // daemon ~80s after startup).  Mirror the enabled check from
        // bitshares_client.js so both stay aligned.
        const settings = readGeneralSettings({ fallback: null });
        refreshNodeList();

        // Lightweight node list refresh from the health cache. This is separate
        // from updater schedules and does not run active node probes.
        const nodeRefreshInterval = setInterval(refreshNodeList, getCredentialDaemonNodeRefreshIntervalMs(settings));
        if (typeof nodeRefreshInterval.unref === 'function') {
            nodeRefreshInterval.unref();
        }

        // Register SIGHUP handler for policy and node list reload.
        // PM2 may forward SIGHUP on terminal disconnect, but we treat it
        // as a trigger to refresh configuration.
        process.on('SIGHUP', () => {
            daemonLogger.log?.('[credential-daemon] SIGHUP received: refreshing configuration and node list...');

            try {
                // Reload policy config first. If it no longer validates, fail closed.
                policyConfig = credentialPolicy.loadRequiredPolicyConfig(policyConfigPath);
                debugLog('Policy config reloaded');
            } catch (err) {
                daemonLogger.error?.(`[credential-daemon] SIGHUP policy reload failed: ${err.message}`);
                shutdown(1, 'invalid policy reload');
                return;
            }

            // Reload node list
            refreshNodeList();
        });

        ensureCredentialRuntimeDirSync({ root: __dirname, runtimeDir: RUNTIME_DIR, socketPath: SOCKET_PATH, readyFilePath: READY_FILE });
        daemonLogger.log?.(`[credential-daemon] Runtime socket path: ${SOCKET_PATH}`);
        daemonLogger.log?.(`[credential-daemon] Ready file path: ${READY_FILE}`);

        // Clean up old socket if it exists
        try {
            removeSecureStaleFile(SOCKET_PATH, 'socket');
            removeSecureStaleFile(READY_FILE, 'file');
        } catch (err) {
            throw new Error(`Insecure credential runtime path detected: ${err.message}`);
        }

        // Create server
        server = net.createServer(handleConnection);
        server.listen(SOCKET_PATH, () => {
            try {
                fs.chmodSync(SOCKET_PATH, 0o600);
                assertPrivatePathSecurity(SOCKET_PATH, { expectedType: 'socket', requiredMode: 0o600 });
            } catch (err) {
                debugLog(`Unable to chmod socket ${SOCKET_PATH}`, err);
            }
            // Create ready file to signal startup completion
            try {
                fs.writeFileSync(READY_FILE, Date.now().toString());
                fs.chmodSync(READY_FILE, 0o600);
                assertPrivatePathSecurity(READY_FILE, { expectedType: 'file', requiredMode: 0o600 });
                daemonLogger.log?.(`[credential-daemon] Ready: listening on ${SOCKET_PATH}`);
            } catch (err) {
                debugLog(`Unable to update ready file permissions ${READY_FILE}`, err);
            }
        });

        server.on('error', (error) => {
            daemonLogger.error(`Server error: ${error.message}`);
            process.exit(1);
        });

        // Handle graceful shutdown.
        // SIGTERM is sent by PM2 when stopping the daemon — honour it.
        // SIGINT is from stray Ctrl-C in the parent terminal; under PM2
        // management we ignore it so the daemon stays alive.  When running
        // interactively (not via PM2), SIGINT still works because the
        // process group leader is the shell.
        process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
        process.on('SIGINT', () => {
            daemonLogger.log?.(
                '[credential-daemon] SIGINT ignored (daemon is managed by PM2; use `pm2 stop dexbot-cred` to shut down).'
            );
        });

    } catch (error) {
        daemonLogger.error(`[credential-daemon] Startup failed: ${error.stack || error.message}`);
        shutdown(1, 'startup failure');
    }
}

/**
 * Handle incoming client connection to daemon.
 * Reads newline-delimited JSON requests and processes credential requests.
 * 
 * @param {net.Socket} socket - Connected client socket
 */
function handleConnection(socket) {
    let buffer = '';

    socket.on('data', (data) => {
        try {
            buffer += data.toString();

            // Look for newline-delimited JSON
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    processRequest(line.trim(), socket);
                }
            }
        } catch (error) {
            sendError(socket, 'Invalid request');
        }
    });

    socket.on('end', () => {
        // Connection closed
    });

    socket.on('error', (error) => {
        // Client disconnected or error
    });
}

/**
 * Process incoming credential request from client.
 * Validates request format and retrieves private key if valid.
 * Sends success or error response back to client.
 * 
 * @param {string} requestStr - JSON string with {type, accountName}
 * @param {net.Socket} socket - Client socket to send response
 */
function processRequest(requestStr, socket) {
    // The outer try/catch handles JSON parse errors and any synchronous throws.
    // Each async branch manages its own errors via .catch() → sendError(), so
    // the outer catch is not expected to fire for async operation failures.
    try {
        const request = JSON.parse(requestStr);
        const { type, accountName } = request;

        if (!type) {
            return sendError(socket, 'Missing "type" field');
        }

        if (!accountName) {
            return sendError(socket, 'Missing "accountName" field');
        }

        if (type === 'probe-account') {
            loadCurrentPrivateKey(accountName)
                .then(() => {
                    // Session registration
                    const sessionId = generateSessionId();
                    activeSessions.set(sessionId, {
                        accountName,
                        createdAt: Date.now(),
                    });
                    appendAuditLog({
                        event: 'session_created',
                        accountName,
                        sessionId,
                        timestamp: new Date().toISOString(),
                    });
                    sendSuccess(socket, { sessionId });
                })
                .catch((error) => sendError(socket, error.message));
            return;
        }

        if (type === 'broadcast-operation') {
            const operation = request.operation;
            if (!operation || typeof operation !== 'object') {
                return sendError(socket, 'Missing "operation" field');
            }

            const sessionId = request.sessionId || null;

            // Session validation
            if (!checkSessionValid(accountName, sessionId)) {
                const reason = 'invalid or expired session';
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'session: ' + reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + reason);
            }

            // Source authentication (HMAC verification)
            // For broadcast-operation, we verify HMAC over [operation] (single-element array)
            const hmacResult = credentialPolicy.verifySourceHmac(
                { ...request, operations: [operation] },
                policyConfig
            );
            if (!hmacResult.valid) {
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'source: ' + hmacResult.reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + 'invalid source authentication');
            }
            if (hmacResult.skipped) {
                debugLog(`[warn] no botHmacSecret configured for ${accountName} — source authentication skipped`);
            }

            // Policy evaluation — treat as single-operation batch
            const policy = credentialPolicy.resolveAccountPolicy(policyConfig, accountName);
            const context = credentialPolicy.buildPolicyContext({
                ...request,
                operations: [operation],
            });

            credentialPolicy.evaluatePolicy(policy, context)
                .then(async (result) => {
                    if (!result.allow) {
                        appendAuditLog({
                            event: 'sign_denied',
                            accountName,
                            sessionId,
                            policyId: result.policyId,
                            reason: result.reason,
                            opCount: 1,
                            opTypes: [operation && operation.op_name].filter(Boolean),
                            timestamp: new Date().toISOString(),
                        });
                        sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + result.reason);
                        return;
                    }

                    const privateKey = await loadCurrentPrivateKey(accountName);
                    const signResult = await broadcastWithRetry(
                        accountName, privateKey,
                        (client) => client.broadcast(operation)
                    );

                    appendAuditLog({
                        event: 'sign_allowed',
                        accountName,
                        sessionId,
                        opCount: 1,
                        opTypes: [operation && operation.op_name].filter(Boolean),
                        timestamp: new Date().toISOString(),
                    });
                    sendSuccess(socket, signResult);
                })
                .catch((error) => sendError(socket, error.message));
            return;
        }

        if (type === 'execute-operations') {
            const operations = request.operations;
            if (!Array.isArray(operations)) {
                return sendError(socket, 'Missing "operations" field');
            }

            const sessionId = request.sessionId || null;

            // Session validation
            if (!checkSessionValid(accountName, sessionId)) {
                const reason = 'invalid or expired session';
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'session: ' + reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + reason);
            }

            // Source authentication (HMAC verification)
            const hmacResult = credentialPolicy.verifySourceHmac(request, policyConfig);
            if (!hmacResult.valid) {
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'source: ' + hmacResult.reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + 'invalid source authentication');
            }
            if (hmacResult.skipped) {
                debugLog(`[warn] no botHmacSecret configured for ${accountName} — source authentication skipped`);
            }

            // Policy evaluation — before any key material is touched
            const policy = credentialPolicy.resolveAccountPolicy(policyConfig, accountName);
            const context = credentialPolicy.buildPolicyContext(request);

            credentialPolicy.evaluatePolicy(policy, context)
                .then(async (result) => {
                    if (!result.allow) {
                        appendAuditLog({
                            event: 'sign_denied',
                            accountName,
                            sessionId,
                            policyId: result.policyId,
                            reason: result.reason,
                            opCount: operations.length,
                            opTypes: operations.map((o) => o && o.op_name).filter(Boolean),
                            timestamp: new Date().toISOString(),
                        });
                        sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + result.reason);
                        return;
                    }

                    const privateKey = await loadCurrentPrivateKey(accountName);
                    const signResult = await broadcastWithRetry(
                        accountName, privateKey,
                        (client) => executeOperationsWithClient(client, operations)
                    );

                    appendAuditLog({
                        event: 'sign_allowed',
                        accountName,
                        sessionId,
                        opCount: operations.length,
                        opTypes: operations.map((o) => o && o.op_name).filter(Boolean),
                        timestamp: new Date().toISOString(),
                    });
                    sendSuccess(socket, signResult);
                })
                .catch((error) => sendError(socket, error.message));
            return;
        }

        if (type === 'private-key') {
            loadCurrentPrivateKey(accountName)
                .then((privateKey) => sendSuccess(socket, { privateKey }))
                .catch((error) => sendError(socket, error.message));
            return;
        }

        return sendError(socket, `Unknown credential type: ${type}`);
    } catch (error) {
        sendError(socket, error.message);
    }
}

/**
 * Send successful credential response to client.
 * 
 * @param {net.Socket} socket - Client socket
 * @param {Object} data - Response data (e.g., {privateKey: "5K..."})
 */
function sendSuccess(socket, data) {
    const response = JSON.stringify({
        success: true,
        ...data
    });
    socket.write(response + '\n');
}

/**
 * Send error response to client.
 * 
 * @param {net.Socket} socket - Client socket
 * @param {string} message - Error message
 */
function sendError(socket, message) {
    const response = JSON.stringify({
        success: false,
        error: message
    });
    socket.write(response + '\n');
}

/**
 * Gracefully shutdown daemon.
 * Clears the derived vault secret from memory and closes server.
 */
function shutdown(exitCode = 0, reason = 'shutdown') {
    if (daemonShuttingDown) return;
    daemonShuttingDown = true;
    daemonLogger.log?.(`[credential-daemon] Shutdown requested (${reason}, exitCode=${exitCode})`);

    // Clear derived vault secret from memory
    if (vaultSecret) {
        if (Buffer.isBuffer(vaultSecret)) vaultSecret.fill(0);
        vaultSecret = null;
    }
    if (sessionSecret) {
        if (Buffer.isBuffer(sessionSecret)) sessionSecret.fill(0);
        sessionSecret = null;
    }
    if (sessionAccountKeys) {
        for (const [key, val] of sessionAccountKeys) {
            if (Buffer.isBuffer(val)) {
                val.fill(0);
            }
        }
        sessionAccountKeys.clear();
    }

    // Close server — don't wait for active connections, process.exit will
    // tear everything down.  A hanging server.close() would prevent PM2 from
    // stopping the daemon, causing a SIGKILL after 1.6s.
    if (server) {
        try { server.close(); } catch (_) {}
    }
    daemonLogger.log?.('[credential-daemon] Server closed');
    process.exit(exitCode);
}

// Start daemon
registerProcessDiagnostics();
initialize().catch(error => {
    daemonLogger.error(`[credential-daemon] Startup failed: ${error.stack || error.message}`);
    shutdown(1, 'startup failure');
});
