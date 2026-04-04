'use strict';

const assert = require('assert');
const path = require('path');

// ---------------------------------------------------------------------------
// claw_runtime_matrix
// ---------------------------------------------------------------------------

function testRuntimeMatrix() {
  const matrix = require('../modules/claw_runtime_matrix');

  const all = matrix.listSupportedClawRuntimes();
  assert.ok(all.length >= 5);

  const names = all.map((r) => r.runtime);
  assert.deepStrictEqual(names, ['openclaw', 'nanobot', 'picoclaw', 'zeroclaw', 'nullclaw']);

  // Each entry is a defensive clone — mutations must not affect the registry
  all[0].runtime = 'mutated';
  assert.notStrictEqual(matrix.listSupportedClawRuntimes()[0].runtime, 'mutated');

  // Known runtime lookup
  const zc = matrix.getSupportedClawRuntime('zeroclaw');
  assert.strictEqual(zc.runtime, 'zeroclaw');
  assert.strictEqual(zc.preferredTransport, 'local-cli-json');
  assert.strictEqual(zc.skillFile, 'SKILL.toml');

  const nb = matrix.getSupportedClawRuntime('nanobot');
  assert.strictEqual(nb.runtime, 'nanobot');
  assert.strictEqual(nb.preferredTransport, 'mcp-stdio-jsonl');
  assert.ok(nb.notes.includes('newline-delimited JSON-RPC'));

  const pc = matrix.getSupportedClawRuntime('picoclaw');
  assert.strictEqual(pc.runtime, 'picoclaw');
  assert.strictEqual(pc.preferredTransport, 'mcp-stdio-jsonl');
  assert.ok(pc.notes.includes('newline-delimited JSON-RPC'));

  const nc = matrix.getSupportedClawRuntime('nullclaw');
  assert.strictEqual(nc.runtime, 'nullclaw');
  assert.strictEqual(nc.preferredTransport, 'skill-toml-or-mcp');
  assert.strictEqual(nc.skillFile, 'SKILL.toml');

  // Lookup is case-insensitive and trims whitespace
  assert.strictEqual(matrix.getSupportedClawRuntime('  ZeroClaw  ').runtime, 'zeroclaw');
  assert.strictEqual(matrix.getSupportedClawRuntime('OPENCLAW').runtime, 'openclaw');
  assert.strictEqual(matrix.getSupportedClawRuntime('NullClaw').runtime, 'nullclaw');

  // Unknown / missing runtime returns null
  assert.strictEqual(matrix.getSupportedClawRuntime('unknown'), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(''), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(null), null);
  assert.strictEqual(matrix.getSupportedClawRuntime(undefined), null);
}

// ---------------------------------------------------------------------------
// claw_manifest
// ---------------------------------------------------------------------------

function testClawManifest() {
  const manifest = require('../modules/claw_manifest');

  const desc = manifest.describeClawBridge();

  // Top-level shape
  assert.ok(desc.compatibility);
  assert.ok(desc.commands);
  assert.ok(desc.tools);
  assert.ok(desc.surfaces);
  assert.strictEqual(desc.surfaces.settings, undefined);

  // Identity
  assert.strictEqual(desc.compatibility.name, 'Claw');
  assert.strictEqual(desc.compatibility.version, 2);
  assert.ok(desc.surfaces.profiles.includes('bot settings'));

  // Commands list is non-empty and consistent with catalog
  assert.ok(Array.isArray(desc.commands));
  assert.ok(desc.commands.length > 0);
  assert.ok(desc.commands.includes('manifest'));
  assert.ok(desc.commands.includes('create-limit-order'));
  assert.ok(desc.commands.includes('dynamic-weight-apply'));

  // byRisk grouping covers at least read and execute buckets
  assert.ok(Array.isArray(desc.tools.byRisk.read));
  assert.ok(Array.isArray(desc.tools.byRisk.execute));

  // catalog array matches commands list length
  assert.strictEqual(desc.tools.catalog.length, desc.commands.length);

  // Runtime-focused call sets recommendedTransport from the matrix
  const zcDesc = manifest.describeClawBridge({ runtimeName: 'zeroclaw' });
  assert.strictEqual(zcDesc.compatibility.recommendedTransport, 'local-cli-json');
  assert.strictEqual(zcDesc.options.runtimeName, 'zeroclaw');

  const nbDesc = manifest.describeClawBridge({ runtimeName: 'nanobot' });
  assert.strictEqual(nbDesc.compatibility.recommendedTransport, 'mcp-stdio-jsonl');
  assert.strictEqual(nbDesc.options.runtimeName, 'nanobot');

  // Unknown runtime falls back gracefully
  const unknownDesc = manifest.describeClawBridge({ runtimeName: 'unknown' });
  assert.strictEqual(unknownDesc.compatibility.recommendedTransport, 'runtime-specific');
  assert.strictEqual(unknownDesc.options.runtimeName, null);

  // Options are passed through
  const withOpts = manifest.describeClawBridge({
    accountName: 'alice',
    profileRoot: '/tmp/profiles',
    socketPath: '/tmp/cred.sock'
  });
  assert.strictEqual(withOpts.options.accountName, 'alice');
  assert.strictEqual(withOpts.options.profileRoot, '/tmp/profiles');
  assert.strictEqual(withOpts.options.socketPath, '/tmp/cred.sock');
}

// ---------------------------------------------------------------------------
// zeroclaw_manifest
// ---------------------------------------------------------------------------

function testZeroClawManifest() {
  const manifest = require('../modules/zeroclaw_manifest');

  const desc = manifest.describeZeroClawBridge();

  // Identity override
  assert.strictEqual(desc.compatibility.name, 'ZeroClaw');
  assert.ok(desc.compatibility.trustModel.includes('ZeroClaw'));

  // Still carries the full command surface
  assert.ok(Array.isArray(desc.commands));
  assert.ok(desc.commands.length > 0);

  // Runtime is locked to zeroclaw
  assert.strictEqual(desc.options.runtimeName, 'zeroclaw');
  assert.strictEqual(desc.compatibility.recommendedTransport, 'local-cli-json');

  // Options forwarded correctly
  const withOpts = manifest.describeZeroClawBridge({ accountName: 'bob' });
  assert.strictEqual(withOpts.options.accountName, 'bob');
}

// ---------------------------------------------------------------------------
// nullclaw_manifest
// ---------------------------------------------------------------------------

function testNullClawManifest() {
  const manifest = require('../modules/nullclaw_manifest');

  const desc = manifest.describeNullClawBridge();

  assert.strictEqual(desc.compatibility.name, 'NullClaw');
  assert.ok(desc.compatibility.trustModel.includes('NullClaw'));
  assert.strictEqual(desc.options.runtimeName, 'nullclaw');
  assert.strictEqual(desc.compatibility.recommendedTransport, 'skill-toml-or-mcp');
  assert.ok(Array.isArray(desc.commandExamples));
  assert.ok(desc.commandExamples.some((example) => example.includes('nullclaw_bridge.js')));

  const withOpts = manifest.describeNullClawBridge({ accountName: 'carol' });
  assert.strictEqual(withOpts.options.accountName, 'carol');
}

// ---------------------------------------------------------------------------
// dexbot_bridge — getDexbot2Root branching only
// ---------------------------------------------------------------------------

function testDexbotBridgeRootResolution() {
  const bridgePath = require.resolve('../modules/dexbot_bridge');

  // --- Branch 1: DEXBOT2_ROOT env var is set ---
  delete require.cache[bridgePath];
  const savedEnv = process.env.DEXBOT2_ROOT;
  process.env.DEXBOT2_ROOT = '/custom/dexbot2';
  try {
    const bridge = require('../modules/dexbot_bridge');
    assert.strictEqual(bridge.getDexbot2Root(), path.resolve('/custom/dexbot2'));
  } finally {
    if (savedEnv === undefined) {
      delete process.env.DEXBOT2_ROOT;
    } else {
      process.env.DEXBOT2_ROOT = savedEnv;
    }
    delete require.cache[bridgePath];
  }

  // --- Branch 2: no env var, auto-detected local repo layout ---
  // The test is already running inside the DEXBot2 repo, so the existsSync
  // check for modules/order/index.js should resolve to the repo root.
  delete require.cache[bridgePath];
  delete process.env.DEXBOT2_ROOT;
  try {
    const bridge = require('../modules/dexbot_bridge');
    const root = bridge.getDexbot2Root();
    const expectedRoot = path.resolve(__dirname, '..', '..');
    assert.strictEqual(root, expectedRoot);
  } finally {
    if (savedEnv !== undefined) {
      process.env.DEXBOT2_ROOT = savedEnv;
    }
    delete require.cache[bridgePath];
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  testRuntimeMatrix();
  testClawManifest();
  testZeroClawManifest();
  testNullClawManifest();
  testDexbotBridgeRootResolution();
  console.log('claw manifest and matrix tests passed');
}

main();
