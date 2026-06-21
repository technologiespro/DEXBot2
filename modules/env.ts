'use strict';

declare const globalThis: any;
declare const process: any;

/**
 * Environment detection — single source of truth for Node-vs-browser.
 *
 * The codebase has both Node-only code paths (CLI launchers, Unix sockets,
 * child_process) and browser-compatible paths (crypto, storage, ecc). The
 * `isBrowser()` / `hasProcess()` pair is the canonical check; prefer these
 * over inline `typeof window` / `typeof process` ternaries.
 */
export function isBrowser(): boolean {
    return typeof globalThis !== 'undefined'
        && typeof globalThis.window !== 'undefined'
        && typeof globalThis.window.document !== 'undefined';
}

export function hasProcess(): boolean {
    return typeof process !== 'undefined'
        && typeof process.execPath === 'string';
}

/**
 * getNodeRequire — bundler-evasion helper.
 *
 * Returns the Node.js `require` function when running in Node, or `null` when
 * bundled for the browser.
 *
 * Why a function (not a top-level `const _require = ...`):
 *   Bundlers like esbuild constant-fold `typeof x !== 'undefined'` checks at
 *   bundle time, so `const _require = typeof require !== 'undefined' ? require : undefined`
 *   would be replaced with `const _require = require` — defeating the evasion.
 *   Wrapping the check in a function body defers evaluation to runtime, so the
 *   bundler never sees the `require` reference inside the function.
 *
 * Hoisting the result to module scope (`const _require = getNodeRequire()`)
 * works in current esbuild because it does not inline module-scope function
 * calls during static analysis, so the resulting `_require` reference stays
 * opaque. For maximum robustness against future bundler behaviour, prefer
 * calling `getNodeRequire()` inside the function body that needs it.
 */
let _nodeRequire: any;
export function getNodeRequire(): any {
    if (_nodeRequire === undefined) {
        try {
            if (typeof require !== 'undefined') _nodeRequire = require;
            else _nodeRequire = null;
        } catch {
            _nodeRequire = null;
        }
    }
    return _nodeRequire;
}
