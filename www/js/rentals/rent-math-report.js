/**
 * @fileoverview Rentals (#157, phase 3) maths of the agreement terms, the lease
 * reminders for Today (REM-4) and the yearly report per property (RENT-19).
 * Pure (no DOM, Firestore or AppState); not precached (LAZY_ASSETS), imported only
 * by the lazy rentals/rent-report.js. Number definitions: docs/calculations.md.
 * @module rentals/rent-math-report
 */

import { round2 } from '../utils/money.js';
import { isMonth, addMonths, chargeDue, increaseDue } from './rent-math.js';
// ---------- Agreement terms (#157 phase 3) ----------

export const MAX_NOTICE_MONTHS = 12;
/** Today shows an agreement ending this month or in the next 2 months (about 60 days), or already past. */
export const LEASE_ENDING_AHEAD = 2;

/** Months from `a` to `b` ('YYYY-MM'). */
const monthsFrom = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/**
 * Agreement terms of a lease: the month the agreement ends (empty = none) and the notice
 * period in whole months (0–12); the end not before the start month.
 * @returns {?string} i18n key of what is wrong
 */
export function agreementError({ agreementEnd = '', noticeMonths = 0 } = {}, startMonth = '') {
    if (agreementEnd && (!isMonth(agreementEnd) || (isMonth(startMonth) && agreementEnd < startMonth))) return 'msg.rent.agr_end_bad';
    const n = Number(noticeMonths);
    if (!Number.isInteger(n) || n < 0 || n > MAX_NOTICE_MONTHS) return 'msg.rent.agr_notice_bad';
    return null;
}

/** The month notice must be given by (agreement end − notice months), or '' without both. */
export const noticeBy = (l) => (isMonth(l?.agreementEnd) && Number(l?.noticeMonths) > 0 ? addMonths(l.agreementEnd, -Number(l.noticeMonths)) : '');

/**
 * REM-4: lease reminders for Today: active leases whose agreement ends this month,
 * in the next 2 months or has already ended (`left` months, negative = past), with
 * the notice month; and rents due an increase (RENT-6). Endings first (soonest), then increases.
 * @param {Array<Object>} leases active leases
 * @param {string} month this month 'YYYY-MM'
 * @param {{today?: Date, names?: (l: Object) => {place: string, tenant: string}}} [opts]
 */
export function leaseReminders(leases, month, { today = new Date(), names = () => ({ place: '', tenant: '' }) } = {}) {
    const ending = [];
    const increase = [];
    for (const l of leases || []) {
        if (!l || l.status !== 'active' || !isMonth(month)) continue;
        if (isMonth(l.agreementEnd)) {
            const left = monthsFrom(month, l.agreementEnd);
            if (left <= LEASE_ENDING_AHEAD) ending.push({ kind: 'ending', leaseId: l.id, ...names(l), end: l.agreementEnd, left, notice: noticeBy(l) });
        }
        const inc = increaseDue(l, month, today);
        if (inc.due) increase.push({ kind: 'increase', leaseId: l.id, ...names(l), pct: inc.pct, rent: Number(l.rent) || 0, newRent: inc.newRent });
    }
    ending.sort((a, b) => a.left - b.left || String(a.place).localeCompare(String(b.place)));
    increase.sort((a, b) => String(a.place).localeCompare(String(b.place)));
    return [...ending, ...increase];
}

// ---------- Yearly report per property (RENT-19) ----------

/** The 12 months of a financial year (April–March, `fy` = its first year) or of a calendar year. */
export function reportMonths(year, fy = true) {
    const first = fy ? `${year}-04` : `${year}-01`;
    return Array.from({ length: 12 }, (_, i) => addMonths(first, i));
}

const blank = () => ({ rent: 0, collected: 0, due: 0, expenses: 0, tax: 0, net: 0 });
const add = (a, b) => { Object.keys(a).forEach(k => { a[k] = round2(a[k] + (b[k] || 0)); }); };

/**
 * RENT-19: per property and month of the year: rent = Σ amount of the month's charges (RENT-1),
 * collected = Σ paid on them (RENT-2, advances in the month they pay), due = Σ due, expenses =
 * RENT-17, of which property tax (category 'tax'), net = collected − expenses (RENT-18); each
 * property's year total and the total of all.
 * @param {{charges?: Object[], expenses?: Object[], properties?: Object[]}} src
 * @param {string[]} months reportMonths()
 * @returns {{months: string[], rows: Array<{id: string, name: string, months: Object<string, Object>, total: Object}>, total: Object}}
 */
export function yearReport({ charges = [], expenses = [], properties = [] } = {}, months) {
    const inYear = new Set(months);
    const byId = new Map();
    const row = (id) => {
        if (!byId.has(id)) {
            const p = properties.find(x => x.id === id);
            byId.set(id, { id, name: p ? p.name : '', months: Object.fromEntries(months.map(m => [m, blank()])), total: blank() });
        }
        return byId.get(id);
    };
    properties.forEach(p => row(p.id));
    charges.forEach(c => {
        if (!c || !inYear.has(c.month)) return;
        add(row(c.propertyId || '').months[c.month], { rent: Number(c.amount) || 0, collected: Number(c.paid) || 0, due: chargeDue(c) });
    });
    expenses.forEach(e => {
        const m = e && e.month;
        if (!inYear.has(m)) return;
        const amount = Number(e.amount) || 0;
        add(row(e.propertyId || '').months[m], { expenses: amount, tax: e.category === 'tax' ? amount : 0 });
    });
    const total = blank();
    const rows = [...byId.values()].map(r => {
        months.forEach(m => {
            const x = r.months[m];
            x.net = round2(x.collected - x.expenses);
            add(r.total, { ...x, net: 0 });
        });
        r.total.net = round2(r.total.collected - r.total.expenses);
        add(total, { ...r.total, net: 0 });
        return r;
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    total.net = round2(total.collected - total.expenses);
    return { months, rows, total };
}