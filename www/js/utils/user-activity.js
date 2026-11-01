/**
 * @fileoverview Admin › Users counts and the per-person activity report (#145).
 * Pure: the page passes the loaded users, the bills already on this phone and
 * the audit rows of the range. Specs: docs/calculations.md ADM-1 … ADM-3.
 * @module utils/user-activity
 */

import { activityBills, billTotal, round2 } from './money.js';
import { toJsDate, parseAnyBillDate, startOfLocalDay, addLocalDays, monthRange } from './dates.js';

/** Audit actions counted per person (ADM-3). */
export const ACTIVITY_ACTIONS = Object.freeze({
    payments: ['RECORD_PAYMENT', 'UPDATE_PAYMENT', 'CLEAR_DUE'],
    edits: ['EDIT_BILL', 'EDIT_SALE'],
    voids: ['VOID_BILL']
});

export const ACTIVITY_RANGES = ['today', 'week', 'month', 'last_month'];

/**
 * ADM-1: people by role. Removed / rejected first, then pending (status pending
 * or no role), then the role; members are the stored role `staff`.
 * @param {Array<{role?: string, status?: string}>} users
 * @param {(u: Object) => boolean} isRemoved
 * @returns {{owner: number, manager: number, member: number, pending: number, removed: number, active: number}}
 */
export function userCounts(users, isRemoved = () => false) {
    const c = { owner: 0, manager: 0, member: 0, pending: 0, removed: 0, active: 0 };
    (users || []).forEach(u => {
        if (!u) return;
        if (isRemoved(u)) c.removed++;
        else if (u.status === 'pending' || !u.role) c.pending++;
        else {
            c.active++;
            if (u.role === 'owner') c.owner++;
            else if (u.role === 'manager') c.manager++;
            else c.member++;
        }
    });
    return c;
}

/**
 * Local [from, to) in ms for a range id.
 * @param {'today'|'week'|'month'|'last_month'} range
 * @param {Date} [now]
 * @returns {{from: number, to: number}}
 */
export function activityRange(range, now = new Date()) {
    const tomorrow = addLocalDays(now, 1).getTime();
    if (range === 'today') return { from: startOfLocalDay(now).getTime(), to: tomorrow };
    if (range === 'week') return { from: addLocalDays(now, -6).getTime(), to: tomorrow };
    if (range === 'last_month') return monthRange(now, -1);
    return { from: monthRange(now, 0).from, to: tomorrow };
}

/** When a bill was first saved (server createdAt, else its client timestamp, else its date). */
export function billCreatedMs(bill) {
    const d = toJsDate(bill?.createdAt) || toJsDate(bill?.timestamp) || parseAnyBillDate(bill?.date);
    return d ? d.getTime() : null;
}

/** Who saved a bill: purchases / retail store `userId`, wholesale `createdBy`. */
export const billAuthor = (bill) => bill?.userId || bill?.createdBy || null;

const blankRow = (uid) => ({ uid, bills: 0, billTotal: 0, payments: 0, edits: 0, voids: 0, lastActive: null });

/**
 * ADM-2 / ADM-3: per person in [from, to).
 * - bills / billTotal: active, non-opening bills (activityBills) this person saved in the range; total =
 *   Σ billTotal, whole rupees.
 * - payments / edits / voids: their audit rows in the range by action (ACTIVITY_ACTIONS).
 * - lastActive: their latest bill or audit row in the range (ms).
 * Rows sorted by bills, then actions, then uid.
 * @param {{bills: Array<Object>, audit: Array<{userId: string, action: string, timestamp: number}>, from: number, to: number}} p
 * @returns {Array<Object>}
 */
export function activityByUser({ bills, audit, from, to }) {
    const rows = new Map();
    const row = (uid) => {
        if (!rows.has(uid)) rows.set(uid, blankRow(uid));
        return rows.get(uid);
    };
    const seen = (r, ms) => { if (r.lastActive === null || ms > r.lastActive) r.lastActive = ms; };
    activityBills(bills || []).forEach(b => {
        const uid = billAuthor(b);
        const ms = billCreatedMs(b);
        if (!uid || ms === null || ms < from || ms >= to) return;
        const r = row(uid);
        r.bills++;
        r.billTotal = round2(r.billTotal + billTotal(b));
        seen(r, ms);
    });
    (audit || []).forEach(a => {
        const ms = Number(a?.timestamp);
        if (!a?.userId || !Number.isFinite(ms) || ms < from || ms >= to) return;
        const r = row(a.userId);
        Object.entries(ACTIVITY_ACTIONS).forEach(([key, actions]) => {
            if (actions.includes(a.action)) r[key]++;
        });
        seen(r, ms);
    });
    const out = [...rows.values()];
    out.forEach(r => { r.billTotal = Math.round(r.billTotal); });
    const actions = (r) => r.payments + r.edits + r.voids;
    return out.sort((a, b) => b.bills - a.bills || actions(b) - actions(a) || (a.uid < b.uid ? -1 : 1));
}
