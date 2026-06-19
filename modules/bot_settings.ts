const { getStorage } = require('./storage');
const storage = getStorage();
const { readBotsFileSync } = require('./bots_file_lock');
const { parseJsonWithComments } = require('./order/utils/system');
const { createHash } = require('./crypto/sync');
const { createBotKey } = require('./account_orders');
const { isPositiveNumber, isPositiveNumberOrPercent, toDecimal } = require('./order/utils/math');
const { resolveMinCollateralIncreaseThreshold } = require('./cr_planner');
const { writeJSON } = require('./utils/fs_utils');

function loadSettingsFile(filePath: string, { silent = false, exitOnError = true }: { silent?: boolean; exitOnError?: boolean } = {}): { config: any; filePath: string } {
    if (!storage.exists(filePath)) {
        if (!silent) {
            console.error(`${filePath} not found. Run: dexbot bots`);
        }
        return { config: {}, filePath };
    }

    try {
        const { config } = readBotsFileSync(filePath, parseJsonWithComments);
        return { config, filePath };
    } catch (err: any) {
        console.error('Failed to parse bot settings from', filePath);
        console.error('Error:', err.message);
        console.error('Please check the JSON syntax in profiles/bots.json and try again.');
        if (exitOnError) {
            throw err;
        }
        throw err;
    }
}

function saveSettingsFile(config: any, filePath: string): void {
    try {
        writeJSON(filePath, config);
    } catch (err: any) {
        console.error('Failed to save bot settings to', filePath, '-', err.message);
        throw err;
    }
}

function resolveRawBotEntries(settings: any): any[] {
    if (!settings || typeof settings !== 'object') return [];
    if (Array.isArray(settings.bots)) return settings.bots;
    if (Object.keys(settings).length > 0) return [settings];
    return [];
}

function _stableBotId(entry: any): string {
    const stable = {
        name: entry.name || '',
        preferredAccount: entry.preferredAccount || '',
        assetA: entry.assetA || entry.assetAId || '',
        assetB: entry.assetB || entry.assetBId || '',
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 8);
}

function normalizeBotEntry(entry: any, index: number = 0): any {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    if (!normalized.id) {
        normalized.id = _stableBotId(normalized);
    }
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
}

function normalizeBotEntries(rawEntries: any[]): any[] {
    return rawEntries.map((entry: any, index: number) => normalizeBotEntry(entry, index));
}

function selectBotEntry(settings: any, botName: string): any {
    const entries = resolveRawBotEntries(settings);
    if (!botName) return null;
    return entries.find((b: any) => b && b.name === botName) || null;
}

function selectActiveBotEntries(settings: any): any[] {
    return resolveRawBotEntries(settings).filter((entry: any) => entry && entry.active !== false);
}

/**
 * Persist auto-generated `id` fields back to the config object and save it.
 * Must be called with the live config object (not a file path) to avoid
 * TOCTOU races. Returns true if any ids were added (config was saved).
 *
 * @param {Object} config - The full bots.json config object ({bots: [...]})
 * @param {any[]} normalized - Normalized bot entries with generated ids
 * @param {string} configPath - Path to write the config to
 */
function persistMissingIds(config: any, normalized: any[], configPath: string): boolean {
    const botsArray = resolveRawBotEntries(config);
    let changed = false;
    for (let i = 0; i < normalized.length; i++) {
        if (i < botsArray.length && normalized[i].id && !botsArray[i].id) {
            botsArray[i].id = normalized[i].id;
            changed = true;
        }
    }
    if (changed) {
        saveSettingsFile(config, configPath);
    }
    return changed;
}

function validateBotEntry(b: any, i: number, src: string): string | null {
    const problems = [];
    const required = ['assetA', 'assetB', 'activeOrders', 'botFunds'];
    for (const k of required) {
        if (!(k in b)) problems.push(`missing '${k}'`);
    }

    if ('activeOrders' in b) {
        if (typeof b.activeOrders !== 'object' || b.activeOrders === null) problems.push("'activeOrders' must be an object");
        else {
            if (!('buy' in b.activeOrders)) problems.push("activeOrders missing 'buy'");
            if (!('sell' in b.activeOrders)) problems.push("activeOrders missing 'sell'");
        }
    }

    if ('botFunds' in b) {
        if (typeof b.botFunds !== 'object' || b.botFunds === null) problems.push("'botFunds' must be an object");
        else {
            if (!('buy' in b.botFunds)) problems.push("botFunds missing 'buy'");
            if (!('sell' in b.botFunds)) problems.push("botFunds missing 'sell'");
        }
    }

    if ('debtPolicy' in b) {
        if (typeof b.debtPolicy !== 'object' || b.debtPolicy === null) {
            problems.push("'debtPolicy' must be an object");
        } else {
            const dp = b.debtPolicy;

            if (!Array.isArray(dp.lending) || dp.lending.length === 0) {
                problems.push("debtPolicy.lending must be a non-empty array");
            } else {
                dp.lending.forEach((item: any, idx: number) => {
                    if (typeof item !== 'object' || item === null) {
                        problems.push(`debtPolicy.lending[${idx}] must be an object`);
                        return;
                    }
                    if (!item.collateralAsset || typeof item.collateralAsset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].collateralAsset must be a non-empty string`);
                    }
                    if (!item.asset || typeof item.asset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].asset must be a non-empty string`);
                    }
                    if (!['mpa', 'creditOffer'].includes(item.type)) {
                        problems.push(`debtPolicy.lending[${idx}].type must be 'mpa' or 'creditOffer'`);
                    }

                    // ratio: optional, non-negative number, defaults to 1
                    if (item.ratio !== undefined) {
                        if (!Number.isFinite(item.ratio) || item.ratio < 0) {
                            problems.push(`debtPolicy.lending[${idx}].ratio must be a non-negative number`);
                        }
                    }

                    // maxBorrowAmount: optional, must be a fixed positive number (no percentage)
                    if ('maxBorrowAmount' in item) {
                        if (!isPositiveNumber(item.maxBorrowAmount)) {
                            problems.push(`debtPolicy.lending[${idx}].maxBorrowAmount must be a positive number (fixed amount, not percentage)`);
                        }
                    }

                    // maxCollateralAmount: optional, positive number or percentage
                    if ('maxCollateralAmount' in item && !isPositiveNumberOrPercent(item.maxCollateralAmount)) {
                        problems.push(`debtPolicy.lending[${idx}].maxCollateralAmount must be a positive number or percentage`);
                    }

                    if ('minCollateralIncreaseThreshold' in item) {
                        const referenceAmount = typeof item.minCollateralIncreaseThreshold === 'string' && item.minCollateralIncreaseThreshold.trim().endsWith('%')
                            ? 1
                            : null;
                        if (resolveMinCollateralIncreaseThreshold(item.minCollateralIncreaseThreshold, referenceAmount) === null) {
                            problems.push(`debtPolicy.lending[${idx}].minCollateralIncreaseThreshold must be a non-negative number or percentage`);
                        }
                    }

                    if (item.type === 'mpa') {
                        // MPA-specific validation (maxCollateralRatio is optional for MPA)
                        if ('targetCollateralRatio' in item) {
                            const tcr = Number(item.targetCollateralRatio);
                            if (!Number.isFinite(tcr) || tcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].targetCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            if (!Number.isFinite(mcr) || mcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxCollateralRatio' in item) {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item && 'maxCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            const mxcr = Number(item.maxCollateralRatio);
                            if (Number.isFinite(mcr) && Number.isFinite(mxcr) && mcr > mxcr) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio (${mcr}) cannot exceed maxCollateralRatio (${mxcr})`);
                            }
                        }
                        if ('debtOnly' in item && typeof item.debtOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].debtOnly must be a boolean`);
                        }
                    } else if (item.type === 'creditOffer') {
                        // Credit offer-specific validation (maxCollateralRatio is required)
                        if (!('maxCollateralRatio' in item)) {
                            problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio is required for creditOffer`);
                        } else {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxFeeRatePerDay' in item) {
                            const fr = Number(item.maxFeeRatePerDay);
                            if (!Number.isFinite(fr) || fr < 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxFeeRatePerDay must be a non-negative number`);
                            }
                        }
                        if ('autoRepay' in item) {
                            const ar = Number(item.autoRepay);
                            if (![0, 1, 2].includes(ar)) {
                                problems.push(`debtPolicy.lending[${idx}].autoRepay must be 0, 1, or 2`);
                            }
                        }
                        if ('renewOnly' in item && typeof item.renewOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].renewOnly must be a boolean`);
                        }
                        if ('allowedOfferIds' in item) {
                            if (!Array.isArray(item.allowedOfferIds)) {
                                problems.push(`debtPolicy.lending[${idx}].allowedOfferIds must be an array`);
                            }
                        }
                    }
                });
            }

            // Global maxCollateralAmount: optional, caps total collateral across all lending items
            if ('maxCollateralAmount' in dp && !isPositiveNumberOrPercent(dp.maxCollateralAmount)) {
                problems.push("debtPolicy.maxCollateralAmount must be a positive number or percentage");
            }
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries: any[], sourceName: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    entries.forEach((entry: any, index: number) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
    });

    // Cross-bot validation: check if botFunds percentages sum > 100% per account
    const accountFunds: Record<string, { buy: number; sell: number; botNames: string[] }> = {};
    for (const entry of entries) {
        if (!entry.active || !entry.preferredAccount || !entry.botFunds) continue;
        if (!accountFunds[entry.preferredAccount]) {
            accountFunds[entry.preferredAccount] = { buy: 0, sell: 0, botNames: [] };
        }
        const acc = accountFunds[entry.preferredAccount];
        acc.buy += toDecimal(entry.botFunds.buy);
        acc.sell += toDecimal(entry.botFunds.sell);
        acc.botNames.push(entry.name || entry.botKey || `bot-${entries.indexOf(entry)}`);
    }
    for (const [account, funds] of Object.entries(accountFunds)) {
        if (funds.botNames.length > 1) {
            if (funds.buy > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.buy * 100).toFixed(0)}% of BUY funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
            if (funds.sell > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.sell * 100).toFixed(0)}% of SELL funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
        }
    }

    return { errors, warnings };
}

export = {
    collectValidationIssues,
    loadSettingsFile,
    normalizeBotEntry,
    normalizeBotEntries,
    persistMissingIds,
    resolveRawBotEntries,
    saveSettingsFile,
    selectActiveBotEntries,
    selectBotEntry,
    validateBotEntry
};
