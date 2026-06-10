'use strict';

const fs = require('fs');
const path = require('path');
const { BUILD_DIR } = require('../../modules/constants');

function isDexbot2Root(candidate: string) {
  return !!candidate && (
    fs.existsSync(path.join(candidate, BUILD_DIR, 'dexbot.js')) ||
    fs.existsSync(path.join(candidate, 'dexbot.js')) ||
    fs.existsSync(path.join(candidate, 'dexbot.ts'))
  );
}

function findDexbot2Root(startDir?: string) {
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

const LP_PARENT_DIR = path.dirname(path.dirname(__dirname));
const LP_PROJECT_ROOT = path.basename(LP_PARENT_DIR) === BUILD_DIR ? path.dirname(LP_PARENT_DIR) : LP_PARENT_DIR;
const DEFAULT_ROOT = findDexbot2Root(LP_PROJECT_ROOT);

function normalizeRoot(options: Record<string, any> = {}) {
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

function normalizeProfileDir(options: Record<string, any> = {}) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }
  return path.join(DEFAULT_ROOT, 'profiles');
}

function resolveRuntimeScript(root: string, ...segments: string[]) {
  const sourcePath = path.join(root, ...segments);
  if (fs.existsSync(sourcePath)) {
    return sourcePath;
  }
  return path.join(root, BUILD_DIR, ...segments);
}

export = { normalizeRoot, normalizeProfileDir, resolveRuntimeScript };
