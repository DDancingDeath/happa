/**
 * @fileoverview Phone storage full (#153): spots QuotaExceededError from
 * localStorage, IndexedDB and Firestore's offline cache (which wraps it in an
 * 'unavailable' error), so a refused write says "Save failed — storage full"
 * instead of "Saved". Not the Firestore daily read/write limit (quota-guard.js).
 * @module utils/storage-full
 */

import { t } from '../i18n/index.js';

export const STORAGE_FULL_KEY = 'msg.sync.storage_full';
/** Shown instead of "Saved" for a bill stored on this phone while offline. */
export const SAVED_ON_PHONE_KEY = 'msg.sync.saved_on_phone';
/** Shown when a save could not be confirmed even on this phone: it may still arrive. */
export const SAVE_UNCONFIRMED_KEY = 'msg.sync.save_unconfirmed';
export const EXPENSE_UNCONFIRMED_KEY = 'msg.sync.expense_unconfirmed';

const FULL_TEXT = /QuotaExceededError|NS_ERROR_DOM_QUOTA_REACHED|quota has been exceeded|exceeded the quota/i;

/**
 * @param {*} err
 * @returns {boolean} true when the device refused a write for lack of space
 */
export function isStorageFullError(err) {
    if (!err) return false;
    if (typeof err === 'string') return FULL_TEXT.test(err);
    if (typeof err !== 'object') return false;
    if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    if (err.code === 22 || err.code === 1014) return true;
    const text = `${err.message || ''} ${typeof err.toString === 'function' ? err.toString() : ''}`;
    if (FULL_TEXT.test(text)) return true;
    return !!err.cause && err.cause !== err && isStorageFullError(err.cause);
}

/**
 * Toast text for a failed save: the storage-full message when that is the cause.
 * @param {*} err
 * @param {string} fallback - Text shown for any other failure
 * @returns {string}
 */
export function saveFailedText(err, fallback) {
    return isStorageFullError(err) ? t(STORAGE_FULL_KEY) : fallback;
}

/**
 * localStorage.setItem that reports instead of throwing.
 * @param {string} key
 * @param {string} value
 * @param {Storage} [store]
 * @returns {{ok: boolean, full: boolean}}
 */
export function safeSetItem(key, value, store) {
    try {
        (store || localStorage).setItem(key, value);
        return { ok: true, full: false };
    } catch (err) {
        console.warn(`Storing ${key} failed:`, err);
        return { ok: false, full: isStorageFullError(err) };
    }
}
