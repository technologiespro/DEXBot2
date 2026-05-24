// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

function isDexbot2Root(candidate) {
  return !!candidate && (
    fs.existsSync(path.join(candidate, 'dist', 'dexbot.js')) ||
    fs.existsSync(path.join(candidate, 'dexbot.js')) ||
    fs.existsSync(path.join(candidate, 'dexbot.ts'))
  );
}

function findDexbot2Root(startDir) {
  let candidate = path.resolve(startDir || __dirname);
  for (let i = 0; i < 8; i++) {
    if (isDexbot2Root(candidate)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return path.resolve(startDir || __dirname);
}

const DEFAULT_ROOT = findDexbot2Root(path.resolve(__dirname, '..', '..'));

function normalizeRoot(options = {}) {
  if (options.profileRoot) {
    const resolved = path.resolve(options.profileRoot);
    let candidate = path.dirname(resolved);
    for (let i = 0; i < 3; i++) {
      if (isDexbot2Root(candidate)) {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    // Fall back to one level up (original behavior)
    return path.dirname(resolved);
  }
  return DEFAULT_ROOT;
}

function normalizeProfileDir(options = {}) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }
  return path.join(DEFAULT_ROOT, 'profiles');
}

function resolveRuntimeScript(root, ...segments) {
  const sourcePath = path.join(root, ...segments);
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  return path.join(root, 'dist', ...segments);
}

export = { normalizeRoot, normalizeProfileDir, resolveRuntimeScript };
