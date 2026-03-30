const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const DEFAULT_MANIFEST_FILE = 'config.json';
const DEFAULT_BOTS_FILE = 'bots.json';
const DEFAULT_GENERAL_SETTINGS_FILE = 'general.settings.json';
const DEFAULT_AMA_PROFILES_FILE = 'ama_profiles.json';
const DEFAULT_ORDERS_DIR = 'orders';

const KNOWN_BOT_KEYS = new Set([
  'active', 'activeOrders', 'assetA', 'assetAId', 'assetB', 'assetBId',
  'botFunds', 'dryRun', 'gridPrice', 'gridPriceOffsetCooldownMs',
  'gridPriceOffsetAllowNeutralReset', 'gridPriceOffsetMaxPct',
  'gridPriceOffsetMinConfidence', 'gridPriceOffsetMinDeltaPct', 'gridPriceOffsetPct',
  'gridPriceOffsetRequireConfirmedTrend',
  'gridPriceOffsetScale',
  'incrementPercent', 'maxPrice',
  'minPrice', 'name', 'preferredAccount', 'startPrice', 'strategy',
  'targetSpreadPercent', 'weightDistribution',
  // Added by normalization
  'botIndex', 'botKey'
]);
const REQUIRED_BOT_KEY_ALIASES = {
  assetA: ['assetA', 'assetAId'],
  assetB: ['assetB', 'assetBId']
};

function sanitizeKey(source) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

function createBotKey(bot, index) {
  const identifier = bot && bot.name
    ? bot.name
    : bot && bot.assetA && bot.assetB
      ? `${bot.assetA}/${bot.assetB}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

function resolveRawBotEntries(settings) {
  if (!settings || typeof settings !== 'object') return [];
  if (Array.isArray(settings.bots)) return settings.bots;
  if (Object.keys(settings).length > 0) return [settings];
  return [];
}

function validateBotEntry(entry, index, logger) {
  const warnings = [];

  for (const [label, aliases] of Object.entries(REQUIRED_BOT_KEY_ALIASES)) {
    const hasAnyAlias = aliases.some((key) => {
      const value = entry[key];
      return value !== undefined && value !== null && value !== '';
    });
    if (!hasAnyAlias) {
      warnings.push(`bot[${index}]: missing required key '${label}'`);
    }
  }

  const unrecognizedKeys = [];
  for (const key of Object.keys(entry)) {
    if (!KNOWN_BOT_KEYS.has(key)) {
      unrecognizedKeys.push(key);
    }
  }

  if (logger && warnings.length > 0) {
    for (const warning of warnings) {
      (logger.warn || logger.log || console.warn).call(logger, `[dexbot-profiles] ${warning}`);
    }
  }
  if (logger && unrecognizedKeys.length > 0) {
    const logDebug = logger.debug || logger.log || console.debug;
    logDebug.call(logger, `[dexbot-profiles] bot[${index}]: unrecognized keys: ${unrecognizedKeys.join(', ')}`);
  }

  return warnings;
}

function normalizeBotEntries(rawEntries, options = {}) {
  const logger = options.logger || null;
  return rawEntries.map((entry, index) => {
    if (logger) {
      validateBotEntry(entry, index, logger);
    }
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
  });
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function isFileLike(targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectoryLike(targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveProfilesDir(profileRoot) {
  const candidates = [];
  const root = profileRoot ? path.resolve(profileRoot) : null;

  if (root) {
    candidates.push(root);
    candidates.push(path.join(root, 'profiles'));
    if (path.basename(root) === 'profiles') {
      candidates.push(path.dirname(root));
    }
  }

  if (process.env.DEXBOT_PROFILE_ROOT) {
    const envRoot = path.resolve(process.env.DEXBOT_PROFILE_ROOT);
    candidates.push(envRoot);
    candidates.push(path.join(envRoot, 'profiles'));
  }

  candidates.push(path.resolve(process.cwd(), 'profiles'));

  for (const candidate of candidates) {
    if (isFileLike(candidate)) {
      return path.dirname(candidate);
    }

    if (!isDirectoryLike(candidate)) {
      continue;
    }

    const manifestFile = path.join(candidate, DEFAULT_MANIFEST_FILE);
    const botsFile = path.join(candidate, DEFAULT_BOTS_FILE);
    const generalSettingsFile = path.join(candidate, DEFAULT_GENERAL_SETTINGS_FILE);
    const amaProfilesFile = path.join(candidate, DEFAULT_AMA_PROFILES_FILE);

    if (
      fs.existsSync(manifestFile) ||
      fs.existsSync(botsFile) ||
      fs.existsSync(generalSettingsFile) ||
      fs.existsSync(amaProfilesFile)
    ) {
      return candidate;
    }
  }

  if (root && isDirectoryLike(root)) {
    return root;
  }

  return path.resolve(process.cwd(), 'profiles');
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

async function acquireFileLock(filePath) {
  const lockPath = `${filePath}.lock`;

  // Acquire advisory lock
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fsPromises.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return async () => {
        await fsPromises.unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = await fsPromises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30000) {
          // Stale lock — attempt to break it atomically by re-creating with wx.
          // If another process grabbed it between our stat and this write, the
          // wx flag will throw EEXIST and we retry on the next iteration.
          try {
            await fsPromises.unlink(lockPath);
            await fsPromises.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return async () => {
              await fsPromises.unlink(lockPath).catch(() => {});
            };
          } catch {
            // Another writer beat us — fall through and retry
          }
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Could not acquire lock on ${filePath} within 5000ms`);
}

async function writeJsonPayload(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  } catch (err) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function writeJsonFileAtomic(filePath, data) {
  const release = await acquireFileLock(filePath);
  try {
    await writeJsonPayload(filePath, data);
  } finally {
    await release();
  }
}

async function readTriggerFile(triggerPath) {
  try {
    const raw = await fsPromises.readFile(triggerPath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return { exists: true, payload: null };
    try {
      return { exists: true, payload: JSON.parse(trimmed) };
    } catch {
      return { exists: true, payload: trimmed };
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, payload: null };
    throw err;
  }
}

async function listFiles(dirPath) {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Failed to list ${dirPath}: ${error.message}`);
  }
}

function matchBotIdentifier(bot, identifier) {
  if (!bot || identifier === null || identifier === undefined) {
    return false;
  }

  if (typeof identifier === 'object') {
    if (identifier.botKey && bot.botKey === identifier.botKey) {
      return true;
    }
    if (identifier.name && bot.name === identifier.name) {
      return true;
    }
    if (identifier.assetA && identifier.assetB && bot.assetA === identifier.assetA && bot.assetB === identifier.assetB) {
      return true;
    }
    return false;
  }

  const value = String(identifier).trim();
  if (!value) {
    return false;
  }

  if (bot.botKey === value || bot.name === value) {
    return true;
  }

  if (`${bot.assetA}/${bot.assetB}` === value) {
    return true;
  }

  return sanitizeKey(bot.name) === sanitizeKey(value);
}

function findAmaProfile(bundle, bot) {
  const profiles = Array.isArray(bundle?.amaProfiles?.profiles) ? bundle.amaProfiles.profiles : [];
  if (profiles.length === 0 || !bot) {
    return null;
  }

  const botAssetA = bot.assetAId || bot.assetA || null;
  const botAssetB = bot.assetBId || bot.assetB || null;

  const match = profiles.find((profile) => {
    if (!profile || typeof profile !== 'object') {
      return false;
    }

    const profileAssetA = profile.assetAId || profile.assetA || null;
    const profileAssetB = profile.assetBId || profile.assetB || null;

    return profileAssetA === botAssetA && profileAssetB === botAssetB;
  });

  return match ? clone(match) : null;
}

function buildClawProfileContext(bundle, options = {}) {
  if (!bundle || typeof bundle !== 'object') {
    return null;
  }

  const botIdentifier = options.botIdentifier || options.botRef || options.botKey || options.name || null;
  const selectedBot =
    options.selectedBot ||
    (botIdentifier ? bundle.bots.find((bot) => matchBotIdentifier(bot, botIdentifier)) : null) ||
    bundle.activeBots[0] ||
    bundle.bots[0] ||
    null;

  const selectedAmaProfile = findAmaProfile(bundle, selectedBot);
  const selectedOrderSnapshotPath = selectedBot ? path.join(bundle.ordersDir, `${selectedBot.botKey}.json`) : null;
  const selectedGridPriceSnapshotPath = selectedBot ? path.join(bundle.ordersDir, `${selectedBot.botKey}.gridprice.json`) : null;
  const selectedTriggerPath = selectedBot ? path.join(bundle.profilesDir, `recalculate.${selectedBot.botKey}.trigger`) : null;
  const selectedOrderSnapshot = selectedBot
    ? clone(options.orderSnapshot !== undefined ? options.orderSnapshot : null)
    : null;
  const selectedGridPriceSnapshot = selectedBot
    ? clone(options.gridPriceSnapshot !== undefined ? options.gridPriceSnapshot : null)
    : null;

  return {
    profileRoot: bundle.profilesDir,
    runtime: {
      loadedAt: new Date().toISOString(),
      selectedBotRef: botIdentifier,
      sourceFiles: clone(bundle.files)
    },
    settings: {
      amaProfiles: clone(bundle.amaProfiles),
      bots: clone(bundle.bots),
      general: clone(bundle.generalSettings),
      manifest: clone(bundle.manifest)
    },
    selectedBot: selectedBot ? clone(selectedBot) : null,
    selectedBotFiles: selectedBot ? {
      gridPriceSnapshot: selectedGridPriceSnapshotPath,
      orderSnapshot: selectedOrderSnapshotPath,
      trigger: selectedTriggerPath
    } : null,
    selectedBotState: selectedBot ? {
      gridPriceSnapshot: selectedGridPriceSnapshot,
      orderSnapshot: selectedOrderSnapshot,
      selectedAmaProfile,
      triggerExists: selectedTriggerPath ? fs.existsSync(selectedTriggerPath) : false,
      triggerPayload: options.triggerPayload !== undefined ? options.triggerPayload : null
    } : null,
    summary: {
      activeBotCount: bundle.activeBots.length,
      amaProfileCount: Array.isArray(bundle.amaProfiles?.profiles) ? bundle.amaProfiles.profiles.length : 0,
      botCount: bundle.bots.length,
      hasAmaProfiles: Boolean(bundle.amaProfiles),
      hasGeneralSettings: Boolean(bundle.generalSettings),
      hasManifest: Boolean(bundle.manifest),
      orderFileCount: bundle.orderFiles.length
    }
  };
}

async function loadDexbotProfileBundle(profileRoot, options = {}) {
  const profilesDir = resolveProfilesDir(profileRoot || options.profileRoot);
  const ordersDir = path.join(profilesDir, DEFAULT_ORDERS_DIR);
  const manifestFile = options.manifestFile || path.join(profilesDir, DEFAULT_MANIFEST_FILE);
  const botsFile = options.botsFile || path.join(profilesDir, DEFAULT_BOTS_FILE);
  const generalSettingsFile = options.generalSettingsFile || path.join(profilesDir, DEFAULT_GENERAL_SETTINGS_FILE);
  const amaProfilesFile = options.amaProfilesFile || path.join(profilesDir, DEFAULT_AMA_PROFILES_FILE);

  const [manifest, botsConfig, generalSettings, amaProfiles, orderFiles] = await Promise.all([
    readJsonFile(manifestFile),
    readJsonFile(botsFile),
    readJsonFile(generalSettingsFile),
    readJsonFile(amaProfilesFile),
    listFiles(ordersDir)
  ]);

  const bots = normalizeBotEntries(resolveRawBotEntries(botsConfig), { logger: options.logger });
  const activeBots = bots.filter((bot) => bot.active !== false);
  const botsByKey = Object.fromEntries(bots.map((bot) => [bot.botKey, bot]));
  const botsByName = Object.fromEntries(bots.filter((bot) => bot.name).map((bot) => [bot.name, bot]));

  return {
    amaProfiles,
    activeBots,
    bots,
    botsByKey,
    botsByName,
    botsConfig,
    files: {
      amaProfiles: amaProfilesFile,
      bots: botsFile,
      generalSettings: generalSettingsFile,
      manifest: manifestFile,
      ordersDir
    },
    generalSettings,
    manifest,
    orderFiles,
    ordersDir,
    profilesDir
  };
}

function createDexbotProfileAdapter(profileRoot, options = {}) {
  let cachedBundle = null;

  async function loadBundle(forceReload = false) {
    if (!cachedBundle || forceReload) {
      cachedBundle = await loadDexbotProfileBundle(profileRoot, options);
    }
    return cachedBundle;
  }

  function getProfilesDir() {
    return resolveProfilesDir(profileRoot || options.profileRoot);
  }

  async function listBots({ activeOnly = false, forceReload = false } = {}) {
    const bundle = await loadBundle(forceReload);
    return activeOnly ? bundle.activeBots : bundle.bots;
  }

  async function findBot(identifier, forceReload = false) {
    const bundle = await loadBundle(forceReload);
    return bundle.bots.find((bot) => matchBotIdentifier(bot, identifier)) || null;
  }

  async function getBotBundle(identifier, forceReload = false) {
    const bundle = await loadBundle(forceReload);
    const bot = bundle.bots.find((entry) => matchBotIdentifier(entry, identifier)) || null;
    if (!bot) {
      return null;
    }

    const orderSnapshotPath = path.join(bundle.ordersDir, `${bot.botKey}.json`);
    const gridPriceSnapshotPath = path.join(bundle.ordersDir, `${bot.botKey}.gridprice.json`);
    const triggerPath = path.join(bundle.profilesDir, `recalculate.${bot.botKey}.trigger`);

    const [orderSnapshot, gridPriceSnapshot, trigger] = await Promise.all([
      readJsonFile(orderSnapshotPath),
      readJsonFile(gridPriceSnapshotPath),
      readTriggerFile(triggerPath)
    ]);

    return {
      bot,
      files: {
        gridPriceSnapshot: gridPriceSnapshotPath,
        orderSnapshot: orderSnapshotPath,
        trigger: triggerPath
      },
      gridPriceSnapshot,
      orderSnapshot,
      triggerExists: trigger.exists,
      triggerPayload: trigger.payload
    };
  }

  async function getClawProfileContext(identifier, options = {}) {
    const bundle = await loadBundle(Boolean(options.forceReload));
    const bot = identifier ? bundle.bots.find((entry) => matchBotIdentifier(entry, identifier)) || null : null;
    const selectedBot = options.selectedBot || bot || bundle.activeBots[0] || bundle.bots[0] || null;
    const selectedBotBundle = selectedBot ? await getBotBundle(selectedBot.botKey, Boolean(options.forceReload)) : null;
    return buildClawProfileContext(bundle, {
      ...options,
      botIdentifier: identifier,
      gridPriceSnapshot: selectedBotBundle ? selectedBotBundle.gridPriceSnapshot : null,
      orderSnapshot: selectedBotBundle ? selectedBotBundle.orderSnapshot : null,
      selectedBot,
      triggerPayload: selectedBotBundle ? selectedBotBundle.triggerPayload : null
    });
  }

  async function listOrderArtifacts(forceReload = false) {
    const bundle = await loadBundle(forceReload);
    return Promise.all(bundle.orderFiles.map(async (fileName) => {
      const fullPath = path.join(bundle.ordersDir, fileName);
      if (fileName.endsWith('.json')) {
        return { fileName, fullPath, json: await readJsonFile(fullPath) };
      }
      return { fileName, fullPath, json: null };
    }));
  }

  async function consumeTrigger(botKey) {
    const triggerPath = path.join(getProfilesDir(), `recalculate.${botKey}.trigger`);
    const trigger = await readTriggerFile(triggerPath);
    if (!trigger.exists) {
      return { consumed: false, payload: null };
    }
    await fsPromises.unlink(triggerPath).catch(() => {});
    return { consumed: true, payload: trigger.payload };
  }

  async function writeTrigger(botKey, payload = null) {
    const triggerPath = path.join(getProfilesDir(), `recalculate.${botKey}.trigger`);
    const content = payload ? JSON.stringify(payload, null, 2) : '';
    await fsPromises.writeFile(triggerPath, content, 'utf8');
  }

  async function updateBotSettings(identifier, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new Error('patch must be a non-null object');
    }

    const bundle = await loadBundle(true);
    const release = await acquireFileLock(bundle.files.bots);

    try {
      const currentBotsConfig = await readJsonFile(bundle.files.bots);
      const currentRawEntries = resolveRawBotEntries(currentBotsConfig);
      const currentBots = normalizeBotEntries(currentRawEntries, { logger: options.logger });
      const bot = currentBots.find((entry) => matchBotIdentifier(entry, identifier));
      if (!bot) {
        throw new Error(`Bot not found: ${identifier}`);
      }

      if (!currentRawEntries[bot.botIndex]) {
        throw new Error(`Bot index ${bot.botIndex} out of range`);
      }

      const nextEntry = {
        ...currentRawEntries[bot.botIndex],
        ...patch
      };
      const nextRawEntries = currentRawEntries.slice();
      nextRawEntries[bot.botIndex] = nextEntry;

      // Preserve the original wrapper structure
      const dataToWrite = Array.isArray(currentBotsConfig)
        ? nextRawEntries
        : Array.isArray(currentBotsConfig?.bots)
          ? { ...currentBotsConfig, bots: nextRawEntries }
          : nextEntry;

      await writeJsonPayload(bundle.files.bots, dataToWrite);
    } finally {
      await release();
    }

    cachedBundle = null;
    const freshBundle = await loadBundle(true);
    return freshBundle.bots.find((entry) => matchBotIdentifier(entry, identifier)) || null;
  }

  return {
    buildClawProfileContext: (bundle, contextOptions = {}) => buildClawProfileContext(bundle, contextOptions),
    consumeTrigger,
    findBot,
    getBotBundle,
    getClawProfileContext,
    getProfilesDir,
    listBots,
    listOrderArtifacts,
    loadBundle,
    resolveProfilesDir: () => resolveProfilesDir(profileRoot || options.profileRoot),
    updateBotSettings,
    writeTrigger
  };
}

module.exports = {
  createBotKey,
  createDexbotProfileAdapter,
  buildClawProfileContext,
  loadDexbotProfileBundle,
  normalizeBotEntries,
  readTriggerFile,
  resolveProfilesDir,
  resolveRawBotEntries,
  sanitizeKey,
  acquireFileLock,
  validateBotEntry,
  writeJsonFileAtomic
};
