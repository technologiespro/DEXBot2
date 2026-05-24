const path = require('path');
const fs = require('fs');

function candidateExists(candidatePath) {
  if (fs.existsSync(candidatePath)) {
    return true;
  }
  if (!path.extname(candidatePath) && fs.existsSync(`${candidatePath}.js`)) {
    return true;
  }
  if (candidatePath.endsWith('.js') && fs.existsSync(candidatePath.replace(/\.js$/, '.ts'))) {
    return true;
  }
  return false;
}

function getDexbot2Root() {
  if (process.env.DEXBOT2_ROOT) {
    return path.resolve(process.env.DEXBOT2_ROOT);
  }

  const repoRoot = path.resolve(__dirname, '../..');
  if (
    candidateExists(path.join(repoRoot, 'modules', 'order', 'index.js')) ||
    candidateExists(path.join(repoRoot, 'dist', 'modules', 'order', 'index.js'))
  ) {
    return repoRoot;
  }

  throw new Error('Unable to resolve DEXBot2 root. Set DEXBOT2_ROOT or run from a DEXBot2 checkout.');
}

function resolveDexbot2Path(relativePath) {
  const root = getDexbot2Root();
  const normalizedPath = String(relativePath || '');
  const candidates = [path.join(root, normalizedPath)];

  if (normalizedPath.endsWith('.js')) {
    candidates.push(path.join(root, normalizedPath.replace(/\.js$/, '.ts')));
  }

  candidates.push(path.join(root, 'dist', normalizedPath));

  for (const candidate of candidates) {
    if (candidateExists(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

function requireDexbot2Module(relativePath) {
  return require(resolveDexbot2Path(relativePath));
}

function loadDexbotOrderSubsystem() {
  return requireDexbot2Module('modules/order/index.js');
}

function loadDexbotOrderUtils() {
  return loadDexbotOrderSubsystem().utils;
}

function loadDexbotOrderConstants() {
  return loadDexbotOrderSubsystem().constants;
}

function loadDexbotOrderSystemUtils() {
  return requireDexbot2Module('modules/order/utils/system');
}

export = {
  getDexbot2Root,
  loadDexbotOrderConstants,
  loadDexbotOrderSubsystem,
  loadDexbotOrderSystemUtils,
  loadDexbotOrderUtils,
  requireDexbot2Module,
  resolveDexbot2Path
};
