/**
 * Storage abstraction layer.
 *
 * Provides a unified IStorageAdapter interface for all filesystem operations.
 *
 * Usage:
 *   const storage = require('./modules/storage').getStorage();
 *   const data = storage.readJSON('/path/to/file.json');
 *   storage.writeJSON('/path/to/file.json', { hello: 'world' });
 *   if (storage.exists('/path/to/file.json')) { ... }
 *
 * Node:    wraps fs.*Sync directly; writeJSON uses unified atomic tmp+rename.
 * Browser: in-memory Map backed by IndexedDB (call flush() to persist).
 *
 * Adapter selection:
 *   - If `globalThis.window !== undefined` → BrowserStorageAdapter
 *   - Otherwise → NodeStorageAdapter
 *   - Explicit override via `setAdapter(adapter)` for DI/testing.
 */

const { IStorageAdapter } = require('./types');
const NodeStorageAdapter = require('./node_adapter');
const createBrowserStorageAdapter = require('./browser_adapter');

let _adapter = null;

function getStorage() {
  if (_adapter) return _adapter;

  const isBrowser = typeof globalThis !== 'undefined' && typeof globalThis.window !== 'undefined';
  if (isBrowser) {
    _adapter = createBrowserStorageAdapter();
  } else {
    _adapter = new NodeStorageAdapter();
  }

  return _adapter;
}

/**
 * Override the storage adapter (for DI, testing, or explicit choice).
 * Pass `null` to reset to auto-detection on next `getStorage()` call.
 */
function setAdapter(adapter) {
  _adapter = adapter;
}

export { getStorage, setAdapter, IStorageAdapter, NodeStorageAdapter, createBrowserStorageAdapter };
