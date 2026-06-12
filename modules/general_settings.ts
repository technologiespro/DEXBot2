/**
 * modules/general_settings.ts - General Application Settings
 * 
 * Centralized management for application-wide settings stored in profiles/general.settings.json.
 * Provides read/write operations with fallback handling.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonFileAtomic } = require('./bots_file_lock');

// Resolve profiles directory correctly whether running from source (modules/)
// or compiled output (dist/modules/)
// NOTE: Uses hardcoded 'dist' intentionally — this module is loaded by
// constants.ts (circular dep), so it cannot import BUILD_DIR from there.
const PARENT_DIR = path.dirname(__dirname);
const ROOT = path.basename(PARENT_DIR) === 'dist' ? path.dirname(PARENT_DIR) : PARENT_DIR;
const PROFILES_DIR = path.join(ROOT, 'profiles');
const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');

/**
 * Read general application settings from file.
 * Returns fallback if file missing, empty, or parse fails.
 * 
 * @param {Object} [options={}] - Read options
 * @param {*} [options.fallback=null] - Fallback value if file missing or invalid
 * @param {Function} [options.onError=null] - Optional error callback (err, filePath)
 * @returns {Object|*} Parsed settings object or fallback value
 */
function readGeneralSettings({ fallback = null, onError = null }: { fallback?: any; onError?: ((err: Error, filePath: string) => void) | null } = {}): any {
    if (!fs.existsSync(SETTINGS_FILE)) return fallback;

    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (err: any) {
        if (typeof onError === 'function') onError(err, SETTINGS_FILE);
        return fallback;
    }
}

/**
 * Write general application settings to file.
 * Creates profiles directory if it doesn't exist.
 * Formats output as pretty-printed JSON.
 * 
 * @param {Object} settings - Settings object to write
 * @throws {Error} If write operation fails
 */
function writeGeneralSettings(settings: any): void {
    // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A plain
    // writeFileSync could leave a truncated file on crash and break the
    // next process that reads general.settings.json.
    writeJsonFileAtomic(SETTINGS_FILE, settings);
}

export = {
    PROFILES_DIR,
    SETTINGS_FILE,
    readGeneralSettings,
    writeGeneralSettings,
};
