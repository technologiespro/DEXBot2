'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '../../');

function normalizeRoot(options = {}) {
  if (options.profileRoot) {
    const resolved = path.resolve(options.profileRoot);
    // Walk up from profileRoot looking for dexbot.js as a project root marker
    let candidate = path.dirname(resolved);
    for (let i = 0; i < 3; i++) {
      if (fs.existsSync(path.join(candidate, 'dexbot.js'))) {
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

module.exports = { normalizeRoot, normalizeProfileDir };
