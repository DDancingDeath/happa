/**
 * @fileoverview Saved period ranges (#140): period A and, optionally, the
 * period B it is compared with, kept on this phone only (localStorage, no
 * reads or writes to the database). Relative presets stay relative: a saved
 * "This month vs Last year" is this month whenever it is opened.
 * @module utils/saved-ranges
 */

import { isPeriodPreset } from './insights-context.js';
import { safeSetItem } from './storage-full.js';

export const SAVED_RANGES_KEY = 'happa.savedRanges';
/** Most ranges kept; saving one more drops the oldest. */
export const MAX_SAVED_RANGES = 10;

const idOf = (a, b) => `${a}|${b || ''}`;

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

function write(store, list) {
    return safeSetItem(SAVED_RANGES_KEY, JSON.stringify(list.map(({ a, b }) => ({ a, b }))), store);
}

/**
 * Saves A (and B) first in the list; the same pair saved again moves to the top.
 * @returns {{ok: boolean, full?: boolean, list: Array<{id: string, a: string, b: ?string}>}} ok false: invalid preset or storage full
 */
export function addSavedRange(store, a, b = null) {
    if (!isPeriodPreset(a) || (b !== null && !isPeriodPreset(b))) return { ok: false, list: readSavedRanges(store) };
    const id = idOf(a, b);
    const list = [{ id, a, b }, ...readSavedRanges(store).filter(x => x.id !== id)].slice(0, MAX_SAVED_RANGES);
    const res = write(store, list);
    return { ok: res.ok, full: res.full, list: res.ok ? list : readSavedRanges(store) };
}

/** @returns {Array<{id: string, a: string, b: ?string}>} the list without `id` */
export function removeSavedRange(store, id) {
    const list = readSavedRanges(store).filter(x => x.id !== id);
    write(store, list);
    return list;
}

/** Id of a saved pair. */
export const savedRangeId = idOf;
