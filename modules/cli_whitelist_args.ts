'use strict';

function buildMarketAdapterWhitelistNpmArgs(args: string[] = []): string[] {
    const forwardedArgs = Array.isArray(args) ? args.filter((arg) => typeof arg === 'string' && arg.length > 0) : [];
    return [
        'run',
        'market-adapter:whitelist',
        ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : []),
    ];
}

export = {
    buildMarketAdapterWhitelistNpmArgs,
};
