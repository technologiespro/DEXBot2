#!/usr/bin/env node

const path = require('path');
const {
  buildRuntimeSkillMarkdown,
  writeRuntimeSkillMarkdown
} = require('../modules/claw_skill_md');

function parseArgs(argv) {
  const options = {
    outputPath: null,
    profileRoot: null,
    repoRoot: path.resolve(__dirname, '..'),
    runtimeName: null
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

    if (arg === '--runtime' && next) {
      options.runtimeName = next;
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
    '  node scripts/claw_skill_md.js --runtime <openclaw|nanobot|picoclaw> [--repo-root PATH] [--profile-root PATH] [--output PATH]',
    '',
    'Outputs a SKILL.md file for the requested runtime.',
    'If --output is omitted, the markdown is written to stdout.'
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.runtimeName) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  if (options.outputPath) {
    await writeRuntimeSkillMarkdown(options.outputPath, options.runtimeName, {
      profileRoot: options.profileRoot,
      repoRoot: options.repoRoot
    });
    return;
  }

  process.stdout.write(`${buildRuntimeSkillMarkdown(options.runtimeName, {
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
