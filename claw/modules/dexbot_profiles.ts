const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { DEFAULT_CONFIG, GRID_LIMITS, INCREMENT_BOUNDS } = require('../../modules/constants');
const { resolveRelativePrice } = require('../../modules/order/utils/math');
const { acquireFileLock } = require('../../market_adapter/utils/file_lock');

import type { BotSettings, ProfileOptions, Logger, ClawProfileBundle } from './types';

const DEFAULT_MANIFEST_FILE = 'config.json';
const DEFAULT_BOTS_FILE = 'bots.json';
const DEFAULT_GENERAL_SETTINGS_FILE = 'general.settings.json';
const DEFAULT_MARKET_PROFILES_FILE = 'market_profiles.json';
const DEFAULT_ORDERS_DIR = 'orders';

const KNOWN_BOT_KEYS = new Set([
  'active', 'activeOrders', 'assetA', 'assetAId', 'assetB', 'assetBId',
  'botFunds', 'dryRun', 'gridPrice',
  'incrementPercent', 'maxPrice',
  'minPrice', 'name', 'preferredAccount', 'startPrice', 'strategy',
  'targetSpreadPercent', 'weightDistribution',
  // Added by normalization
  'botIndex', 'botKey'
]);
const BOT_SETTINGS_READ_ONLY_KEYS = new Set(['botIndex', 'botKey']);
const BOT_SETTINGS_TRIGGER_KEYS = new Set([
  'active',
  'activeOrders',
  'assetA',
  'assetAId',
  'assetB',
  'assetBId',
  'botFunds',
  'dryRun',
  'gridPrice',
  'incrementPercent',
  'maxPrice',
  'minPrice',
  'preferredAccount',
  'startPrice',
  'strategy',
  'targetSpreadPercent',
  'weightDistribution'
]);
const REQUIRED_BOT_KEY_ALIASES = {
  assetA: ['assetA', 'assetAId'],
  assetB: ['assetB', 'assetBId']
};

const BOT_SETTINGS_NESTED_KEYS = Object.freeze({
  activeOrders: new Set(['buy', 'sell']),
  botFunds: new Set(['buy', 'sell']),
  weightDistribution: new Set(['buy', 'sell'])
});
const BOT_SETTINGS_STATE_FIELDS = Object.freeze({
  numeric: [
    'incrementPercent',
    'targetSpreadPercent'
  ],
  boolean: [
    'active',
    'dryRun'
  ],
  priceLike: [
    'startPrice',
    'gridPrice',
    'minPrice',
    'maxPrice'
  ],
  string: [
    'name',
    'preferredAccount',
    'assetA',
    'assetB',
    'assetAId',
    'assetBId',
    'strategy'
  ]
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumericString(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}

function isPositiveNumericString(value) {
  if (!isNumericString(value)) {
    return false;
  }

  return Number(value.trim()) > 0;
}

function isPositiveMultiplierString(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?x$/i.test(trimmed)) {
    return false;
  }

  return parseFloat(trimmed) > 0;
}

function isPositivePriceLike(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value) && value > 0) ||
    isPositiveNumericString(value) ||
    isPositiveMultiplierString(value)
  );
}

function resolveComparablePriceValue(value, startPrice = null, mode = 'min') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (isNumericString(value)) {
    return Number(value.trim());
  }

  if (typeof value === 'string' && Number.isFinite(startPrice)) {
    const resolved = resolveRelativePrice(value, startPrice, mode);
    return Number.isFinite(resolved) ? resolved : null;
  }

  return null;
}

function validateNestedBotSettingKeys(field, value, errors) {
  const allowedKeys = BOT_SETTINGS_NESTED_KEYS[field];
  if (!allowedKeys || !isPlainObject(value)) {
    return;
  }

  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`${field} contains unrecognized keys: ${unknownKeys.join(', ')}`);
  }
}

function normalizeBooleanField(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeNumberField(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isPercentageString(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed.endsWith('%')) {
    return false;
  }

  const numeric = Number(trimmed.slice(0, -1).trim());
  return Number.isFinite(numeric);
}

function cloneBotSettings(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeBotSettings(bot: Partial<BotSettings> = {}) {
  const normalized = cloneBotSettings(bot) || {};

  normalized.active = normalizeBooleanField(normalized.active, DEFAULT_CONFIG.active);
  normalized.dryRun = normalizeBooleanField(normalized.dryRun, DEFAULT_CONFIG.dryRun);
  normalized.startPrice = normalized.startPrice === undefined ? DEFAULT_CONFIG.startPrice : normalized.startPrice;
  normalized.minPrice = normalized.minPrice === undefined ? DEFAULT_CONFIG.minPrice : normalized.minPrice;
  normalized.maxPrice = normalized.maxPrice === undefined ? DEFAULT_CONFIG.maxPrice : normalized.maxPrice;
  normalized.gridPrice = normalized.gridPrice === undefined ? DEFAULT_CONFIG.gridPrice : normalized.gridPrice;
  normalized.incrementPercent = normalized.incrementPercent === undefined
    ? DEFAULT_CONFIG.incrementPercent
    : normalizeNumberField(normalized.incrementPercent, DEFAULT_CONFIG.incrementPercent);
  normalized.targetSpreadPercent = normalized.targetSpreadPercent === undefined
    ? DEFAULT_CONFIG.targetSpreadPercent
    : normalizeNumberField(normalized.targetSpreadPercent, DEFAULT_CONFIG.targetSpreadPercent);
  normalized.weightDistribution = {
    ...cloneBotSettings(DEFAULT_CONFIG.weightDistribution),
    ...(isPlainObject(normalized.weightDistribution) ? normalized.weightDistribution : {})
  };
  normalized.botFunds = {
    ...cloneBotSettings(DEFAULT_CONFIG.botFunds),
    ...(isPlainObject(normalized.botFunds) ? normalized.botFunds : {})
  };
  normalized.activeOrders = {
    ...cloneBotSettings(DEFAULT_CONFIG.activeOrders),
    ...(isPlainObject(normalized.activeOrders) ? normalized.activeOrders : {})
  };
  return normalized;
}

function mergeBotSettingsPatch(currentBot: Record<string, any> = {}, patch: Record<string, any> = {}) {
  const next = cloneBotSettings(currentBot) || {};
  const patchKeys = Object.keys(patch || {});

  for (const key of patchKeys) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }

    if (['weightDistribution', 'botFunds', 'activeOrders'].includes(key) && isPlainObject(value)) {
      next[key] = {
        ...(isPlainObject(next[key]) ? next[key] : {}),
        ...value
      };
      continue;
    }

    next[key] = value;
  }

  return next;
}

function describeBotSettingMutability() {
  const readOnly = [...BOT_SETTINGS_READ_ONLY_KEYS].sort();
  const writable = [...KNOWN_BOT_KEYS].filter((key) => !BOT_SETTINGS_READ_ONLY_KEYS.has(key)).sort();

  return {
    readOnly,
    triggerOnChange: [...BOT_SETTINGS_TRIGGER_KEYS].sort(),
    writable
  };
}

function validateBotSettingsValue(field, value, errors) {
  const push = (message) => errors.push(message);

  switch (field) {
    case 'active':
    case 'dryRun':
      if (typeof value !== 'boolean') {
        push(`${field} must be a boolean`);
      }
      break;

    case 'name':
    case 'preferredAccount':
    case 'assetA':
    case 'assetB':
    case 'strategy':
      if (typeof value !== 'string' || value.trim() === '') {
        push(`${field} must be a non-empty string`);
      }
      break;

    case 'assetAId':
    case 'assetBId':
      if (typeof value !== 'string' || value.trim() === '') {
        push(`${field} must be a non-empty string`);
      }
      break;

    case 'incrementPercent': {
      const increment = Number(value);
      if (!Number.isFinite(increment) || increment <= 0) {
        push('incrementPercent must be a positive number');
        break;
      }
      if (Number.isFinite(INCREMENT_BOUNDS.MIN_PERCENT) && increment < INCREMENT_BOUNDS.MIN_PERCENT) {
        push(`incrementPercent must be >= ${INCREMENT_BOUNDS.MIN_PERCENT}`);
      }
      if (Number.isFinite(INCREMENT_BOUNDS.MAX_PERCENT) && increment > INCREMENT_BOUNDS.MAX_PERCENT) {
        push(`incrementPercent must be <= ${INCREMENT_BOUNDS.MAX_PERCENT}`);
      }
      break;
    }

    case 'targetSpreadPercent': {
      const spread = Number(value);
      if (!Number.isFinite(spread) || spread <= 0) {
        push('targetSpreadPercent must be a positive number');
      }
      break;
    }

    case 'startPrice':
      if (!isPositivePriceLike(value)
        && !(typeof value === 'string' && ['pool', 'book', 'market'].includes(value.toLowerCase()))) {
        push('startPrice must be a positive number or one of pool/book (or legacy: market)');
      }
      break;

    case 'gridPrice':
      if (value !== null
        && !isPositivePriceLike(value)
        && !(typeof value === 'string' && /^(pool|book|market|ama(?:[1-4])?)$/i.test(value))) {
        push('gridPrice must be null, a positive number, or one of pool/book/ama/ama1..ama4 (or legacy: market)');
      }
      break;

    case 'minPrice':
    case 'maxPrice':
      if (!isPositivePriceLike(value)) {
        push(`${field} must be a positive number or a multiplier string like 3x`);
      }
      break;



    case 'weightDistribution':
      if (!isPlainObject(value)) {
        push('weightDistribution must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('weightDistribution', value, errors);
      if (!isFiniteNumber(value.sell)) {
        push('weightDistribution.sell must be a finite number');
      }
      if (!isFiniteNumber(value.buy)) {
        push('weightDistribution.buy must be a finite number');
      }
      break;

    case 'botFunds':
      if (!isPlainObject(value)) {
        push('botFunds must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('botFunds', value, errors);
      for (const side of ['sell', 'buy']) {
        const sideValue = value[side];
        if (sideValue === undefined) {
          continue;
        }
        if (typeof sideValue === 'number') {
          if (!Number.isFinite(sideValue) || sideValue < 0) {
            push(`botFunds.${side} must be a finite number greater than or equal to 0`);
          }
          continue;
        }
        if (typeof sideValue === 'string' && isPercentageString(sideValue)) {
          const numeric = Number(sideValue.trim().slice(0, -1).trim());
          if (numeric < 0) {
            push(`botFunds.${side} percentage must be greater than or equal to 0`);
          }
          continue;
        }
        push(`botFunds.${side} must be a finite number or a percentage string`);
      }
      break;

    case 'activeOrders':
      if (!isPlainObject(value)) {
        push('activeOrders must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('activeOrders', value, errors);
      for (const side of ['sell', 'buy']) {
        const sideValue = value[side];
        if (sideValue === undefined) {
          continue;
        }
        if (!Number.isInteger(Number(sideValue)) || Number(sideValue) < 0) {
          push(`activeOrders.${side} must be an integer greater than or equal to 0`);
        }
      }
      break;

    case 'botIndex':
    case 'botKey':
      push(`${field} is read-only`);
      break;

    default:
      break;
  }
}

function validateBotSettingsState(bot: Record<string, any> = {}) {
  const errors = [];
  const warnings = [];

  for (const field of Object.keys(BOT_SETTINGS_NESTED_KEYS)) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  for (const field of [
    ...BOT_SETTINGS_STATE_FIELDS.boolean,
    ...BOT_SETTINGS_STATE_FIELDS.numeric,
    ...BOT_SETTINGS_STATE_FIELDS.priceLike
  ].filter((field) => !BOT_SETTINGS_NESTED_KEYS[field])) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  for (const field of BOT_SETTINGS_STATE_FIELDS.string.filter((field) => !BOT_SETTINGS_NESTED_KEYS[field])) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  const increment = Number(bot.incrementPercent);
  const spread = Number(bot.targetSpreadPercent);
  if (Number.isFinite(increment) && Number.isFinite(spread)) {
    const minSpread = increment * GRID_LIMITS.MIN_SPREAD_FACTOR;
    if (spread + Number.EPSILON < minSpread) {
      errors.push(`targetSpreadPercent must be >= ${GRID_LIMITS.MIN_SPREAD_FACTOR}x incrementPercent (${Number(minSpread.toFixed(6))})`);
    }
  }

  const resolvedStartPrice = resolveComparablePriceValue(bot.startPrice);
  const resolvedMinPrice = resolveComparablePriceValue(bot.minPrice, resolvedStartPrice, 'min');
  const resolvedMaxPrice = resolveComparablePriceValue(bot.maxPrice, resolvedStartPrice, 'max');
  if (resolvedMinPrice !== null && resolvedMaxPrice !== null) {
    if (resolvedMinPrice >= resolvedMaxPrice) {
      errors.push('minPrice must be less than maxPrice');
    }
  }

  if (resolvedStartPrice !== null) {
    if (resolvedMinPrice !== null && resolvedStartPrice < resolvedMinPrice) {
      errors.push('startPrice must be greater than or equal to minPrice');
    }
    if (resolvedMaxPrice !== null && resolvedStartPrice > resolvedMaxPrice) {
      errors.push('startPrice must be less than or equal to maxPrice');
    }
  }

  const unknownKeys = Object.keys(bot).filter((key) => !KNOWN_BOT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.push(`unrecognized keys: ${unknownKeys.join(', ')}`);
  }

  return {
    errors,
    warnings,
    valid: errors.length === 0
  };
}

function validateBotSettingsPatch(patch: Record<string, any> = {}, currentBot: Record<string, any> = {}, options: Partial<ProfileOptions> = {}) {
  const errors = [];
  const warnings = [];
  const patchKeys = Object.keys(patch || {});
  const allowUnknownKeys = Boolean(options.allowUnknownKeys);

  if (!isPlainObject(patch)) {
    return {
      errors: ['patch must be a non-null object'],
      merged: cloneBotSettings(currentBot) || {},
      patchKeys: [],
      triggerRequired: false,
      valid: false,
      warnings: []
    };
  }

  for (const key of patchKeys) {
    if (!KNOWN_BOT_KEYS.has(key)) {
      if (allowUnknownKeys) {
        warnings.push(`unrecognized patch key: ${key}`);
      } else {
        errors.push(`unrecognized patch key: ${key}`);
      }
      continue;
    }

    if (['weightDistribution', 'botFunds', 'activeOrders'].includes(key) && isPlainObject(patch[key])) {
      validateNestedBotSettingKeys(key, patch[key], errors);
      const mergedField = {
        ...(isPlainObject(currentBot[key]) ? currentBot[key] : {}),
        ...patch[key]
      };
      validateBotSettingsValue(key, mergedField, errors);
      continue;
    }

    validateBotSettingsValue(key, patch[key], errors);
  }

  const merged = mergeBotSettingsPatch(currentBot, patch);
  const mergedValidation = validateBotSettingsState(normalizeBotSettings(merged));
  errors.push(...mergedValidation.errors.filter((entry) => !errors.includes(entry)));
  warnings.push(...mergedValidation.warnings);

  const triggerRequired = patchKeys.some((key) => BOT_SETTINGS_TRIGGER_KEYS.has(key));

  return {
    errors,
    merged,
    patchKeys,
    triggerRequired,
    valid: errors.length === 0,
    warnings
  };
}

function buildBotSettingsView(bot: Record<string, any> | null, bundle: ClawProfileBundle | null, options: Record<string, any> = {}) {
  const current = cloneBotSettings(bot) || null;
  const effective = current ? normalizeBotSettings(current) : null;
  const currentValidation = current ? validateBotSettingsState(current) : { errors: [], warnings: [], valid: true };
  const effectiveValidation = effective ? validateBotSettingsState(effective) : { errors: [], warnings: [], valid: true };
  const mutability = describeBotSettingMutability();
  const b = bundle as any;
  const selectedBotFiles = current && bundle ? {
    gridPriceSnapshot: path.join(b.ordersDir || path.join(b.profilesDir, DEFAULT_ORDERS_DIR), `${current.botKey}.dynamicgrid.json`),
    orderSnapshot: path.join(b.ordersDir || path.join(b.profilesDir, DEFAULT_ORDERS_DIR), `${current.botKey}.json`),
    trigger: path.join(b.profilesDir, `recalculate.${current.botKey}.trigger`)
  } : null;

  return {
    current,
    defaults: cloneBotSettings(DEFAULT_CONFIG),
    effective,
    files: selectedBotFiles,
    identifier: options.identifier || null,
    mutability,
    rawValidation: currentValidation,
    validation: effectiveValidation
  };
}

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
      : bot && bot.assetAId && bot.assetBId
        ? `${bot.assetAId}/${bot.assetBId}`
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

function normalizeBotEntries(rawEntries: Record<string, any>[], options: Partial<ProfileOptions> = {}) {
  const logger = options.logger || null;
  return rawEntries.map((entry: any, index: number) => {
    if (logger) {
      validateBotEntry(entry, index, logger);
    }
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
  }) as any[];
}

const { clone } = require('./utils');

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
    const marketProfilesFile = path.join(candidate, DEFAULT_MARKET_PROFILES_FILE);

    if (
      fs.existsSync(manifestFile) ||
      fs.existsSync(botsFile) ||
      fs.existsSync(generalSettingsFile) ||
      fs.existsSync(marketProfilesFile)
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
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read ${filePath}: ${error.message}`);
  }
}

async function writeJsonPayload(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  } catch (err: any) {
    await fsPromises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function writeTextPayload(filePath, content) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fsPromises.writeFile(tmpPath, `${content}\n`, 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  } catch (err: any) {
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
  } catch (err: any) {
    if (err.code === 'ENOENT') return { exists: false, payload: null };
    throw err;
  }
}

async function listFiles(dirPath) {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error: any) {
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
    if (identifier.assetAId && identifier.assetBId) {
      const botAId = bot.assetAId || null;
      const botBId = bot.assetBId || null;
      if (botAId === identifier.assetAId && botBId === identifier.assetBId) {
        return true;
      }
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

  if (bot.assetA && bot.assetB && `${bot.assetA}/${bot.assetB}` === value) {
    return true;
  }

  if (bot.assetAId && bot.assetBId && `${bot.assetAId}/${bot.assetBId}` === value) {
    return true;
  }

  // Cross-match: identifier may use IDs while bot has symbols, or vice versa
  const [pairA, pairB] = value.includes('/') ? value.split('/', 2) : [null, null];
  if (pairA && pairB) {
    const botA = bot.assetA || bot.assetAId || null;
    const botB = bot.assetB || bot.assetBId || null;
    if (botA && botB && pairA === botA && pairB === botB) {
      return true;
    }
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

function buildClawProfileContext(bundle: Record<string, any>, options: Partial<ProfileOptions> = {}) {
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
  const selectedGridPriceSnapshotPath = selectedBot ? path.join(bundle.ordersDir, `${selectedBot.botKey}.dynamicgrid.json`) : null;
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

async function loadDexbotProfileBundle(profileRoot: string, options: Partial<ProfileOptions> = {}) {
  const profilesDir = resolveProfilesDir(profileRoot || options.profileRoot);
  const ordersDir = path.join(profilesDir, DEFAULT_ORDERS_DIR);
  const manifestFile = options.manifestFile || path.join(profilesDir, DEFAULT_MANIFEST_FILE);
  const botsFile = options.botsFile || path.join(profilesDir, DEFAULT_BOTS_FILE);
  const generalSettingsFile = options.generalSettingsFile || path.join(profilesDir, DEFAULT_GENERAL_SETTINGS_FILE);
  const marketProfilesFile = options.marketProfilesFile || path.join(profilesDir, DEFAULT_MARKET_PROFILES_FILE);

  const [manifest, botsConfig, generalSettings, marketProfiles, orderFiles] = await Promise.all([
    readJsonFile(manifestFile),
    readJsonFile(botsFile),
    readJsonFile(generalSettingsFile),
    readJsonFile(marketProfilesFile),
    listFiles(ordersDir)
  ]);

  const bots = normalizeBotEntries(resolveRawBotEntries(botsConfig), { logger: options.logger });
  const activeBots = bots.filter((bot) => bot.active !== false);
  const botsByKey = Object.fromEntries(bots.map((bot) => [bot.botKey, bot]));
  const botsByName = Object.fromEntries(bots.filter((bot) => bot.name).map((bot) => [bot.name, bot]));

  return {
    marketProfiles,
    amaProfiles: marketProfiles,
    activeBots,
    bots,
    botsByKey,
    botsByName,
    botsConfig,
    files: {
      marketProfiles: marketProfilesFile,
      amaProfiles: marketProfilesFile,
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

function createDexbotProfileAdapter(profileRoot: string, options: Partial<ProfileOptions> = {}) {
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
    const gridPriceSnapshotPath = path.join(bundle.ordersDir, `${bot.botKey}.dynamicgrid.json`);
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

  async function getBotSettings(identifier, forceReload = false) {
    const bundle = await loadBundle(forceReload);
    const bot = identifier
      ? bundle.bots.find((entry) => matchBotIdentifier(entry, identifier)) || null
      : bundle.activeBots[0] || bundle.bots[0] || null;

    return buildBotSettingsView(bot, bundle, {
      identifier
    });
  }

  async function previewBotSettingsUpdate(identifier: any, patch: any, options: Record<string, any> = {}) {
    const bundle = await loadBundle(Boolean(options.forceReload));
    const bot = identifier
      ? bundle.bots.find((entry) => matchBotIdentifier(entry, identifier)) || null
      : bundle.activeBots[0] || bundle.bots[0] || null;
    if (!bot) {
      throw new Error(`Bot not found: ${identifier}`);
    }

    const validation = validateBotSettingsPatch(patch, bot, options);
    const nextBot = validation.merged;
    const currentValidation = validateBotSettingsState(bot);

    return {
      bot: cloneBotSettings(bot),
      changedKeys: validation.patchKeys,
      current: buildBotSettingsView(bot, bundle, { identifier }),
      errors: validation.errors,
      next: buildBotSettingsView(nextBot, bundle, { identifier }),
      patch: cloneBotSettings(patch) || {},
      triggerRequired: validation.triggerRequired,
      valid: validation.valid,
      warnings: [...currentValidation.warnings, ...validation.warnings]
    };
  }

  async function applyBotSettingsPatch(identifier: any, patch: any, options: Record<string, any> = {}) {
    if (!isPlainObject(patch)) {
      throw new Error('patch must be a non-null object');
    }

    const bundle = await loadBundle(true);
    const release = await acquireFileLock(bundle.files.bots);

    try {
      const currentBotsConfig = await readJsonFile(bundle.files.bots);
      const currentRawEntries = resolveRawBotEntries(currentBotsConfig);
      const currentBots = normalizeBotEntries(currentRawEntries, { logger: options.logger });
      const bot = identifier
        ? currentBots.find((entry) => matchBotIdentifier(entry, identifier))
        : currentBots.find((entry) => entry.active !== false) || currentBots[0] || null;
      if (!bot) {
        throw new Error(`Bot not found: ${identifier}`);
      }

      if (!currentRawEntries[bot.botIndex]) {
        throw new Error(`Bot index ${bot.botIndex} out of range`);
      }

      const validation = validateBotSettingsPatch(patch, currentRawEntries[bot.botIndex], options);
      if (!validation.valid) {
        const error: any = new Error(`Bot settings validation failed:\n${validation.errors.map((entry) => `  - ${entry}`).join('\n')}`);
        error.validation = validation;
        throw error;
      }

      const nextEntry = validation.merged;
      const nextRawEntries = currentRawEntries.slice();
      nextRawEntries[bot.botIndex] = nextEntry;

      const dataToWrite = Array.isArray(currentBotsConfig)
        ? nextRawEntries
        : Array.isArray(currentBotsConfig?.bots)
          ? { ...currentBotsConfig, bots: nextRawEntries }
          : nextEntry;

      await writeJsonPayload(bundle.files.bots, dataToWrite);

      let triggerPayload = null;
      let triggerPath = null;
      const shouldWriteTrigger = options.writeTrigger === true
        || options.trigger === true
        || (options.trigger === undefined && (
          options.triggerPayload !== undefined
          || validation.patchKeys.some((key) => BOT_SETTINGS_TRIGGER_KEYS.has(key))
        ));
      if (shouldWriteTrigger) {
        triggerPath = path.join(bundle.profilesDir, `recalculate.${bot.botKey}.trigger`);
        triggerPayload = options.triggerPayload !== undefined
          ? options.triggerPayload
          : {
              botKey: bot.botKey,
              changedKeys: validation.patchKeys,
              reason: options.triggerReason || 'settings_update',
              updatedAt: new Date().toISOString()
            };
        const content = triggerPayload ? JSON.stringify(triggerPayload, null, 2) : '';
        await fsPromises.mkdir(path.dirname(triggerPath), { recursive: true });
        await writeTextPayload(triggerPath, content);
      }

      cachedBundle = null;
      const freshBundle = await loadBundle(true);
      const updatedBot = freshBundle.bots.find((entry) => entry.botIndex === bot.botIndex) || null;

      return {
        changedKeys: validation.patchKeys,
        current: buildBotSettingsView(bot, bundle, { identifier }),
        errors: [],
        next: buildBotSettingsView(updatedBot || nextEntry, freshBundle, { identifier }),
        patch: cloneBotSettings(patch) || {},
        reasoning: options.reasoning || [],
        triggerPath,
        triggerPayload,
        updatedBot: updatedBot ? cloneBotSettings(updatedBot) : cloneBotSettings(nextEntry),
        valid: true,
        warnings: validation.warnings
      };
    } finally {
      await release();
    }
  }


  async function getClawProfileContext(identifier: any, options: Record<string, any> = {}) {
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
    await fsPromises.mkdir(path.dirname(triggerPath), { recursive: true });
    await writeTextPayload(triggerPath, content);
  }

  async function updateBotSettings(identifier, patch) {
    if (!isPlainObject(patch)) {
      throw new Error('patch must be a non-null object');
    }

    const bundle = await loadBundle(true);
    const release = await acquireFileLock(bundle.files.bots);
    let selectedBotIndex = null;

    try {
      const currentBotsConfig = await readJsonFile(bundle.files.bots);
      const currentRawEntries = resolveRawBotEntries(currentBotsConfig);
      const currentBots = normalizeBotEntries(currentRawEntries, { logger: options.logger });
      const bot = identifier
        ? currentBots.find((entry) => matchBotIdentifier(entry, identifier))
        : currentBots.find((entry) => entry.active !== false) || currentBots[0] || null;
      if (!bot) {
        throw new Error(`Bot not found: ${identifier}`);
      }

      if (!currentRawEntries[bot.botIndex]) {
        throw new Error(`Bot index ${bot.botIndex} out of range`);
      }
      selectedBotIndex = bot.botIndex;

      const validation = validateBotSettingsPatch(patch, currentRawEntries[bot.botIndex], {});
      if (!validation.valid) {
        const error: any = new Error(`Bot settings validation failed:\n${validation.errors.map((entry) => `  - ${entry}`).join('\n')}`);
        error.validation = validation;
        throw error;
      }

      const nextEntry = validation.merged;
      const nextRawEntries = currentRawEntries.slice();
      nextRawEntries[bot.botIndex] = nextEntry;

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
    return freshBundle.bots.find((entry) => entry.botIndex === selectedBotIndex) || null;
  }

  return {
    buildClawProfileContext: (bundle, contextOptions = {}) => buildClawProfileContext(bundle, contextOptions),
    applyBotSettingsPatch,
    consumeTrigger,
    findBot,
    getBotBundle,
    getBotSettings,
    getClawProfileContext,
    getProfilesDir,
    listBots,
    listOrderArtifacts,
    loadBundle,
    previewBotSettingsUpdate,
    resolveProfilesDir: () => resolveProfilesDir(profileRoot || options.profileRoot),
    updateBotSettings,
    writeTrigger
  };
}

export = {
  buildBotSettingsView,
  createBotKey,
  createDexbotProfileAdapter,
  buildClawProfileContext,
  describeBotSettingMutability,
  loadDexbotProfileBundle,
  matchBotIdentifier,
  normalizeBotSettings,
  normalizeBotEntries,
  readTriggerFile,
  resolveProfilesDir,
  resolveRawBotEntries,
  sanitizeKey,
  validateBotEntry,
  validateBotSettingsPatch,
  validateBotSettingsState,
  writeJsonFileAtomic
};
