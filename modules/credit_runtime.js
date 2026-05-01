'use strict';

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const { blockchainToFloat, floatToBlockchainInt, resolveConfigValue } = require('./order/utils/math');
const { deriveLiquidityPoolTokenValue } = require('./order/utils/system');
const { toFiniteNumber } = require('./order/format');
const { createBotKey } = require('./account_orders');
const { buildCollateralFallbackPlan, buildDebtFirstCrPlan, resolveTargetCollateralRatio } = require('./cr_planner');

const CREDIT_FEE_RATE_DENOM = 1_000_000;
const ZERO_ASSET_ID = '1.3.0';
const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'profiles', 'credit_runtime');

const { ensureDir: ensureDirSync } = require('./order/utils/system');

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function positiveOrNull(value) {
    const num = toFiniteNumber(value, null);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function positiveOrPercentOrNull(value) {
    const numeric = positiveOrNull(value);
    if (numeric !== null) return numeric;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) && percent > 0 ? percent / 100 : null;
}

function normalizeNumberArray(value) {
    return Array.isArray(value)
        ? value.map((item) => String(item)).filter(Boolean)
        : [];
}

function roundToPlaces(value, places = 6) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const factor = 10 ** places;
    return Math.round(num * factor) / factor;
}

function getMapEntries(value) {
    if (value instanceof Map) return Array.from(value.entries());
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.entries(value);
    return [];
}

function getPriceBaseAssetId(price) {
    return price?.base?.asset_id || null;
}

function getPriceQuoteAssetId(price) {
    return price?.quote?.asset_id || null;
}

function toAmountObject(amount, assetId) {
    return {
        amount,
        asset_id: assetId,
    };
}

function getChainAmountValue(value) {
    if (value && typeof value === 'object' && value.amount !== undefined) {
        return toFiniteNumber(value.amount, null);
    }
    return toFiniteNumber(value, null);
}

function getAssetPrecision(asset) {
    const precision = Number(asset?.precision);
    return Number.isFinite(precision) ? precision : null;
}

function blockchainAmountToFloat(value, asset) {
    const amount = getChainAmountValue(value);
    const precision = getAssetPrecision(asset);
    if (!Number.isFinite(amount) || precision === null) {
        return null;
    }
    return blockchainToFloat(amount, precision);
}

function isDeterministicMpaDebtBalanceError(err, plan) {
    const debtDelta = toFiniteNumber(plan?.debtDelta, 0);
    if (!Number.isFinite(debtDelta) || debtDelta >= 0) {
        return false;
    }
    const message = String(err?.message || err || '').toLowerCase();
    return message.includes('insufficient')
        && (message.includes('balance') || message.includes('fund') || message.includes('mpa'));
}

function normalizeCollateralMap(acceptableCollateral) {
    const result = new Map();
    for (const [assetId, price] of getMapEntries(acceptableCollateral)) {
        if (!assetId || !price) continue;
        result.set(String(assetId), price);
    }
    return result;
}

function resolveAutoRepayValue(value) {
    if (value === true) return 1;
    if (value === false || value === null || value === undefined) return 0;
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const int = Math.trunc(num);
    if (int < 0) return 0;
    if (int > 2) return 2;
    return int;
}

function normalizeAmountSpec(spec) {
    if (spec === null || spec === undefined) return null;
    if (typeof spec === 'number' || typeof spec === 'string') {
        return { amount: spec, assetId: null };
    }
    if (typeof spec === 'object') {
        return {
            amount: spec.amount ?? spec.value ?? null,
            assetId: spec.asset_id || spec.assetId || spec.asset || null,
        };
    }
    return null;
}

function isPercentageAmountSpec(spec) {
    const normalized = normalizeAmountSpec(spec);
    return typeof normalized?.amount === 'string' && normalized.amount.trim().endsWith('%');
}

function getAccountRef(bot) {
    return bot?.accountId
        || bot?.account?.id
        || bot?.account?.name
        || bot?.config?.preferredAccount
        || null;
}

function getAccountName(bot) {
    return bot?.account?.name
        || bot?.config?.preferredAccount
        || bot?.account?.id
        || bot?.accountId
        || null;
}

function parseFullAccount(fullAccountResult) {
    if (!Array.isArray(fullAccountResult) || fullAccountResult.length === 0) return null;
    const entry = fullAccountResult[0];
    if (Array.isArray(entry) && entry.length >= 2) {
        return entry[1]?.account || entry[1] || null;
    }
    return entry?.account || entry || null;
}

function parseCallOrders(accountObj) {
    if (!accountObj || typeof accountObj !== 'object') return [];
    if (Array.isArray(accountObj.call_orders)) return accountObj.call_orders;
    if (accountObj.account && Array.isArray(accountObj.account.call_orders)) return accountObj.account.call_orders;
    return [];
}

function parseDealSummary(deal) {
    if (!deal || typeof deal !== 'object') return null;
    return {
        id: deal.id,
        borrower: deal.borrower,
        offerId: deal.offerId || deal.offer_id || null,
        offerOwner: deal.offerOwner || deal.offer_owner || null,
        debtAssetId: deal.debtAssetId || deal.debt_asset || null,
        debtAmount: toFiniteNumber(deal.debtAmount ?? deal.debt_amount, 0) || 0,
        collateralAssetId: deal.collateralAssetId || deal.collateral_asset || null,
        collateralAmount: toFiniteNumber(deal.collateralAmount ?? deal.collateral_amount, 0) || 0,
        feeRate: toFiniteNumber(deal.feeRate ?? deal.fee_rate, 0) || 0,
        latestRepayTime: deal.latestRepayTime || deal.latest_repay_time || null,
        autoRepay: toFiniteNumber(deal.autoRepay ?? deal.auto_repay, 0) || 0,
    };
}

function parseCallOrderSummary(order) {
    if (!order || typeof order !== 'object') return null;
    return {
        id: order.id || null,
        borrower: order.borrower || null,
        debtAssetId: order.debtAssetId || order.call_price?.quote?.asset_id || null,
        debtAmount: toFiniteNumber(order.debt?.amount ?? order.debtAmount, 0) || 0,
        collateralAssetId: order.collateralAssetId || order.call_price?.base?.asset_id || null,
        collateralAmount: toFiniteNumber(order.collateral?.amount ?? order.collateralAmount, 0) || 0,
        debt: order.debt || null,
        collateral: order.collateral || null,
        call_price: order.call_price || null,
    };
}

function parseCreditOfferSummary(offer) {
    if (!offer || typeof offer !== 'object') return null;
    return {
        id: offer.id || null,
        ownerAccount: offer.owner_account || offer.ownerAccount || null,
        assetType: offer.asset_type || offer.assetType || null,
        totalBalance: toFiniteNumber(offer.total_balance ?? offer.totalBalance, 0) || 0,
        currentBalance: toFiniteNumber(offer.current_balance ?? offer.currentBalance, 0) || 0,
        feeRate: toFiniteNumber(offer.fee_rate ?? offer.feeRate, 0) || 0,
        maxDurationSeconds: toFiniteNumber(offer.max_duration_seconds ?? offer.maxDurationSeconds, 0) || 0,
        minDealAmount: toFiniteNumber(offer.min_deal_amount ?? offer.minDealAmount, 0) || 0,
        enabled: !!offer.enabled,
        acceptableCollateral: offer.acceptable_collateral || offer.acceptableCollateral || null,
    };
}

class CreditRuntime {
    constructor(bot, options = {}) {
        this.bot = bot || {};
        this.config = this.bot.config || {};
        this.options = options || {};
        this.log = typeof this.bot._log === 'function' ? this.bot._log.bind(this.bot) : console.log.bind(console);
        this.warn = typeof this.bot._warn === 'function' ? this.bot._warn.bind(this.bot) : console.warn.bind(console);

        const fallbackBotKey = createBotKey(this.config, this.config.botIndex ?? 0);
        this.botKey = this.config.botKey || fallbackBotKey;
        this.stateDir = this.options.stateDir || DEFAULT_STATE_DIR;
        this.statePath = path.join(this.stateDir, `${this.botKey}.json`);
        this._assetCache = new Map();
        this._objectCache = new Map();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        this.state = this._createDefaultState();
        this._loaded = false;
    }

    _createDefaultState() {
        return {
            botKey: this.botKey,
            updatedAt: null,
            mpaCallOrders: [],
            activeDealIds: [],
            activeOfferIds: [],
            ownedCreditOffers: [],
            creditDeals: [],
            debtSnapshot: null,
            lastBorrowRequest: null,
            lastRepayAt: null,
            lastGridResetAt: null,
            lastCrAdjustment: null,
            reborrowPending: false,
            pendingReborrows: [],
            positions: {}, // debtAssetId -> positionState
        };
    }

    get debtPolicy() {
        return this.config?.debtPolicy && typeof this.config.debtPolicy === 'object'
            ? this.config.debtPolicy
            : null;
    }

    isEnabled() {
        const dp = this.debtPolicy;
        if (!dp) return false;
        if (!Array.isArray(dp.lending) || dp.lending.length === 0) return false;
        return dp.lending.every((item) =>
            typeof item.collateralAsset === 'string' && item.collateralAsset.length > 0
        );
    }

    _positionKey(debtAssetId, collateralAssetId) {
        return `${debtAssetId}:${collateralAssetId}`;
    }

    _findLendingItemByType(type) {
        const dp = this.debtPolicy;
        if (!Array.isArray(dp?.lending)) return null;
        return dp.lending.find((item) => item.type === type) || null;
    }

    async _findLendingItemForAsset(assetId) {
        if (!assetId || !this.debtPolicy?.lending) return null;
        for (const item of this.debtPolicy.lending) {
            let cached = this._assetCache.get(String(item.asset));
            if (!cached && item.asset) {
                cached = await this._resolveAsset(item.asset);
            }
            if (cached && String(cached.id) === String(assetId)) {
                return item;
            }
        }
        return null;
    }

    _stateWithDefaults(state = {}) {
        const merged = { ...this._createDefaultState(), ...deepClone(state || {}) };
        merged.activeDealIds = Array.isArray(merged.activeDealIds) ? merged.activeDealIds : [];
        merged.activeOfferIds = Array.isArray(merged.activeOfferIds) ? merged.activeOfferIds : [];
        merged.mpaCallOrders = Array.isArray(merged.mpaCallOrders) ? merged.mpaCallOrders : [];
        merged.ownedCreditOffers = Array.isArray(merged.ownedCreditOffers) ? merged.ownedCreditOffers : [];
        merged.creditDeals = Array.isArray(merged.creditDeals) ? merged.creditDeals : [];
        merged.pendingReborrows = Array.isArray(merged.pendingReborrows) ? merged.pendingReborrows : [];
        merged.reborrowPending = merged.pendingReborrows.length > 0 || !!merged.reborrowPending;
        merged.botKey = merged.botKey || this.botKey;
        merged.positions = merged.positions && typeof merged.positions === 'object' ? merged.positions : {};
        return merged;
    }

    async loadState({ forceReload = false } = {}) {
        if (this._loaded && !forceReload) {
            return this.state;
        }

        ensureDirSync(this.stateDir);
        if (!fs.existsSync(this.statePath)) {
            this.state = this._stateWithDefaults();
            this._loaded = true;
            return this.state;
        }

        try {
            const raw = fs.readFileSync(this.statePath, 'utf8');
            const parsed = raw ? JSON.parse(raw) : {};
            this.state = this._stateWithDefaults(parsed);
        } catch (err) {
            this.warn(`credit runtime: failed to load ${this.statePath}: ${err.message}`);
            this.state = this._stateWithDefaults();
        }

        this._loaded = true;
        return this.state;
    }

    async persistState(reason = 'update') {
        ensureDirSync(this.stateDir);
        this.state.updatedAt = new Date().toISOString();
        this.state.botKey = this.botKey;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        const payload = JSON.stringify(this.state, null, 2) + '\n';
        fs.writeFileSync(this.statePath, payload, 'utf8');
        if (reason) {
            this.log(`credit runtime: persisted ${this.botKey} state (${reason})`);
        }
        return this.state;
    }

    async shutdown() {
        if (!this._loaded) return;
        await this.persistState('shutdown');
    }

    async _dbCall(method, args = []) {
        await waitForConnected();
        if (!BitShares?.db || typeof BitShares.db.call !== 'function') {
            throw new Error('BitShares DB client is unavailable');
        }
        return BitShares.db.call(method, args);
    }

    async _resolveAccountId(accountRef) {
        if (!accountRef) return null;
        if (/^1\.2\.\d+$/.test(accountRef)) return accountRef;
        return chainOrders.resolveAccountId(accountRef);
    }

    async _resolveAccountName(accountRef) {
        if (!accountRef) return null;
        if (!/^1\.2\.\d+$/.test(accountRef)) return accountRef;
        return chainOrders.resolveAccountName(accountRef);
    }

    async _getFullAccount(accountRef) {
        if (!accountRef) return null;
        if (this._fullAccountCache && this._fullAccountCache.ref === String(accountRef)) {
            return this._fullAccountCache.account;
        }
        const accounts = await this._dbCall('get_full_accounts', [[accountRef], false]);
        const account = parseFullAccount(accounts);
        this._fullAccountCache = { ref: String(accountRef), account: account || null };
        return account || null;
    }

    async _resolveAsset(assetRef) {
        if (!assetRef) return null;
        const cacheKey = String(assetRef);
        if (this._assetCache.has(cacheKey)) {
            return this._assetCache.get(cacheKey);
        }

        let asset = null;
        if (/^1\.3\.\d+$/.test(cacheKey)) {
            const result = await this._dbCall('get_assets', [[cacheKey]]);
            asset = Array.isArray(result) ? result[0] : null;
        } else {
            const result = await this._dbCall('lookup_asset_symbols', [[cacheKey]]);
            asset = Array.isArray(result) ? result[0] : null;
        }

        if (asset) {
            this._assetCache.set(cacheKey, asset);
            if (asset.id) {
                this._assetCache.set(String(asset.id), asset);
            }
            if (asset.symbol) {
                this._assetCache.set(String(asset.symbol), asset);
            }
        }

        return asset;
    }

    async _resolveBitassetData(assetRef) {
        const asset = await this._resolveAsset(assetRef);
        const bitassetDataId = asset?.bitasset_data_id || null;
        if (!bitassetDataId) return null;

        if (this._objectCache.has(bitassetDataId)) {
            return this._objectCache.get(bitassetDataId);
        }

        const objects = await this._dbCall('get_objects', [[bitassetDataId]]);
        const bitassetData = Array.isArray(objects) ? objects[0] : null;
        if (bitassetData) {
            this._objectCache.set(bitassetDataId, bitassetData);
        }
        return bitassetData;
    }

    _computeBtsPerDebt(settlementPrice, debtAsset, backingAsset) {
        const base = settlementPrice?.base;
        const quote = settlementPrice?.quote;
        if (!base || !quote || !debtAsset || !backingAsset) return null;

        const baseAsset = base.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const quoteAsset = quote.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const baseAmount = blockchainAmountToFloat(base.amount, baseAsset);
        const quoteAmount = blockchainAmountToFloat(quote.amount, quoteAsset);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }

        if (base.asset_id === backingAsset.id && quote.asset_id === debtAsset.id) {
            return baseAmount / quoteAmount;
        }
        if (base.asset_id === debtAsset.id && quote.asset_id === backingAsset.id) {
            return quoteAmount / baseAmount;
        }
        return null;
    }

    _normalizePolicyList(value) {
        return normalizeNumberArray(value);
    }

    async _resolveAmountToBlockchainInt(spec, asset, accountRef, { balanceField = 'total', referenceAmount = null, referenceLabel = 'available balance' } = {}) {
        const normalized = normalizeAmountSpec(spec);
        if (!normalized || normalized.amount === null || normalized.amount === undefined) {
            return null;
        }
        if (!asset || !asset.id) {
            throw new Error('Unable to resolve asset metadata for amount spec');
        }

        const isPercent = typeof normalized.amount === 'string' && normalized.amount.trim().endsWith('%');
        let total = null;
        if (isPercent) {
            if (Number.isFinite(referenceAmount)) {
                total = Number(referenceAmount);
            } else {
                if (!accountRef) {
                    throw new Error(`Unable to resolve account for percentage amount on ${asset.id}`);
                }
                const balances = await chainOrders.getOnChainAssetBalances(accountRef, [asset.id]);
                const balance = balances?.[String(asset.id)] || balances?.[String(asset.symbol)] || null;
                total = toFiniteNumber(balance?.[balanceField], null);
                if (!Number.isFinite(total) || total < 0) {
                    throw new Error(`Unable to resolve ${referenceLabel} for ${asset.id}`);
                }
            }
            if (!Number.isFinite(total) || total < 0) {
                throw new Error(`Unable to resolve account for percentage amount on ${asset.id}`);
            }
        }

        const resolved = resolveConfigValue(normalized.amount, total);
        if (!Number.isFinite(resolved) || resolved <= 0) {
            return null;
        }
        if (isPercent && resolved > total) {
            throw new Error(`Requested amount ${resolved} exceeds available ${balanceField} balance ${total} for ${asset.id}`);
        }

        const intValue = floatToBlockchainInt(resolved, asset.precision);
        if (!Number.isFinite(intValue) || intValue <= 0) {
            return null;
        }

        return intValue;
    }

    _resolveLendingPolicyForOffer(offer) {
        const offerDebtAssetId = offer?.asset_type || null;
        if (!offerDebtAssetId || !this.debtPolicy?.lending) return null;
        for (const item of this.debtPolicy.lending) {
            if (item.type !== 'creditOffer') continue;
            const cached = this._assetCache.get(String(item.asset));
            if (cached && String(cached.id) === String(offerDebtAssetId)) {
                return item;
            }
        }
        return null;
    }

    async _resolveMpaFeedPrice(debtAssetId, collateralAssetId) {
        if (!debtAssetId || !collateralAssetId) return null;

        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = this.state.positions[posKey]?.mpaFeedPrice;
        if (cached !== undefined && cached !== null && cached > 0) return cached;

        const bitassetData = await this._resolveBitassetData(debtAssetId);
        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        if (!debtAsset || !collateralAsset) return null;

        const feedPrice = this._computeBtsPerDebt(bitassetData?.current_feed?.settlement_price, debtAsset, collateralAsset);
        if (!Number.isFinite(feedPrice) || feedPrice <= 0) return null;

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        this.state.positions[posKey].mpaFeedPrice = feedPrice;
        return feedPrice;
    }

    async _resolveCreditConversionRate(lendingItem, debtAssetId, collateralAssetId) {
        if (!debtAssetId || !collateralAssetId) return null;

        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = this.state.positions[posKey]?.creditConversionRate;
        if (cached !== undefined && cached !== null) return cached;

        const offerIds = new Set();

        const deals = Array.isArray(this.state.positions[posKey]?.creditDeals)
            ? this.state.positions[posKey].creditDeals
            : [];
        for (const deal of deals) {
            if (deal?.offerId) offerIds.add(String(deal.offerId));
        }

        const allowedOfferIds = this._normalizePolicyList(lendingItem?.allowedOfferIds);
        for (const id of allowedOfferIds) {
            if (id) offerIds.add(String(id));
        }

        if (offerIds.size === 0) return null;

        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);

        const offerObjects = await this._dbCall('get_objects', [Array.from(offerIds)]);
        if (!Array.isArray(offerObjects)) return null;

        for (const offer of offerObjects) {
            if (!offer || String(offer.asset_type) !== String(debtAssetId)) continue;
            if (offer.enabled === false) continue;

            const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
            const price = collateralMap.get(String(collateralAssetId));
            if (!price) continue;

            const baseAmount = blockchainAmountToFloat(price?.base, collateralAsset);
            const quoteAmount = blockchainAmountToFloat(price?.quote, debtAsset);
            if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0) continue;

            const rate = quoteAmount / baseAmount;
            if (!Number.isFinite(rate) || rate <= 0) continue;

            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].creditConversionRate = rate;
            return rate;
        }

        return null;
    }

    async _calculateCollateralDistribution() {
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) return;

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return;

        // Group lending items by their collateral asset
        const groups = new Map();
        for (const item of dp.lending) {
            const ref = item.collateralAsset;
            if (!ref) continue;
            if (!groups.has(ref)) groups.set(ref, []);
            groups.get(ref).push(item);
        }

        const validAssetIds = new Set();

        for (const [collateralRef, items] of groups) {
            const collateralAsset = await this._resolveAsset(collateralRef);
            if (!collateralAsset) continue;

            const totalCollateralAvailable = await this._getCollateralPercentageBase(accountRef, collateralAsset.id);
            const totalMaxCollateral = resolveConfigValue(dp.maxCollateralAmount ?? '100%', totalCollateralAvailable);
            const C_total = Math.min(totalCollateralAvailable, totalMaxCollateral);

            const weightEntries = await Promise.all(
                items.map(async (item) => {
                    const ratio = item.ratio ?? 1;
                    const resolvedAsset = await this._resolveAsset(item.asset);
                    const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;

                    let targetCr = 1.0;
                    let weight = ratio * targetCr;

                    if (item.type === 'mpa') {
                        targetCr = resolveTargetCollateralRatio(item) || 2.0;
                        const feedPrice = assetId
                            ? await this._resolveMpaFeedPrice(assetId, collateralAsset.id)
                            : null;
                        if (feedPrice !== null && feedPrice > 0) {
                            weight = ratio * feedPrice * targetCr;
                        } else {
                            weight = ratio * targetCr;
                            if (assetId) {
                                this.warn(`credit runtime: unable to discover MPA feed price for ${item.asset}; using collateral-first fallback`);
                            }
                        }
                    } else if (item.type === 'creditOffer') {
                        targetCr = toFiniteNumber(item.maxCollateralRatio, 2.0);
                        const conversionRate = assetId
                            ? await this._resolveCreditConversionRate(item, assetId, collateralAsset.id)
                            : null;
                        if (conversionRate !== null && conversionRate > 0) {
                            weight = (ratio * targetCr) / conversionRate;
                        } else {
                            weight = ratio * targetCr;
                            if (assetId) {
                                this.warn(`credit runtime: unable to discover credit offer price for ${item.asset}; using collateral-first fallback`);
                            }
                        }
                    }

                    return { item, weight, assetId };
                })
            );

            const totalWeight = weightEntries.reduce((sum, e) => sum + e.weight, 0);
            if (totalWeight === 0) continue;

            for (const { weight, assetId } of weightEntries) {
                if (!assetId || !collateralAsset.id) continue;
                const posKey = this._positionKey(assetId, collateralAsset.id);
                validAssetIds.add(posKey);
                const C_i = (C_total * weight) / totalWeight;
                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].assignedCollateralBudget = C_i;
            }
        }

        for (const key of Object.keys(this.state.positions)) {
            if (!validAssetIds.has(key)) {
                delete this.state.positions[key];
            }
        }
    }

    _calculateBorrowAmountFromCollateral(collateralAmountInt, collateralPrice) {
        const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, null);
        const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, null);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }
        return Math.floor((Number(collateralAmountInt) * quoteAmount) / baseAmount);
    }

    _enforceMaxBorrowAmount(policy, borrowInt, debtAsset) {
        const maxBorrowAmountValue = positiveOrNull(policy?.maxBorrowAmount);
        if (maxBorrowAmountValue === null) return;
        const borrowFloat = blockchainToFloat(borrowInt, debtAsset.precision);
        if (!Number.isFinite(borrowFloat)) return;
        const currentTotal = this._getCreditDebtForAsset(debtAsset);
        if (currentTotal + borrowFloat > maxBorrowAmountValue) {
            throw new Error(`borrowAmount ${borrowFloat} would exceed maxBorrowAmount ${maxBorrowAmountValue} (current total ${currentTotal})`);
        }
    }

    _getCreditDebtForAsset(asset) {
        const assetId = asset?.id || asset;
        const deals = Array.isArray(this.state?.creditDeals) ? this.state.creditDeals : [];
        return deals.reduce((sum, deal) => {
            if (String(deal?.debtAssetId) === String(assetId)) {
                return sum + (blockchainAmountToFloat(deal?.debtAmount, asset) || 0);
            }
            return sum;
        }, 0);
    }

    _getCreditCollateralForAsset(asset) {
        const assetId = asset?.id || asset;
        const deals = Array.isArray(this.state?.creditDeals) ? this.state.creditDeals : [];
        return deals.reduce((sum, deal) => {
            if (String(deal?.collateralAssetId) === String(assetId)) {
                return sum + (blockchainAmountToFloat(deal?.collateralAmount, asset) || 0);
            }
            return sum;
        }, 0);
    }

    async _getCollateralPercentageBase(accountId, assetId) {
        if (!accountId || !assetId) return null;

        const asset = await this._resolveAsset(assetId);
        if (!asset) return null;

        const [balances, account, deals] = await Promise.all([
            chainOrders.getOnChainAssetBalances(accountId, [assetId]),
            this._getFullAccount(accountId).catch(() => null),
            this._fetchBorrowerDeals().catch(() => []),
        ]);

        const balance = balances?.[String(assetId)] || balances?.[String(asset.symbol)] || null;
        const onChainTotal = toFiniteNumber(balance?.total, null);
        if (!Number.isFinite(onChainTotal)) {
            return null;
        }

        let committed = 0;
        for (const order of parseCallOrders(account)) {
            const orderCollateralAssetId = order?.call_price?.base?.asset_id || null;
            if (String(orderCollateralAssetId) !== String(assetId)) continue;
            committed += blockchainAmountToFloat(order?.collateral, asset) || 0;
        }

        for (const deal of deals) {
            if (String(deal?.collateralAssetId) !== String(assetId)) continue;
            const dealAsset = await this._resolveAsset(deal.collateralAssetId);
            committed += blockchainAmountToFloat(deal?.collateralAmount, dealAsset || asset) || 0;
        }

        return onChainTotal + committed;
    }

    async _enforceMaxCollateralAmount(policy, collateralInt, collateralAsset, accountId) {
        const maxCollateralAmountValue = policy?.maxCollateralAmount;
        if (maxCollateralAmountValue == null) return;
        let limitFloat = positiveOrNull(maxCollateralAmountValue);
        if (limitFloat === null) {
            const trimmed = typeof maxCollateralAmountValue === 'string' ? maxCollateralAmountValue.trim() : '';
            if (!trimmed.endsWith('%')) return;
            const referenceAmount = await this._getCollateralPercentageBase(accountId, collateralAsset.id);
            if (!Number.isFinite(referenceAmount)) {
                throw new Error(`Unable to resolve collateral percentage base for ${collateralAsset.id}`);
            }
            limitFloat = resolveConfigValue(maxCollateralAmountValue, referenceAmount);
        }
        if (!Number.isFinite(limitFloat) || limitFloat < 0) return;
        const collateralFloat = blockchainToFloat(collateralInt, collateralAsset.precision);
        if (!Number.isFinite(collateralFloat)) return;
        const currentTotal = this._getCreditCollateralForAsset(collateralAsset);
        if (currentTotal + collateralFloat > limitFloat) {
            throw new Error(`collateralAmount ${collateralFloat} would exceed maxCollateralAmount ${limitFloat} (current total ${currentTotal})`);
        }
    }

    _calculateDailyFeeRate(offer) {
        const feeRate = toFiniteNumber(offer?.fee_rate, 0) || 0;
        const maxDurationSeconds = toFiniteNumber(offer?.max_duration_seconds, 0) || 0;
        if (feeRate <= 0 || maxDurationSeconds <= 0) return 0;
        const feeRateDenom = this.bot?.config?.FEE_PARAMETERS?.GRAPHENE_FEE_RATE_DENOM ?? 1000000;
        const flatFeePercent = feeRate / feeRateDenom;
        const durationDays = maxDurationSeconds / 86400;
        return flatFeePercent / durationDays;
    }

    _getDefaultMaxFeeRatePerDay() {
        return this.bot?.config?.FEE_PARAMETERS?.DEFAULT_MAX_FEE_RATE_PER_DAY ?? (1 / 3000);
    }

    _validateCreditPolicy(policy, offer, deal = null) {
        if (!policy || typeof policy !== 'object') return { allow: false, reason: 'creditOffer policy missing' };
        const allowedOfferIds = this._normalizePolicyList(policy.allowedOfferIds);
        const maxFeeRatePerDay = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const maxBorrowAmount = positiveOrNull(policy.maxBorrowAmount);
        const maxCollateralAmount = positiveOrPercentOrNull(policy.maxCollateralAmount);
        const maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);

        if (maxCollateralRatio === null) {
            return { allow: false, reason: 'creditOffer maxCollateralRatio is required' };
        }
        if (policy.maxBorrowAmount != null && maxBorrowAmount === null) {
            return { allow: false, reason: 'creditOffer maxBorrowAmount must be positive' };
        }
        if (policy.maxCollateralAmount != null && maxCollateralAmount === null) {
            return { allow: false, reason: 'creditOffer maxCollateralAmount must be positive or percentage' };
        }

        if (allowedOfferIds.length > 0 && offer?.id && !allowedOfferIds.includes(String(offer.id))) {
            return { allow: false, reason: `offer ${offer.id} is not allowed` };
        }

        if (deal) {
            if (allowedOfferIds.length > 0 && deal.offerId && !allowedOfferIds.includes(String(deal.offerId))) {
                return { allow: false, reason: `deal offer ${deal.offerId} is not allowed` };
            }
        }

        const dailyRate = this._calculateDailyFeeRate(offer);
        if (dailyRate > maxFeeRatePerDay) {
            return { allow: false, reason: `offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDay}` };
        }

        return { allow: true, reason: null };
    }

    async _calculateCollateralValueInDebtAsset(collateralAmountInt, collateralAsset, debtAsset, collateralPrice) {
        const collateralAmountFloat = blockchainToFloat(collateralAmountInt, collateralAsset.precision);
        if (!Number.isFinite(collateralAmountFloat) || collateralAmountFloat <= 0) {
            return null;
        }

        if (collateralAsset?.for_liquidity_pool) {
            const valuePerShare = await deriveLiquidityPoolTokenValue(BitShares, collateralAsset.id, debtAsset.id);
            if (!Number.isFinite(valuePerShare) || valuePerShare <= 0) {
                return null;
            }
            return collateralAmountFloat * valuePerShare;
        }

        const baseAmountFloat = blockchainAmountToFloat(collateralPrice?.base, collateralAsset);
        const quoteAmountFloat = blockchainAmountToFloat(collateralPrice?.quote, debtAsset);
        if (!Number.isFinite(baseAmountFloat) || !Number.isFinite(quoteAmountFloat) || baseAmountFloat <= 0 || quoteAmountFloat <= 0) {
            return null;
        }
        return (collateralAmountFloat * quoteAmountFloat) / baseAmountFloat;
    }

    async _fetchBorrowerDeals() {
        if (this._borrowerDealsCache) return this._borrowerDealsCache;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return [];
        const accountId = await this._resolveAccountId(accountRef);
        if (!accountId) return [];
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter(Boolean) : [];
        this._borrowerDealsCache = normalized;
        return normalized;
    }

    async _fetchOwnedCreditOffers() {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return [];
        }

        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const offers = await this._dbCall('get_credit_offers_by_owner', [accountId]);
        return Array.isArray(offers) ? offers.map(parseCreditOfferSummary).filter(Boolean) : [];
    }

    async _buildDebtSnapshot() {
        const snapshot = {
            assets: {},
            mpaCallOrders: Array.isArray(this.state.mpaCallOrders) ? this.state.mpaCallOrders : [],
            creditDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [],
            ownedCreditOffers: Array.isArray(this.state.ownedCreditOffers) ? this.state.ownedCreditOffers : [],
        };

        const bump = (assetId, field, amount) => {
            if (!assetId || !Number.isFinite(amount) || amount === 0) return;
            const key = String(assetId);
            if (!snapshot.assets[key]) {
                snapshot.assets[key] = {
                    assetId: key,
                    mpaDebt: 0,
                    mpaCollateral: 0,
                    creditDebt: 0,
                    creditCollateral: 0,
                    offeredBalance: 0,
                    totalDebt: 0,
                    totalCollateral: 0,
                };
            }
            snapshot.assets[key][field] += amount;
        };

        for (const order of snapshot.mpaCallOrders) {
            const debtAsset = order?.debtAssetId ? await this._resolveAsset(order.debtAssetId) : null;
            const collateralAsset = order?.collateralAssetId ? await this._resolveAsset(order.collateralAssetId) : null;
            bump(order?.debtAssetId, 'mpaDebt', blockchainAmountToFloat(order?.debtAmount, debtAsset) || 0);
            bump(order?.collateralAssetId, 'mpaCollateral', blockchainAmountToFloat(order?.collateralAmount, collateralAsset) || 0);
        }

        for (const deal of snapshot.creditDeals) {
            const debtAsset = deal?.debtAssetId ? await this._resolveAsset(deal.debtAssetId) : null;
            const collateralAsset = deal?.collateralAssetId ? await this._resolveAsset(deal.collateralAssetId) : null;
            bump(deal?.debtAssetId, 'creditDebt', blockchainAmountToFloat(deal?.debtAmount, debtAsset) || 0);
            bump(deal?.collateralAssetId, 'creditCollateral', blockchainAmountToFloat(deal?.collateralAmount, collateralAsset) || 0);
        }

        for (const offer of snapshot.ownedCreditOffers) {
            const asset = offer?.assetType ? await this._resolveAsset(offer.assetType) : null;
            bump(offer?.assetType, 'offeredBalance', blockchainAmountToFloat(offer?.currentBalance, asset) || 0);
        }

        for (const entry of Object.values(snapshot.assets)) {
            entry.totalDebt = (entry.mpaDebt || 0) + (entry.creditDebt || 0);
            entry.totalCollateral = (entry.mpaCollateral || 0) + (entry.creditCollateral || 0);
        }

        return snapshot;
    }

    async refreshMpaState(lendingItem) {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshMpaState requires a lendingItem');
        }

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return null;
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const account = await this._getFullAccount(accountRef);
        const callOrders = parseCallOrders(account).map(parseCallOrderSummary).filter(Boolean);
        this.state.mpaCallOrders = callOrders;

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id ? String(configuredCollateralAsset.id) : null;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;

        const candidateOrders = callOrders.filter((entry) =>
            String(entry?.call_price?.quote?.asset_id) === assetId
        );

        const createEmptyState = (reason) => {
            const empty = {
                activeCallOrderId: null,
                mpaSelectionConflict: reason || null,
                debtAssetId: assetId,
                currentCollateralAssetId: null,
                currentDebtAmount: 0,
                currentCollateralAmount: 0,
                currentCollateralFundsTotal: null,
                currentCollateralRatio: null,
                feedPrice: null,
                targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
                minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
                maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            };
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            Object.assign(this.state.positions[posKey], empty);
            return empty;
        };

        if (candidateOrders.length === 0) {
            return createEmptyState('no matching MPA position');
        }

        if (candidateOrders.length > 1) {
            const reason = `multiple matching MPA positions found for ${assetId} in ${this.botKey}`;
            this.warn(`credit runtime: ${reason}; refusing to select one automatically`);
            return createEmptyState(reason);
        }

        const callOrder = candidateOrders[0];
        const callOrderCollateralAssetId = callOrder?.call_price?.base?.asset_id || null;
        const collateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (configuredCollateralAssetId && callOrderCollateralAssetId && String(callOrderCollateralAssetId) !== String(configuredCollateralAssetId)) {
            return createEmptyState(`call order collateral ${callOrderCollateralAssetId} does not match configured collateral ${configuredCollateralAssetId}`);
        }

        const bitassetData = await this._resolveBitassetData(assetId);

        const debtAmount = blockchainAmountToFloat(callOrder?.debt, debtAsset) || 0;
        const collateralAmount = blockchainAmountToFloat(callOrder?.collateral, collateralAsset) || 0;
        const collateralBalances = callOrderCollateralAssetId ? await chainOrders.getOnChainAssetBalances(accountRef, [callOrderCollateralAssetId]) : {};
        const collateralBalance = callOrderCollateralAssetId ? (collateralBalances?.[String(callOrderCollateralAssetId)] || collateralBalances?.[String(collateralAsset?.symbol)] || null) : null;
        const currentCollateralFundsTotal = toFiniteNumber(collateralBalance?.total, null);
        const feedPrice = this._computeBtsPerDebt(bitassetData?.current_feed?.settlement_price, debtAsset, collateralAsset);
        if (Number.isFinite(feedPrice) && feedPrice > 0) {
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].mpaFeedPrice = feedPrice;
        }
        const currentCollateralRatio = debtAmount > 0 && feedPrice > 0
            ? collateralAmount / (debtAmount * feedPrice)
            : null;

        const posState = {
            activeCallOrderId: callOrder.id || null,
            debtAssetId: assetId,
            currentCollateralAssetId: callOrderCollateralAssetId,
            currentDebtAmount: debtAmount,
            currentCollateralAmount: collateralAmount,
            currentCollateralFundsTotal,
            currentCollateralRatio,
            feedPrice,
            targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
            minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
            maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            mpaSelectionConflict: null,
        };

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        Object.assign(this.state.positions[posKey], posState);

        return posState;
    }

    async refreshCreditState(options = {}, lendingItem) {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshCreditState requires a lendingItem');
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const normalizedDeals = Array.isArray(options.deals)
            ? options.deals.map(parseDealSummary).filter(Boolean)
            : await this._fetchBorrowerDeals();
        const ownedCreditOffers = Array.isArray(options.ownedCreditOffers)
            ? options.ownedCreditOffers.map(parseCreditOfferSummary).filter(Boolean)
            : await this._fetchOwnedCreditOffers();
        const trackedOffers = new Map();

        const offerIdsFromDeals = normalizedDeals.map((deal) => deal.offerId).filter(Boolean);
        const offerIds = Array.from(new Set(offerIdsFromDeals.map(String)));

        if (offerIds.length > 0) {
            const offerObjects = await this._dbCall('get_objects', [offerIds]);
            if (Array.isArray(offerObjects)) {
                for (const offer of offerObjects) {
                    if (offer && offer.id) {
                        trackedOffers.set(String(offer.id), offer);
                    }
                }
            }
        }

        const expectedCollateralAssetObj = await this._resolveAsset(lendingItem.collateralAsset);
        const expectedCollateralId = expectedCollateralAssetObj?.id ? String(expectedCollateralAssetObj.id) : null;
        const posKey = expectedCollateralId ? this._positionKey(assetId, expectedCollateralId) : assetId;

        // Cache conversion rate from discovered offers to avoid duplicate fetches in distribution.
        // We cache the first matching enabled offer's rate. In practice, all offers for the same
        // debt+collateral asset pair should have the same conversion rate.
        if (expectedCollateralId) {
            for (const offer of trackedOffers.values()) {
                if (String(offer?.asset_type) !== assetId) continue;
                const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
                const price = collateralMap.get(expectedCollateralId);
                if (!price) continue;
                const debtAssetResolved = await this._resolveAsset(assetId);
                const collateralAssetResolved = await this._resolveAsset(expectedCollateralId);
                const baseAmount = blockchainAmountToFloat(price?.base, collateralAssetResolved);
                const quoteAmount = blockchainAmountToFloat(price?.quote, debtAssetResolved);
                if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0) continue;
                const rate = quoteAmount / baseAmount;
                if (!Number.isFinite(rate) || rate <= 0) continue;
                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].creditConversionRate = rate;
                break;
            }
        }

        const activeDeals = [];
        for (const deal of normalizedDeals) {
            if (String(deal.debtAssetId) !== assetId) {
                continue;
            }
            if (expectedCollateralId && deal.collateralAssetId && String(deal.collateralAssetId) !== expectedCollateralId) {
                continue;
            }
            const offer = deal.offerId ? trackedOffers.get(String(deal.offerId)) : null;
            const validation = this._validateCreditPolicy(lendingItem, offer, deal);
            if (!validation.allow) {
                continue;
            }
            activeDeals.push({
                ...deal,
                offerEnabled: !!offer?.enabled,
                offerFeeRate: toFiniteNumber(offer?.fee_rate, deal.feeRate) || deal.feeRate,
                offerMaxDurationSeconds: toFiniteNumber(offer?.max_duration_seconds, null),
                canReborrow: !!offer?.enabled,
            });
        }

        const activeDealIds = activeDeals.map((deal) => deal.id).filter(Boolean);
        const activeOfferIds = Array.from(new Set(activeDeals.map((deal) => deal.offerId).filter(Boolean)));

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        this.state.positions[posKey].creditDeals = activeDeals;
        this.state.positions[posKey].activeDealIds = activeDealIds;
        this.state.positions[posKey].activeOfferIds = activeOfferIds;

        // Rebuild global tracking arrays from all positions
        const allActiveDealIds = [];
        const allActiveOfferIds = [];
        const allCreditDeals = [];
        for (const pos of Object.values(this.state.positions)) {
            if (Array.isArray(pos.activeDealIds)) {
                allActiveDealIds.push(...pos.activeDealIds);
            }
            if (Array.isArray(pos.activeOfferIds)) {
                allActiveOfferIds.push(...pos.activeOfferIds);
            }
            if (Array.isArray(pos.creditDeals)) {
                allCreditDeals.push(...pos.creditDeals);
            }
        }
        this.state.activeDealIds = allActiveDealIds;
        this.state.activeOfferIds = allActiveOfferIds;
        this.state.creditDeals = allCreditDeals;

        this.state.ownedCreditOffers = ownedCreditOffers;
        this.state.lastBorrowRequest = this.state.lastBorrowRequest || null;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        return this.state;
    }

    async refreshState() {
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        await this.loadState();
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) {
            return this.persistState('refresh');
        }

        const allDeals = await this._fetchBorrowerDeals();

        for (const item of dp.lending) {
            if (item.type === 'mpa') {
                await this.refreshMpaState(item);
            } else if (item.type === 'creditOffer') {
                await this.refreshCreditState({ deals: allDeals }, item);
            }
        }
        await this._calculateCollateralDistribution();

        this.state.debtSnapshot = await this._buildDebtSnapshot();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        return this.persistState('refresh');
    }

    async _buildMpaPlanFromState(lendingItem, assetId) {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_buildMpaPlanFromState requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_buildMpaPlanFromState requires an assetId');
        }
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : assetId;
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        if (posState.mpaSelectionConflict) {
            return { blocked: true, reason: posState.mpaSelectionConflict };
        }
        const plan = buildDebtFirstCrPlan({
            currentCollateralAmount: posState.currentCollateralAmount,
            currentDebtAmount: posState.currentDebtAmount,
            feedPrice: posState.feedPrice,
            minCollateralRatio: lendingItem.minCollateralRatio,
            maxCollateralRatio: lendingItem.maxCollateralRatio,
            targetCollateralRatio: lendingItem.targetCollateralRatio,
            maxBorrowAmount: lendingItem.maxBorrowAmount,
            maxCollateralAmount: posState.assignedCollateralBudget ?? lendingItem.maxCollateralAmount,
            collateralLimitReferenceAmount: posState.currentCollateralFundsTotal,
        });

        if (!plan) return null;
        if (plan.blocked) return plan;
        return plan;
    }

    async buildMpaUpdateOperation(plan, options = {}, lendingItem, assetId) {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('buildMpaUpdateOperation requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('buildMpaUpdateOperation requires an assetId');
        }
        const policy = lendingItem;

        if (!policy || !plan) return null;
        if (plan.blocked) {
            throw new Error(plan.reason || 'MPA plan blocked');
        }

        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : assetId;
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        const leg = options.leg || 'debt';

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for MPA update');
        }

        const debtAsset = posState.debtAssetId ? await this._resolveAsset(posState.debtAssetId) : null;
        const account = await this._getFullAccount(getAccountRef(this.bot));
        const currentCallOrder = parseCallOrders(account).find((entry) => entry.id === posState.activeCallOrderId) || null;
        const callOrderCollateralAssetId = currentCallOrder?.call_price?.base?.asset_id || null;
        const callOrderCollateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (!debtAsset || !callOrderCollateralAsset) {
            throw new Error('Unable to resolve MPA asset metadata');
        }

        const debtDelta = leg === 'collateral' ? 0 : plan.debtDelta;
        const collateralDelta = leg === 'debt' ? 0 : plan.collateralDelta;
        const debtInt = floatToBlockchainInt(debtDelta, debtAsset.precision);
        const collateralInt = floatToBlockchainInt(collateralDelta, callOrderCollateralAsset.precision);
        if (debtInt === 0 && collateralInt === 0) {
            return null;
        }

        const extensions = {};
        if (Number.isFinite(plan.targetCollateralRatio)) {
            extensions.target_collateral_ratio = plan.targetCollateralRatio;
        }

        return {
            op_name: 'call_order_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                funding_account: accountId,
                delta_collateral: toAmountObject(collateralInt, callOrderCollateralAsset.id),
                delta_debt: toAmountObject(debtInt, debtAsset.id),
                extensions,
            }
        };
    }

    async buildCreditOfferAcceptOperation({ offer, borrowAmount, collateralAmount, autoRepay = false, specificPolicy = null }) {
        let policy = specificPolicy;
        if (!policy) {
            const dp = this.debtPolicy;
            const offerObj = typeof offer === 'object' ? offer : null;
            const offerDebtAssetId = offerObj?.asset_type || null;
            if (dp?.lending && offerDebtAssetId) {
                for (const item of dp.lending) {
                    if (item.type !== 'creditOffer') continue;
                    let cached = this._assetCache.get(String(item.asset));
                    if (!cached && item.asset) {
                        cached = await this._resolveAsset(item.asset);
                    }
                    if (cached && String(cached.id) === String(offerDebtAssetId)) {
                        policy = item;
                        break;
                    }
                }
            }
        }
        if (!policy) {
            throw new Error('creditOffer policy missing');
        }

        const offerObj = typeof offer === 'object' ? offer : null;
        const offerId = offerObj?.id || offer;
        if (!offerId) {
            throw new Error('credit offer id is required');
        }

        const validation = this._validateCreditPolicy(policy, offerObj, null);
        if (!validation.allow) {
            throw new Error(validation.reason || 'credit offer rejected by policy');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit offer accept');
        }

        const debtAssetId = offerObj?.asset_type || null;
        const debtAsset = debtAssetId ? await this._resolveAsset(debtAssetId) : null;
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit offer');
        }

        const collateralMap = normalizeCollateralMap(offerObj?.acceptable_collateral);
        const collateralSpec = normalizeAmountSpec(collateralAmount);
        const collateralAssetId = collateralSpec?.assetId || offerObj?.collateral_asset_id || null;
        if (!collateralAssetId && collateralMap.size > 1) {
            throw new Error('collateral asset is required for multi-asset credit offers');
        }
        let collateralPrice = collateralAssetId ? collateralMap.get(String(collateralAssetId)) : null;
        if (!collateralPrice && collateralMap.size === 1) {
            collateralPrice = collateralMap.values().next().value;
        }
        if (!collateralPrice) {
            throw new Error('Unable to determine acceptable collateral for credit offer');
        }

        const collateralAsset = collateralAssetId ? await this._resolveAsset(collateralAssetId) : await this._resolveAsset(getPriceBaseAssetId(collateralPrice));
        if (!collateralAsset) {
            throw new Error('Unable to resolve collateral asset metadata for credit offer');
        }

        let borrowInt = null;
        let requiredCollateralInt = null;
        const requestedBorrowAmount = borrowAmount !== undefined && borrowAmount !== null
            ? positiveOrNull(borrowAmount)
            : null;

        if (borrowAmount !== undefined && borrowAmount !== null && requestedBorrowAmount === null) {
            throw new Error('borrowAmount must be positive');
        }

        if (requestedBorrowAmount !== null) {
            borrowInt = floatToBlockchainInt(requestedBorrowAmount, debtAsset.precision);
            if (!Number.isFinite(borrowInt) || borrowInt <= 0) {
                throw new Error('borrowAmount must be positive');
            }
            this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset);

            const minimumCollateralInt = this._calculateRequiredCollateral(borrowInt, collateralPrice);
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, collateralAsset.id)
                : null;
            requiredCollateralInt = collateralSpec?.amount !== null && collateralSpec?.amount !== undefined
                ? await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' })
                : minimumCollateralInt;
            if (Number.isFinite(minimumCollateralInt) && Number.isFinite(requiredCollateralInt) && requiredCollateralInt < minimumCollateralInt) {
                throw new Error(`collateral amount ${requiredCollateralInt} is below required collateral ${minimumCollateralInt}`);
            }
        } else {
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, collateralAsset.id)
                : null;
            requiredCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' });
            borrowInt = this._calculateBorrowAmountFromCollateral(requiredCollateralInt, collateralPrice);
            if (Number.isFinite(borrowInt) && borrowInt > 0) {
                this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset);
            }
        }

        if (!Number.isFinite(requiredCollateralInt) || requiredCollateralInt <= 0) {
            throw new Error('Unable to determine collateral amount for credit offer');
        }

        if (!Number.isFinite(borrowInt) || borrowInt <= 0) {
            throw new Error('Unable to determine borrow amount from collateral amount');
        }

        await this._enforceMaxCollateralAmount(policy, requiredCollateralInt, collateralAsset, accountId);

        const minDealAmount = toFiniteNumber(offerObj?.min_deal_amount, null);
        if (minDealAmount !== null && borrowInt < minDealAmount) {
            throw new Error(`borrowAmount ${borrowInt} is below min_deal_amount ${minDealAmount}`);
        }

        const maxFeeRatePerDayValue = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const dailyRate = this._calculateDailyFeeRate(offerObj);
        if (dailyRate > maxFeeRatePerDayValue) {
            throw new Error(`offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDayValue}`);
        }

        const offerFeeRate = toFiniteNumber(offerObj?.fee_rate, 0) || 0;

        if (offerObj?.enabled === false) {
            throw new Error(`credit offer ${offerId} is disabled`);
        }

        const minDurationSeconds = positiveOrNull(policy.minDurationSeconds);
        const minDuration = minDurationSeconds !== null ? minDurationSeconds : 0;
        const policyCollateralAssetRef = policy.collateralAsset;
        if (policyCollateralAssetRef && collateralAsset?.id) {
            const policyCollateralAsset = await this._resolveAsset(policyCollateralAssetRef);
            if (policyCollateralAsset?.id && String(collateralAsset.id) !== String(policyCollateralAsset.id)) {
                throw new Error(`collateral asset ${collateralAsset.id} does not match policy.collateralAsset`);
            }
        }

        const maxCollateralRatioValue = positiveOrNull(policy.maxCollateralRatio);
        if (maxCollateralRatioValue === null) {
            throw new Error('creditOffer maxCollateralRatio is required');
        }

        const borrowAmountFloat = blockchainToFloat(borrowInt, debtAsset.precision);
        const collateralValueInDebtAsset = await this._calculateCollateralValueInDebtAsset(requiredCollateralInt, collateralAsset, debtAsset, collateralPrice);
        if (!Number.isFinite(borrowAmountFloat) || borrowAmountFloat <= 0 || !Number.isFinite(collateralValueInDebtAsset) || collateralValueInDebtAsset <= 0) {
            throw new Error(collateralAsset?.for_liquidity_pool
                ? 'Unable to value liquidity pool collateral for credit offer'
                : 'Unable to determine collateral value for credit offer');
        }

        const collateralRatio = collateralValueInDebtAsset / borrowAmountFloat;
        if (collateralRatio > maxCollateralRatioValue) {
            throw new Error(`collateral ratio ${collateralRatio} exceeds maxCollateralRatio ${maxCollateralRatioValue}`);
        }

        const extensions = {};
        const autoRepayValue = resolveAutoRepayValue(autoRepay);
        if (autoRepayValue > 0) {
            extensions.auto_repay = autoRepayValue;
        }

        const op = {
            op_name: 'credit_offer_accept',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                borrower: accountId,
                offer_id: offerId,
                borrow_amount: toAmountObject(borrowInt, debtAsset.id),
                collateral: toAmountObject(requiredCollateralInt, collateralAsset.id),
                max_fee_rate: offerFeeRate,
                min_duration_seconds: minDuration,
                extensions,
            }
        };

        this.state.lastBorrowRequest = {
            offerId: String(offerId),
            borrowAmount: borrowInt,
            collateralAmount: requiredCollateralInt,
            autoReborrow: !!policy?.autoReborrow,
            requestedAt: new Date().toISOString()
        };

        return op;
    }

    _calculateRequiredCollateral(borrowAmountInt, collateralPrice) {
        const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, null);
        const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, null);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }
        return Math.ceil((Number(borrowAmountInt) * baseAmount) / quoteAmount);
    }

    _calculateCreditFee(repayAmountInt, feeRate) {
        const repay = BigInt(Math.max(0, Math.trunc(Number(repayAmountInt))));
        const rate = BigInt(Math.max(0, Math.trunc(Number(feeRate))));
        const denom = BigInt(CREDIT_FEE_RATE_DENOM);
        if (repay <= 0n || rate <= 0n) return 0;
        return Number(((repay * rate) + denom - 1n) / denom);
    }

    async buildCreditDealRepayOperation(deal, repayAmount) {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit repay');
        }

        const debtAsset = await this._resolveAsset(dealSummary.debtAssetId);
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit repay');
        }

        const repayInt = floatToBlockchainInt(repayAmount, debtAsset.precision);
        if (!Number.isFinite(repayInt) || repayInt <= 0) {
            throw new Error('repayAmount must be positive');
        }
        if (repayInt > dealSummary.debtAmount) {
            throw new Error(`repayAmount ${repayInt} exceeds unpaid amount ${dealSummary.debtAmount}`);
        }

        const creditFee = this._calculateCreditFee(repayInt, dealSummary.feeRate);

        return {
            op_name: 'credit_deal_repay',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                repay_amount: toAmountObject(repayInt, debtAsset.id),
                credit_fee: toAmountObject(creditFee, debtAsset.id),
                extensions: [],
            }
        };
    }

    async buildCreditDealUpdateOperation(deal, autoRepay) {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit deal update');
        }

        return {
            op_name: 'credit_deal_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                auto_repay: resolveAutoRepayValue(autoRepay),
                extensions: [],
            }
        };
    }

    async executeOperations(operations, reason = 'credit runtime') {
        if (!Array.isArray(operations) || operations.length === 0) {
            return { skipped: true, reason: 'no operations', operations: [] };
        }

        if (this.bot?.config?.dryRun) {
            return { dryRun: true, reason, operations: deepClone(operations) };
        }

        const accountName = await this._resolveAccountName(getAccountRef(this.bot));
        if (!accountName) {
            throw new Error('Unable to resolve account name for broadcast');
        }
        if (!this.bot?.privateKey) {
            throw new Error('Missing signing key for credit runtime broadcast');
        }

        return chainOrders.executeBatch(accountName, this.bot.privateKey, operations);
    }

    async openCreditPosition({ offer, borrowAmount, collateralAmount, autoRepay = false, reason = 'credit borrow' }) {
        const offerObj = typeof offer === 'object' ? offer : await this._getOfferById(offer);
        const acceptOp = await this.buildCreditOfferAcceptOperation({
            offer: offerObj,
            borrowAmount,
            collateralAmount,
            autoRepay,
        });
        const result = await this.executeOperations([acceptOp], reason);
        await this.refreshState();
        await this.persistState(reason);
        return result;
    }

    async repayCreditDeal(deal, repayAmount, options = {}) {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : await this._getDealById(deal);
        if (!dealSummary) {
            throw new Error('credit deal not found');
        }

        const repayOp = await this.buildCreditDealRepayOperation(dealSummary, repayAmount);
        const operations = [repayOp];
        const reborrowPolicy = options.specificPolicy || await this._findLendingItemForAsset(dealSummary.debtAssetId) || {};
        const shouldAutoReborrow = options.autoReborrow !== false && !!reborrowPolicy.autoReborrow;
        let deferredReborrowRequest = null;
        let inlineReborrowPlanned = false;

        if (shouldAutoReborrow) {
            const reborrowAmount = options.reborrowAmount !== undefined && options.reborrowAmount !== null
                ? options.reborrowAmount
                : repayAmount;
            const reborrowCollateralAmount = options.collateralAmount !== undefined
                ? options.collateralAmount
                : null;
            const policyHasAutoRepay = Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay');
            const autoRepaySetting = options.autoRepay !== undefined
                ? options.autoRepay
                : (policyHasAutoRepay ? reborrowPolicy.autoRepay : (dealSummary.autoRepay ?? false));
            const offer = await this._getOfferById(dealSummary.offerId);
            if (offer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        specificPolicy: options.specificPolicy,
                    });
                    operations.push(acceptOp);
                    inlineReborrowPlanned = true;
                } catch (err) {
                    deferredReborrowRequest = {
                        sourceDealId: dealSummary.id,
                        offerId: dealSummary.offerId,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        specificPolicy: options.specificPolicy,
                        requestedAt: new Date().toISOString(),
                        reason: err.message,
                    };
                }
            } else {
                deferredReborrowRequest = {
                    sourceDealId: dealSummary.id,
                    offerId: dealSummary.offerId,
                    borrowAmount: reborrowAmount,
                    collateralAmount: reborrowCollateralAmount,
                    autoRepay: autoRepaySetting,
                    specificPolicy: options.specificPolicy,
                    requestedAt: new Date().toISOString(),
                    reason: 'offer unavailable',
                };
            }
        }

        const result = await this.executeOperations(operations, 'credit repay');
        this.state.lastRepayAt = new Date().toISOString();
        const onChainDeals = await this._fetchBorrowerDeals();
        const sourceDealStillActive = onChainDeals.some((entry) => String(entry?.id) === String(dealSummary.id));
        await this.refreshState();
        if (shouldAutoReborrow && !inlineReborrowPlanned && !sourceDealStillActive) {
            const reborrowOffer = await this._getOfferById(dealSummary.offerId);
            const reborrowRequest = deferredReborrowRequest || {
                sourceDealId: dealSummary.id,
                offerId: dealSummary.offerId,
                borrowAmount: options.reborrowAmount !== undefined && options.reborrowAmount !== null
                    ? options.reborrowAmount
                    : repayAmount,
                collateralAmount: options.collateralAmount !== undefined ? options.collateralAmount : null,
                autoRepay: options.autoRepay !== undefined
                    ? options.autoRepay
                    : (Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay')
                        ? reborrowPolicy.autoRepay
                        : (dealSummary.autoRepay ?? false)),
                specificPolicy: options.specificPolicy,
                requestedAt: new Date().toISOString(),
                reason: deferredReborrowRequest?.reason || null,
            };
            if (reborrowOffer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer: reborrowOffer,
                        borrowAmount: reborrowRequest.borrowAmount,
                        collateralAmount: reborrowRequest.collateralAmount,
                        autoRepay: reborrowRequest.autoRepay,
                        specificPolicy: reborrowRequest.specificPolicy,
                    });
                    await this.executeOperations([acceptOp], 'credit reborrow');
                    await this.refreshState();
                    deferredReborrowRequest = null;
                } catch (err) {
                    this.queueReborrow({
                        ...reborrowRequest,
                        reason: err.message,
                    });
                }
            } else {
                this.queueReborrow({
                    ...reborrowRequest,
                    reason: 'offer unavailable',
                });
            }
        } else if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && !sourceDealStillActive) {
            this.queueReborrow(deferredReborrowRequest);
        }
        await this.persistState('credit repay');
        return result;
    }

    queueReborrow(request) {
        if (!request || typeof request !== 'object') return;
        this.state.pendingReborrows = Array.isArray(this.state.pendingReborrows) ? this.state.pendingReborrows : [];
        this.state.pendingReborrows.push({
            sourceDealId: request.sourceDealId || null,
            offerId: request.offerId || null,
            borrowAmount: request.borrowAmount ?? null,
            collateralAmount: request.collateralAmount ?? null,
            autoRepay: request.autoRepay ?? false,
            specificPolicy: request.specificPolicy || null,
            requestedAt: request.requestedAt || new Date().toISOString(),
            reason: request.reason || null,
        });
        this.state.reborrowPending = this.state.pendingReborrows.length > 0;
    }

    async _getOfferById(offerId) {
        if (!offerId) return null;
        const cacheKey = `offer:${offerId}`;
        if (this._objectCache.has(cacheKey)) {
            return this._objectCache.get(cacheKey);
        }
        const objects = await this._dbCall('get_objects', [[offerId]]);
        const offer = Array.isArray(objects) ? objects[0] : null;
        if (offer) {
            this._objectCache.set(cacheKey, offer);
        }
        return offer;
    }

    async _getDealById(dealId) {
        if (!dealId) return null;
        const deals = Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [];
        const fromState = deals.find((entry) => String(entry.id) === String(dealId));
        if (fromState) return fromState;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return null;
        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter(Boolean) : [];
        return normalized.find((entry) => String(entry.id) === String(dealId)) || null;
    }

    async processPendingReborrows() {
        if (!Array.isArray(this.state.pendingReborrows) || this.state.pendingReborrows.length === 0) {
            return { processed: 0, remaining: 0 };
        }

        const onChainDeals = await this._fetchBorrowerDeals();
        const activeDealIds = new Set(onChainDeals.map((deal) => String(deal?.id)).filter(Boolean));
        const nextQueue = [];
        let processed = 0;

        for (const request of this.state.pendingReborrows) {
            if (!request?.offerId || (request.borrowAmount == null && request.collateralAmount == null)) {
                continue;
            }

            const offer = await this._getOfferById(request.offerId);
            if (!offer || offer.enabled === false) {
                nextQueue.push(request);
                continue;
            }

            // Resolve policy: prefer request.specificPolicy, fall back to current debtPolicy lending item
            const requestPolicy = request.specificPolicy || this._resolveLendingPolicyForOffer(offer);
            if (!requestPolicy || !requestPolicy.autoReborrow) {
                this.warn(`credit runtime: dropping pending reborrow for offer ${request.offerId}; autoReborrow disabled or policy missing`);
                continue;
            }

            if (request.sourceDealId && activeDealIds.has(String(request.sourceDealId))) {
                nextQueue.push({ ...request, reason: 'source deal still active on-chain' });
                continue;
            }

            try {
                const acceptOp = await this.buildCreditOfferAcceptOperation({
                    offer,
                    borrowAmount: request.borrowAmount ?? null,
                    collateralAmount: request.collateralAmount || null,
                    autoRepay: request.autoRepay ?? false,
                    specificPolicy: request.specificPolicy || requestPolicy,
                });
                await this.executeOperations([acceptOp], 'credit reborrow');
                processed++;
            } catch (err) {
                nextQueue.push({ ...request, reason: err.message });
            }
        }

        this.state.pendingReborrows = nextQueue;
        this.state.reborrowPending = nextQueue.length > 0;
        await this.refreshState();
        await this.persistState('pending reborrows');

        return { processed, remaining: nextQueue.length };
    }

    async _runMpaMaintenance(context, options, lendingItem, assetId) {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runMpaMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runMpaMaintenance requires an assetId');
        }

        const plan = await this._buildMpaPlanFromState(lendingItem, assetId);
        if (plan?.blocked) {
            return { blocked: true, reason: plan.reason };
        }
        if (!plan) {
            return null;
        }

        const executed = [];
        let result = null;

        const debtOp = await this.buildMpaUpdateOperation(plan, { leg: 'debt' }, lendingItem, assetId);
        if (debtOp) {
            try {
                result = await this.executeOperations([debtOp], `mpa maintenance:${context} debt`);
                executed.push({ leg: 'debt', operation: debtOp, result });
                await this.refreshMpaState(lendingItem);
            } catch (err) {
                if (!isDeterministicMpaDebtBalanceError(err, plan)) {
                    throw err;
                }
                this.warn(`credit runtime: MPA debt leg failed; attempting collateral fallback: ${err.message}`);
                await this.refreshMpaState(lendingItem);
                const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
                const configuredCollateralAssetId = configuredCollateralAsset?.id;
                const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;
                const posState = this.state.positions[posKey];
                const collateralPlan = buildCollateralFallbackPlan({
                    currentCollateralAmount: posState?.currentCollateralAmount,
                    currentDebtAmount: posState?.currentDebtAmount,
                    feedPrice: posState?.feedPrice,
                    targetCollateralRatio: plan.targetCollateralRatio,
                    maxCollateralAmount: posState?.assignedCollateralBudget ?? lendingItem.maxCollateralAmount,
                    collateralLimitReferenceAmount: posState?.currentCollateralFundsTotal,
                });
                if (!collateralPlan) {
                    throw err;
                }
                const fallbackOp = await this.buildMpaUpdateOperation(collateralPlan, { leg: 'collateral' }, lendingItem, assetId);
                if (!fallbackOp) {
                    throw err;
                }
                result = await this.executeOperations([fallbackOp], `mpa maintenance:${context} collateral fallback`);
                executed.push({ leg: 'collateral-fallback', operation: fallbackOp, result, debtError: err.message });
                await this.refreshMpaState(lendingItem);
            }
        }

        const fallbackPlan = await this._buildMpaPlanFromState(lendingItem, assetId);
        if (fallbackPlan && !fallbackPlan.blocked) {
            const collateralOp = await this.buildMpaUpdateOperation(fallbackPlan, { leg: 'collateral' }, lendingItem, assetId);
            if (collateralOp) {
                result = await this.executeOperations([collateralOp], `mpa maintenance:${context} collateral`);
                executed.push({ leg: 'collateral', operation: collateralOp, result });
                await this.refreshMpaState(lendingItem);
            }
        }

        if (executed.length > 0) {
            const lastAction = {
                context,
                plan,
                executedAt: new Date().toISOString(),
                executed,
            };
            const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
            const configuredCollateralAssetId = configuredCollateralAsset?.id;
            const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].lastMpaAction = lastAction;

            this.state.lastCrAdjustment = {
                context,
                plan,
                executedAt: new Date().toISOString(),
            };
            if (typeof this.bot?.requestGridReset === 'function') {
                try {
                    const resetReason = plan.resetReason || 'cr-adjustment';
                    const resetResult = await this.bot.requestGridReset(resetReason, {
                        fillLockAlreadyHeld: options.fillLockAlreadyHeld ?? (context === 'periodic'),
                    });
                    this.state.lastGridResetAt = new Date().toISOString();
                    return { plan, executed, resetResult };
                } catch (err) {
                    this.warn(`credit runtime: grid reset after CR adjustment failed: ${err.message}`);
                    return { plan, executed, resetError: err.message };
                }
            }
            return { plan, executed };
        }
        return null;
    }

    async _runCreditMaintenance(lendingItem, assetId) {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runCreditMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runCreditMaintenance requires an assetId');
        }

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : assetId;

        // Phase 1: Proactively repay deals nearing expiration before processing reborrows
        const expiryThresholdHours = this.bot?.config?.TIMING?.CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS ?? 12;
        const expiryThresholdMs = expiryThresholdHours * 60 * 60 * 1000;

        const posState = this.state.positions[posKey];
        if (!posState) return null;

        const activeDealIds = new Set((posState.creditDeals || []).map((d) => String(d?.id)).filter(Boolean));

        for (const deal of (posState.creditDeals || [])) {
            if (!activeDealIds.has(String(deal?.id))) continue;
            if (!deal.latestRepayTime) continue;
            const timeLeft = new Date(deal.latestRepayTime) - Date.now();
            if (timeLeft < expiryThresholdMs) {
                try {
                    this.warn(`credit runtime: deal ${deal.id} expires in ${Math.round(timeLeft / 60000)}m; proactively repaying and reborrowing`);
                    const debtAsset = await this._resolveAsset(deal.debtAssetId);
                    const repayAmount = blockchainAmountToFloat(deal.debtAmount, debtAsset);
                    if (!Number.isFinite(repayAmount) || repayAmount <= 0) {
                        throw new Error(`unable to convert deal ${deal.id} debt amount for repay`);
                    }
                    await this.repayCreditDeal(deal, repayAmount, {
                        autoReborrow: true,
                        collateralAmount: posState.assignedCollateralBudget,
                        specificPolicy: lendingItem,
                    });
                    activeDealIds.delete(String(deal.id));
                } catch (err) {
                    this.warn(`credit runtime: proactive repay/reborrow for deal ${deal.id} failed: ${err.message}`);
                }
            }
        }

        // Phase 2: Ensure auto_repay matches policy on existing deals
        const policyAutoRepay = resolveAutoRepayValue(lendingItem?.autoRepay);
        if (policyAutoRepay > 0) {
            const currentDeals = posState.creditDeals || [];
            for (const deal of currentDeals) {
                if (resolveAutoRepayValue(deal.autoRepay) !== policyAutoRepay) {
                    try {
                        this.log(`credit runtime: updating auto_repay on deal ${deal.id} to ${policyAutoRepay}`);
                        const updateOp = await this.buildCreditDealUpdateOperation(deal, policyAutoRepay);
                        await this.executeOperations([updateOp], 'credit deal auto_repay update');
                    } catch (err) {
                        this.warn(`credit runtime: failed to update auto_repay on deal ${deal.id}: ${err.message}`);
                    }
                }
            }
        }

        return null;
    }

    async runMaintenance(context = 'periodic', options = {}) {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }

        await this.refreshState();

        const results = {
            context,
            mpa: [],
            credit: [],
        };

        const dp = this.debtPolicy;
        for (const item of dp.lending) {
            const resolvedAsset = await this._resolveAsset(item.asset);
            const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
            if (!assetId) {
                this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                continue;
            }
            if (item.type === 'mpa') {
                results.mpa.push(await this._runMpaMaintenance(context, options, item, assetId));
            } else if (item.type === 'creditOffer') {
                results.credit.push(await this._runCreditMaintenance(item, assetId));
            }
        }

        const reborrowResult = await this.processPendingReborrows();
        await this.persistState(context);
        return { ...results, reborrows: reborrowResult };
    }

    async runCreditWatchdog() {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }
        try {
            await this.refreshState();

            const mpaResults = [];
            const creditResults = [];

            const dp = this.debtPolicy;
            for (const item of dp.lending) {
                const resolvedAsset = await this._resolveAsset(item.asset);
                const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                if (!assetId) {
                    this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                    continue;
                }
                if (item.type === 'mpa') {
                    mpaResults.push(await this._runMpaMaintenance('watchdog', {}, item, assetId));
                } else if (item.type === 'creditOffer') {
                    creditResults.push(await this._runCreditMaintenance(item, assetId));
                }
            }

            const reborrowResult = await this.processPendingReborrows();
            await this.persistState('watchdog');
            return {
                mpa: mpaResults,
                credit: creditResults,
                reborrows: reborrowResult,
                remainingDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals.length : 0,
            };
        } catch (err) {
            this.warn(`credit runtime: watchdog error: ${err.message}`);
            return { skipped: true, reason: err.message };
        }
    }

    /**
     * Get total collateral (MPA + credit deals) per asset from the debt snapshot.
     * @param {Array<string>} assetIds - Asset IDs to look up
     * @returns {Object} mapping assetId -> total collateral float
     */
    getCollateralOffsets(assetIds) {
        const snapshot = this.state?.debtSnapshot?.assets || {};
        const result = {};
        for (const assetId of assetIds) {
            const key = String(assetId);
            const entry = snapshot[key];
            result[key] = toFiniteNumber(entry?.totalCollateral, 0);
        }
        return result;
    }

    getStateSnapshot() {
        return deepClone(this.state);
    }
}

module.exports = CreditRuntime;
