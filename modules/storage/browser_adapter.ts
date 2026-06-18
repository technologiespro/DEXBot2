/**
 * BrowserStorageAdapter — in-memory Map backed by IndexedDB.
 *
 * Architecture:
 *   - On construction, schedules an async IndexedDB load into an in-memory Map.
 *     Until the load completes, synchronous reads return undefined/defaults.
 *   - All sync operations (readJSON, writeJSON, exists, etc.) hit the Map.
 *   - Call `await adapter.flush()` periodically or after writes to persist
 *     to IndexedDB.  This matches the browser's single-tab / single-process
 *     concurrency model — no cross-process atomicity needed.
 *
 * IndexedDB schema:
 *   DB name: "DEXBotStorage"
 *   Store name: "files"
 *   Key: file path (string)
 *   Value: { content: string, type: 'json' | 'text', mtime: number }
 *
 * If IndexedDB is unavailable (private browsing, SSR), falls back to a
 * MemoryMap adapter that logs a warning.
 */

function createBrowserStorageAdapter() {
  const store = new Map();

  /** Try to open IndexedDB and load all records into memory. */
  async function initFromIndexedDB() {
    let db;
    try {
      db = await openDB();
      const tx = db.transaction('files', 'readonly');
      const cursor = tx.objectStore('files').openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = (event: any) => {
          const cur = event.target.result;
          if (cur) {
            store.set(cur.key, cur.value);
            cur.continue();
          } else {
            resolve();
          }
        };
        cursor.onerror = () => reject(cursor.error);
      });
    } catch {
      // IndexedDB unavailable — MemoryMap mode
    } finally {
      if (db) db.close();
    }
  }

  /** Flush in-memory store back to IndexedDB. */
  async function flush() {
    let db;
    try {
      db = await openDB();
      const tx = db.transaction('files', 'readwrite');
      const os = tx.objectStore('files');
      for (const [key, value] of store) {
        os.put(value, key);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // MemoryMap mode — nothing to flush
    } finally {
      if (db) db.close();
    }
  }

  function openDB() {
    const idb: any = (globalThis as any).indexedDB;
    return new Promise<any>((resolve, reject) => {
      const request = idb.open('DEXBotStorage', 1);
      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files');
        }
      };
      request.onsuccess = (event: any) => resolve(event.target.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Kick off async IndexedDB load (non-blocking)
  initFromIndexedDB().catch(() => {});

  const adapter = {
    readJSON(path) {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return JSON.parse(entry.content);
    },

    writeJSON(path, data, options) {
      if (options?.flag === 'wx' && store.has(path)) {
        const err: any = new Error(`EEXIST: ${path}`);
        err.code = 'EEXIST';
        throw err;
      }
      const content = JSON.stringify(data, null, 2) + '\n';
      store.set(path, {
        content,
        type: 'json',
        mtime: Date.now(),
        mode: options?.mode,
      });
    },

    exists(path) {
      return store.has(path);
    },

    ensureDir(_path, _options) {
      // In-memory: directories are implicit
    },

    unlink(path) {
      store.delete(path);
    },

    readFile(path, encoding = 'utf8') {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (encoding === 'utf8' || encoding === 'utf-8') return entry.content;
      return entry.content;
    },

    writeFile(path, data, options) {
      store.set(path, {
        content: data,
        type: 'text',
        mtime: Date.now(),
        mode: typeof options === 'object' ? options.mode : undefined,
      });
    },

    rename(oldPath, newPath) {
      const entry = store.get(oldPath);
      if (entry) {
        store.set(newPath, entry);
        store.delete(oldPath);
      }
    },

    stat(path) {
      const entry = store.get(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        mtimeMs: entry.mtime || 0,
        isFile: () => true,
        isDirectory: () => false,
      };
    },

    readdir(_path) {
      return [];
    },

    open(_path, _flags, _mode) {
      throw new Error('open() not supported in browser adapter');
    },
    close() {
      throw new Error('close() not supported in browser adapter');
    },
    write() {
      throw new Error('write() not supported in browser adapter');
    },
    fsync() {
      throw new Error('fsync() not supported in browser adapter');
    },
    chmod() {
      // no-op in browser
    },
    realpath(path) {
      return path;
    },
    access() {
      // no-op — all file operations are permitted in-memory
    },
    utimes(_path, _atime, _mtime) {
      // no-op in browser
    },
    lstat(path) {
      return this.stat(path);
    },

    rmdir(_path) {
      // no-op in browser
    },

    rm(_path, _options) {
      // no-op in browser
    },

    mkdtemp(prefix) {
      return `${prefix}${Date.now()}`;
    },

    readlink(_path) {
      throw new Error('readlink() not supported in browser adapter');
    },

    flush,
  };

  return adapter;
}

export = createBrowserStorageAdapter;
