'use strict';

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const { blockchainToFloat, floatToBlockchainInt, resolveConfigValue } = require('./order/utils/math');
const { deriveLiquidityPoolTokenValue } = require('./order/utils/system');
const { createBotKey } = require('./account_orders');
const { buildDebtFirstCrPlan, resolveTargetCollateralRatio } = require('./cr_planner');

const CREDIT_FEE_RATE_DENOM = 1_000_000;
const ZERO_ASSET_ID = '1.3.0';
const DEFAULT_STATE_DIR = path.join(__dirname, '..', 'profiles', 'credit_runtime');

function ensureDirSync(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function positiveOrNull(value) {
    const num = toFiniteNumber(value, null);
    return Number.isFinite(num) && num > 0 ? num : null;
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

function normalizeCollateralMap(acceptableCollateral) {
    const result = new Map();
    for (const [assetId, price] of getMapEntries(acceptableCollateral)) {
        if (!assetId || !price) continue;
        result.set(String(assetId), price);
    }
    return result;
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
        this.state = this._createDefaultState();
        this._loaded = false;
    }

    _createDefaultState() {
        return {
            botKey: this.botKey,
            updatedAt: null,
            activeCallOrderId: null,
            activeDealIds: [],
            activeOfferIds: [],
            mpaSelectionConflict: null,
            debtAssetId: null,
            currentDebtAmount: 0,
            currentCollateralAmount: 0,
            currentCollateralRatio: null,
            targetCollateralRatio: null,
            minCollateralRatio: null,
            maxCollateralRatio: null,
            feedPrice: null,
            creditDeals: [],
            lastBorrowRequest: null,
            lastMpaAction: null,
            lastRepayAt: null,
            lastGridResetAt: null,
            lastCrAdjustment: null,
            reborrowPending: false,
            pendingReborrows: [],
        };
    }

    get debtPolicy() {
        return this.config?.debtPolicy && typeof this.config.debtPolicy === 'object'
            ? this.config.debtPolicy
            : null;
    }

    isEnabled() {
        return !!this.debtPolicy;
    }

    _stateWithDefaults(state = {}) {
        const merged = { ...this._createDefaultState(), ...deepClone(state || {}) };
        merged.activeDealIds = Array.isArray(merged.activeDealIds) ? merged.activeDealIds : [];
        merged.activeOfferIds = Array.isArray(merged.activeOfferIds) ? merged.activeOfferIds : [];
        merged.creditDeals = Array.isArray(merged.creditDeals) ? merged.creditDeals : [];
        merged.pendingReborrows = Array.isArray(merged.pendingReborrows) ? merged.pendingReborrows : [];
        merged.reborrowPending = merged.pendingReborrows.length > 0 || !!merged.reborrowPending;
        merged.botKey = merged.botKey || this.botKey;
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
        const ref = accountRef || getAccountRef(this.bot);
        if (!ref) return null;
        const resolved = await this._dbCall('get_full_accounts', [[ref], false]);
        return parseFullAccount(resolved);
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

    async _resolveAmountToBlockchainInt(spec, asset, accountRef, { balanceField = 'free' } = {}) {
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
            if (!accountRef) {
                throw new Error(`Unable to resolve account for percentage amount on ${asset.id}`);
            }
            const balances = await chainOrders.getOnChainAssetBalances(accountRef, [asset.id]);
            const balance = balances?.[String(asset.id)] || balances?.[String(asset.symbol)] || null;
            total = toFiniteNumber(balance?.[balanceField], null);
            if (!Number.isFinite(total) || total < 0) {
                throw new Error(`Unable to resolve available balance for ${asset.id}`);
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
        if (Number.isFinite(borrowFloat) && borrowFloat > maxBorrowAmountValue) {
            throw new Error(`borrowAmount ${borrowFloat} exceeds maxBorrowAmount ${maxBorrowAmountValue}`);
        }
    }

    _validateMpaPolicy(policy, debtAssetId, collateralAssetId) {
        if (!policy || typeof policy !== 'object') return { allow: false, reason: 'MPA policy missing' };

        const allowedDebtAssets = this._normalizePolicyList(policy.allowedDebtAssets);
        const allowedCollateralAssets = this._normalizePolicyList(policy.allowedCollateralAssets);
        const maxBorrowAmount = positiveOrNull(policy.maxBorrowAmount);
        const maxCollateralAmount = positiveOrNull(policy.maxCollateralAmount);
        const minCr = positiveOrNull(policy.minCollateralRatio);
        const maxCr = positiveOrNull(policy.maxCollateralRatio);

        if (allowedDebtAssets.length > 0 && debtAssetId && !allowedDebtAssets.includes(String(debtAssetId))) {
            return { allow: false, reason: `debt asset ${debtAssetId} is not allowed` };
        }
        if (allowedCollateralAssets.length > 0 && collateralAssetId && !allowedCollateralAssets.includes(String(collateralAssetId))) {
            return { allow: false, reason: `collateral asset ${collateralAssetId} is not allowed` };
        }
        if (maxBorrowAmount !== null && maxBorrowAmount <= 0) {
            return { allow: false, reason: 'maxBorrowAmount must be positive' };
        }
        if (maxCollateralAmount !== null && maxCollateralAmount <= 0) {
            return { allow: false, reason: 'maxCollateralAmount must be positive' };
        }
        if (minCr !== null && maxCr !== null && minCr > maxCr) {
            return { allow: false, reason: 'minCollateralRatio cannot exceed maxCollateralRatio' };
        }
        return { allow: true, reason: null };
    }

    _validateCreditPolicy(policy, offer, deal = null) {
        if (!policy || typeof policy !== 'object') return { allow: false, reason: 'creditOffer policy missing' };
        const allowedOfferIds = this._normalizePolicyList(policy.allowedOfferIds);
        const allowedDebtAssets = this._normalizePolicyList(policy.allowedDebtAssets);
        const allowedCollateralAssets = this._normalizePolicyList(policy.allowedCollateralAssets);
        const maxFeeRate = positiveOrNull(policy.maxFeeRate);
        const maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);

        if (maxFeeRate === null) {
            return { allow: false, reason: 'creditOffer maxFeeRate is required' };
        }
        if (maxCollateralRatio === null) {
            return { allow: false, reason: 'creditOffer maxCollateralRatio is required' };
        }

        if (allowedOfferIds.length > 0 && offer?.id && !allowedOfferIds.includes(String(offer.id))) {
            return { allow: false, reason: `offer ${offer.id} is not allowed` };
        }
        if (allowedDebtAssets.length > 0 && offer?.asset_type && !allowedDebtAssets.includes(String(offer.asset_type))) {
            return { allow: false, reason: `debt asset ${offer.asset_type} is not allowed` };
        }

        if (deal) {
            if (allowedOfferIds.length > 0 && deal.offerId && !allowedOfferIds.includes(String(deal.offerId))) {
                return { allow: false, reason: `deal offer ${deal.offerId} is not allowed` };
            }
            if (allowedDebtAssets.length > 0 && deal.debtAssetId && !allowedDebtAssets.includes(String(deal.debtAssetId))) {
                return { allow: false, reason: `deal debt asset ${deal.debtAssetId} is not allowed` };
            }
            if (allowedCollateralAssets.length > 0 && deal.collateralAssetId && !allowedCollateralAssets.includes(String(deal.collateralAssetId))) {
                return { allow: false, reason: `deal collateral asset ${deal.collateralAssetId} is not allowed` };
            }
            if (maxFeeRate !== null && deal.feeRate > maxFeeRate) {
                return { allow: false, reason: `deal fee rate ${deal.feeRate} exceeds maxFeeRate ${maxFeeRate}` };
            }
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

        const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, null);
        const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, null);
        if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }
        return (collateralAmountFloat * quoteAmount) / baseAmount;
    }

    async _fetchBorrowerDeals() {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return [];
        }

        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const deals = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        return Array.isArray(deals) ? deals.map(parseDealSummary).filter(Boolean) : [];
    }

    async refreshMpaState() {
        await this.loadState();
        const policy = this.debtPolicy?.mpa;
        if (!policy) {
            return null;
        }

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return null;
        }

        const account = await this._getFullAccount(accountRef);
        const callOrders = parseCallOrders(account);
        if (callOrders.length === 0) {
            this.state.activeCallOrderId = null;
            this.state.mpaSelectionConflict = null;
            this.state.debtAssetId = null;
            this.state.currentDebtAmount = 0;
            this.state.currentCollateralAmount = 0;
            this.state.currentCollateralRatio = null;
            this.state.feedPrice = null;
            return this.state;
        }

        const allowedDebtAssets = this._normalizePolicyList(policy.allowedDebtAssets);
        let candidateOrders = callOrders;
        if (allowedDebtAssets.length > 0) {
            candidateOrders = callOrders.filter((entry) => allowedDebtAssets.includes(String(entry?.call_price?.quote?.asset_id)));
        }
        if (candidateOrders.length === 0) {
            const reason = allowedDebtAssets.length > 0
                ? `no MPA position matches allowedDebtAssets for ${this.botKey}`
                : `no MPA position found for ${this.botKey}`;
            this.state.activeCallOrderId = null;
            this.state.mpaSelectionConflict = reason;
            this.state.debtAssetId = null;
            this.state.currentDebtAmount = 0;
            this.state.currentCollateralAmount = 0;
            this.state.currentCollateralRatio = null;
            this.state.feedPrice = null;
            this.state.targetCollateralRatio = resolveTargetCollateralRatio(policy);
            this.state.minCollateralRatio = positiveOrNull(policy.minCollateralRatio);
            this.state.maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);
            return this.state;
        }
        if (candidateOrders.length > 1) {
            const reason = `multiple matching MPA positions found for ${this.botKey}`;
            this.warn(`credit runtime: ${reason}; refusing to select one automatically`);
            this.state.activeCallOrderId = null;
            this.state.mpaSelectionConflict = reason;
            this.state.debtAssetId = null;
            this.state.currentDebtAmount = 0;
            this.state.currentCollateralAmount = 0;
            this.state.currentCollateralRatio = null;
            this.state.feedPrice = null;
            this.state.targetCollateralRatio = resolveTargetCollateralRatio(policy);
            this.state.minCollateralRatio = positiveOrNull(policy.minCollateralRatio);
            this.state.maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);
            return this.state;
        }
        const callOrder = candidateOrders[0] || null;

        const debtAssetId = callOrder?.call_price?.quote?.asset_id || null;
        const collateralAssetId = callOrder?.call_price?.base?.asset_id || null;
        const debtAsset = debtAssetId ? await this._resolveAsset(debtAssetId) : null;
        const collateralAsset = collateralAssetId ? await this._resolveAsset(collateralAssetId) : null;
        const bitassetData = debtAssetId ? await this._resolveBitassetData(debtAssetId) : null;

        const debtAmount = blockchainAmountToFloat(callOrder?.debt, debtAsset) || 0;
        const collateralAmount = blockchainAmountToFloat(callOrder?.collateral, collateralAsset) || 0;
        const feedPrice = this._computeBtsPerDebt(bitassetData?.current_feed?.settlement_price, debtAsset, collateralAsset);
        const currentCollateralRatio = debtAmount > 0 && feedPrice > 0
            ? collateralAmount / (debtAmount * feedPrice)
            : null;
        const targetCollateralRatio = resolveTargetCollateralRatio(policy);
        const minCollateralRatio = positiveOrNull(policy.minCollateralRatio);
        const maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);

        this.state.activeCallOrderId = callOrder.id || null;
        this.state.debtAssetId = debtAssetId;
        this.state.currentDebtAmount = debtAmount;
        this.state.currentCollateralAmount = collateralAmount;
        this.state.currentCollateralRatio = currentCollateralRatio;
        this.state.feedPrice = feedPrice;
        this.state.targetCollateralRatio = targetCollateralRatio;
        this.state.minCollateralRatio = minCollateralRatio;
        this.state.maxCollateralRatio = maxCollateralRatio;
        this.state.mpaSelectionConflict = null;
        this.state.lastMpaAction = this.state.lastMpaAction || null;

        return this.state;
    }

    async refreshCreditState(options = {}) {
        await this.loadState();
        const policy = this.debtPolicy?.creditOffer;
        if (!policy) {
            return null;
        }

        const normalizedDeals = Array.isArray(options.deals)
            ? options.deals.map(parseDealSummary).filter(Boolean)
            : await this._fetchBorrowerDeals();
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

        const activeDeals = [];
        for (const deal of normalizedDeals) {
            const offer = deal.offerId ? trackedOffers.get(String(deal.offerId)) : null;
            const validation = this._validateCreditPolicy(policy, offer, deal);
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

        this.state.activeDealIds = activeDeals.map((deal) => deal.id).filter(Boolean);
        this.state.activeOfferIds = Array.from(new Set(activeDeals.map((deal) => deal.offerId).filter(Boolean)));
        this.state.creditDeals = activeDeals;
        this.state.lastBorrowRequest = this.state.lastBorrowRequest || null;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        return this.state;
    }

    async refreshState() {
        await this.loadState();
        await this.refreshMpaState();
        await this.refreshCreditState();
        return this.persistState('refresh');
    }

    _buildMpaPlanFromState() {
        const policy = this.debtPolicy?.mpa;
        if (!policy) return null;
        if (this.state.mpaSelectionConflict) {
            return { blocked: true, reason: this.state.mpaSelectionConflict };
        }
        const plan = buildDebtFirstCrPlan({
            currentCollateralAmount: this.state.currentCollateralAmount,
            currentDebtAmount: this.state.currentDebtAmount,
            feedPrice: this.state.feedPrice,
            minCollateralRatio: policy.minCollateralRatio,
            maxCollateralRatio: policy.maxCollateralRatio,
            targetCollateralRatio: policy.targetCollateralRatio,
            maxBorrowAmount: policy.maxBorrowAmount,
            maxCollateralAmount: policy.maxCollateralAmount,
        });

        if (!plan) return null;
        if (plan.blocked) return plan;
        return plan;
    }

    async buildMpaUpdateOperation(plan, options = {}) {
        const policy = this.debtPolicy?.mpa;
        if (!policy || !plan) return null;
        if (plan.blocked) {
            throw new Error(plan.reason || 'MPA plan blocked');
        }

        const leg = options.leg || 'debt';

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for MPA update');
        }

        const debtAsset = this.state.debtAssetId ? await this._resolveAsset(this.state.debtAssetId) : null;
        const account = await this._getFullAccount(getAccountRef(this.bot));
        const currentCallOrder = parseCallOrders(account).find((entry) => entry.id === this.state.activeCallOrderId) || null;
        const collateralAssetId = currentCallOrder?.call_price?.base?.asset_id || null;
        const collateralAsset = collateralAssetId ? await this._resolveAsset(collateralAssetId) : null;

        if (!debtAsset || !collateralAsset) {
            throw new Error('Unable to resolve MPA asset metadata');
        }

        const debtDelta = leg === 'collateral' ? 0 : plan.debtDelta;
        const collateralDelta = leg === 'debt' ? 0 : plan.collateralDelta;
        const debtInt = floatToBlockchainInt(debtDelta, debtAsset.precision);
        const collateralInt = floatToBlockchainInt(collateralDelta, collateralAsset.precision);
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
                delta_collateral: toAmountObject(collateralInt, collateralAsset.id),
                delta_debt: toAmountObject(debtInt, debtAsset.id),
                extensions,
            }
        };
    }

    async buildCreditOfferAcceptOperation({ offer, borrowAmount, collateralAmount, autoRepay = false }) {
        const policy = this.debtPolicy?.creditOffer;
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
            requiredCollateralInt = collateralSpec?.amount !== null && collateralSpec?.amount !== undefined
                ? await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'free' })
                : minimumCollateralInt;
            if (Number.isFinite(minimumCollateralInt) && Number.isFinite(requiredCollateralInt) && requiredCollateralInt < minimumCollateralInt) {
                throw new Error(`collateral amount ${requiredCollateralInt} is below required collateral ${minimumCollateralInt}`);
            }
        } else {
            requiredCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'free' });
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

        const minDealAmount = toFiniteNumber(offerObj?.min_deal_amount, null);
        if (minDealAmount !== null && borrowInt < minDealAmount) {
            throw new Error(`borrowAmount ${borrowInt} is below min_deal_amount ${minDealAmount}`);
        }

        const maxFeeRateValue = positiveOrNull(policy.maxFeeRate);
        if (maxFeeRateValue === null) {
            throw new Error('creditOffer maxFeeRate is required');
        }
        const offerFeeRate = toFiniteNumber(offerObj?.fee_rate, 0) || 0;
        if (offerFeeRate > maxFeeRateValue) {
            throw new Error(`offer fee rate ${offerFeeRate} exceeds maxFeeRate ${maxFeeRateValue}`);
        }

        if (offerObj?.enabled === false) {
            throw new Error(`credit offer ${offerId} is disabled`);
        }

        const minDurationSeconds = positiveOrNull(policy.minDurationSeconds);
        const minDuration = minDurationSeconds !== null ? minDurationSeconds : 0;
        const maxCollateralAssets = this._normalizePolicyList(policy.allowedCollateralAssets);
        if (maxCollateralAssets.length > 0 && collateralAsset?.id && !maxCollateralAssets.includes(String(collateralAsset.id))) {
            throw new Error(`collateral asset ${collateralAsset.id} is not allowed`);
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

        const op = {
            op_name: 'credit_offer_accept',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                borrower: accountId,
                offer_id: offerId,
                borrow_amount: toAmountObject(borrowInt, debtAsset.id),
                collateral: toAmountObject(requiredCollateralInt, collateralAsset.id),
                max_fee_rate: maxFeeRateValue,
                min_duration_seconds: minDuration,
                extensions: autoRepay ? { auto_repay: true } : {}
            }
        };

        this.state.lastBorrowRequest = {
            offerId: String(offerId),
            borrowAmount: borrowInt,
            collateralAmount: requiredCollateralInt,
            autoReborrow: !!this.debtPolicy?.creditOffer?.autoReborrow,
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
        const policy = this.debtPolicy?.creditOffer;
        if (!policy) {
            throw new Error('creditOffer policy missing');
        }

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
                auto_repay: !!autoRepay,
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
        await this.refreshCreditState();
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
        const shouldAutoReborrow = options.autoReborrow !== false && !!this.debtPolicy?.creditOffer?.autoReborrow;
        let deferredReborrowRequest = null;
        let inlineReborrowPlanned = false;

        if (shouldAutoReborrow) {
            const reborrowAmount = options.reborrowAmount !== undefined && options.reborrowAmount !== null
                ? options.reborrowAmount
                : repayAmount;
            const reborrowCollateralAmount = options.collateralAmount !== undefined
                ? options.collateralAmount
                : null;
            const offer = await this._getOfferById(dealSummary.offerId);
            if (offer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: false,
                    });
                    operations.push(acceptOp);
                    inlineReborrowPlanned = true;
                } catch (err) {
                    deferredReborrowRequest = {
                        sourceDealId: dealSummary.id,
                        offerId: dealSummary.offerId,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
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
                    requestedAt: new Date().toISOString(),
                    reason: 'offer unavailable',
                };
            }
        }

        const result = await this.executeOperations(operations, 'credit repay');
        this.state.lastRepayAt = new Date().toISOString();
        const onChainDeals = await this._fetchBorrowerDeals();
        const sourceDealStillActive = onChainDeals.some((entry) => String(entry?.id) === String(dealSummary.id));
        if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && !sourceDealStillActive) {
            this.queueReborrow(deferredReborrowRequest);
        }
        await this.refreshCreditState({ deals: onChainDeals });
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
        if (!this.debtPolicy?.creditOffer?.autoReborrow) {
            return { processed: 0, remaining: Array.isArray(this.state.pendingReborrows) ? this.state.pendingReborrows.length : 0, skipped: true };
        }
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
            if (request.sourceDealId && activeDealIds.has(String(request.sourceDealId))) {
                nextQueue.push({ ...request, reason: 'source deal still active on-chain' });
                continue;
            }

            const offer = await this._getOfferById(request.offerId);
            if (!offer || offer.enabled === false) {
                nextQueue.push(request);
                continue;
            }

            try {
                const acceptOp = await this.buildCreditOfferAcceptOperation({
                    offer,
                    borrowAmount: request.borrowAmount ?? null,
                    collateralAmount: request.collateralAmount || null,
                    autoRepay: false,
                });
                await this.executeOperations([acceptOp], 'credit reborrow');
                processed++;
            } catch (err) {
                nextQueue.push({ ...request, reason: err.message });
            }
        }

        this.state.pendingReborrows = nextQueue;
        this.state.reborrowPending = nextQueue.length > 0;
        await this.refreshCreditState();
        await this.persistState('pending reborrows');

        return { processed, remaining: nextQueue.length };
    }

    async runMaintenance(context = 'periodic', options = {}) {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }

        await this.loadState();
        await this.refreshState();

        const results = {
            context,
            mpa: null,
            credit: null,
        };

        if (this.debtPolicy?.mpa) {
            const plan = this._buildMpaPlanFromState();
            if (plan?.blocked) {
                results.mpa = { blocked: true, reason: plan.reason };
            } else if (plan) {
                const executed = [];
                let result = null;

                const debtOp = await this.buildMpaUpdateOperation(plan, { leg: 'debt' });
                if (debtOp) {
                    result = await this.executeOperations([debtOp], `mpa maintenance:${context} debt`);
                    executed.push({ leg: 'debt', operation: debtOp, result });
                    await this.refreshMpaState();
                }

                const fallbackPlan = this._buildMpaPlanFromState();
                if (fallbackPlan && !fallbackPlan.blocked) {
                    const collateralOp = await this.buildMpaUpdateOperation(fallbackPlan, { leg: 'collateral' });
                    if (collateralOp) {
                        result = await this.executeOperations([collateralOp], `mpa maintenance:${context} collateral`);
                        executed.push({ leg: 'collateral', operation: collateralOp, result });
                        await this.refreshMpaState();
                    }
                }

                if (executed.length > 0) {
                    this.state.lastMpaAction = {
                        context,
                        plan,
                        executedAt: new Date().toISOString(),
                        executed,
                    };
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
                            results.mpa = { plan, executed, resetResult };
                        } catch (err) {
                            results.mpa = { plan, executed, resetError: err.message };
                            this.warn(`credit runtime: grid reset after CR adjustment failed: ${err.message}`);
                        }
                    } else {
                        results.mpa = { plan, executed };
                    }
                }
            }
        }

        if (this.debtPolicy?.creditOffer) {
            const pending = await this.processPendingReborrows();
            results.credit = pending;
        }

        await this.persistState(context);
        return results;
    }

    getStateSnapshot() {
        return deepClone(this.state);
    }
}

module.exports = CreditRuntime;
