const SAFE_CHILD_ENV_KEYS = [
    'AMA_SIGNAL_RUNNER_FIXTURE_JSON',
    'APPDATA',
    'BITSHARES_ACCOUNT',
    'BOT_NAME',
    'CALC_CYCLES',
    'CALC_DELAY_MS',
    'COLORTERM',
    'COMSPEC',
    'DEXBOT_CRED_RUNTIME_DIR',
    'DEXBOT_PROFILE_ROOT',
    'DEXBOT2_ROOT',
    'FORCE_COLOR',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'LOGNAME',
    'NODE',
    'NODE_ENV',
    'NODE_PATH',
    'NO_COLOR',
    'NVM_BIN',
    'NVM_DIR',
    'NVM_INC',
    'NUMBER_OF_PROCESSORS',
    'OPEN_ORDERS_SYNC_LOOP_MS',
    'PATH',
    'PATHEXT',
    'PM2_HOME',
    'PREFERRED_ACCOUNT',
    'PWD',
    'SHELL',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER',
    'USERNAME',
    'USERPROFILE',
    'LIVE_BOT_NAME',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
];

function buildScopedChildEnv({ extra = {} } = {}) {
    const env = {};
    for (const key of SAFE_CHILD_ENV_KEYS) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key];
        }
    }
    return { ...env, ...extra };
}

module.exports = {
    SAFE_CHILD_ENV_KEYS,
    buildScopedChildEnv,
};
