function findFirstPositionalArg(args) {
    return args.find((arg) => !arg.startsWith('-') && arg !== 'claw-only') || null;
}

function parseUnlockStartArgs(argv = process.argv) {
    const args = argv.slice(2);
    const clawOnly = args.includes('--claw-only') || args.includes('claw-only');
    return {
        botName: clawOnly ? null : findFirstPositionalArg(args) || process.env.BOT_NAME || null,
        clawOnly,
    };
}

function parsePm2Args(argv = process.argv) {
    const args = argv.slice(2);
    const command = args[0] || 'unlock-start';
    const knownCommands = new Set(['unlock-start', 'claw-only', '--claw-only', 'update', 'stop', 'delete', 'restart', 'reload', 'help']);

    if (command === 'claw-only' || command === '--claw-only') {
        return {
            command: 'claw-only',
            target: null,
            clawOnly: true,
        };
    }

    if (!knownCommands.has(command)) {
        return {
            command: 'unlock-start',
            target: command,
            clawOnly: false,
        };
    }

    if (command !== 'unlock-start') {
        return {
            command,
            target: args[1] || null,
            clawOnly: false,
        };
    }

    const clawOnly = args.includes('--claw-only');
    const target = clawOnly ? null : findFirstPositionalArg(args.slice(1));

    return {
        command,
        target,
        clawOnly,
    };
}

module.exports = {
    findFirstPositionalArg,
    parsePm2Args,
    parseUnlockStartArgs,
};
