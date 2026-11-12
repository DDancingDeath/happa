// @ts-check
/**
 * @fileoverview Owner reminders on Today that a lazy page works out (no reads here): salaries due
 * (#373, WP-11; Workers / Salaries) and bills due (#437, RB-11; Recurring bills). Each page keeps its
 * figure on this phone for that owner when it loads or saves; the owner's phone refreshes a figure
 * kept from an earlier day once per session (main.js; refreshPayDue in modules/workers.js,
 * refreshBillsDue in modules/recurring-bills.js).
 * @module utils/pay-reminder
 */

import { emit, REMINDERS_CHANGED } from './events.js';
import { toLocalISODate } from './dates.js';

const PAY_KEY = 'happa.payDue';
const BILLS_KEY = 'happa.billsDue';

/** @param {Storage} store @param {string} key @param {Record<string, *>} record */
function keep(store, key, record) {
    try {
        store.setItem(key, JSON.stringify(record));
    } catch (_) { /* storage full: Today just shows no line */ }
    emit(REMINDERS_CHANGED);
}

/** The record kept for this owner, or null. @param {Storage} store @param {string} key @param {string} uid */
function kept(store, key, uid) {
    try {
        const s = JSON.parse(store.getItem(key) || 'null');
        return s && s.uid === uid ? s : null;
    } catch (_) {
        return null;
    }
}

/**
 * Kept for this owner but not from today (never kept = false: no reads).
 * @param {Storage} store @param {string} key @param {string} uid @param {Date} [now]
 */
function stale(store, key, uid, now = new Date()) {
    const s = kept(store, key, uid);
    if (!s) return false;
    return !s.at || toLocalISODate(new Date(s.at)) !== toLocalISODate(now);
}

/**
 * @param {Storage} store
 * @param {{uid: string, months: Record<string, {count: number, due: number}>, at?: number}} s
 */
export function savePayDue(store, { uid, months, at = Date.now() }) {
    keep(store, PAY_KEY, { uid, months, at });
}

/**
 * WP-11 for this owner and month, or null (not kept on this phone, or nothing due).
 * @param {Storage} store
 * @param {string} uid
 * @param {string} month 'YYYY-MM'
 * @returns {?{count: number, due: number, at: number}}
 */
export function payDueReminder(store, uid, month) {
    const s = kept(store, PAY_KEY, uid);
    const m = s && s.months ? s.months[month] : null;
    if (!m || !(Number(m.due) > 0) || !(Number(m.count) > 0)) return null;
    return { count: Number(m.count), due: Number(m.due), at: Number(s.at) || 0 };
}

/**
 * True when this phone keeps salaries for this owner but not from today: the owner's phone then
 * reads the workers once (after the first screen). Never kept here (Workers not opened on this
 * phone) = false: no reads.
 * @param {Storage} store
 * @param {string} uid
 * @param {Date} [now]
 */
export const payDueStale = (store, uid, now = new Date()) => stale(store, PAY_KEY, uid, now);

/**
 * @param {Storage} store
 * @param {{uid: string, days: Record<string, {count: number, due: number, nobill: number}>, at?: number}} s
 */
export function saveBillsDue(store, { uid, days, at = Date.now() }) {
    keep(store, BILLS_KEY, { uid, days, at });
}

/**
 * RB-11 for this owner and day, or null (not kept on this phone, or nothing due).
 * @param {Storage} store
 * @param {string} uid
 * @param {string} day 'YYYY-MM-DD'
 * @returns {?{count: number, due: number, nobill: number, at: number}}
 */
export function billsDueReminder(store, uid, day) {
    const s = kept(store, BILLS_KEY, uid);
    const d = s && s.days ? s.days[day] : null;
    if (!d || !(Number(d.count) > 0)) return null;
    return { count: Number(d.count), due: Math.max(0, Number(d.due) || 0), nobill: Math.max(0, Number(d.nobill) || 0), at: Number(s.at) || 0 };
}

/** As payDueStale, for the bills (Recurring bills not opened on this phone = false: no reads). @param {Storage} store @param {string} uid @param {Date} [now] */
export const billsDueStale = (store, uid, now = new Date()) => stale(store, BILLS_KEY, uid, now);
