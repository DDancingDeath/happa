/**
 * @fileoverview Writes that must not silently overwrite another phone's change (#113):
 * item, settings and user writes need the internet, and an item or settings section
 * saved over a newer version from another phone is refused. Codes the data layer
 * throws and the message each shows.
 * @module utils/write-conflict
 */

export const NEEDS_INTERNET = 'needs-internet';
export const CHANGED_ELSEWHERE = 'changed-elsewhere';

/** @returns {Error} code NEEDS_INTERNET */
export function needsInternetError() {
    return Object.assign(new Error('This change needs the internet'), { code: NEEDS_INTERNET });
}

/**
 * @param {string} what what changed (for the log)
 * @returns {Error} code CHANGED_ELSEWHERE
 */
export function changedElsewhereError(what) {
    return Object.assign(new Error(`${what} was changed on another phone`), { code: CHANGED_ELSEWHERE });
}

/** The phone says it is offline (navigator.onLine === false). */
export function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Message key for a refused write: offline, changed on another phone, else the fallback.
 * @param {*} error
 * @param {string} fallbackKey
 * @returns {string} i18n key
 */
export function writeErrorKey(error, fallbackKey) {
    if (error?.code === NEEDS_INTERNET) return 'msg.sync.needs_internet_write';
    if (error?.code === CHANGED_ELSEWHERE) return 'msg.sync.changed_elsewhere';
    return fallbackKey;
}
