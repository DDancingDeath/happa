/**
 * @fileoverview The date of a new bill (#147): which days may be picked, the check
 * before saving and the time the bill is saved with. Pure: "now", the role and
 * Roles & access are parameters. purchase.js, retail-sale.js and wholesale-sales.js
 * read the Date box, call these and save; firestore.rules (billTimeOk) checks the
 * same window on the server for everyone but the owner.
 *
 * - Day: today by default; never in the future. Everyone but the owner may go back
 *   at most the role's edit window (Roles & access › editDays, the bill edit window):
 *   editDays 2 = today, yesterday and the day before. The owner may go back to the
 *   1st of the previous month: the oldest day the app keeps live (history window,
 *   stock checkpoint, month snapshots and rate stats are rebuilt from it).
 * - Time: today = the save time; an earlier day = that day at the current time of
 *   day. It is the bill's `timestamp` (BILL-TIME): stock, Today, the cash drawer, dues
 *   and Money count the bill on that day. `enteredAt` keeps when it was entered;
 *   the edit window still counts from the server's `createdAt`.
 * @module utils/bill-date
 */

import { accessFor } from './role-access.js';
import { addLocalDays, monthStart, parseLocalDate, toLocalISODate } from './dates.js';

/**
 * Days that may be picked for a new bill.
 * @param {{role?: string, roleAccess?: Object, now?: Date}} who
 * @returns {{max: string, min: string, days: ?number}} YYYY-MM-DD; days null for the owner
 */
export function billDayRange({ role, roleAccess, now = new Date() } = {}) {
    const max = toLocalISODate(now);
    const liveFrom = toLocalISODate(monthStart(now, -1));
    if (role === 'owner') return { max, min: liveFrom, days: null };
    const days = accessFor(role, roleAccess).editDays;
    // Never before the oldest day the app keeps live, whatever the role's window
    const byRole = toLocalISODate(addLocalDays(now, -days));
    return { max, min: byRole > liveFrom ? byRole : liveFrom, days };
}

/**
 * Check the picked day before saving.
 * @param {string} day YYYY-MM-DD
 * @param {{role?: string, roleAccess?: Object, now?: Date}} who
 * @returns {?{key: string, params?: Object}} null when fine, else the i18n message key
 */
export function validateBillDay(day, who = {}) {
    if (!parseLocalDate(day)) return { key: 'msg.billing.choose_date' };
    const range = billDayRange(who);
    if (day > range.max) return { key: 'msg.billing.date_in_future' };
    if (day < range.min) {
        if (range.days === null || range.min > toLocalISODate(addLocalDays(who.now || new Date(), -range.days))) return { key: 'msg.billing.date_before_last_month' };
        return range.days === 0 ? { key: 'msg.billing.date_today_only' } : { key: 'msg.billing.date_too_old', params: { days: range.days } };
    }
    return null;
}

/**
 * The time a new bill on `day` is saved with: now for today, else that day at the
 * current time of day (local).
 * @param {string} day YYYY-MM-DD
 * @param {Date} [now]
 * @returns {Date}
 */
export function billTimeFor(day, now = new Date()) {
    const picked = parseLocalDate(day);
    if (!picked || day === toLocalISODate(now)) return now;
    return new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
}

/**
 * Cash on a bill dated before today (#147): that day's drawer may already be counted
 * and closed, so the cash would show in no open drawer. Everyone but the owner is
 * refused (the rules refuse it too, `noBackdatedCash`): online or due only. The owner
 * may, after a confirm when that day's cash is closed.
 * @param {string} day YYYY-MM-DD
 * @param {number} cash
 * @param {string} role
 * @param {Date} [now]
 * @returns {'ok'|'refuse'|'owner-check'}
 */
export function backdatedCash(day, cash, role, now = new Date()) {
    if (!(Number(cash) > 0) || day >= toLocalISODate(now)) return 'ok';
    return role === 'owner' ? 'owner-check' : 'refuse';
}
