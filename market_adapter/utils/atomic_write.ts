// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

function writeJsonAtomic(targetPath, data, options = {}) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

export = {
    writeJsonAtomic,
};
