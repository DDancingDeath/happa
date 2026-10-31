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
import { isOnlineExpense, round2 } from './money.js';

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
 * The day doc's total and count: personalExpenseDays/{day} = { amounts: { <expense id>: amount },
 * online: { <expense id>: true } }. Each expense sets or removes only its own key, so repeated,
 * late or concurrent writes can't make the total drift (#98). `online` flags the expenses paid
 * online (EXP-MODE, #118); a flag without an amount (left by an older app's delete) is ignored.
 * @param {?Object} doc
 * @returns {{total: number, count: number, online: number, onlineCount: number}}
 */
export function dayDocTotals(doc) {
    const map = doc && typeof doc.amounts === 'object' && doc.amounts ? doc.amounts : {};
    const flags = doc && typeof doc.online === 'object' && doc.online ? doc.online : {};
    const amounts = Object.values(map);
    const onlineIds = Object.keys(map).filter(id => flags[id] === true);
    return {
        total: round2(amounts.reduce((s, v) => s + (Number(v) || 0), 0)),
        count: amounts.length,
        online: round2(onlineIds.reduce((s, id) => s + (Number(map[id]) || 0), 0)),
        onlineCount: onlineIds.length
    };
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
 * The online flags of the day docs as the personal rows say they should be:
 * { [day]: { [id]: true } } for the rows paid online (EXP-MODE).
 * @param {Array<Object>} rows personal expenses ({ id, day | date, paymentMode })
 * @returns {Object<string, Object<string, true>>}
 */
export function personalOnlineFromRows(rows) {
    const out = {};
    (Array.isArray(rows) ? rows : []).forEach(r => {
        const day = r?.day || personalDayKey(r?.date);
        if (!day || r?.id === undefined || r?.id === null || !isOnlineExpense(r)) return;
        (out[day] = out[day] || {})[String(r.id)] = true;
    });
    return out;
}

/**
 * Keys to set (amount and online flag) or remove (null) so a day doc matches the rows.
 * @param {Object<string, number>} want from personalDaysFromRows
 * @param {?Object} doc the stored day doc
 * @param {Object<string, true>} [wantOnline] from personalOnlineFromRows
 * @returns {Array<{id: string, amount: ?number, online: boolean}>}
 */
export function personalDayFixes(want, doc, wantOnline = {}) {
    const have = doc && typeof doc.amounts === 'object' && doc.amounts ? doc.amounts : {};
    const haveOnline = doc && typeof doc.online === 'object' && doc.online ? doc.online : {};
    const fixes = [];
    Object.entries(want || {}).forEach(([id, amount]) => {
        const online = wantOnline?.[id] === true;
        if (have[id] !== amount || (haveOnline[id] === true) !== online) fixes.push({ id, amount, online });
    });
    Object.keys(have).forEach(id => {
        if (!want || !(id in want)) fixes.push({ id, amount: null, online: false });
    });
    return fixes;
}

/**
 * Personal expenses of a day as the cash count and Today show them: the
 * personal rows this phone has, plus, when it didn't load the personal
 * collection, the stored day total (rows still in `expenses`, from before #98,
 * are counted from the list either way). `online` is the part paid online (EXP-MODE).
 * @param {Array<Object>} rows that day's personal rows in memory
 * @param {boolean} readable the personal listener delivered its rows on this phone
 * @param {?{total?: number, count?: number, online?: number}} dayDoc dayDocTotals() of personalExpenseDays/{day}
 * @returns {{total: number, count: number, online: number}}
 */
export function personalForDay(rows, readable, dayDoc) {
    const list = Array.isArray(rows) ? rows : [];
    const amountOf = (e) => Number(e.amount) || Number(e.total) || 0;
    let total = list.reduce((s, e) => s + amountOf(e), 0);
    let online = list.filter(isOnlineExpense).reduce((s, e) => s + amountOf(e), 0);
    let count = list.length;
    if (!readable && dayDoc) {
        total += Number(dayDoc.total) || 0;
        online += Number(dayDoc.online) || 0;
        count += Number(dayDoc.count) || 0;
    }
    return { total: round2(total), count, online: round2(online) };
}
