#!/usr/bin/env node

const path = require('path');
const {
  buildNullClawSkillToml,
  describeNullClawSkill,
  writeNullClawSkillFile
} = require('../modules/nullclaw_skill');

const NS_PARENT_DIR = path.dirname(path.dirname(__dirname));
const NS_PROJECT_ROOT = path.basename(NS_PARENT_DIR) === 'dist' ? path.dirname(NS_PARENT_DIR) : NS_PARENT_DIR;

function parseArgs(argv) {
  const options: Record<string, any> = {
    outputPath: null,
    profileRoot: null,
    repoRoot: path.join(NS_PROJECT_ROOT, 'claw')
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--output' && next) {
      options.outputPath = next;
      i += 1;
      continue;
    }

    if (arg === '--repo-root' && next) {
      options.repoRoot = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--profile-root' && next) {
      options.profileRoot = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/nullclaw_skill.js [--repo-root PATH] [--profile-root PATH] [--output PATH]',
    '',
    'Outputs the NullClaw SKILL.toml that bridges NullClaw to AI-Bot.',
    'If --output is omitted, the TOML is written to stdout.'
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.outputPath) {
    await writeNullClawSkillFile(options.outputPath, {
      profileRoot: options.profileRoot,
      repoRoot: options.repoRoot
    });
    return;
  }

  process.stdout.write(`${buildNullClawSkillToml({
    profileRoot: options.profileRoot,
    repoRoot: options.repoRoot
  })}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err.message);
    process.exit(1);
  });
}

export = {
  describeNullClawSkill
};
