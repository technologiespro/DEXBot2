function setCachedModule(modulePath, exports) {
    const original = require.cache[modulePath];
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    };
    return original;
}

function restoreCachedModule(modulePath, original) {
    if (original) {
        require.cache[modulePath] = original;
    } else {
        delete require.cache[modulePath];
    }
}

module.exports = {
    restoreCachedModule,
    setCachedModule,
};
