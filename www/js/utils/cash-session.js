/**
 * @fileoverview Pure cash-session helpers (#66, #69, #101).
 * @module utils/cash-session
 */

import { round2 } from './money.js';
import { parseLocalDate } from './dates.js';

/**
 * Reads a cash amount typed by the user. 0 is a valid amount (empty drawer);
 * empty, negative or non-numeric input returns null.
 * @param {*} raw
 * @returns {number|null}
 */
export function parseCashAmount(raw) {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    if (str === '') return null;
    const n = Number(str);
    if (!Number.isFinite(n) || n < 0) return null;
    return round2(n);
}

/**
 * Cash in / out / expected for a session from its saved `transactions`
 * snapshot (or the live totals passed in). Same field names everywhere:
 * cashSales, cashPurchases, businessExpenses, personalExpenses, dueReceived,
 * duePaid, cashDeposits.
 * @param {?Rec} session
 * @param {?Rec} [transactions=session.transactions]
 * @returns {{opening: number, cashIn: number, cashOut: number, expected: number}}
 *   cashIn excludes the opening balance; expected = opening + cashIn − cashOut.
 */
export function sessionTotals(session, transactions = session?.transactions) {
    const t = transactions || {};
    const n = (v) => Number(v) || 0;
    const opening = n(session?.openingBalance);
    const cashIn = round2(n(t.cashDeposits) + n(t.cashSales) + n(t.dueReceived));
    const cashOut = round2(n(t.cashPurchases) + n(t.duePaid) + n(t.businessExpenses) + n(t.personalExpenses));
    return { opening, cashIn, cashOut, expected: round2(opening + cashIn - cashOut) };
}

/**
 * A closed session whose cash was never counted: auto-closed by the app
 * (`counted: false`), or auto-closed by an older app version that stored a
 * fake ₹0 count (`autoSignedOut` without a later count).
 * @param {Object} session
 * @returns {boolean}
 */
export function isNotCounted(session) {
    if (!session || !session.signedOut) return false;
    if (session.counted === false) return true;
    return session.counted === undefined && session.autoSignedOut === true;
}

/**
 * The most recent closed session with a real count, or null.
 * @param {Object[]} sessions
 * @returns {?Object}
 */
export function lastCountedSession(sessions) {
    const closed = (sessions || [])
        .filter(s => s && s.signedOut && !isNotCounted(s) && Number.isFinite(Number(s.closingBalance)) && s.closingBalance !== null)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.signOutTime || '').localeCompare(String(a.signOutTime || '')));
    return closed[0] || null;
}

/**
 * Error code thrown by FirebaseService.openCashSession when there is no
 * connection (#38): opening cash is never queued offline.
 */
export const CASH_NEEDS_INTERNET = 'cash/needs-internet';

/**
 * Id of a day's cash session (#38): one document per local day, so a second
 * phone opening cash joins the same session.
 * @param {string} date YYYY-MM-DD
 * @returns {string}
 */
export function cashSessionDocId(date) {
    return `cash_${date}`;
}

/**
 * The session for `date`. Older days can have more than one (random ids from
 * before #38): prefer the per-day id, then the earliest opened.
 * @param {Object[]} sessions
 * @param {string} date
 * @returns {?Object}
 */
export function sessionForDate(sessions, date) {
    const same = (sessions || []).filter(s => s && s.date === date);
    if (same.length <= 1) return same[0] || null;
    return same.find(s => s.id === cashSessionDocId(date))
        || same.slice().sort((a, b) => String(a.signInTime || '').localeCompare(String(b.signInTime || '')))[0];
}

/**
 * Days that have more than one cash session, newest first.
 * @param {Object[]} sessions
 * @returns {string[]}
 */
export function duplicateSessionDays(sessions) {
    const count = new Map();
    (sessions || []).forEach(s => { if (s?.date) count.set(s.date, (count.get(s.date) || 0) + 1); });
    return [...count].filter(([, n]) => n > 1).map(([d]) => d).sort().reverse();
}

/**
 * Fields written when the app closes a session nobody closed (#101): the
 * expected balance is kept, but nothing was counted, so there is no closing
 * balance and no difference (no fake shortage).
 * @param {Object} session Fresh session data (needs `date`, `openingBalance`)
 * @param {Object} transactions Totals for that day
 * @returns {Object}
 */
export function autoCloseFields(session, transactions) {
    const { expected } = sessionTotals(session, transactions);
    const day = parseLocalDate(session.date);
    const endOfDay = day ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59) : new Date();
    return {
        closingBalance: null,
        expectedBalance: expected,
        difference: null,
        counted: false,
        signOutTime: endOfDay.toISOString(),
        signedOut: true,
        autoSignedOut: true,
        autoClosed: true,
        autoSignOutReason: 'Session not closed by end of day',
        transactions: { ...transactions }
    };
}
