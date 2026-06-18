/**
 * NodeStorageAdapter — wraps fs.*Sync calls directly.
 * Single unified atomic-write implementation replaces all prior variants.
 *
 * Atomic write strategy:
 *   writeJSON → tmp file (with crypto.randomBytes for collision resistance)
 *             → optional fd-level write with mode + fsync
 *             → rename over target
 *             → cleanup tmp on failure
 *
 * This subsumes the 5 prior implementations:
 *   1. fs_utils.writeJSON             (tmp+rename, no mode/fsync)
 *   2. bots_file_lock.writeJsonFileAtomic (tmp+rename + crypto.randomBytes + ensureDir)
 *   3. atomic_write.writeJsonAtomic   (tmp+rename + Math.random + ensureDir)
 *   4. chain_keys inline              (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   5. credential_policy inline       (openSync 0o600 + writeSync + fsyncSync + renameSync)
 *   6. account_orders._persist        (writeFileSync + read-fsync + renameSync)
 */

const fs = require('fs');
const { path } = require('../path_api');
const { randomBytes } = require('../crypto/sync');

class NodeStorageAdapter {
  readJSON(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  writeJSON(filePath: string, data: any, options: any = {}) {
    const dir = path.dirname(filePath);
    if (dir && !this.exists(dir)) {
      this.ensureDir(dir);
    }

    const suffix = options.tmpPrefix || `.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
    const tmpPath = `${filePath}${suffix}`;
    const content = JSON.stringify(data, null, 2) + '\n';

    try {
      if (options.mode !== undefined || options.fsync) {
        const fd = fs.openSync(tmpPath, 'w', options.mode ?? 0o666);
        try {
          fs.writeSync(fd, content, 0, 'utf8');
          if (options.fsync) {
            fs.fsyncSync(fd);
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.writeFileSync(tmpPath, content, 'utf8');
      }
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      this.unlink(tmpPath);
      throw err;
    }
  }

  exists(path) {
    return fs.existsSync(path);
  }

  ensureDir(path: string, options: any = {}) {
    const opts: any = { recursive: true };
    if (options.mode !== undefined) opts.mode = options.mode;
    fs.mkdirSync(path, opts);
  }

  unlink(path) {
    if (!path) return;
    try { fs.unlinkSync(path); } catch (_) {}
  }

  readFile(path, encoding = 'utf8') {
    return fs.readFileSync(path, encoding);
  }

  writeFile(path, data, options) {
    fs.writeFileSync(path, data, options ?? 'utf8');
  }

  rename(oldPath, newPath) {
    fs.renameSync(oldPath, newPath);
  }

  stat(path) {
    return fs.statSync(path);
  }

  readdir(path) {
    return fs.readdirSync(path);
  }

  open(path, flags, mode) {
    return fs.openSync(path, flags, mode);
  }

  close(fd) {
    fs.closeSync(fd);
  }

  write(fd, buffer, position, encoding) {
    fs.writeSync(fd, buffer, position, encoding);
  }

  fsync(fd) {
    fs.fsyncSync(fd);
  }

  chmod(path, mode) {
    fs.chmodSync(path, mode);
  }

  realpath(path) {
    return fs.realpathSync(path);
  }

  access(path, mode) {
    return fs.accessSync(path, mode);
  }

  utimes(path, atime, mtime) {
    fs.utimesSync(path, atime, mtime);
  }

  lstat(path) {
    return fs.lstatSync(path);
  }

  rmdir(path) {
    fs.rmdirSync(path);
  }

  rm(path, options = {}) {
    fs.rmSync(path, options);
  }

  mkdtemp(prefix) {
    return fs.mkdtempSync(prefix);
  }

  readlink(path) {
    return fs.readlinkSync(path);
  }
}

export = NodeStorageAdapter;
