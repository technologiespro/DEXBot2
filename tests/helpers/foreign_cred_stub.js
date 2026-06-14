#!/usr/bin/env node
// Stub that mimics a foreign credential daemon and is exposed under a path
// that unlock.ts' isLikelyCredentialDaemonProcess recognises.  The argv
// is rewritten so /proc/<pid>/cmdline shows the canonical credential-daemon
// path even though we are running this stub.  The kernel reports the
// execve'd path, so we spawn ourselves through a small wrapper that uses
// execvp with that argv.  The launcher detects the stub via the socket,
// treats it as a real foreign credential daemon, kills it, and prompts for
// a fresh master password.
const net = require('net');
const fs = require('fs');
const safeUnlink = (p) => { try { fs.unlinkSync(p); } catch (_) {} };

const socketPath = process.env.DEXBOT_TEST_SOCKET
    || '/run/user/0/dexbot2/dexbot-cred-daemon.sock';
const readyPath = process.env.DEXBOT_TEST_READY
    || '/run/user/0/dexbot2/dexbot-cred-daemon.ready';

safeUnlink(socketPath)
const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const req = JSON.parse(line);
                if (req.type === 'ping') {
                    socket.write(JSON.stringify({ success: true, pong: true }) + '\n');
                } else {
                    socket.write(JSON.stringify({ success: false, error: 'stub: not a real daemon' }) + '\n');
                }
            } catch (e) {
                socket.write(JSON.stringify({ success: false, error: 'stub: parse error' }) + '\n');
            }
        }
    });
    socket.on('error', () => {});
});

server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
    try { fs.writeFileSync(readyPath, String(Date.now())); fs.chmodSync(readyPath, 0o600); } catch (_) {}
    console.error(`foreign-stub listening on ${socketPath}`);
});

const shutdown = () => { server.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
