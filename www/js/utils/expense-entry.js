/**
 * @fileoverview The date and payment mode of a new expense (#118): which days
 * may be picked, the check before saving and the stored fields. Pure: "now",
 * the role and Roles & access are parameters. modules/miscellaneous.js reads
 * the form, calls these and saves; firestore.rules (expenseFieldsOk,
 * expenseDayInWindow) check the same rules on the server.
 *
 * - Mode: cash or online (EXPENSE_MODES), cash by default; expenseMode() in
 *   money.js reads it back (no mode = cash).
 * - Day: today by default; never in the future; everyone but the owner may go
 *   back at most the role's edit window (Roles & access › editDays, the bill
 *   edit window): editDays 2 = today, yesterday and the day before.
 * @module utils/expense-entry
 */

import { EXPENSE_MODES } from './money.js';
import { accessFor } from './role-access.js';
import { addLocalDays, parseLocalDate, toLocalISODate } from './dates.js';

export { EXPENSE_MODES };

/** Payment mode of a new expense unless the user picks another. */
export const DEFAULT_EXPENSE_MODE = 'cash';

/**
 * Days that may be picked for a new expense.
 * @param {{role?: string, roleAccess?: Object, now?: Date}} who
 * @returns {{max: string, min: ?string, days: number}} YYYY-MM-DD; min null = no limit (owner)
 */
export function expenseDayRange({ role, roleAccess, now = new Date() } = {}) {
    const max = toLocalISODate(now);
    if (role === 'owner') return { max, min: null, days: Infinity };
    const days = accessFor(role, roleAccess).editDays;
    return { max, min: toLocalISODate(addLocalDays(now, -days)), days };
}

/**
 * Check the picked day and mode before saving.
 * @param {{day: string, mode: string}} entry
 * @param {{role?: string, roleAccess?: Object, now?: Date}} who
 * @returns {?{key: string, params?: Object}} null when fine, else the i18n message key
 */
export function validateExpenseEntry({ day, mode }, who = {}) {
    if (!EXPENSE_MODES.includes(mode)) return { key: 'msg.expenses.choose_mode' };
    if (!parseLocalDate(day)) return { key: 'msg.expenses.choose_date' };
    const range = expenseDayRange(who);
    if (day > range.max) return { key: 'msg.expenses.date_in_future' };
    if (range.min && day < range.min) {
        return range.days === 0 ? { key: 'msg.expenses.date_today_only' } : { key: 'msg.expenses.date_too_old', params: { days: range.days } };
    }
    return null;
}

/**
 * Stored date fields of a new expense on `day`: `day` (YYYY-MM-DD) and `date`
 * as the app has always written it (en-IN "31/10/2026, 2:05:34 pm"). Today: the
 * current time; an earlier day: that day at the current time of day, so the
 * expense counts on the day picked (Today, the drawer, Money, Statements read
 * `date`). The save time stays in `timestamp`.
 * @param {string} day YYYY-MM-DD
 * @param {Date} [now]
 * @returns {{day: string, date: string}}
 */
export function expenseDateFields(day, now = new Date()) {
    const picked = parseLocalDate(day);
    const at = !picked || day === toLocalISODate(now)
        ? now
        : new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
    return { day: toLocalISODate(at), date: at.toLocaleString('en-IN') };
}
