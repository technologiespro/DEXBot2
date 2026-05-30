const fs = require('fs');
const { readBotsFileSync } = require('./bots_file_lock');
const { parseJsonWithComments } = require('./order/utils/system');
const { createBotKey } = require('./account_orders');
const { isPositiveNumber, isPositiveNumberOrPercent } = require('./order/utils/math');
const { resolveMinCollateralIncreaseThreshold } = require('./cr_planner');

function loadSettingsFile(filePath: string, { silent = false, exitOnError = true }: { silent?: boolean; exitOnError?: boolean } = {}): { config: any; filePath: string } {
    if (!fs.existsSync(filePath)) {
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
            process.exit(1);
        }
        throw err;
    }
}

function saveSettingsFile(config: any, filePath: string): void {
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
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

function normalizeBotEntry(entry: any, index: number = 0): any {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
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
                            if (Number(item.minCollateralRatio) > Number(item.maxCollateralRatio)) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio cannot exceed maxCollateralRatio`);
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
    return { errors, warnings };
}

export = {
    collectValidationIssues,
    loadSettingsFile,
    normalizeBotEntry,
    normalizeBotEntries,
    resolveRawBotEntries,
    saveSettingsFile,
    selectActiveBotEntries,
    selectBotEntry,
    validateBotEntry
};
