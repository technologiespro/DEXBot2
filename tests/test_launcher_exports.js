const assert = require('assert');

console.log('Running launcher export tests');

const unlockStart = require('../unlock-start');
const {
    parsePm2Args,
    parseUnlockStartArgs,
} = require('../modules/launcher/launch_modes');

assert.strictEqual(typeof unlockStart.main, 'function', 'unlock-start should export main');
assert.strictEqual(typeof unlockStart.buildDexbotStartArgs, 'function', 'unlock-start should export buildDexbotStartArgs');
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--claw-only']),
    { botName: null, clawOnly: true },
    'unlock-start parser should recognize claw-only mode'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', 'XRP-BTS']),
    { botName: 'XRP-BTS', clawOnly: false },
    'unlock-start parser should capture bot names'
);
const originalBotName = process.env.BOT_NAME;
process.env.BOT_NAME = 'ENV-BOT';
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start']),
    { botName: 'ENV-BOT', clawOnly: false },
    'unlock-start parser should use BOT_NAME when no bot argument is passed'
);
assert.deepStrictEqual(
    parseUnlockStartArgs(['node', 'unlock-start', '--claw-only']),
    { botName: null, clawOnly: true },
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
assert.deepStrictEqual(
    unlockStart.buildDexbotStartArgs('XRP-BTS'),
    ['dexbot.js', 'start', 'XRP-BTS'],
    'launcher should append the requested bot name'
);
assert.deepStrictEqual(
    unlockStart.buildDexbotStartArgs(null),
    ['dexbot.js', 'start'],
    'launcher should omit the bot arg when starting all bots'
);

console.log('launcher export tests passed');
process.exit(0);
