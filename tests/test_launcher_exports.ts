const assert = require('assert');
const path = require('path');

console.log('Running launcher export tests');

const unlockStart = require('../unlock-start');
const {
    parsePm2Args,
    parseUnlockStartArgs,
} = require('../modules/launcher/launch_modes');
const {
    buildRuntimeScriptArgs,
    buildRuntimeScriptPath,
} = require('../modules/launcher/runtime_entry');

assert.strictEqual(typeof unlockStart.main, 'function', 'unlock-start should export main');
assert.strictEqual(typeof unlockStart.buildDexbotStartArgs, 'function', 'unlock-start should export buildDexbotStartArgs');
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false },
    'unlock-start parser should recognize claw-only mode'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'XRP-BTS']),
    { botName: 'XRP-BTS', clawOnly: false, isolated: false },
    'unlock-start parser should capture bot names'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--isolated']),
    { botName: null, clawOnly: false, isolated: true },
    'unlock-start parser should recognize isolated flag'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--isolated', 'XRP-BTS']),
    { botName: 'XRP-BTS', clawOnly: false, isolated: true },
    'unlock-start parser should combine isolated flag with bot name'
);
const originalBotName = process.env.BOT_NAME;
process.env.BOT_NAME = 'ENV-BOT';
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start']),
    { botName: 'ENV-BOT', clawOnly: false, isolated: false },
    'unlock-start parser should use BOT_NAME when no bot argument is passed'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false },
    'unlock-start parser should ignore BOT_NAME in claw-only mode'
);
if (originalBotName === undefined) {
    delete process.env.BOT_NAME;
} else {
    process.env.BOT_NAME = originalBotName;
}
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'claw-only']),
    { command: 'claw-only', target: null, clawOnly: true },
    'pm2 parser should accept claw-only as a direct command'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'unlock-start', '--claw-only']),
    { command: 'unlock-start', target: null, clawOnly: true },
    'pm2 parser should accept claw-only as a flag'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'XRP-BTS']),
    { command: 'unlock-start', target: 'XRP-BTS', clawOnly: false },
    'pm2 parser should treat a bare bot name as unlock-start shorthand'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'restart', 'all']),
    { command: 'restart', target: 'all', clawOnly: false },
    'pm2 parser should accept restart commands'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'reload', 'dexbot-cred']),
    { command: 'reload', target: 'dexbot-cred', clawOnly: false },
    'pm2 parser should accept reload commands'
);
const expectedDexbotPath = path.join(__dirname, '..', 'dexbot.ts');
assert.deepStrictEqual(
    unlockStart.buildDexbotStartArgs('XRP-BTS'),
    ['--import', 'tsx', expectedDexbotPath, 'start', 'XRP-BTS'],
    'launcher should append the requested bot name'
);
assert.deepStrictEqual(
    unlockStart.buildDexbotStartArgs(null),
    ['--import', 'tsx', expectedDexbotPath, 'start'],
    'launcher should omit the bot arg when starting all bots'
);
assert.strictEqual(
    buildRuntimeScriptPath(path.join(__dirname, '..'), ['dexbot']),
    expectedDexbotPath,
    'runtime helper should resolve source entrypoints to .ts paths'
);
assert.deepStrictEqual(
    buildRuntimeScriptArgs({
        codeRoot: path.join(__dirname, '..', 'dist'),
        scriptSegments: ['dexbot'],
        scriptArgs: ['start'],
    }),
    [path.join(__dirname, '..', 'dist', 'dexbot.js'), 'start'],
    'runtime helper should resolve dist entrypoints to .js paths without tsx'
);

assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'status']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'status', target: null } },
    'unlock-start parser should parse control status'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'stop', 'XRP-BTS']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop', target: 'XRP-BTS' } },
    'unlock-start parser should parse control stop <name>'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'restart', 'XRP-BTS']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart', target: 'XRP-BTS' } },
    'unlock-start parser should parse control restart <name>'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'stop-all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop-all', target: null } },
    'unlock-start parser should parse control stop-all'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'restart-all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart-all', target: null } },
    'unlock-start parser should parse control restart-all'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'control', 'shutdown']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'shutdown', target: null } },
    'unlock-start parser should parse control shutdown'
);

console.log('launcher export tests passed');
process.exit(0);
