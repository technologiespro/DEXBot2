'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function countOccurrences(text, needle) {
  return (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

async function testClawSkillMarkdown() {
  const { buildRuntimeSkillMarkdown, writeRuntimeSkillMarkdown } = require('../modules/claw_skill_md');

  const repoRoot = path.join(os.tmpdir(), 'repo root');
  const profileRoot = path.join(os.tmpdir(), 'profile root');
  const markdown = buildRuntimeSkillMarkdown('openclaw', { repoRoot, profileRoot });
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'claw-skill-md-')), 'SKILL.md');
  const written = await writeRuntimeSkillMarkdown(outputPath, 'openclaw', { repoRoot, profileRoot });
  const fileText = await fs.readFile(outputPath, 'utf8');

  assert.strictEqual(written, fileText);
  assert.ok(markdown.startsWith('---\nname: bitshares-claw'));
  assert.ok(markdown.includes('## OpenClaw Setup'));
  assert.ok(markdown.includes(`openclaw plugins install -l ${repoRoot}`));
  assert.ok(markdown.includes(`Repo root: \`${repoRoot}\``));
  assert.ok(markdown.includes(`Default profile root: \`${profileRoot}\``));
  assert.ok(markdown.includes('claw_manifest'));
  assert.ok(markdown.includes('claw_honest_context'));
}

function testZeroClawSkillMarkdownRejects() {
  const { buildRuntimeSkillMarkdown } = require('../modules/claw_skill_md');

  assert.throws(
    () => buildRuntimeSkillMarkdown('zeroclaw'),
    /ZeroClaw uses SKILL\.toml via scripts\/zeroclaw_skill\.js, not claw_skill_md\.js/
  );
}

async function testZeroClawSkillToml() {
  const { buildZeroClawSkillToml, describeZeroClawSkill, writeZeroClawSkillFile } = require('../modules/zeroclaw_skill');
  const { getZeroClawSkillTools } = require('../modules/zeroclaw_catalog');

  const repoRoot = path.join(os.tmpdir(), 'zero repo');
  const profileRoot = path.join(os.tmpdir(), 'zero profile');
  const toml = buildZeroClawSkillToml({ repoRoot, profileRoot });
  const description = describeZeroClawSkill({ repoRoot, profileRoot });
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'zeroclaw-skill-')), 'SKILL.toml');
  const written = await writeZeroClawSkillFile(outputPath, { repoRoot, profileRoot });
  const fileText = await fs.readFile(outputPath, 'utf8');
  const toolCount = getZeroClawSkillTools().length;

  assert.strictEqual(written, fileText);
  assert.strictEqual(countOccurrences(toml, '[[tools]]'), toolCount);
  assert.ok(toml.includes('[skill]'));
  assert.ok(toml.includes('name = "ai-bots"'));
  assert.ok(toml.includes(description.bridgeScript));
  assert.ok(toml.includes('--profile-root'));
  assert.strictEqual(description.repositoryRoot, path.resolve(repoRoot));
  assert.strictEqual(description.profileRoot, path.resolve(profileRoot));
  assert.strictEqual(description.bridgeScript, path.join(repoRoot, 'scripts', 'zeroclaw_bridge.js').replace(/\\/g, '/'));
  assert.strictEqual(description.output, toml);
}

async function testNullClawSkillToml() {
  const { buildNullClawSkillToml, describeNullClawSkill, writeNullClawSkillFile } = require('../modules/nullclaw_skill');
  const { getNullClawSkillTools } = require('../modules/nullclaw_catalog');

  const repoRoot = path.join(os.tmpdir(), 'null repo');
  const profileRoot = path.join(os.tmpdir(), 'null profile');
  const toml = buildNullClawSkillToml({ repoRoot, profileRoot });
  const description = describeNullClawSkill({ repoRoot, profileRoot });
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nullclaw-skill-')), 'SKILL.toml');
  const written = await writeNullClawSkillFile(outputPath, { repoRoot, profileRoot });
  const fileText = await fs.readFile(outputPath, 'utf8');
  const toolCount = getNullClawSkillTools().length;

  assert.strictEqual(written, fileText);
  assert.strictEqual(countOccurrences(toml, '[[tools]]'), toolCount);
  assert.ok(toml.includes('[skill]'));
  assert.ok(toml.includes('name = "bitshares-claw"'));
  assert.ok(toml.includes('NullClaw bridge to the AI-Bot / DEXBot2 BitShares layer'));
  assert.ok(toml.includes(description.bridgeScript));
  assert.ok(toml.includes('--profile-root'));
  assert.strictEqual(description.repositoryRoot, path.resolve(repoRoot));
  assert.strictEqual(description.profileRoot, path.resolve(profileRoot));
  assert.strictEqual(description.bridgeScript, path.join(repoRoot, 'scripts', 'nullclaw_bridge.js').replace(/\\/g, '/'));
  assert.strictEqual(description.output, toml);
}

async function main() {
  await testClawSkillMarkdown();
  testZeroClawSkillMarkdownRejects();
  await testZeroClawSkillToml();
  await testNullClawSkillToml();
  console.log('claw skill generation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
