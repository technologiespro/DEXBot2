#!/usr/bin/env node
/**
 * credential-daemon.js - Secure Private Key Server
 *
 * DEXBot credential daemon for multi-bot private key management.
 * Enables bot processes to request pre-decrypted keys via Unix socket.
 * Derived vault secret kept in RAM only, never exposed to bot processes.
 *
 * ===============================================================================
 * DAEMON OPERATION
 * ===============================================================================
 *
 * STARTUP:
 * 1. Prompts for master password ONCE at startup
 * 2. Authenticates with profiles/keys.json
 * 3. Keeps only the derived vault secret in RAM during operation
 * 4. Listens on Unix socket for credential requests
 * 5. Services private key requests from bot processes
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
const chainKeys = require('./modules/chain_keys');
const {
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialRuntimeDir,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const { fetchBootstrapPassword } = require('./modules/launcher/credential_bootstrap');
const { normalizeBootstrapCredential } = require('./modules/launcher/credential_secret');

// Platform check - Unix sockets require Unix-like systems or Windows 10+
const platform = os.platform();
if (platform === 'win32') {
    const release = os.release();
    const majorVersion = parseInt(release.split('.')[0], 10);
    if (majorVersion < 10) {
        console.error('❌ Credential daemon requires Windows 10 or later');
        console.error('   On older Windows, use: node bot.js <bot-name> with interactive prompt');
        process.exit(1);
    }
}

const RUNTIME_DIR = getCredentialRuntimeDir({ root: __dirname });
const SOCKET_PATH = getCredentialSocketPath({ root: __dirname, runtimeDir: RUNTIME_DIR });
const READY_FILE = getCredentialReadyFilePath({ root: __dirname, runtimeDir: RUNTIME_DIR });

let vaultSecret = null;
let server = null;

function debugLog(message, err = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    console.error(`[credential-daemon][debug] ${message}${suffix}`);
}

async function resolveVaultSecret() {
    const envSecret = process.env.DAEMON_PASSWORD;
    if (envSecret) {
        delete process.env.DAEMON_PASSWORD;
        return normalizeBootstrapCredential(envSecret);
    }

    const bootstrapSocket = process.env.DEXBOT_CRED_BOOTSTRAP_SOCKET;
    delete process.env.DEXBOT_CRED_BOOTSTRAP_SOCKET;

    if (bootstrapSocket) {
        return normalizeBootstrapCredential(await fetchBootstrapPassword({
            socketPath: bootstrapSocket,
        }));
    }

    return chainKeys.authenticate();
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
        ensureCredentialRuntimeDirSync({ root: __dirname, runtimeDir: RUNTIME_DIR, socketPath: SOCKET_PATH, readyFilePath: READY_FILE });

        // Clean up old socket if it exists
        try {
            if (fs.existsSync(SOCKET_PATH)) {
                fs.unlinkSync(SOCKET_PATH);
            }
        } catch (err) {
            // Silently ignore
        }

        // Create server
        server = net.createServer(handleConnection);
        server.listen(SOCKET_PATH, () => {
            try {
                fs.chmodSync(SOCKET_PATH, 0o600);
            } catch (err) {
                debugLog(`Unable to chmod socket ${SOCKET_PATH}`, err);
            }
            // Create ready file to signal startup completion
            try {
                fs.writeFileSync(READY_FILE, Date.now().toString());
                fs.chmodSync(READY_FILE, 0o600);
            } catch (err) {
                debugLog(`Unable to update ready file permissions ${READY_FILE}`, err);
            }
        });

        server.on('error', (error) => {
            console.error('❌ Server error:', error.message);
            process.exit(1);
        });

        // Handle graceful shutdown
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

    } catch (error) {
        console.error('❌', error.message);
        process.exit(1);
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
    try {
        const request = JSON.parse(requestStr);
        const { type, accountName } = request;

        if (!type) {
            return sendError(socket, 'Missing "type" field');
        }

        if (type !== 'private-key') {
            return sendError(socket, `Unknown credential type: ${type}`);
        }

        if (!accountName) {
            return sendError(socket, 'Missing "accountName" field');
        }

        // Retrieve private key
        let privateKey;
        try {
            privateKey = chainKeys.getPrivateKey(accountName, vaultSecret);
        } catch (error) {
            return sendError(socket, error.message);
        }

        sendSuccess(socket, { privateKey });
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
function shutdown() {
    // Clear derived vault secret from memory
    if (vaultSecret) {
        vaultSecret = null;
    }

    // Close server
    if (server) {
        server.close(() => {
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
}

// Start daemon
initialize().catch(error => {
    console.error('❌', error.message);
    process.exit(1);
});
