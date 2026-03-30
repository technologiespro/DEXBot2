'use strict';

const {
  computeDynamicWeights
} = require('../../market_adapter/dynamic_weights');
const { fetchTrendInput } = require('./feed_price_source');
const { TrendAnalyzer } = require('../../analysis/trend_detection/trend_analyzer');

const DEFAULT_DYNAMIC_WEIGHT_POLICY = Object.freeze({
  allowNeutralUpdate: true,
  cooldownMs: 30 * 60 * 1000,
  enabled: true,
  gridPriceOffsetAllowNeutralReset: true,
  gridPriceOffsetCooldownMs: 30 * 60 * 1000,
  gridPriceOffsetEnabled: true,
  gridPriceOffsetMaxPct: 0.5,
  gridPriceOffsetMinConfidence: 70,
  gridPriceOffsetMinDeltaPct: 0.1,
  gridPriceOffsetRequireAmaGridPrice: true,
  gridPriceOffsetRequireConfirmedTrend: true,
  gridPriceOffsetScale: 1,
  minConfidence: 60,
  minWeightDelta: 0.1,
  requireBtsQuote: true,
  requireConfirmedTrend: true,
  requireTrendReady: true,
  triggerOnApply: true,
  triggerReason: 'dynamic_weight_update',
  writeTriggerPayload: true
});

const DEFAULT_ANALYZER_CONFIG = Object.freeze({
  feedPremiumConfig: {
    deadZonePercent: 0.25
  },
  feedTrendConfig: {
    minBarsForConfirmation: 3,
    thresholdPercent: 1.0
  },
  lookbackBars: 20
});

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePolicy(policy = {}) {
  const merged = {
    ...DEFAULT_DYNAMIC_WEIGHT_POLICY,
    ...policy
  };

  merged.allowNeutralUpdate = normalizeBoolean(policy.allowNeutralUpdate, DEFAULT_DYNAMIC_WEIGHT_POLICY.allowNeutralUpdate);
  merged.enabled = normalizeBoolean(policy.enabled, DEFAULT_DYNAMIC_WEIGHT_POLICY.enabled);
  merged.gridPriceOffsetAllowNeutralReset = normalizeBoolean(
    policy.gridPriceOffsetAllowNeutralReset,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetAllowNeutralReset
  );
  merged.gridPriceOffsetCooldownMs = normalizeNumber(
    policy.gridPriceOffsetCooldownMs,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetCooldownMs
  );
  merged.gridPriceOffsetEnabled = normalizeBoolean(policy.gridPriceOffsetEnabled, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetEnabled);
  merged.gridPriceOffsetMaxPct = normalizeNumber(policy.gridPriceOffsetMaxPct, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetMaxPct);
  merged.gridPriceOffsetMinConfidence = normalizeNumber(
    policy.gridPriceOffsetMinConfidence,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetMinConfidence
  );
  merged.gridPriceOffsetMinDeltaPct = normalizeNumber(
    policy.gridPriceOffsetMinDeltaPct,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetMinDeltaPct
  );
  merged.gridPriceOffsetRequireAmaGridPrice = normalizeBoolean(
    policy.gridPriceOffsetRequireAmaGridPrice,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetRequireAmaGridPrice
  );
  merged.gridPriceOffsetRequireConfirmedTrend = normalizeBoolean(
    policy.gridPriceOffsetRequireConfirmedTrend,
    DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetRequireConfirmedTrend
  );
  merged.gridPriceOffsetScale = normalizeNumber(policy.gridPriceOffsetScale, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetScale);
  merged.minConfidence = normalizeNumber(policy.minConfidence, DEFAULT_DYNAMIC_WEIGHT_POLICY.minConfidence);
  merged.minWeightDelta = normalizeNumber(policy.minWeightDelta, DEFAULT_DYNAMIC_WEIGHT_POLICY.minWeightDelta);
  merged.requireBtsQuote = normalizeBoolean(policy.requireBtsQuote, DEFAULT_DYNAMIC_WEIGHT_POLICY.requireBtsQuote);
  merged.requireConfirmedTrend = normalizeBoolean(policy.requireConfirmedTrend, DEFAULT_DYNAMIC_WEIGHT_POLICY.requireConfirmedTrend);
  merged.requireTrendReady = normalizeBoolean(policy.requireTrendReady, DEFAULT_DYNAMIC_WEIGHT_POLICY.requireTrendReady);
  merged.triggerOnApply = normalizeBoolean(policy.triggerOnApply, DEFAULT_DYNAMIC_WEIGHT_POLICY.triggerOnApply);
  merged.writeTriggerPayload = normalizeBoolean(policy.writeTriggerPayload, DEFAULT_DYNAMIC_WEIGHT_POLICY.writeTriggerPayload);

  merged.analyzerConfig = {
    ...DEFAULT_ANALYZER_CONFIG,
    ...(policy.analyzerConfig && typeof policy.analyzerConfig === 'object' ? policy.analyzerConfig : {})
  };

  return merged;
}

function normalizeWeightDistribution(weightDistribution) {
  return {
    sell: normalizeNumber(weightDistribution?.sell, 0.5),
    buy: normalizeNumber(weightDistribution?.buy, 0.5)
  };
}

function isAmaGridPrice(bot = {}) {
  return /^ama(?:[1-4])?$/.test(String(bot.gridPrice || '').trim().toLowerCase());
}

function computeGridPriceOffset(bot, analysis, policy) {
  const currentOffsetPct = normalizeNumber(bot?.gridPriceOffsetPct, 0);

  if (!policy.gridPriceOffsetEnabled) {
    return { offsetPct: 0, reason: 'gridprice_offset_disabled' };
  }

  if (policy.gridPriceOffsetRequireAmaGridPrice && !isAmaGridPrice(bot)) {
    return { offsetPct: currentOffsetPct, reason: 'gridprice_mode_not_ama' };
  }

  if (!analysis?.isReady) {
    return { offsetPct: currentOffsetPct, reason: 'trend_not_ready' };
  }

  if (policy.gridPriceOffsetRequireConfirmedTrend && analysis.isConfirmed === false) {
    return { offsetPct: currentOffsetPct, reason: 'trend_not_confirmed' };
  }

  if (analysis.trend === 'NEUTRAL') {
    if (policy.gridPriceOffsetAllowNeutralReset) {
      return { offsetPct: 0, reason: 'neutral_reset' };
    }
    return { offsetPct: currentOffsetPct, reason: 'neutral_updates_disabled' };
  }

  if (analysis.trend !== 'UP' && analysis.trend !== 'DOWN') {
    return { offsetPct: currentOffsetPct, reason: 'trend_unavailable' };
  }

  const minConfidence = normalizeNumber(policy.gridPriceOffsetMinConfidence, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetMinConfidence);
  if (Number.isFinite(minConfidence) && analysis.confidence < minConfidence) {
    return { offsetPct: currentOffsetPct, reason: 'confidence_below_threshold' };
  }

  const scale = Math.max(0, normalizeNumber(policy.gridPriceOffsetScale, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetScale));
  const maxPct = Math.max(0, normalizeNumber(policy.gridPriceOffsetMaxPct, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetMaxPct));
  const confidenceFactor = Math.max(0, Math.min(1, normalizeNumber(analysis.confidence, 0) / 100));
  const magnitude = Math.min(maxPct, maxPct * confidenceFactor * scale);
  const direction = analysis.trend === 'UP' ? 1 : -1;
  const offsetPct = Math.round(direction * magnitude * 1000) / 1000;

  return {
    offsetPct,
    reason: analysis.trend === 'UP' ? 'trend_up' : 'trend_down'
  };
}

function computeOffsetCooldownRemainingMs(lastAppliedAt, cooldownMs) {
  const ms = normalizeNumber(cooldownMs, DEFAULT_DYNAMIC_WEIGHT_POLICY.gridPriceOffsetCooldownMs);
  if (!Number.isFinite(lastAppliedAt) || ms <= 0) return 0;
  return Math.max(0, ms - (Date.now() - lastAppliedAt));
}

function computeWeightDelta(currentWeights, nextWeights) {
  const current = normalizeWeightDistribution(currentWeights);
  const next = normalizeWeightDistribution(nextWeights);
  const deltaSell = Math.round((next.sell - current.sell) * 1000) / 1000;
  const deltaBuy = Math.round((next.buy - current.buy) * 1000) / 1000;
  return {
    current,
    deltaBuy,
    deltaSell,
    magnitude: Math.max(Math.abs(deltaSell), Math.abs(deltaBuy))
  };
}

function resolveBotMarketRef(bot = {}) {
  return bot.assetAId || bot.assetA || null;
}

function resolveBotQuoteRef(bot = {}) {
  return bot.assetBId || bot.assetB || null;
}

async function isEligibleBot(bot, policy, market) {
  if (!bot || typeof bot !== 'object') {
    return { eligible: false, reason: 'missing_bot' };
  }

  if (bot.active === false) {
    return { eligible: false, reason: 'bot_inactive' };
  }

  if (policy.requireBtsQuote) {
    const quoteRef = resolveBotQuoteRef(bot);
    if (!quoteRef) {
      return { eligible: false, reason: 'missing_quote_asset' };
    }

    if (quoteRef === 'BTS') {
      return { eligible: true, reason: null };
    }

    if (market && typeof market.getAsset === 'function') {
      const quoteAsset = await market.getAsset(quoteRef).catch(() => null);
      if (!quoteAsset || quoteAsset.symbol !== 'BTS') {
        return { eligible: false, reason: 'quote_asset_not_bts' };
      }
    } else {
      return { eligible: false, reason: 'unable_to_verify_quote_asset' };
    }
  }

  if (!resolveBotMarketRef(bot)) {
    return { eligible: false, reason: 'missing_market_asset' };
  }

  return { eligible: true, reason: null };
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function createAnalyzerCache() {
  const analyzers = new Map();

  return {
    get(botKey, analyzerConfig, TrendAnalyzerClass) {
      const cacheKey = `${botKey || 'bot'}:${stableStringify(analyzerConfig || {})}`;
      if (!analyzers.has(cacheKey)) {
        analyzers.set(cacheKey, new TrendAnalyzerClass(analyzerConfig || {}));
      }
      return analyzers.get(cacheKey);
    },
    reset() {
      analyzers.clear();
    }
  };
}

function createDynamicWeightService(deps = {}) {
  const logger = deps.logger || console;
  const market = deps.market || null;
  const profiles = deps.profiles || null;
  const stateStore = deps.stateStore || null;
  const fetchTrendInputFn = deps.fetchTrendInput || fetchTrendInput;
  const computeDynamicWeightsFn = deps.computeDynamicWeights || computeDynamicWeights;
  const TrendAnalyzerClass = deps.TrendAnalyzerClass || TrendAnalyzer;
  const policyDefaults = normalizePolicy(deps.policy || {});
  const analyzerCache = createAnalyzerCache();
  const applyLocks = new Map();

  function acquireBotLock(botKey) {
    const key = botKey || '__default__';
    if (!applyLocks.has(key)) {
      applyLocks.set(key, Promise.resolve());
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const prev = applyLocks.get(key);
    applyLocks.set(key, prev.then(() => gate));
    return prev.then(() => release);
  }

  function getStateContainer(state) {
    if (state && typeof state === 'object') {
      return state.dynamicWeights && typeof state.dynamicWeights === 'object'
        ? state.dynamicWeights
        : {};
    }
    return {};
  }

  async function readServiceState() {
    if (!stateStore || typeof stateStore.read !== 'function') {
      return {};
    }

    const state = await stateStore.read().catch(() => ({}));
    return getStateContainer(state);
  }

  async function patchServiceState(partial) {
    if (!stateStore || typeof stateStore.patch !== 'function') {
      return partial;
    }

    return stateStore.patch({
      dynamicWeights: partial
    });
  }

  async function writeBotServiceState(botKey, nextBotState) {
    if (!botKey) {
      return nextBotState;
    }

    if (stateStore && typeof stateStore.update === 'function') {
      return stateStore.update((rootState) => {
        const baseRoot = rootState && typeof rootState === 'object' && !Array.isArray(rootState)
          ? rootState
          : {};
        const currentDynamicWeights = getStateContainer(baseRoot);
        return {
          ...baseRoot,
          dynamicWeights: {
            ...currentDynamicWeights,
            [botKey]: nextBotState
          }
        };
      });
    }

    const state = await readServiceState();
    state[botKey] = nextBotState;
    return patchServiceState(state);
  }

  function buildTriggerPayload(bot, policy, trendInput, analysis, preview) {
    return {
      botKey: bot.botKey || null,
      botName: bot.name || null,
      currentWeights: preview.currentWeights,
      feedPrice: trendInput.feedPrice,
      marketPrice: trendInput.marketPrice,
      gridPriceOffsetPct: preview.gridPriceOffsetPct,
      gridPriceOffsetReason: preview.gridPriceOffsetReason,
      gridPriceOffsetCooldownMs: policy.gridPriceOffsetCooldownMs,
      nextWeights: preview.nextWeights,
      decisionReason: preview.reason,
      policy: {
        allowNeutralUpdate: policy.allowNeutralUpdate,
        cooldownMs: policy.cooldownMs,
        gridPriceOffsetAllowNeutralReset: policy.gridPriceOffsetAllowNeutralReset,
        gridPriceOffsetEnabled: policy.gridPriceOffsetEnabled,
        gridPriceOffsetMaxPct: policy.gridPriceOffsetMaxPct,
        gridPriceOffsetMinConfidence: policy.gridPriceOffsetMinConfidence,
        gridPriceOffsetMinDeltaPct: policy.gridPriceOffsetMinDeltaPct,
        gridPriceOffsetRequireAmaGridPrice: policy.gridPriceOffsetRequireAmaGridPrice,
        gridPriceOffsetRequireConfirmedTrend: policy.gridPriceOffsetRequireConfirmedTrend,
        gridPriceOffsetScale: policy.gridPriceOffsetScale,
        gridPriceOffsetCooldownMs: policy.gridPriceOffsetCooldownMs,
        enabled: policy.enabled,
        minConfidence: policy.minConfidence,
        minWeightDelta: policy.minWeightDelta,
        requireConfirmedTrend: policy.requireConfirmedTrend,
        requireTrendReady: policy.requireTrendReady,
        triggerReason: policy.triggerReason,
        writeTriggerPayload: policy.writeTriggerPayload
      },
      premium: trendInput.premium,
      reason: policy.triggerReason,
      trend: analysis.trend,
      confidence: analysis.confidence,
      triggeredAt: new Date().toISOString()
    };
  }

  async function evaluateSelectedBot(selectedBot, options = {}) {
    const policy = normalizePolicy({
      ...policyDefaults,
      ...(options.policy || {})
    });

    const currentWeights = normalizeWeightDistribution(selectedBot?.weightDistribution);
    const eligibility = await isEligibleBot(selectedBot, policy, market);
    if (!eligibility.eligible) {
      return {
        applied: false,
        currentWeights,
        eligible: false,
        reason: eligibility.reason,
        policy
      };
    }

    if (!policy.enabled) {
      return {
        applied: false,
        currentWeights,
        eligible: true,
        reason: 'policy_disabled',
        policy
      };
    }

    const marketRef = resolveBotMarketRef(selectedBot);
    const trendInput = await fetchTrendInputFn(marketRef);
    const analyzer = analyzerCache.get(selectedBot.botKey || marketRef, policy.analyzerConfig, TrendAnalyzerClass);
    const analysis = analyzer.update(trendInput.marketPrice, trendInput.feedPrice);

    if (policy.requireTrendReady && !analysis.isReady) {
      return {
        applied: false,
        currentWeights,
        eligible: true,
        reason: analysis.reason || 'trend_not_ready',
        policy,
        trendInput,
        trendAnalysis: analysis
      };
    }

    const nextWeights = computeDynamicWeightsFn(analysis, options.priceContext || {}, currentWeights);
    const delta = computeWeightDelta(currentWeights, nextWeights);
    const gridPriceOffset = computeGridPriceOffset(selectedBot, analysis, policy);
    const currentGridPriceOffsetPct = normalizeNumber(selectedBot?.gridPriceOffsetPct, 0);
    const gridPriceOffsetDelta = Math.abs(gridPriceOffset.offsetPct - currentGridPriceOffsetPct);
    let shouldUpdateWeights = delta.magnitude >= policy.minWeightDelta;
    let weightUpdateBlockedReason = shouldUpdateWeights && policy.requireConfirmedTrend && analysis.isConfirmed === false
      ? 'trend_not_confirmed'
      : null;
    if (weightUpdateBlockedReason) {
      shouldUpdateWeights = false;
    }
    const shouldUpdateGridPriceOffset = policy.gridPriceOffsetEnabled && gridPriceOffsetDelta >= policy.gridPriceOffsetMinDeltaPct;
    const shouldResetGridPriceOffset = policy.gridPriceOffsetEnabled === false && currentGridPriceOffsetPct !== 0;

    if (!policy.allowNeutralUpdate && analysis.trend === 'NEUTRAL' && shouldUpdateWeights) {
      shouldUpdateWeights = false;
      weightUpdateBlockedReason = 'neutral_updates_disabled';
    }

    if (shouldUpdateWeights && Number.isFinite(policy.minConfidence) && analysis.confidence < policy.minConfidence) {
      shouldUpdateWeights = false;
      weightUpdateBlockedReason = 'confidence_below_threshold';
    }

    if (!shouldUpdateWeights && !shouldUpdateGridPriceOffset && !shouldResetGridPriceOffset) {
      return {
        applied: false,
        currentWeights,
        eligible: true,
        nextWeights,
        gridPriceOffsetPct: gridPriceOffset.offsetPct,
        gridPriceOffsetReason: gridPriceOffset.reason,
        gridPriceOffsetDelta,
        reason: weightUpdateBlockedReason || 'changes_below_threshold',
        policy,
        trendInput,
        trendAnalysis: analysis,
        delta
      };
    }

    const state = await readServiceState();
    const botState = state[selectedBot.botKey] || {};
    const lastAppliedAt = botState.lastAppliedAt ? Date.parse(botState.lastAppliedAt) : null;
    const lastGridPriceOffsetAppliedAt = botState.lastGridPriceOffsetAppliedAt ? Date.parse(botState.lastGridPriceOffsetAppliedAt) : null;
    const cooldownRemainingMs = Number.isFinite(lastAppliedAt)
      ? Math.max(0, policy.cooldownMs - (Date.now() - lastAppliedAt))
      : 0;
    const gridPriceOffsetCooldownRemainingMs = computeOffsetCooldownRemainingMs(
      lastGridPriceOffsetAppliedAt,
      policy.gridPriceOffsetCooldownMs
    );
    const canUpdateWeights = shouldUpdateWeights && cooldownRemainingMs === 0;
    const canUpdateGridPriceOffset = shouldResetGridPriceOffset || (shouldUpdateGridPriceOffset && gridPriceOffsetCooldownRemainingMs === 0);

    if (!canUpdateWeights && !canUpdateGridPriceOffset) {
      const hasPendingChanges = shouldUpdateWeights || shouldUpdateGridPriceOffset || shouldResetGridPriceOffset;
      return {
        applied: false,
        currentWeights,
        cooldownRemainingMs,
        eligible: true,
        gridPriceOffsetCooldownRemainingMs,
        nextWeights,
        gridPriceOffsetPct: gridPriceOffset.offsetPct,
        gridPriceOffsetReason: gridPriceOffset.reason,
        gridPriceOffsetDelta,
        reason: hasPendingChanges ? 'cooldown_active' : 'changes_below_threshold',
        policy,
        trendInput,
        trendAnalysis: analysis,
        delta
      };
    }

    const preview = {
      currentWeights,
      delta,
      eligible: true,
      canUpdateGridPriceOffset,
      canUpdateWeights,
      gridPriceOffsetDelta,
      gridPriceOffsetPct: gridPriceOffset.offsetPct,
      gridPriceOffsetReason: gridPriceOffset.reason,
      gridPriceOffsetCooldownRemainingMs,
      nextWeights,
      policy,
      trendAnalysis: analysis,
      trendInput
    };

    return {
      ...preview,
      applied: false,
      reason: 'preview_only'
    };
  }

  async function applySelectedBot(selectedBot, options = {}) {
    const release = await acquireBotLock(selectedBot.botKey);
    try {
      return await _applySelectedBot(selectedBot, options);
    } finally {
      release();
    }
  }

  async function _applySelectedBot(selectedBot, options = {}) {
    const preview = await evaluateSelectedBot(selectedBot, options);
    if (preview.reason !== 'preview_only') {
      return preview;
    }

    const policy = preview.policy || policyDefaults;
    const botIdentifier = selectedBot.botKey || selectedBot.name || resolveBotMarketRef(selectedBot);
    if (!profiles || typeof profiles.updateBotSettings !== 'function') {
      throw new Error('profiles.updateBotSettings is not available');
    }

    const patch = {};
    if (preview.canUpdateWeights) {
      patch.weightDistribution = {
        sell: preview.nextWeights.sell,
        buy: preview.nextWeights.buy
      };
    }
    if (preview.canUpdateGridPriceOffset) {
      patch.gridPriceOffsetPct = policy.gridPriceOffsetEnabled === false ? 0 : preview.gridPriceOffsetPct;
    }

    const updatedBot = Object.keys(patch).length > 0
      ? await profiles.updateBotSettings(botIdentifier, patch)
      : selectedBot;

    let triggerPath = null;
    if (policy.triggerOnApply && typeof profiles.writeTrigger === 'function') {
      const payload = policy.writeTriggerPayload
        ? buildTriggerPayload(selectedBot, policy, preview.trendInput, preview.trendAnalysis, preview)
        : null;
      await profiles.writeTrigger(selectedBot.botKey || botIdentifier, payload);
      triggerPath = `profiles/recalculate.${selectedBot.botKey || botIdentifier}.trigger`;
    }

    const state = await readServiceState();
    const botState = state[selectedBot.botKey] || {};
    const nextBotState = {
      currentWeights: preview.currentWeights,
      lastAppliedAt: preview.canUpdateWeights ? new Date().toISOString() : botState.lastAppliedAt || null,
      lastReason: policy.triggerReason,
      lastTrend: preview.trendAnalysis?.trend || null,
      lastWeights: preview.canUpdateWeights ? preview.nextWeights : (selectedBot.weightDistribution || preview.currentWeights),
      lastGridPriceOffsetAppliedAt: preview.canUpdateGridPriceOffset ? new Date().toISOString() : botState.lastGridPriceOffsetAppliedAt || null,
      lastGridPriceOffsetPct: preview.canUpdateGridPriceOffset
        ? (policy.gridPriceOffsetEnabled === false ? 0 : preview.gridPriceOffsetPct)
        : normalizeNumber(selectedBot?.gridPriceOffsetPct, 0),
      lastGridPriceOffsetReason: preview.gridPriceOffsetReason
    };
    await writeBotServiceState(selectedBot.botKey, nextBotState);

    return {
      ...preview,
      applied: true,
      triggerPath,
      updatedBot
    };
  }

  return {
    applySelectedBot,
    evaluateSelectedBot,
    getPolicy: () => clone(policyDefaults),
    normalizePolicy,
    resetAnalyzers: () => analyzerCache.reset()
  };
}

module.exports = {
  DEFAULT_ANALYZER_CONFIG,
  DEFAULT_DYNAMIC_WEIGHT_POLICY,
  createDynamicWeightService,
  normalizePolicy
};
