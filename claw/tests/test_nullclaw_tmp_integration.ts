// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  createNullClawBridge,
  describeNullClawBridge,
  runNullClawCommand
} = require('../modules/nullclaw_bridge');
const { writeNullClawSkillFile } = require('../modules/nullclaw_skill');

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nullclaw-integration-'));
  const homeRoot = path.join(tmpRoot, 'home');
  const dexbotRoot = path.join(tmpRoot, 'dexbot');
  const workspaceSkillDir = path.join(homeRoot, '.nullclaw', 'workspace', 'skills', 'bitshares-claw');
  const outputPath = path.join(workspaceSkillDir, 'SKILL.toml');

  await fs.mkdir(dexbotRoot, { recursive: true });

  await writeNullClawSkillFile(outputPath, {
    profileRoot: dexbotRoot,
    repoRoot
  });

  const skillText = await fs.readFile(outputPath, 'utf8');
  assert.ok(skillText.includes('name = "bitshares-claw"'));
  assert.ok(skillText.includes('NullClaw bridge to the AI-Bot / DEXBot2 BitShares layer'));
  assert.ok(skillText.includes('nullclaw'));
  assert.ok(skillText.includes('nullclaw_bridge.js'));

  const bridge = createNullClawBridge({
    runtime: {
      name: 'nullclaw-test'
    }
  });
  assert.strictEqual(bridge.runtime.name, 'nullclaw-test');

  const manifest = describeNullClawBridge({ profileRoot: dexbotRoot });
  const runtime = await runNullClawCommand('runtime', { profileRoot: dexbotRoot });

  assert.strictEqual(manifest.options.runtimeName, 'nullclaw');
  assert.strictEqual(manifest.options.profileRoot, dexbotRoot);
  assert.strictEqual(manifest.compatibility.recommendedTransport, 'skill-toml-or-mcp');
  assert.ok(manifest.commandExamples.some((example) => example.includes('nullclaw_bridge.js')));
  assert.ok(Array.isArray(manifest.tools.catalog));
  assert.strictEqual((await runNullClawCommand('manifest', { profileRoot: dexbotRoot })).options.runtimeName, 'nullclaw');
  assert.strictEqual(runtime.name, 'nullclaw');
  assert.strictEqual(runtime.profileRoot, dexbotRoot);
  assert.strictEqual(runtime.accountName, null);

  console.log('nullclaw tmp integration test passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err.message);
  process.exit(1);
});
