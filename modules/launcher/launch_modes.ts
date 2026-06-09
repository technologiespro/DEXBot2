const CONTROL_COMMANDS = new Set(['status', 'stat', 'stop', 'delete', 'restart', 'stop-all', 'restart-all', 'shutdown']);

function findFirstPositionalArg(args: string[]): string | null {
    return args.find((arg: string) => !arg.startsWith('-') && arg !== 'claw-only' && !CONTROL_COMMANDS.has(arg)) || null;
}

function parseUnlockArgs(argv = process.argv) {
    const args = argv.slice(2);
    const clawOnly = args.includes('--claw-only') || args.includes('claw-only');
    const isolated = args.includes('--isolated');

    if (args[0] && CONTROL_COMMANDS.has(args[0])) {
        let cmd = args[0];
        const target = args[1] || null;

        // Normalize whole-runtime controls:
        //   restart, restart all -> restart-all
        //   stop, stop all       -> stop-all
        // Keep stop/restart <botName> for isolated per-bot control.
        const consumedAll = (cmd === 'restart' || cmd === 'stop') && (!target || target === 'all');
        if (consumedAll) {
            cmd += '-all';
        }

        return {
            botName: null,
            clawOnly: false,
            isolated: false,
            control: { cmd, target: consumedAll ? null : target },
        };
    }

    return {
        botName: clawOnly ? null : findFirstPositionalArg(args) || process.env.BOT_NAME || null,
        clawOnly,
        isolated,
    };
}

const parseUnlockStartArgs = parseUnlockArgs;

function parsePm2Args(argv = process.argv) {
    const args = argv.slice(2);
    const command = args[0] || null;
    const knownCommands = new Set(['claw-only', '--claw-only', 'update', 'stop', 'delete', 'restart', 'help']);

    if (command === 'claw-only' || command === '--claw-only') {
        return {
            command: 'claw-only',
            target: null,
            clawOnly: true,
        };
    }

    if (!command || !knownCommands.has(command)) {
        return {
            command: null,
            target: command,
            clawOnly: false,
        };
    }

    return {
        command,
        target: args[1] || null,
        clawOnly: false,
    };
}

export = {
    findFirstPositionalArg,
    parsePm2Args,
    parseUnlockArgs,
    parseUnlockStartArgs,
};
