'use strict';

const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.resolve(__dirname, '..', '..', 'profiles');
const ORDERS_DIR = path.join(PROFILES_DIR, 'orders');
const WHITELIST_FILE = path.join(PROFILES_DIR, 'dynamic_weight_whitelist.json');

function readOptionalFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { exists: false, content: null };
    }
    return {
        exists: true,
        content: fs.readFileSync(filePath, 'utf8'),
    };
}

function restoreOptionalFile(filePath, original) {
    if (original.exists) {
        fs.writeFileSync(filePath, original.content, 'utf8');
        return;
    }
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function withDynamicWeightFiles(botKey) {
    const snapshotFile = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    const originalWhitelist = readOptionalFile(WHITELIST_FILE);
    const originalSnapshot = readOptionalFile(snapshotFile);

    fs.mkdirSync(ORDERS_DIR, { recursive: true });
    fs.writeFileSync(
        WHITELIST_FILE,
        JSON.stringify({ whitelist: [botKey] }, null, 2),
        'utf8'
    );

    return {
        writeSnapshot({ isReady, effectiveWeights, centerPrice = 100 }) {
            fs.writeFileSync(
                snapshotFile,
                JSON.stringify({
                    centerPrice,
                    updatedAt: '2026-04-22T00:00:00.000Z',
                    dynamicWeights: {
                        isReady,
                        trend: 'NEUTRAL',
                        confidence: 0,
                        effectiveWeights,
                    },
                }, null, 2),
                'utf8'
            );
        },
        cleanup() {
            restoreOptionalFile(snapshotFile, originalSnapshot);
            restoreOptionalFile(WHITELIST_FILE, originalWhitelist);
        },
    };
}

module.exports = {
    withDynamicWeightFiles,
};
