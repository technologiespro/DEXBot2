'use strict';

const path = require('path');

function mirrorCachedModule(sourcePath, distPath) {
    const cached = require.cache[sourcePath];
    if (cached) {
        require.cache[distPath] = cached;
    }
}

function loadDistWithMirrors(callerDir, distRelativePath, mirrors = []) {
    for (const [sourceRelativePath, distMirrorRelativePath] of mirrors) {
        mirrorCachedModule(
            path.resolve(callerDir, sourceRelativePath),
            path.resolve(callerDir, distMirrorRelativePath),
        );
    }

    const distPath = path.resolve(callerDir, distRelativePath);
    delete require.cache[distPath];
    return require(distPath);
}

module.exports = {
    loadDistWithMirrors,
};
