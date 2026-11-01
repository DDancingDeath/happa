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
import { toLocalISODate } from './dates.js';

/** Parties listed per reminder; the rest are counted. */
export const REMINDER_LIMIT = 3;
const RENT_KEY = 'happa.rentDueSummary';
const LEASE_KEY = 'happa.rentLeaseNotes';
/** Lease reminders kept for Today (the rest are counted). */
export const LEASE_REMINDER_LIMIT = 20;

/**
 * REM-1: parties whose oldest open due is older than 30 days (Outstanding's
 * chase-first order: oldest bucket, then the biggest amount), top `limit`.
 * @param {Array<Object>} bills open bills of one side (receivables or payables)
 * @param {{today?: Date, limit?: number}} [opts]
 * @returns {{parties: Array<{key: string, name: string, phone: string, total: number, oldestDays: ?number}>, more: number, total: number}}
 */
export function overdueReminder(bills, { today = new Date(), limit = REMINDER_LIMIT } = {}) {
    const all = chaseFirst(buildAging(bills, { today }).parties, Infinity);
    let total = 0;
    all.forEach(p => { total += p.total; });
    return {
        parties: all.slice(0, limit).map(p => ({ key: p.key, name: p.name, phone: p.phone, total: p.total, oldestDays: p.oldestDays })),
        more: Math.max(0, all.length - limit),
        total: Math.round(total * 100) / 100
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

/** Units of RENT-10 rows that owe anything (REM-2 "units"). */
export function unitsWithDue(rows) {
    return (rows || []).filter(r => r && r.due > 0).length;
}

/**
 * Called by the Rent page on every render: keeps REM-2 for Today when it shows
 * the current month with complete data (no load error, nothing truncated).
 * @param {{month: string, errors: Set}} state Rentals page state
 * @param {Array<Object>} rows RENT-10 rows
 * @param {Array<string>} [truncated] rent-store keys cut at their limit
 */
export function noteRent(state, rows, truncated = []) {
    try {
        if (state.errors?.size || truncated.length || state.month !== toLocalISODate(new Date()).slice(0, 7)) return;
        let due = 0;
        let late = 0;
        rows.forEach(r => { due += Number(r.due) || 0; if (r.late) late++; });
        saveRentReminder(localStorage, { uid: AppState.currentUser?.uid, month: state.month, due: round2(due), late, dueUnits: unitsWithDue(rows) });
    } catch (_) { /* never break the Rent page */ }
}

/**
 * Rentals keeps its lease reminders for Today (REM-4, worked out by rent-math-report.leaseReminders
 * when the Rent page shows this month with complete data).
 * @param {Storage} store
 * @param {{uid: string, month: string, items: Array<Object>, at?: number}} s
 */
export function saveLeaseReminders(store, { uid, month, items, at = Date.now() }) {
    const list = (items || []).slice(0, LEASE_REMINDER_LIMIT).map(x => ({
        kind: x.kind === 'increase' ? 'increase' : 'ending', place: String(x.place || ''), tenant: String(x.tenant || ''),
        end: x.end || '', left: Number(x.left) || 0, notice: x.notice || '', newRent: Number(x.newRent) || 0, pct: Number(x.pct) || 0
    }));
    try {
        store.setItem(LEASE_KEY, JSON.stringify({ uid, month, items: list, more: Math.max(0, (items || []).length - list.length), at }));
    } catch (_) { /* storage full: Today just shows no lease lines */ }
}

/**
 * REM-4: this person's lease reminders for this month, or null (Rentals not opened this
 * month on this phone, or nothing to remind).
 * @returns {?{items: Array<Object>, more: number, at: number}}
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