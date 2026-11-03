// @ts-check
/**
 * @fileoverview Skip re-computing a screen whose inputs have not changed (#24).
 * Finance/Reports/Analytics re-ran every aggregate on each tab visit; with
 * years of history that is noticeable. A memo records the input signature of
 * the last completed render; the tab-show path re-renders only when it differs.
 * @module utils/render-memo
 */

import { AppState } from './state.js';

const DATA_KEYS = [
    'items', 'purchaseHistory', 'retailSalesHistory', 'salesHistory',
    'expensesHistory', 'stockAdjustments', 'withdrawalsHistory', 'stock'
];

const ids = new WeakMap();
let nextId = 1;
const idOf = (/** @type {*} */ value) => {
    if (!value || typeof value !== 'object') return 0;
    if (!ids.has(value)) ids.set(value, nextId++);
    return ids.get(value);
};

/**
 * Cheap signature of everything these screens read: listeners publish a new
 * array on every change (identity), local edits change length, and the clock
 * hour covers "today"/"last 7 days" windows moving on.
 * @param {Date} [now]
 * @returns {string}
 */
export function dataSignature(now = new Date()) {
    const parts = DATA_KEYS.map((key) => {
        const value = /** @type {Rec} */ (AppState)[key];
        return `${idOf(value)}:${Array.isArray(value) ? value.length : ''}`;
    });
    parts.push(/** @type {Rec} */ (AppState).dataVersion ?? '', /** @type {Rec} */ (AppState).historyLoadedFrom,
        /** @type {Rec} */ (AppState).stockReady, /** @type {Rec} */ (AppState).userRole,
        `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`);
    return parts.join('|');
}

/**
 * @returns {{isCurrent: (extra?: *) => boolean, record: (extra?: *) => void, reset: () => void}}
 *   `extra` = the screen's own filter state (JSON-serialisable).
 */
export function createRenderMemo() {
    /** @type {?string} */
    let last = null;
    const key = (/** @type {*} */ extra) => `${dataSignature()}#${JSON.stringify(extra ?? null)}`;
    return {
        isCurrent: (extra) => last !== null && last === key(extra),
        record: (extra) => { last = key(extra); },
        reset: () => { last = null; }
    };
}
