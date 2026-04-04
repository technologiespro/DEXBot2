'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const path = require('path');

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

function createMockConnection(script) {
  return (socketPath, onConnect) => {
    const socket = new EventEmitter();
    socket.socketPath = socketPath;
    socket.write = (payload) => {
      socket.payload = payload;
    };
    socket.end = () => {
      socket.ended = true;
    };
    socket.destroy = () => {
      socket.destroyed = true;
    };

    process.nextTick(() => {
      script({ onConnect, socket, socketPath });
    });

    return socket;
  };
}

function testClawCatalog() {
  const catalog = require('../modules/claw_catalog');
  const commands = catalog.listClawCommandNames();

  assert.ok(commands.length > 20);
  assert.strictEqual(commands.length, new Set(commands).size);
  assert.ok(commands.includes('manifest'));
  assert.ok(commands.includes('create-limit-order'));
  assert.ok(commands.includes('dynamic-weight-apply'));

  const createLimitOrder = catalog.getClawToolByCommand('create-limit-order');
  assert.strictEqual(createLimitOrder.risk, 'execute');
  assert.strictEqual(createLimitOrder.toolName, 'claw_create_limit_order');
  assert.ok(createLimitOrder.inputSchema.required.includes('sellAsset'));

  const sameTool = catalog.getClawToolByName('claw_create_limit_order');
  assert.strictEqual(sameTool.command, 'create-limit-order');

  const catalogCopy = catalog.getClawToolCatalog();
  catalogCopy[0].command = 'mutated';
  assert.notStrictEqual(catalog.getClawToolCatalog()[0].command, 'mutated');

  const examples = catalog.buildClawCommandExamples('node scripts/claw_bridge.js');
  assert.ok(examples.some((line) => line.startsWith('node scripts/claw_bridge.js manifest')));
  assert.ok(examples.some((line) => line.includes('dynamic-weight-apply')));
}

async function testCredentialDaemonClient() {
  const clientPath = require.resolve('../modules/dexbot_credential_client');
  const runtimePath = require.resolve('../../modules/credential_runtime');
  clearModule(clientPath);
  clearModule(runtimePath);
  const client = require('../modules/dexbot_credential_client');
  const runtime = require('../../modules/credential_runtime');

  const originalExistsSync = fs.existsSync;
  const originalLstatSync = fs.lstatSync;
  const originalCreateConnection = net.createConnection;

  const credStatFor = (filePath) => ({
    isSymbolicLink: () => false,
    isFile: () => !String(filePath).endsWith('.sock'),
    isSocket: () => String(filePath).endsWith('.sock'),
    isDirectory: () => false,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: 0o100600,
  });

  fs.lstatSync = (filePath) => {
    if (String(filePath).includes('cred')) return credStatFor(filePath);
    return originalLstatSync.call(fs, filePath);
  };

  try {
    assert.strictEqual(client.DEFAULT_SOCKET_PATH, runtime.getCredentialSocketPath());
    assert.strictEqual(client.DEFAULT_READY_FILE, runtime.getCredentialReadyFilePath());

    let readyChecks = 0;
    fs.existsSync = (filePath) => {
      if (String(filePath).includes('cred')) {
        readyChecks += 1;
        return readyChecks >= 2;
      }
      return originalExistsSync.call(fs, filePath);
    };

    await client.waitForCredentialDaemon(50, {
      pollIntervalMs: 0,
      readyFilePath: '/tmp/dexbot-cred.ready',
      socketPath: '/tmp/dexbot-cred.sock'
    });
    assert.ok(readyChecks >= 2);

    fs.existsSync = () => false;
    await assert.rejects(
      client.waitForCredentialDaemon(5, {
        pollIntervalMs: 0,
        readyFilePath: '/tmp/dexbot-cred.ready',
        socketPath: '/tmp/dexbot-cred.sock'
      }),
      /Timed out waiting for DEXBot2 credential daemon/
    );

    fs.existsSync = () => true;
    assert.strictEqual(
      client.isCredentialDaemonReady({
        readyFilePath: '/tmp/dexbot-cred.ready',
        socketPath: '/tmp/dexbot-cred.sock'
      }),
      true
    );

    let socketRef = null;
    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      socketRef = socket;
      onConnect();
      socket.emit('data', Buffer.from(`${JSON.stringify({ success: true, privateKey: 'daemon-secret' })}\n`));
    });

    const privateKey = await client.requestPrivateKeyFromCredentialDaemon('alice', {
      socketPath: '/tmp/dexbot-cred.sock',
      timeoutMs: 50
    });

    assert.strictEqual(privateKey, 'daemon-secret');
    assert.ok(String(socketRef.payload).includes('"accountName":"alice"'));

    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /accountName is required/
    );

    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      onConnect();
      socket.emit('data', Buffer.from('not-json\n'));
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /Invalid credential daemon response/
    );

    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      onConnect();
      socket.emit('data', Buffer.from(`${JSON.stringify({ success: false, error: 'denied' })}\n`));
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /denied/
    );

    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      onConnect();
      socket.emit('error', new Error('boom'));
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /Credential daemon connection failed: boom/
    );

    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      onConnect();
      socket.emit('end');
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /Credential daemon closed the connection unexpectedly/
    );

    net.createConnection = createMockConnection(({ onConnect, socket }) => {
      onConnect();
      socket.emit('data', Buffer.from('{"success":true'));
      socket.emit('end');
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 50
      }),
      /Credential daemon closed the connection unexpectedly/
    );

    net.createConnection = createMockConnection(({ onConnect }) => {
      onConnect();
    });
    await assert.rejects(
      client.requestPrivateKeyFromCredentialDaemon('alice', {
        socketPath: '/tmp/dexbot-cred.sock',
        timeoutMs: 5
      }),
      /Credential daemon request timed out/
    );
  } finally {
    fs.existsSync = originalExistsSync;
    fs.lstatSync = originalLstatSync;
    net.createConnection = originalCreateConnection;
    clearModule(clientPath);
    clearModule(runtimePath);
  }
}

function testDexbotBridgeRootResolution() {
  const bridge = require('../modules/dexbot_bridge');
  const expectedRoot = path.resolve(__dirname, '..', '..');

  assert.strictEqual(bridge.getDexbot2Root(), expectedRoot);
}

async function main() {
  testClawCatalog();
  testDexbotBridgeRootResolution();
  await testCredentialDaemonClient();
  console.log('claw catalog and credential client tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
