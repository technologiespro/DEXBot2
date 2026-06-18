'use strict';

const { path } = require('../../modules/path_api');
const { getStorage } = require('../../modules/storage');
const storage = getStorage();
const { PROJECT_ROOT } = require('./paths');

function findLatestLpData(options: any = {}) {
    const includePriceSnapshots = options.includePriceSnapshots === true;
    const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(PROJECT_ROOT, 'market_adapter', 'data', 'lp');
    const out = [];

    if (!storage.exists(dataDir)) return null;
    const stack = [dataDir];
    while (stack.length > 0) {
        const dir = stack.pop();
        const entries = storage.readdir(dir).map((name) => { return { name, isDirectory: () => storage.stat(path.join(dir, name)).isDirectory(), isFile: () => storage.stat(path.join(dir, name)).isFile() }; });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            if (!entry.name.startsWith('lp_pool_') && !(includePriceSnapshots && entry.name.startsWith('lp_prices_'))) continue;
            out.push({ path: full, mtime: storage.stat(full).mtimeMs });
        }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return out.length > 0 ? out[0].path : null;
}

export = {
    findLatestLpData,
};
