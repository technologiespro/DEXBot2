const CONTROL_COMMANDS = new Set(['status', 'stop', 'delete', 'restart', 'stop-all', 'restart-all', 'shutdown']);

function findFirstPositionalArg(args: string[]): string | null {
    return args.find((arg: string) => !arg.startsWith('-') && arg !== 'claw-only' && !CONTROL_COMMANDS.has(arg)) || null;
}

function parseUnlockStartArgs(argv = process.argv) {
    const args = argv.slice(2);
    const clawOnly = args.includes('--claw-only') || args.includes('claw-only');
    const isolated = args.includes('--isolated');

    if (args[0] && CONTROL_COMMANDS.has(args[0])) {
        const cmd = args[0];
        const target = args[1] || null;
        return {
            botName: null,
            clawOnly: false,
            isolated: false,
            control: { cmd, target },
        };
    }

    return {
        botName: clawOnly ? null : findFirstPositionalArg(args) || process.env.BOT_NAME || null,
        clawOnly,
        isolated,
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

export = {
    findFirstPositionalArg,
    parsePm2Args,
    parseUnlockStartArgs,
};
