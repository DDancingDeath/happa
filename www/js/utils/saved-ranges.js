// @ts-check
/**
 * @fileoverview Saved period ranges (#140): period A and, optionally, the
 * period B it is compared with, per person. The list lives on the person's own
 * profile (`users/{uid}.savedRanges`, a short text the rules check), which the
 * app already reads at sign-in, so it costs no extra read; this phone keeps a
 * copy per person (localStorage). Relative presets stay relative: a saved
 * "This month vs Last year" is this month whenever it is opened.
 * @module utils/saved-ranges
 */

import { isPeriodPreset } from './insights-context.js';
import { safeSetItem } from './storage-full.js';

export const SAVED_RANGES_KEY = 'happa.savedRanges';
/** Most ranges kept; saving one more drops the oldest. */
export const MAX_SAVED_RANGES = 10;

const idOf = (/** @type {string} */ a, /** @type {?string|undefined} */ b) => `${a}|${b || ''}`;

/**
 * @param {?Storage} store
 * @returns {Array<{id: string, a: string, b: ?string}>} newest first, invalid entries dropped
 */
export function readSavedRanges(store) {
    try {
        const raw = JSON.parse(store?.getItem(SAVED_RANGES_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw.filter(x => x && isPeriodPreset(x.a) && (x.b === null || x.b === undefined || isPeriodPreset(x.b)))
            .map(x => ({ id: idOf(x.a, x.b), a: x.a, b: x.b || null }))
            .filter((x, i, all) => all.findIndex(y => y.id === x.id) === i)
            .slice(0, MAX_SAVED_RANGES);
    } catch (_) {
        return [];
    }
}

/**
 * @param {?Storage} store
 * @param {Array<{a: string, b: ?string}>} list
 * @returns {{ok: boolean, full: boolean}}
 */
function write(store, list) {
    return safeSetItem(SAVED_RANGES_KEY, JSON.stringify(list.map(({ a, b }) => ({ a, b }))), store);
}

/**
 * Replaces this phone's copy (e.g. with the list merged on the profile).
 * @param {?Storage} store
 * @param {Array<{a: string, b: ?string}>} list
 */
export function writeSavedRanges(store, list) {
    return write(store, list);
}

/**
 * A list with A (and B) first; the same pair moves to the top; at most 10 (pure).
 * @param {Array<{id: string, a: string, b: ?string}>} list
 * @param {string} a
 * @param {?string} [b]
 * @returns {Array<{id: string, a: string, b: ?string}>}
 */
export function withSavedRange(list, a, b = null) {
    if (!isPeriodPreset(a) || (b !== null && !isPeriodPreset(b))) return list;
    const id = idOf(a, b);
    return [{ id, a, b }, ...list.filter(x => x.id !== id)].slice(0, MAX_SAVED_RANGES);
}

/**
 * Saves A (and B) first in the list; the same pair saved again moves to the top.
 * @param {?Storage} store
 * @param {string} a
 * @param {?string} [b]
 * @returns {{ok: boolean, full?: boolean, list: Array<{id: string, a: string, b: ?string}>}} ok false: invalid preset or storage full
 */
export function addSavedRange(store, a, b = null) {
    if (!isPeriodPreset(a) || (b !== null && !isPeriodPreset(b))) return { ok: false, list: readSavedRanges(store) };
    const list = withSavedRange(readSavedRanges(store), a, b);
    const res = write(store, list);
    return { ok: res.ok, full: res.full, list: res.ok ? list : readSavedRanges(store) };
}

/**
 * @param {?Storage} store
 * @param {string} id
 * @returns {Array<{id: string, a: string, b: ?string}>} the list without `id`
 */
export function removeSavedRange(store, id) {
    const list = readSavedRanges(store).filter(x => x.id !== id);
    write(store, list);
    return list;
}

/** Id of a saved pair. */
export const savedRangeId = idOf;

/**
 * This phone's copy of one person's list: a Storage whose keys carry the uid,
 * so two people signing in on one phone keep their own lists.
 * @param {?Storage} store
 * @param {string} uid
 * @returns {?Storage}
 */
export function userRangesStore(store, uid) {
    if (!store || !uid) return store;
    const k = (/** @type {string} */ key) => `${key}:${uid}`;
    return /** @type {Storage} */ (/** @type {unknown} */ ({
        getItem: (/** @type {string} */ key) => store.getItem(k(key)),
        setItem: (/** @type {string} */ key, /** @type {string} */ value) => store.setItem(k(key), value),
        removeItem: (/** @type {string} */ key) => store.removeItem(k(key))
    }));
}

/**
 * The list as kept on the profile: "a|b;a|b", newest first ('' = none).
 * @param {Array<{a: string, b: ?string}>} list
 * @returns {string}
 */
export function encodeSavedRanges(list) {
    return (list || []).slice(0, MAX_SAVED_RANGES).map(x => idOf(x.a, x.b)).join(';');
}

/**
 * @param {*} text the profile's savedRanges
 * @returns {Array<{id: string, a: string, b: ?string}>} invalid entries dropped
 */
export function decodeSavedRanges(text) {
    if (typeof text !== 'string' || !text) return [];
    const raw = text.split(';').map(s => s.split('|')).map(([a, b]) => ({ a, b: b || null }));
    const mem = new Map([[SAVED_RANGES_KEY, JSON.stringify(raw)]]);
    return readSavedRanges(/** @type {Storage} */ (/** @type {unknown} */ ({ getItem: (/** @type {string} */ k) => mem.get(k) ?? null })));
}

/**
 * At sign-in: the profile's list wins (another phone may have changed it). A person with
 * none on the profile yet keeps this phone's list (their own copy, or the one saved before
 * lists followed the person, which then goes to them only) and it is sent up once.
 * @param {?Storage} store this phone's storage
 * @param {string} uid
 * @param {*} profileValue `users/{uid}.savedRanges` (undefined when never saved)
 * @returns {?string} text to save on the profile, or null when nothing needs saving
 */
export function syncSavedRangesOnSignIn(store, uid, profileValue) {
    const mine = userRangesStore(store, uid);
    if (typeof profileValue === 'string') {
        write(mine, decodeSavedRanges(profileValue));
        return null;
    }
    const own = readSavedRanges(mine);
    const legacy = readSavedRanges(store);
    try { if (legacy.length) store?.removeItem(SAVED_RANGES_KEY); } catch (_) { /* storage blocked */ }
    const list = own.length ? own : legacy;
    if (!list.length) return null;
    if (!own.length) write(mine, list);
    return encodeSavedRanges(list);
}
