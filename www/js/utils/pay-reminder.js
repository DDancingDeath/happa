// @ts-check
/**
 * @fileoverview Salaries due on Today (#373, WP-11, owner only): what the Workers page last worked
 * out (or the owner's once-a-day refresh), kept on this phone for that owner, a few months ahead.
 * No reads here; the refresh is in modules/workers.js (refreshPayDue), started from main.js.
 * @module utils/pay-reminder
 */

import { emit, REMINDERS_CHANGED } from './events.js';
import { toLocalISODate } from './dates.js';

const KEY = 'happa.payDue';

/**
 * @param {Storage} store
 * @param {{uid: string, months: Record<string, {count: number, due: number}>, at?: number}} s
 */
export function savePayDue(store, { uid, months, at = Date.now() }) {
    try {
        store.setItem(KEY, JSON.stringify({ uid, months, at }));
    } catch (_) { /* storage full: Today just shows no salaries line */ }
    emit(REMINDERS_CHANGED);
}

/**
 * WP-11 for this owner and month, or null (not kept on this phone, or nothing due).
 * @param {Storage} store
 * @param {string} uid
 * @param {string} month 'YYYY-MM'
 * @returns {?{count: number, due: number, at: number}}
 */
export function payDueReminder(store, uid, month) {
    try {
        const s = JSON.parse(store.getItem(KEY) || 'null');
        const m = s && s.uid === uid && s.months ? s.months[month] : null;
        if (!m || !(Number(m.due) > 0) || !(Number(m.count) > 0)) return null;
        return { count: Number(m.count), due: Number(m.due), at: Number(s.at) || 0 };
    } catch (_) {
        return null;
    }
}

/**
 * True when this phone keeps salaries for this owner but not from today: the owner's phone then
 * reads the workers once (after the first screen). Never kept here (Workers not opened on this
 * phone) = false: no reads.
 * @param {Storage} store
 * @param {string} uid
 * @param {Date} [now]
 */
export function payDueStale(store, uid, now = new Date()) {
    try {
        const s = JSON.parse(store.getItem(KEY) || 'null');
        if (!s || s.uid !== uid) return false;
        return !s.at || toLocalISODate(new Date(s.at)) !== toLocalISODate(now);
    } catch (_) {
        return false;
    }
}
