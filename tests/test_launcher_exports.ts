const assert = require('assert');
const path = require('path');

console.log('Running launcher export tests');

const unlock = require('../unlock');
const {
    parsePm2Args,
    parseUnlockArgs,
} = require('../modules/launcher/launch_modes');
const {
    buildRuntimeScriptArgs,
    buildRuntimeScriptPath,
} = require('../modules/launcher/runtime_entry');

assert.strictEqual(typeof unlock.main, 'function', 'unlock should export main');
assert.strictEqual(typeof unlock.buildDexbotStartArgs, 'function', 'unlock should export buildDexbotStartArgs');
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false },
    'unlock parser should recognize claw-only mode'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'XRP-BTS']),
    { botName: 'XRP-BTS', clawOnly: false, isolated: false },
    'unlock parser should capture bot names'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--isolated']),
    { botName: null, clawOnly: false, isolated: true },
    'unlock parser should recognize isolated flag'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--isolated', 'XRP-BTS']),
    { botName: 'XRP-BTS', clawOnly: false, isolated: true },
    'unlock parser should combine isolated flag with bot name'
);
const originalBotName = process.env.BOT_NAME;
process.env.BOT_NAME = 'ENV-BOT';
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock']),
    { botName: 'ENV-BOT', clawOnly: false, isolated: false },
    'unlock parser should use BOT_NAME when no bot argument is passed'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false },
    'unlock parser should ignore BOT_NAME in claw-only mode'
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
    parsePm2Args(['node', 'pm2.js', '--claw-only']),
    { command: 'claw-only', target: null, clawOnly: true },
    'pm2 parser should accept claw-only as a flag'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'XRP-BTS']),
    { command: null, target: 'XRP-BTS', clawOnly: false },
    'pm2 parser should treat a bare bot name as the default PM2 target'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'restart', 'all']),
    { command: 'restart', target: 'all', clawOnly: false },
    'pm2 parser should accept restart commands'
);
const expectedDexbotPath = path.join(__dirname, '..', 'dexbot.ts');
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs('XRP-BTS'),
    ['--import', 'tsx', expectedDexbotPath, 'test', 'XRP-BTS'],
    'launcher should append the requested bot name'
);
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs(null),
    ['--import', 'tsx', expectedDexbotPath, 'test'],
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
    parseUnlockArgs(['node', 'unlock', 'status']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'status', target: null } },
    'unlock parser should parse status'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'stop', 'XRP-BTS']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop', target: 'XRP-BTS' } },
    'unlock parser should parse stop <name>'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'restart', 'XRP-BTS']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart', target: 'XRP-BTS' } },
    'unlock parser should parse restart <name>'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'stop']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop-all', target: null } },
    'unlock parser should parse bare stop as stop all'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'restart']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart-all', target: null } },
    'unlock parser should parse bare restart as restart all'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'stop', 'all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop-all', target: null } },
    'unlock parser should parse stop all for backward compatibility'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'restart', 'all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart-all', target: null } },
    'unlock parser should parse restart all for backward compatibility'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'stop-all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'stop-all', target: null } },
    'unlock parser should parse stop-all (backward compat)'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'restart-all']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'restart-all', target: null } },
    'unlock parser should parse restart-all (backward compat)'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'delete']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'delete', target: null } },
    'unlock parser should parse delete'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'shutdown']),
    { botName: null, clawOnly: false, isolated: false, control: { cmd: 'shutdown', target: null } },
    'unlock parser should reject shutdown in control handling instead of treating it as a bot name'
);

console.log('launcher export tests passed');
process.exit(0);
