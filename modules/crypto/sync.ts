'use strict';

/**
 * Node-only sync crypto operations.
 *
 * WARNING: These are Node.js only. Browser code must use getCrypto() async API.
 * This module exists solely to centralize `require('crypto')` into one place so
 * that the 12+ files that previously imported it directly now import from here.
 */

const _crypto = require('crypto');

export const createHash = _crypto.createHash.bind(_crypto);
export const createHmac = _crypto.createHmac.bind(_crypto);
export const randomBytes = _crypto.randomBytes.bind(_crypto);
export const randomFill = _crypto.randomFill.bind(_crypto);
export const timingSafeEqual = _crypto.timingSafeEqual.bind(_crypto);
export const hkdfSync = _crypto.hkdfSync.bind(_crypto);
export const scryptSync = _crypto.scryptSync.bind(_crypto);
export const createCipheriv = _crypto.createCipheriv.bind(_crypto);
export const createDecipheriv = _crypto.createDecipheriv.bind(_crypto);
export const createECDH = _crypto.createECDH.bind(_crypto);
export const scrypt = _crypto.scrypt.bind(_crypto);
