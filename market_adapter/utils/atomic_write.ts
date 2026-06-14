'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, safeUnlink, writeJSON } = require('../../modules/utils/fs_utils');

function writeJsonAtomic(targetPath, data, options = {}) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        ensureDir(dir);
    }
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        writeJSON(tmpPath, data);
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        safeUnlink(tmpPath)
        throw err;
    }
}

export = {
    writeJsonAtomic,
};
