// @ts-check
/**
 * @fileoverview Expenses page helpers (#90): search the list, one-tap templates
 * from recent entries, and the totals of a section (docs/calculations.md EXP-LIST).
 * Pure: the page passes the loaded expenses of one section.
 * @module utils/expense-list
 */

import { activeExpenses, isActiveExpense, round2 } from './money.js';
import { personalDayKey } from './personal-expenses.js';
import { parseLocalDate, toLocalISODate } from './dates.js';

/** Template chips shown above a section's form. */
export const MAX_EXPENSE_TEMPLATES = 6;

/** @param {*} s @returns {string} */
const fold = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/** @param {*} e @returns {number} */
const amountOf = (e) => Number(e?.amount) || 0;

/**
 * The expense's type as a filter value: trimmed, case kept from the newest entry.
 * @param {Expense} e
 * @returns {string}
 */
const typeOf = (e) => String(e?.type ?? '').replace(/\s+/g, ' ').trim();

/**
 * Whether two expense types are the same type (case and spaces ignored).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function sameExpenseType(a, b) {
    return fold(a) === fold(b);
}

/**
 * Distinct expense types of a list (case-insensitive), A–Z, for the type filter.
 * @param {Array<Expense>} expenses
 * @returns {Array<string>}
 */
export function expenseTypes(expenses) {
    const byKey = new Map();
    (Array.isArray(expenses) ? expenses : []).forEach(e => {
        const type = typeOf(e);
        if (type && !byKey.has(fold(type))) byKey.set(fold(type), type);
    });
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Expenses matching the search: every word of `text` in the type, name, remarks,
 * amount or date; `type` the exact type (case-insensitive); '' = any.
 * @param {Array<Expense>} expenses
 * @param {{text?: string, type?: string}} [query]
 * @returns {Array<Expense>}
 */
export function filterExpenses(expenses, { text = '', type = '' } = {}) {
    const words = fold(text).split(' ').filter(Boolean);
    const wantType = fold(type);
    return (Array.isArray(expenses) ? expenses : []).filter(e => {
        if (!e) return false;
        if (wantType && fold(e.type) !== wantType) return false;
        if (!words.length) return true;
        const hay = fold([e.type, e.personName, e.remarks, e.amount, e.date, e.day].join(' '));
        return words.every(w => hay.includes(w));
    });
}

/** Whether a search is on (text or type picked). */
export function isExpenseSearch({ text = '', type = '' } = {}) {
    return !!(fold(text) || fold(type));
}

/**
 * Template chips: the newest distinct (type, name, amount) entries of the
 * section that count (not voided), newest first. Tapping one fills the form;
 * the user still saves it.
 * @param {Array<Expense>} expenses
 * @param {number} [limit]
 * @returns {Array<{type: string, personName: string, amount: number}>}
 */
export function expenseTemplates(expenses, limit = MAX_EXPENSE_TEMPLATES) {
    const newest = activeExpenses(expenses)
        .filter(e => typeOf(e) && amountOf(e) > 0)
        .map(e => ({ e, at: Number(e.timestamp) || personalDayTime(e) }))
        .sort((a, b) => b.at - a.at);
    const seen = new Set();
    const out = [];
    for (const { e } of newest) {
        const personName = String(e.personName ?? '').replace(/\s+/g, ' ').trim();
        const amount = amountOf(e);
        const key = `${fold(typeOf(e))}|${fold(personName)}|${amount}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: typeOf(e), personName, amount });
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * @param {Expense} e
 * @returns {number} the expense day's time (0 when unreadable)
 */
function personalDayTime(e) {
    const day = personalDayKey(e?.date);
    return parseLocalDate(day || '')?.getTime() || 0;
}

/**
 * EXP-LIST totals of one section: today (E1) and this calendar month (E2) by the
 * expense's day, voided ones never counted; `shown` (E3) = the listed rows that
 * count. `monthFrom` is the month's first day, or the first loaded day when the
 * loaded history starts later (the total is then "since" that day).
 * @param {Array<Expense>} expenses the section's loaded expenses
 * @param {{now?: Date, loadedFrom?: ?(number|Date), shown?: Array<Expense>}} [opts]
 * @returns {{today: number, todayCount: number, month: number, monthCount: number, monthFrom: string, partialMonth: boolean, shown: number, shownCount: number}}
 */
export function expenseTotals(expenses, { now = new Date(), loadedFrom = null, shown = [] } = {}) {
    const today = toLocalISODate(now);
    const monthStart = today.slice(0, 8) + '01';
    const loadedDay = loadedFrom ? toLocalISODate(new Date(loadedFrom)) : null;
    const partialMonth = !!loadedDay && loadedDay > monthStart;
    const out = { today: 0, todayCount: 0, month: 0, monthCount: 0, monthFrom: partialMonth ? loadedDay : monthStart, partialMonth, shown: 0, shownCount: 0 };
    activeExpenses(expenses).forEach(e => {
        const day = personalDayKey(e.date);
        if (!day || day > today || day < monthStart) return;
        out.month += amountOf(e);
        out.monthCount++;
        if (day === today) {
            out.today += amountOf(e);
            out.todayCount++;
        }
    });
    (Array.isArray(shown) ? shown : []).forEach(e => {
        if (!isActiveExpense(e)) return;
        out.shown += amountOf(e);
        out.shownCount++;
    });
    out.today = round2(out.today);
    out.month = round2(out.month);
    out.shown = round2(out.shown);
    return out;
}
