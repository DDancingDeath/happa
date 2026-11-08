// @ts-check
/**
 * @fileoverview Reminders on Today (#86), read-cheap: who to collect udhaar
 * from / pay (Outstanding's "chase first": dues older than 30 days, from the
 * open bills already on the phone) and rent still due (the totals Rentals last
 * showed on this phone this month, kept in localStorage). No reads.
 * Lease reminders (agreement ending, rent increase due) are kept the same way (REM-4).
 * Specs: docs/calculations.md REM-1, REM-2, REM-4.
 * @module utils/reminders
 */

import { buildAging, chaseFirst } from './aging.js';
import { AppState } from './state.js';
import { round2 } from './money.js';
import { toLocalISODate, formatMonth } from './dates.js';
import { emit, REMINDERS_CHANGED } from './events.js';
import { t, getLang } from '../i18n/index.js';
import { formatINR } from './due-reminder.js';

/** Parties listed per reminder; the rest are counted. */
export const REMINDER_LIMIT = 3;
const RENT_KEY = 'happa.rentDueSummary';
const LEASE_KEY = 'happa.rentLeaseNotes';
const BELL_SEEN_KEY = 'happa.rentBellSeen';
/** Lease reminders kept for Today (the rest are counted). */
export const LEASE_REMINDER_LIMIT = 20;

/**
 * REM-1: parties with an OVERDUE bill (oldest open due older than 30 days; Outstanding's
 * chase-first order: oldest bucket, then the biggest amount), top `limit`. `total` is
 * all those parties' dues, `overdue` the part on overdue bills (OD-08).
 * @param {Array<Rec>} bills open bills of one side (receivables or payables)
 * @param {{today?: Date, limit?: number}} [opts]
 * @returns {{parties: Array<{key: string, name: string, phone: string, total: number, overdue: number, oldestDays: ?number}>, more: number, total: number, overdue: number}}
 */
export function overdueReminder(bills, { today = new Date(), limit = REMINDER_LIMIT } = {}) {
    const all = chaseFirst(buildAging(bills, { today }).parties, Infinity);
    let total = 0;
    let overdue = 0;
    all.forEach(p => { total += p.total; overdue += p.overdue; });
    return {
        parties: all.slice(0, limit).map(p => ({ key: p.key, name: p.name, phone: p.phone, total: p.total, overdue: p.overdue, oldestDays: p.oldestDays })),
        more: Math.max(0, all.length - limit),
        total: round2(total),
        overdue: round2(overdue)
    };
}

/**
 * Rentals keeps what its Rent page last showed for this month (RENT-9 totals).
 * @param {Storage} store
 * @param {{uid: string, month: string, due: number, late: number, dueUnits: number, at?: number}} s
 */
export function saveRentReminder(store, { uid, month, due, late, dueUnits, at = Date.now() }) {
    try {
        store.setItem(RENT_KEY, JSON.stringify({ uid, month, due: Number(due) || 0, late: Number(late) || 0, dueUnits: Number(dueUnits) || 0, at }));
    } catch (_) { /* storage full: Today just shows no rent line */ }
    emit(REMINDERS_CHANGED);
}

/**
 * REM-2: the rent reminder for this person and month, or null (not shown when
 * Rentals wasn't opened this month on this phone, or nothing is due).
 * @param {Storage} store
 * @param {string} uid
 * @param {string} month 'YYYY-MM'
 * @returns {?{due: number, late: number, dueUnits: number, at: number}}
 */
export function rentReminder(store, uid, month) {
    try {
        const s = JSON.parse(store.getItem(RENT_KEY) || 'null');
        if (!s || s.uid !== uid || s.month !== month || !(s.due > 0)) return null;
        return { due: s.due, late: s.late, dueUnits: s.dueUnits, at: s.at };
    } catch (_) {
        return null;
    }
}

/**
 * Units of RENT-10 rows that owe anything (REM-2 "units").
 * @param {?Array<Rec>} rows
 * @returns {number}
 */
export function unitsWithDue(rows) {
    return (rows || []).filter(r => r && r.due > 0).length;
}

/**
 * Called by the Rent page on every render: keeps REM-2 for Today when it shows
 * the current month with complete data (no load error, nothing truncated).
 * @param {{month: string, errors?: Set<*>}} state Rentals page state
 * @param {Array<Rec>} rows RENT-10 rows
 * @param {Array<string>} [truncated] rent-store keys cut at their limit
 */
export function noteRent(state, rows, truncated = []) {
    try {
        if (state.errors?.size || truncated.length || state.month !== toLocalISODate(new Date()).slice(0, 7)) return;
        let due = 0;
        let late = 0;
        rows.forEach(r => { due += Number(r.due) || 0; if (r.late) late++; });
        saveRentReminder(localStorage, { uid: /** @type {Rec} */ (AppState).currentUser?.uid, month: state.month, due: round2(due), late, dueUnits: unitsWithDue(rows) });
    } catch (_) { /* never break the Rent page */ }
}

/**
 * Rentals keeps its lease reminders for Today (REM-4, worked out by rent-math-report.leaseReminders
 * when the Rent page shows this month with complete data).
 * @param {Storage} store
 * @param {{uid: string, month: string, items: Array<Rec>, at?: number}} s
 */
export function saveLeaseReminders(store, { uid, month, items, at = Date.now() }) {
    const list = (items || []).slice(0, LEASE_REMINDER_LIMIT).map(x => ({
        kind: x.kind === 'increase' ? 'increase' : 'ending', place: String(x.place || ''), tenant: String(x.tenant || ''),
        end: x.end || '', left: Number(x.left) || 0, notice: x.notice || '', newRent: Number(x.newRent) || 0, pct: Number(x.pct) || 0
    }));
    try {
        store.setItem(LEASE_KEY, JSON.stringify({ uid, month, items: list, more: Math.max(0, (items || []).length - list.length), at }));
    } catch (_) { /* storage full: Today just shows no lease lines */ }
    emit(REMINDERS_CHANGED);
}

/**
 * REM-4: this person's lease reminders for this month, or null (Rentals not opened this
 * month on this phone, or nothing to remind).
 * @param {Storage} store
 * @param {string} uid
 * @param {string} month
 * @returns {?{items: Array<Rec>, more: number, at: number}}
 */
export function leaseReminder(store, uid, month) {
    try {
        const s = JSON.parse(store.getItem(LEASE_KEY) || 'null');
        if (!s || s.uid !== uid || s.month !== month || !Array.isArray(s.items) || !s.items.length) return null;
        return { items: s.items, more: Number(s.more) || 0, at: s.at };
    } catch (_) {
        return null;
    }
}
/** @param {Rec} x @returns {string} */
export function leaseReminderText(x) {
    const mon = (/** @type {string} */ m) => formatMonth(`${m}-01`, { lang: getLang() });
    if (x.kind === 'increase') return t('ui.today.lease_increase', { pct: x.pct, amount: formatINR(x.newRent) });
    return t(x.left < 0 ? 'ui.today.lease_ended' : x.left === 0 ? 'ui.today.lease_ends_now' : 'ui.today.lease_ends', { month: mon(x.end) })
        + (x.notice ? ` · ${t('ui.today.lease_notice', { month: mon(x.notice) })}` : '');
}

/**
 * The rent key changes with due → late, so the badge returns once rent is late.
 * @param {Storage} store @param {string} uid @param {string} month
 * @returns {{items: Array<Rec>, more: number}}
 */
export function rentBellItems(store, uid, month) {
    const items = [];
    const rent = rentReminder(store, uid, month);
    if (rent) items.push({ key: `rent:${month}:${rent.late > 0 ? 'late' : 'due'}`, kind: 'rent', rent, at: rent.at });
    const leases = leaseReminder(store, uid, month);
    const at = leases?.at;
    (leases?.items || []).forEach(x => items.push({
        key: `lease:${month}:${x.kind}:${x.place}:${x.tenant}:${x.end}:${x.newRent}`, kind: 'lease', lease: x, at
    }));
    return { items, more: leases?.more || 0 };
}

/** @param {Storage} store @param {string} uid @returns {Set<string>} */
export function bellSeen(store, uid) {
    try {
        const s = JSON.parse(store.getItem(`${BELL_SEEN_KEY}.${uid}`) || 'null');
        return new Set(s && s.uid === uid && Array.isArray(s.keys) ? s.keys : []);
    } catch (_) {
        return new Set();
    }
}

/** @param {Storage} store @param {string} uid @param {Array<string>} keys */
export function markBellSeen(store, uid, keys) {
    try {
        const all = [...new Set([...keys, ...bellSeen(store, uid)])].slice(0, 3 * LEASE_REMINDER_LIMIT);
        store.setItem(`${BELL_SEEN_KEY}.${uid}`, JSON.stringify({ uid, keys: all }));
    } catch (_) { /* storage full: the badge just shows them again */ }
}
