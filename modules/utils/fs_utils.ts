const fs = require('fs');

function readJSON<T = any>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filePath: string, data: any, options?: { mode?: number }): void {
    let content = JSON.stringify(data, null, 2) + '\n';
    const opts: any = { encoding: 'utf8' };
    if (options?.mode !== undefined) opts.mode = options.mode;
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content, opts);
    fs.renameSync(tmpPath, filePath);
}

function ensureDir(dirPath: string, options?: { mode?: number }): void {
    const opts: any = { recursive: true };
    if (options?.mode !== undefined) opts.mode = options.mode;
    fs.mkdirSync(dirPath, opts);
}

function safeUnlink(filePath: string): void {
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch (_) {}
}

export = { readJSON, writeJSON, ensureDir, safeUnlink };
