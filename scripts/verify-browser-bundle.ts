/**
 * Verify that the browser-safe surface actually bundles for the web.
 *
 * Uses esbuild --platform=browser to attempt bundling selected entry points.
 * Node built-ins (fs, path, crypto, net, https, child_process, os, tls, http)
 * are externalized — they are handled by the package.json "browser" field at
 * real build time.  This test catches cases where a local module import cannot
 * be resolved (missing file) or where a module pulls in unexpected dependencies.
 *
 * Node-only entries are tested WITHOUT externalizing Node built-ins, so they
 * correctly fail with "Could not resolve 'fs'" / 'net' / 'https' etc.
 *
 * Usage: npx tsx scripts/verify-browser-bundle.ts
 * Invoked by: npm run verify:browser-bundle
 */

import { spawnSync } from 'child_process';
import mod from 'module';

// Complete list of Node.js built-in modules — generated at runtime.
const NODE_BUILTINS: string[] = [...(mod.builtinModules || [])];
// Older Node versions may not expose builtinModules — fallback to common set.
if (NODE_BUILTINS.length === 0) {
  NODE_BUILTINS.push(
    'fs', 'path', 'crypto', 'net', 'tls', 'http', 'https',
    'child_process', 'os', 'tty', 'perf_hooks', 'module', 'vm',
    'url', 'querystring', 'stream', 'buffer', 'assert', 'events',
    'util', 'punycode', 'string_decoder', 'timers', 'console',
    'readline', 'cluster', 'dns', 'dgram', 'worker_threads',
    'inspector', 'trace_events', 'async_hooks', 'diagnostics_channel',
  );
}

const EXTERNAL_ARGS = NODE_BUILTINS.flatMap(m => ['--external:' + m]);

interface BundleTest {
  label: string;
  entry: string;
  expectFail: boolean;
  externalizeNodeBuiltins: boolean;
}

const TESTS: BundleTest[] = [
  // ── Browser-safe entries (should bundle) ──────────────────────
  {
    label: 'modules/env.ts (browser-safe)',
    entry: 'modules/env.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/crypto/index.ts (browser-safe)',
    entry: 'modules/crypto/index.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/storage/index.ts (browser-safe)',
    entry: 'modules/storage/index.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/config.ts (browser-safe)',
    entry: 'modules/config.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/runtime.ts (browser-safe)',
    entry: 'modules/runtime.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/utils/math.ts (browser-safe)',
    entry: 'modules/order/utils/math.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'claw/modules/claw_bridge.ts (browser-safe)',
    entry: 'claw/modules/claw_bridge.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'claw/modules/honest_ecosystem.ts (browser-safe)',
    entry: 'claw/modules/honest_ecosystem.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  // ── Node-only entries (should fail without externals) ─────────
  {
    label: 'claw/index.ts (node-only)',
    entry: 'claw/index.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'market_adapter/core/kibana_client.ts (node-only)',
    entry: 'market_adapter/core/kibana_client.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'market_adapter/lp_chart_runner.ts (node-only)',
    entry: 'market_adapter/lp_chart_runner.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
];

let passed = 0;
let failed = 0;

for (const { label, entry, expectFail, externalizeNodeBuiltins } of TESTS) {
  const args = [
    'esbuild', '--platform=browser', '--bundle',
    `--outfile=/dev/null`,
    ...(externalizeNodeBuiltins ? EXTERNAL_ARGS : []),
    entry,
  ];

  const result = spawnSync('npx', args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30000,
  });

  const exitOk = result.status === 0;
  const outcomeCorrect = exitOk === !expectFail;

  if (outcomeCorrect) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    Expected ${expectFail ? 'failure' : 'success'}, got ${exitOk ? 'success' : 'failure'}`);
    const lines = (result.stderr || '').trim().split('\n').slice(0, 6);
    for (const line of lines) console.log(`    ${line}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${TESTS.length} total`);
if (failed > 0) process.exit(1);
