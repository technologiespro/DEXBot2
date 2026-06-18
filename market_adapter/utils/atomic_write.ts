'use strict';

const { getStorage } = require('../../modules/storage');
const storage = getStorage();

/**
 * Write JSON atomically — delegates to the unified StorageAdapter.
 * Subsumed by storage.writeJSON; kept as a backward-compat alias.
 */
function writeJsonAtomic(targetPath, data, options = {}) {
    storage.writeJSON(targetPath, data, options);
}

export = {
    writeJsonAtomic,
};
