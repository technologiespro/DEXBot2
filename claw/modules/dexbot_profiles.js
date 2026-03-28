const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const DEFAULT_MANIFEST_FILE = 'config.json';
const DEFAULT_BOTS_FILE = 'bots.json';
const DEFAULT_GENERAL_SETTINGS_FILE = 'general.settings.json';
const DEFAULT_AMA_PROFILES_FILE = 'ama_profiles.json';
const DEFAULT_ORDERS_DIR = 'orders';

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

function normalizeBotEntries(rawEntries) {
  return rawEntries.map((entry, index) => {
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
      triggerExists: selectedTriggerPath ? fs.existsSync(selectedTriggerPath) : false
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

  const bots = normalizeBotEntries(resolveRawBotEntries(botsConfig));
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

    const [orderSnapshot, gridPriceSnapshot] = await Promise.all([
      readJsonFile(orderSnapshotPath),
      readJsonFile(gridPriceSnapshotPath)
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
      triggerExists: fs.existsSync(triggerPath)
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
      selectedBot
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

  return {
    buildClawProfileContext: (bundle, contextOptions = {}) => buildClawProfileContext(bundle, contextOptions),
    findBot,
    getBotBundle,
    getClawProfileContext,
    getProfilesDir,
    listBots,
    listOrderArtifacts,
    loadBundle,
    resolveProfilesDir: () => resolveProfilesDir(profileRoot || options.profileRoot)
  };
}

module.exports = {
  createBotKey,
  createDexbotProfileAdapter,
  buildClawProfileContext,
  loadDexbotProfileBundle,
  normalizeBotEntries,
  resolveProfilesDir,
  resolveRawBotEntries,
  sanitizeKey
};
