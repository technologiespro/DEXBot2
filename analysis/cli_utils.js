'use strict';

/**
 * Lightweight CLI argument helper for analysis runners.
 */

function parseCliArgs(argv = process.argv.slice(2)) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!key || !key.startsWith('-')) continue;
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function parseTypedArgs(argv, schema) {
    const raw = parseCliArgs(argv);
    const out = schema.defaults ? { ...schema.defaults } : {};
    for (const [flag, cfg] of Object.entries(schema.flags || {})) {
        if (!(flag in raw)) continue;
        const val = raw[flag];
        if (cfg.type === 'boolean') {
            out[cfg.key] = cfg.value !== undefined ? cfg.value : true;
        } else if (cfg.type === 'int') {
            out[cfg.key] = parseInt(val, 10);
        } else if (cfg.type === 'float') {
            out[cfg.key] = parseFloat(val);
        } else {
            out[cfg.key] = val;
        }
    }
    return out;
}

module.exports = {
    parseCliArgs,
    parseTypedArgs,
};
