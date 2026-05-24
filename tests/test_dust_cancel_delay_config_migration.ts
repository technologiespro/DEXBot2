const assert = require('assert');
const Module = require('module');

const constantsModulePath = require.resolve('../modules/constants');
const originalModuleLoad = Module._load;

function loadConstantsWithSettings(mockSettings) {
    delete require.cache[constantsModulePath];

    Module._load = function(request, parent, isMain) {
        if (request === './general_settings' && parent?.filename === constantsModulePath) {
            return {
                readGeneralSettings: () => mockSettings
            };
        }
        return originalModuleLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../modules/constants');
    } finally {
        Module._load = originalModuleLoad;
        delete require.cache[constantsModulePath];
    }
}

function testTopLevelLegacyMinutesMigration() {
    const constants = loadConstantsWithSettings({
        GRID_LIMITS: {
            DUST_CANCEL_DELAY_MIN: 5
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        300,
        'Top-level legacy DUST_CANCEL_DELAY_MIN should migrate to seconds'
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(constants.GRID_LIMITS, 'DUST_CANCEL_DELAY_MIN'),
        false,
        'Top-level legacy DUST_CANCEL_DELAY_MIN should not survive the merge'
    );
}

function testExpertLegacyMinutesMigration() {
    const constants = loadConstantsWithSettings({
        EXPERT: {
            GRID_LIMITS: {
                DUST_CANCEL_DELAY_MIN: 7
            }
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        420,
        'Expert legacy DUST_CANCEL_DELAY_MIN should migrate to seconds'
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(constants.GRID_LIMITS, 'DUST_CANCEL_DELAY_MIN'),
        false,
        'Expert legacy DUST_CANCEL_DELAY_MIN should not survive the merge'
    );
}

function testExplicitSecondsOverrideWins() {
    const constants = loadConstantsWithSettings({
        EXPERT: {
            GRID_LIMITS: {
                DUST_CANCEL_DELAY_MIN: 7,
                DUST_CANCEL_DELAY_SEC: 45
            }
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        45,
        'Explicit DUST_CANCEL_DELAY_SEC should win over legacy minute migration'
    );
}

try {
    testTopLevelLegacyMinutesMigration();
    testExpertLegacyMinutesMigration();
    testExplicitSecondsOverrideWins();
    console.log('Dust cancel delay config migration tests passed');
} catch (err) {
    console.error('Dust cancel delay config migration tests failed');
    console.error(err);
    process.exit(1);
}
