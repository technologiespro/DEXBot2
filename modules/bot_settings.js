const fs = require('fs');
const { readBotsFileSync } = require('./bots_file_lock');
const { parseJsonWithComments } = require('./order/utils/system');
const { createBotKey } = require('./account_orders');

function loadSettingsFile(filePath, { silent = false, exitOnError = true } = {}) {
    if (!fs.existsSync(filePath)) {
        if (!silent) {
            console.error(`${filePath} not found. Run: dexbot bots`);
        }
        return { config: {}, filePath };
    }

    try {
        const { config } = readBotsFileSync(filePath, parseJsonWithComments);
        return { config, filePath };
    } catch (err) {
        console.error('Failed to parse bot settings from', filePath);
        console.error('Error:', err.message);
        console.error('Please check the JSON syntax in profiles/bots.json and try again.');
        if (exitOnError) {
            process.exit(1);
        }
        throw err;
    }
}

function saveSettingsFile(config, filePath) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', err.message);
        throw err;
    }
}

function resolveRawBotEntries(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (Array.isArray(settings.bots)) return settings.bots;
    if (Object.keys(settings).length > 0) return [settings];
    return [];
}

function normalizeBotEntry(entry, index = 0) {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
}

function normalizeBotEntries(rawEntries) {
    return rawEntries.map((entry, index) => normalizeBotEntry(entry, index));
}

function selectBotEntry(settings, botName) {
    const entries = resolveRawBotEntries(settings);
    if (!botName) return null;
    return entries.find((b) => b && b.name === botName) || null;
}

function selectActiveBotEntries(settings) {
    return resolveRawBotEntries(settings).filter((entry) => entry && entry.active !== false);
}

function validateBotEntry(b, i, src) {
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
            if ('mpa' in b.debtPolicy && (typeof b.debtPolicy.mpa !== 'object' || b.debtPolicy.mpa === null)) {
                problems.push("debtPolicy.mpa must be an object");
            }
            if ('creditOffer' in b.debtPolicy && (typeof b.debtPolicy.creditOffer !== 'object' || b.debtPolicy.creditOffer === null)) {
                problems.push("debtPolicy.creditOffer must be an object");
            } else if ('creditOffer' in b.debtPolicy) {
                const creditOffer = b.debtPolicy.creditOffer;
                if ('maxFeeRatePerDay' in creditOffer) {
                    const feeRatePerDay = Number(creditOffer.maxFeeRatePerDay);
                    if (!Number.isFinite(feeRatePerDay) || feeRatePerDay < 0) {
                        problems.push("debtPolicy.creditOffer.maxFeeRatePerDay must be a non-negative number");
                    }
                }
                if (!('maxCollateralRatio' in creditOffer)) {
                    problems.push("debtPolicy.creditOffer.maxCollateralRatio is required");
                } else {
                    const maxCollateralRatio = Number(creditOffer.maxCollateralRatio);
                    if (!Number.isFinite(maxCollateralRatio) || maxCollateralRatio <= 0) {
                        problems.push("debtPolicy.creditOffer.maxCollateralRatio must be a positive number");
                    }
                }
                if ('autoRepay' in creditOffer) {
                    const autoRepay = Number(creditOffer.autoRepay);
                    if (![0, 1, 2].includes(autoRepay)) {
                        problems.push("debtPolicy.creditOffer.autoRepay must be 0, 1, or 2");
                    }
                }
            }
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries, sourceName) {
    const errors = [];
    const warnings = [];
    entries.forEach((entry, index) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
    });
    return { errors, warnings };
}

module.exports = {
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
