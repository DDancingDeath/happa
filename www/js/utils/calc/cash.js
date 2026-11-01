/**
 * @fileoverview Every cash drawer figure for one cash session's day
 * (docs/calculations.md C1–C9) and the drawer's rules: the count against the
 * expected cash (C8), the opening against the last count, and the money fields
 * of a "No bill" due leg. Pure: no DOM, no AppState, no Firestore; the day, the
 * session and whether this phone has the personal expense rows are parameters.
 * modules/cash-management.js gathers the inputs, calls these and renders.
 *
 * Rounding is exactly what the page did before this module existed: day totals
 * in paise (round2), the closing difference in paise, and the figures the
 * status card, the check under the count box and the day details show added
 * with plain JS addition.
 * @module utils/calc/cash
 */

import { activeExpenses, isOnlineExpense, isPersonalExpense, round2 } from '../money.js';
import { endOfLocalDayExclusive, parseAnyBillDate, parseLocalDate } from '../dates.js';
import { dueEvents, saleTimePayment, sumDueEvents } from '../due-payments.js';
import { personalForDay } from '../personal-expenses.js';
import { evaluateCashCount } from '../bill-checks.js';
import { lastCountedSession, sessionTotals } from '../cash-session.js';

export { sessionTotals, lastCountedSession };

/** Field of drawerDay() / the drawer figures → its spec ID in docs/calculations.md. */
export const CASH_SPEC = Object.freeze({
    cashSales: 'C1',
    cashPurchases: 'C2',
    businessExpenses: 'C3', personalExpenses: 'C3',
    dueReceived: 'C4',
    duePaid: 'C5',
    cashDeposits: 'C6',
    expected: 'C7',
    difference: 'C8',
    counted: 'C9'
});

/** Differences up to this many rupees count as "matches" on the count box. */
export const MATCH_WITHIN = 1;
/** A closing or opening that differs by more than this many rupees asks to confirm. */
export const CONFIRM_ABOVE = 1;
/** Colour bands of a difference: under WARN_FROM ok, under HIGH_FROM warn, else high. */
export const WARN_FROM = 50;
export const HIGH_FROM = 500;

const billTime = (value) => {
    const d = parseAnyBillDate(value);
    return d ? d.getTime() : NaN;
};

/**
 * DAY of a cash session: local midnight of `date` to the next local midnight.
 * @param {string} date YYYY-MM-DD
 * @returns {{from: number, to: number}} ms; NaN for both when the date can't be read
 */
export function dayBounds(date) {
    const dayStart = parseLocalDate(date);
    return {
        from: dayStart ? dayStart.getTime() : NaN,
        to: dayStart ? endOfLocalDayExclusive(dayStart).getTime() : NaN
    };
}

/**
 * C1–C6 for one day: what the drawer took in and paid out in cash.
 * @param {Object} src
 * @param {string} src.date YYYY-MM-DD
 * @param {{wholesale?: Object[], retail?: Object[], purchase?: Object[]}} [src.bills] All loaded bills (due payments on older bills count too)
 * @param {Object[]} [src.expenses] Loaded expenses (business, and personal ones when this phone has them); only cash ones count
 * @param {?Object} [src.session] The day's cash session: its due legs (C4, C5) and deposits (C6)
 * @param {boolean} [src.personalReadable=true] This phone has the personal expense rows (#98)
 * @param {?{total?: number, count?: number, online?: number}} [src.personalDay] The day's personalExpenseDays totals, used only when not readable
 * @returns {{cashSales: number, cashPurchases: number, businessExpenses: number, personalExpenses: number, dueReceived: number, duePaid: number, cashDeposits: number}}
 */
export function drawerDay({ date, bills = {}, expenses = [], session = null, personalReadable = true, personalDay = null } = {}) {
    const { from: dateStart, to: dateEnd } = dayBounds(date);
    const inDay = (value) => {
        const t = billTime(value);
        return t >= dateStart && t < dateEnd;
    };

    const transactions = {
        cashSales: 0,
        cashPurchases: 0,
        businessExpenses: 0,
        personalExpenses: 0,
        dueReceived: 0,
        duePaid: 0,
        cashDeposits: 0
    };

    const sales = bills.wholesale || [];
    const retailSales = bills.retail || [];
    const purchases = bills.purchase || [];

    // BILL-AT-SAVE cash (payment.* is canonical); cash collected later on the
    // bill counts as a due payment on its own day.
    [...sales, ...retailSales].forEach(sale => {
        if (inDay(sale.date)) transactions.cashSales += saleTimePayment(sale).cash;
    });
    purchases.forEach(purchase => {
        if (inDay(purchase.date)) transactions.cashPurchases += saleTimePayment(purchase).cash;
    });

    // EXP-KIND; only cash expenses leave the drawer (EXP-MODE, #118: no mode = cash).
    // Personal ones a role can't read come from the day total and its online part (#98).
    // A voided expense (#99) left no cash drawer; its cash is back in the day's drawer
    const payments = activeExpenses(expenses).filter(p => inDay(p.date));
    payments.forEach(payment => {
        if (!isPersonalExpense(payment) && !isOnlineExpense(payment)) transactions.businessExpenses += Number(payment.amount) || 0;
    });
    const personal = personalForDay(
        payments.filter(isPersonalExpense).map(p => ({ amount: Number(p.amount) || 0, paymentMode: p.paymentMode })),
        personalReadable, personalReadable ? null : personalDay);
    transactions.personalExpenses = personal.total - personal.online;

    // DUE-PAY made that day: on bills and/or as drawer legs, each id once (#98). Only cash is drawer cash.
    const dues = sumDueEvents(dueEvents({
        bills: { retail: retailSales, wholesale: sales, purchase: purchases },
        sessions: session ? [session] : [],
        from: dateStart,
        to: dateEnd
    }));
    transactions.dueReceived = dues.receivedCash;
    transactions.duePaid = dues.paidCash;

    if (session && session.cashDeposits) {
        session.cashDeposits.forEach(deposit => {
            transactions.cashDeposits += Number(deposit.amount) || 0;
        });
    }

    Object.keys(transactions).forEach(k => { transactions[k] = round2(transactions[k]); });
    return transactions;
}

/**
 * C7 of the open day; 0 without a session.
 * @param {?Object} session
 * @param {Object} transactions drawerDay()
 * @returns {number}
 */
export function expectedCash(session, transactions) {
    if (!session) return 0;
    return sessionTotals(session, transactions).expected;
}

/**
 * Colour band of a difference: 'ok' under ₹50, 'warn' under ₹500, else 'high'.
 * @param {number} diff
 * @returns {{abs: number, level: 'ok'|'warn'|'high'}}
 */
export function differenceBand(diff) {
    const abs = Math.abs(diff);
    let level = 'ok';
    if (abs >= HIGH_FROM) level = 'high';
    else if (abs >= WARN_FROM) level = 'warn';
    return { abs, level };
}

/**
 * C8 as the screen shows it: counted − expected, not rounded.
 * @param {number} counted
 * @param {number} expected
 * @returns {number}
 */
export function difference(counted, expected) {
    return counted - expected;
}

/**
 * C8 as a closed session saves it (`difference`): counted − expected in paise.
 * @param {number} counted
 * @param {number} expected
 * @returns {number}
 */
export function savedDifference(counted, expected) {
    return round2(counted - expected);
}

/**
 * The status card of today's drawer. Open day: opening, cash in (opening +
 * deposits + sales + due received), cash out (purchases + due paid +
 * expenses) and what should be in the drawer. Closed day: deposits, cash
 * purchases, cash sales, others (expenses + due paid), expected (C7), counted
 * and the difference (C8). Plain addition, as shown.
 * @param {Object} session
 * @param {Object} transactions drawerDay()
 */
export function drawerStatus(session, transactions) {
    const tx = transactions || {};
    const opening = session.openingBalance || 0;
    const cashAdded = tx.cashDeposits || 0;
    const purchases = tx.cashPurchases || 0;
    const sales = tx.cashSales || 0;
    const dueReceived = tx.dueReceived || 0;
    const totalExpenses = (tx.businessExpenses || 0) + (tx.personalExpenses || 0);
    const duePaid = tx.duePaid || 0;
    const others = totalExpenses + duePaid;
    const expected = expectedCash(session, tx);
    const totalCashIn = opening + cashAdded + sales + dueReceived;
    const totalCashOut = purchases + duePaid + totalExpenses;
    const availableCash = totalCashIn - totalCashOut;
    const actual = session.closingBalance || 0;
    const diff = difference(actual, expected);
    return {
        opening, cashAdded, purchases, sales, dueReceived, duePaid, totalExpenses, others,
        expected, totalCashIn, totalCashOut, availableCash,
        actual, diff, diffLevel: differenceBand(diff).level
    };
}

/**
 * The sign-out summary of the open day: each C figure, cash in with the
 * opening (paise), cash out and expected (C7).
 * @param {?Object} session
 * @param {Object} transactions drawerDay()
 */
export function signOutSummary(session, transactions) {
    const tx = transactions || {};
    const totals = sessionTotals(session, tx);
    return {
        opening: session?.openingBalance || 0,
        sales: tx.cashSales || 0,
        purchases: tx.cashPurchases || 0,
        businessExpenses: tx.businessExpenses || 0,
        personalExpenses: tx.personalExpenses || 0,
        dueReceived: tx.dueReceived || 0,
        duePaid: tx.duePaid || 0,
        deposits: tx.cashDeposits || 0,
        totalCashIn: round2(totals.opening + totals.cashIn),
        totalCashOut: totals.cashOut,
        expected: expectedCash(session, tx)
    };
}

/**
 * The check under the count box while closing: matches within ₹1, else extra
 * or short by the difference (C8, not rounded), plus the Q19 bands (#37) other
 * than the plain mismatch.
 * @param {?number} counted parseCashAmount() of the box; null when empty
 * @param {number} expected C7
 * @param {Object} [thresholds] settings checkThresholds
 * @returns {{difference: number, amount: number, kind: 'match'|'extra'|'short', bands: Object[]}}
 */
export function countCheck(counted, expected, thresholds) {
    const diff = difference(counted ?? 0, expected);
    let kind = 'short';
    if (Math.abs(diff) < MATCH_WITHIN) kind = 'match';
    else if (diff > 0) kind = 'extra';
    const bands = counted === null || counted === undefined
        ? []
        : evaluateCashCount({ expected, counted }, thresholds).filter(i => i.id !== 'cash-mismatch');
    return { difference: diff, amount: Math.abs(diff), kind, bands };
}

/**
 * Closing the day with a count: the saved difference (C8, paise), whether to
 * ask first (more than ₹1 off) and the Q19 issues to flag on the session.
 * @param {number} counted
 * @param {number} expected C7
 * @param {Object} [thresholds]
 * @returns {{difference: number, amount: number, extra: boolean, needsConfirm: boolean, issues: Object[]}}
 */
export function closeCheck(counted, expected, thresholds) {
    const diff = savedDifference(counted, expected);
    return {
        difference: diff,
        amount: Math.abs(diff),
        extra: diff > 0,
        needsConfirm: Math.abs(diff) > CONFIRM_ABOVE,
        issues: evaluateCashCount({ expected, counted }, thresholds)
    };
}

/**
 * Opening against the last real count (C9): ask first when more than ₹1 apart.
 * @param {number} lastClosing
 * @param {number} opening
 * @returns {{difference: number, needsConfirm: boolean}}
 */
export function openingCheck(lastClosing, opening) {
    const diff = Math.abs(lastClosing - opening);
    return { difference: diff, needsConfirm: diff > CONFIRM_ABOVE };
}

/**
 * Figures of one day's details: cash in with the opening, cash in without it,
 * cash out and expected (C7) from the transactions given (the saved snapshot,
 * or today's live totals), and the colour bands of the saved difference and of
 * counted − expected balance.
 * @param {Object} session
 * @param {Object} transactions
 * @param {boolean} uncounted isNotCounted(session)
 */
export function sessionDetail(session, transactions, uncounted) {
    const totals = sessionTotals(session, transactions);
    const totalCashIn = totals.opening + totals.cashIn;
    const counted = session.signedOut && !uncounted ? difference(session.closingBalance, session.expectedBalance) : 0;
    return {
        totals,
        totalCashIn,
        cashIn: totalCashIn - (session.openingBalance || 0),
        totalCashOut: totals.cashOut,
        countedLevel: differenceBand(counted).level
    };
}

/**
 * A "No bill" due leg for the session's `duePayments`: cash only, not tied to
 * a bill (C4 when received, C5 when paid).
 * @param {{id: string, type: 'received'|'paid', party: string, amount: number, notes: string, timestamp: string, recordedBy: string}} entry
 * @returns {Object}
 */
export function noBillLeg({ id, type, party, amount, notes, timestamp, recordedBy }) {
    return {
        id,
        type,
        customer: party,
        amount,
        method: 'cash',
        cash: amount,
        online: 0,
        unlinked: true,
        notes,
        timestamp,
        recordedBy
    };
}
