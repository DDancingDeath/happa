/**
 * @fileoverview Personal expenses (#98) live in their own collection, which
 * firestore.rules let only the owner and roles with Roles & access › Personal
 * expenses read or write. Each day's amounts are kept in
 * personalExpenseDays/{YYYY-MM-DD} (written with the expense, one key per
 * expense), so the cash count and Today still add them up on phones that
 * don't load the rows.
 * @module utils/personal-expenses
 */

import { can } from './role-access.js';
import { parseAnyBillDate, toLocalISODate } from './dates.js';
import { round2 } from './money.js';

export const PERSONAL_COLLECTION = 'personalExpenses';
export const PERSONAL_DAYS_COLLECTION = 'personalExpenseDays';

/**
 * Whether firestore.rules let this role read personal expenses.
 * @param {string} role
 * @param {Object} [roleAccess] settings/app.roleAccess
 * @returns {boolean}
 */
export function canReadPersonalExpenses(role, roleAccess) {
    return role === 'owner' || can(role, 'personalExpenses', roleAccess);
}

/**
 * Collection a new expense is saved in.
 * @param {Object} expense
 * @returns {'expenses'|'personalExpenses'}
 */
export function expenseCollectionFor(expense) {
    return expense?.category === 'personal' ? PERSONAL_COLLECTION : 'expenses';
}

/**
 * Local day (YYYY-MM-DD) an expense counts on, or null when its date can't be read.
 * @param {*} date
 * @returns {?string}
 */
export function personalDayKey(date) {
    const d = parseAnyBillDate(date);
    return d ? toLocalISODate(d) : null;
}

/**
 * The day doc's total and count: personalExpenseDays/{day} = { amounts: { <expense id>: amount } }.
 * Each expense sets or removes only its own key, so repeated, late or
 * concurrent writes can't make the total drift (#98).
 * @param {?Object} doc
 * @returns {{total: number, count: number}}
 */
export function dayDocTotals(doc) {
    const amounts = doc && typeof doc.amounts === 'object' && doc.amounts ? Object.values(doc.amounts) : [];
    return { total: round2(amounts.reduce((s, v) => s + (Number(v) || 0), 0)), count: amounts.length };
}

/**
 * Day docs as the personal rows say they should be: { [day]: { [id]: amount } }.
 * Rows without a readable day are left out.
 * @param {Array<Object>} rows personal expenses ({ id, day | date, amount })
 * @returns {Object<string, Object<string, number>>}
 */
export function personalDaysFromRows(rows) {
    const out = {};
    (Array.isArray(rows) ? rows : []).forEach(r => {
        const day = r?.day || personalDayKey(r?.date);
        if (!day || r?.id === undefined || r?.id === null) return;
        (out[day] = out[day] || {})[String(r.id)] = Number(r.amount) || 0;
    });
    return out;
}

/**
 * Keys to set (amount) or remove (null) so a day doc matches the rows.
 * @param {Object<string, number>} want from personalDaysFromRows
 * @param {?Object} doc the stored day doc
 * @returns {Array<{id: string, amount: ?number}>}
 */
export function personalDayFixes(want, doc) {
    const have = doc && typeof doc.amounts === 'object' && doc.amounts ? doc.amounts : {};
    const fixes = [];
    Object.entries(want || {}).forEach(([id, amount]) => {
        if (have[id] !== amount) fixes.push({ id, amount });
    });
    Object.keys(have).forEach(id => {
        if (!want || !(id in want)) fixes.push({ id, amount: null });
    });
    return fixes;
}

/**
 * Personal expenses of a day as the cash count and Today show them: the
 * personal rows this phone has, plus, when it didn't load the personal
 * collection, the stored day total (rows still in `expenses`, from before #98,
 * are counted from the list either way).
 * @param {Array<Object>} rows that day's personal rows in memory
 * @param {boolean} readable the personal listener delivered its rows on this phone
 * @param {?{total?: number, count?: number}} dayDoc dayDocTotals() of personalExpenseDays/{day}
 * @returns {{total: number, count: number}}
 */
export function personalForDay(rows, readable, dayDoc) {
    const list = Array.isArray(rows) ? rows : [];
    let total = list.reduce((s, e) => s + (Number(e.amount) || Number(e.total) || 0), 0);
    let count = list.length;
    if (!readable && dayDoc) {
        total += Number(dayDoc.total) || 0;
        count += Number(dayDoc.count) || 0;
    }
    return { total: round2(total), count };
}
