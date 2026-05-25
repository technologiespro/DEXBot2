'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic_write');
const { acquirePathLockSync, releaseFileLockSync } = require('./file_lock');

function readJsonOrNull(filePath: any) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_: any) {
        return null;
    }
}

function writeJsonAtomicSync(filePath: any, payload: any) {
    writeJsonAtomic(filePath, payload);
}

function updateDynamicGridSnapshotSync(filePath: any, mutator: any, options: any = {}) {
    if (typeof mutator !== 'function') {
        throw new TypeError('updateDynamicGridSnapshotSync requires a mutator function');
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lock = acquirePathLockSync(filePath, options.lock || {});
    try {
        const previous = readJsonOrNull(filePath);
        const result = mutator(previous);
        if (!result || result.write === false) {
            return {
                ok: result?.ok !== false,
                written: false,
                previous,
                snapshot: previous,
            };
        }

        const snapshot = result.snapshot || result;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            return {
                ok: false,
                written: false,
                previous,
                snapshot: previous,
            };
        }

        writeJsonAtomicSync(filePath, snapshot);
        return {
            ok: true,
            written: true,
            previous,
            snapshot,
        };
    } finally {
        releaseFileLockSync(lock);
    }
}

export = {
    readJsonOrNull,
    writeJsonAtomicSync,
    updateDynamicGridSnapshotSync,
};
