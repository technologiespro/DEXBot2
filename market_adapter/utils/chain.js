'use strict';

function getBitsharesClient() {
    // lazy require to avoid circular dependencies at module load time
    return require('../../modules/bitshares_client');
}

async function resolveAsset(symbol, bitsharesClient = null) {
    if (!symbol || typeof symbol !== 'string') {
        throw new Error(`Cannot resolve asset: invalid or missing symbol "${symbol}"`);
    }
    const { BitShares } = bitsharesClient || getBitsharesClient();
    const results = await BitShares.db.lookup_asset_symbols([symbol]);
    const asset = results?.[0];
    if (!asset?.id || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset "${symbol}": lookup failed`);
    }
    return { id: asset.id, precision: asset.precision, symbol };
}

async function findPoolByAssets(assetAId, assetBId, options = {}) {
    const { BitShares } = options.bitsharesClient || getBitsharesClient();
    const sortBy = options.sortBy || 'totalBalance'; // 'totalBalance' or 'assetABalance'

    if (typeof BitShares.db?.get_liquidity_pool_by_asset_ids === 'function') {
        try {
            const pool = await BitShares.db.get_liquidity_pool_by_asset_ids(assetAId, assetBId);
            if (pool?.id) return pool;
        } catch (_) {}
    }

    if (typeof BitShares.db?.get_liquidity_pools_by_assets === 'function') {
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_assets(assetAId, assetBId, 10, false);
            if (Array.isArray(pools) && pools.length > 0) {
                if (sortBy === 'assetABalance') {
                    const idAStr = String(assetAId);
                    return pools.sort((a, b) => {
                        const bal = (p) => {
                            const assetA = String(p.asset_a ?? p.asset_ids?.[0] ?? '');
                            const assetB = String(p.asset_b ?? p.asset_ids?.[1] ?? '');
                            const value = assetA === idAStr
                                ? Number(p.balance_a)
                                : assetB === idAStr
                                    ? Number(p.balance_b)
                                    : Number.NEGATIVE_INFINITY;
                            return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
                        };
                        return bal(b) - bal(a);
                    })[0];
                }
                return pools.sort((x, y) => {
                    const bal = (p) => Number(p.balance_a ?? 0) + Number(p.balance_b ?? 0);
                    return bal(y) - bal(x);
                })[0];
            }
        } catch (_) {}
    }

    const listFn = BitShares.db?.list_liquidity_pools ?? BitShares.db?.get_liquidity_pools;
    if (typeof listFn === 'function') {
        let startId = '1.19.0';
        const page = 100;
        const a = String(assetAId);
        const b = String(assetBId);

        while (true) {
            const pools = await listFn(page, startId);
            if (!Array.isArray(pools) || pools.length === 0) break;

            const effective = startId === '1.19.0' ? pools : pools.slice(1);
            const matches = effective.filter((p) => {
                const ids = (p.asset_ids ?? [p.asset_a, p.asset_b]).map(String);
                return ids.includes(a) && ids.includes(b);
            });
            if (matches.length > 0) {
                if (sortBy === 'assetABalance') {
                    const idAStr = String(assetAId);
                    return matches.sort((a, b) => {
                        const bal = (p) => {
                            const assetA = String(p.asset_a ?? p.asset_ids?.[0] ?? '');
                            const assetB = String(p.asset_b ?? p.asset_ids?.[1] ?? '');
                            const value = assetA === idAStr
                                ? Number(p.balance_a)
                                : assetB === idAStr
                                    ? Number(p.balance_b)
                                    : Number.NEGATIVE_INFINITY;
                            return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
                        };
                        return bal(b) - bal(a);
                    })[0];
                }
                return matches.sort((x, y) => {
                    const bal = (p) => Number(p.balance_a ?? 0) + Number(p.balance_b ?? 0);
                    return bal(y) - bal(x);
                })[0];
            }

            if (pools.length < page) break;
            startId = pools[pools.length - 1].id;
        }
    }

    throw new Error(`No liquidity pool found for ${assetAId}/${assetBId}`);
}

function normalizeMarketSource(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'pool') return 'pool';
    if (value === 'book' || value === 'orderbook' || value === 'market') return 'book';
    return null;
}

function hasNumericStartPrice(raw) {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

function normalizePoolId(id) {
    if (id == null) return null;
    const s = String(id).trim();
    return s.startsWith('1.19.') ? s : `1.19.${s}`;
}

async function resolveBotContext(bot) {
    if (!bot.assetAId && !bot.assetA) {
        throw new Error(`Bot "${bot.botKey}" config is missing assetA symbol or ID`);
    }
    if (!bot.assetBId && !bot.assetB) {
        throw new Error(`Bot "${bot.botKey}" config is missing assetB symbol or ID`);
    }

    const assetA = bot.assetAId && Number.isFinite(bot.assetAPrecision)
        ? { id: bot.assetAId, precision: bot.assetAPrecision, symbol: bot.assetA }
        : await resolveAsset(bot.assetA);

    const assetB = bot.assetBId && Number.isFinite(bot.assetBPrecision)
        ? { id: bot.assetBId, precision: bot.assetBPrecision, symbol: bot.assetB }
        : await resolveAsset(bot.assetB);

    if (hasNumericStartPrice(bot.startPrice)) {
        return {
            assetA,
            assetB,
            poolId: null,
            marketSource: null,
            priceMode: 'fixed',
        };
    }

    // The market adapter source comes from startPrice only. gridPrice/other
    // settings are intentionally ignored here.
    const marketSource = normalizeMarketSource(bot.startPrice) || 'pool';

    let poolId = null;
    if (marketSource === 'pool') {
        poolId = bot.poolId
            ? normalizePoolId(bot.poolId)
            : normalizePoolId((await findPoolByAssets(assetA.id, assetB.id)).id);
    }

    return { assetA, assetB, poolId, marketSource, priceMode: 'market' };
}

module.exports = {
    resolveAsset,
    findPoolByAssets,
    normalizeMarketSource,
    hasNumericStartPrice,
    resolveBotContext,
};
