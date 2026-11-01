// @ts-check
/**
 * @fileoverview Every figure on the Today page for one local day
 * (docs/calculations.md T1–T19, T-LAB-1..3). Pure: no DOM, no AppState, no
 * Firestore; "today" is a parameter. modules/day.js gathers the inputs and
 * renders the result.
 * @module utils/calc/today
 */

import { activeExpenses, activityBills, billTotal, isOnlineExpense, isPersonalExpense, outstandingDue, round2 } from '../money.js';
import { endOfLocalDayExclusive, parseAnyBillDate, startOfLocalDay } from '../dates.js';
import { dueEvents, paymentBreakdown, saleTimePayment, sumDueEvents } from '../due-payments.js';
import { labourGap, labourSummary } from '../labour.js';
import { billDayTime } from './cash.js';

/** Field of todaySummary() → its spec ID in docs/calculations.md. */
export const TODAY_SPEC = Object.freeze({
    purchases: 'T1', purchaseCount: 'T1',
    sales: 'T2', saleCount: 'T2',
    labour: 'T3, T-LAB-1, T-LAB-2, T-LAB-3',
    businessExpenses: 'T4', businessExpenseCount: 'T4',
    personalExpenses: 'T5', personalExpenseCount: 'T5',
    expenses: 'T8, T9', expensesCash: 'T8', expensesOnline: 'T9',
    cashIn: 'T6', onlineIn: 'T7', cashOut: 'T8', onlineOut: 'T9',
    totalIn: 'T10', totalOut: 'T11',
    net: 'T12', netOutflow: 'T12', netAmount: 'T12', isOutflow: 'T12',
    dueReceived: 'T13', duePaid: 'T14',
    dueToReceive: 'T15', dueToPay: 'T16',
    purchaseItems: 'T17', saleItems: 'T17',
    channels: 'T18',
    dayBills: 'T19'
});

const expenseAmount = (/** @type {Expense} */ e) => Number(e.amount) || 0;

/**
 * @template T
 * @param {T[]} list
 * @param {(x: T) => number} valueOf
 * @returns {number}
 */
const sumOf = (list, valueOf) => list.reduce((sum, x) => sum + valueOf(x), 0);

/**
 * T17 item cards: the day's lines grouped by item name, highest value first.
 * @param {Bill[]} bills
 * @returns {Array<{name: string, count: number, quantity: number, totalValue: number, avgRate: ?number}>}
 */
export function itemRows(bills) {
    /** @type {Object<string, {name: string, count: number, quantity: number, totalValue: number}>} */
    const byName = {};
    bills.forEach(bill => {
        (bill.items || []).forEach((/** @type {Rec} */ item) => {
            const name = item.item || item.name || 'Unknown';
            if (!byName[name]) byName[name] = { name, count: 0, quantity: 0, totalValue: 0 };
            byName[name].count += 1;
            byName[name].quantity += parseFloat(item.qty || item.quantity || 0);
            byName[name].totalValue += parseFloat(item.total || item.amount || 0);
        });
    });
    return Object.values(byName)
        .sort((a, b) => b.totalValue - a.totalValue)
        .map(row => ({ ...row, avgRate: row.quantity > 0 ? row.totalValue / row.quantity : null }));
}

/**
 * T18 one bill type's split, adding up to its total: bills, BILL-TOTAL, cash and
 * online paid at save (BILL-AT-SAVE), paid later today (due payments on these
 * bills, cash + online), written off and the due still open (BILL-DUE).
 * @param {Bill[]} bills today's bills of one type
 * @returns {{count: number, total: number, cash: number, online: number, paidLater: number, writtenOff: number, due: number}}
 */
export function channelSplit(bills) {
    const parts = bills.map(b => paymentBreakdown(b));
    return {
        count: bills.length,
        total: round2(sumOf(bills, billTotal)),
        cash: round2(sumOf(parts, p => p.atSave.cash)),
        online: round2(sumOf(parts, p => p.atSave.online)),
        paidLater: round2(sumOf(parts, p => p.later.total)),
        writtenOff: round2(sumOf(parts, p => p.writtenOff)),
        due: round2(sumOf(parts, p => p.due))
    };
}
/**
 * T19 today's bills, newest first, each with its BILL-TOTAL.
 * @param {{purchase: Bill[], wholesale: Bill[], retail: Bill[]}} byType
 * @returns {Array<{type: string, bill: Bill, at: number, total: number}>}
 */
export function dayBillRows(byType) {
    return Object.entries(byType)
        .flatMap(([type, list]) => list.map(bill => ({ type, bill, at: parseAnyBillDate(bill.date)?.getTime() || 0, total: billTotal(bill) })))
        .sort((a, b) => b.at - a.at);
}

/**
 * Every Today figure for the local day containing `today`.
 * @param {Object} [src]
 * @param {{purchase?: Bill[], wholesale?: Bill[], retail?: Bill[]}} [src.bills] All loaded bills (due payments on older bills count too)
 * @param {?Expense[]} [src.expenses]
 * @param {?{total?: number, count?: number, online?: number}} [src.personalDay] Today's personal expense total, count and online part
 *   (personalExpenseDays) when this phone's role can't read the personal rows (#98)
 * @param {CashSession[]} [src.sessions] Cash sessions of the day whose due legs count (each payment id once)
 * @param {Rec} [src.settings] Labour settings (laborRate, labourPackageKg)
 * @param {*} [src.today=new Date()] Any instant of the day (Date, ms or a bill date)
 */
export function todaySummary({ bills = {}, expenses = [], personalDay = null, sessions = [], settings = {}, today = new Date() } = {}) {
    const from = /** @type {Date} */ (startOfLocalDay(today));
    const to = /** @type {Date} */ (endOfLocalDayExclusive(today));
    const onDay = (/** @type {Expense} */ record) => {
        const date = parseAnyBillDate(record.date);
        return date && date >= from && date < to;
    };

    // Bills by BILL-TIME (numeric timestamp, else date), as the drawer counts them (#147)
    const billOnDay = (/** @type {?Bill|undefined} */ bill) => {
        const t = billDayTime(bill);
        return t >= from.getTime() && t < to.getTime();
    };
    const purchaseBills = /** @type {Bill[]} */ (activityBills(bills.purchase).filter(billOnDay));
    const wholesaleBills = /** @type {Bill[]} */ (activityBills(bills.wholesale).filter(billOnDay));
    const retailBills = /** @type {Bill[]} */ (activityBills(bills.retail).filter(billOnDay));
    const saleBills = [...wholesaleBills, ...retailBills];
    const dayExpenses = activeExpenses(expenses).filter(onDay);

    const purchases = sumOf(purchaseBills, billTotal);
    const sales = sumOf(wholesaleBills, billTotal) + sumOf(retailBills, billTotal);

    // EXP-KIND (#219); personal ones this role can't read come as the day total (#98)
    const business = dayExpenses.filter(e => !isPersonalExpense(e));
    const personal = dayExpenses.filter(isPersonalExpense);
    const businessExpenses = sumOf(business, expenseAmount);
    const personalExpenses = round2(sumOf(personal, expenseAmount) + (Number(personalDay?.total) || 0));
    const expensesTotal = businessExpenses + personalExpenses;
    // EXP-MODE (#118): online expenses are online out (T9), the rest cash out (T8); no mode = cash
    const expensesOnline = round2(sumOf(dayExpenses.filter(isOnlineExpense), expenseAmount) + (Number(personalDay?.online) || 0));
    const expensesCash = expensesTotal - expensesOnline;

    // BILL-AT-SAVE: money paid on a bill later is a due payment, counted on the day it was paid.
    let cashPaid = 0, onlinePaid = 0, dueToPay = 0;
    purchaseBills.forEach(p => {
        const paid = saleTimePayment(p);
        cashPaid += paid.cash;
        onlinePaid += paid.online;
        dueToPay += outstandingDue(p);
    });
    let cashReceived = 0, onlineReceived = 0, dueToReceive = 0;
    saleBills.forEach(s => {
        const paid = saleTimePayment(s);
        cashReceived += paid.cash;
        onlineReceived += paid.online;
        dueToReceive += outstandingDue(s);
    });

    const dues = sumDueEvents(dueEvents({
        bills: { retail: bills.retail || [], wholesale: bills.wholesale || [], purchase: bills.purchase || [] },
        sessions,
        from: from.getTime(),
        to: to.getTime()
    }));

    const cashIn = round2(cashReceived + dues.receivedCash);
    const onlineIn = round2(onlineReceived + dues.receivedOnline);
    const cashOut = round2(cashPaid + expensesCash + dues.paidCash);
    const onlineOut = round2(onlinePaid + expensesOnline + dues.paidOnline);
    const totalIn = round2(cashIn + onlineIn);
    const totalOut = round2(cashOut + onlineOut);
    const netOutflow = totalOut - totalIn;

    const labour = labourSummary(purchaseBills, settings);

    return {
        from: from.getTime(),
        to: to.getTime(),
        purchases, purchaseCount: purchaseBills.length,
        sales, saleCount: saleBills.length,
        labour: { ...labour, gap: labourGap(labour.difference), packets: sumOf(labour.rows, r => r.packets) },
        businessExpenses, businessExpenseCount: business.length,
        personalExpenses, personalExpenseCount: personal.length + (Number(personalDay?.count) || 0),
        expenses: expensesTotal,
        expensesCash: round2(expensesCash), expensesOnline,
        cashIn, onlineIn, cashOut, onlineOut,
        totalIn, totalOut,
        net: totalIn - totalOut,
        netOutflow,
        netAmount: Math.abs(netOutflow),
        isOutflow: netOutflow >= 0,
        dueReceived: round2(dues.receivedCash + dues.receivedOnline),
        duePaid: round2(dues.paidCash + dues.paidOnline),
        dueToReceive, dueToPay,
        purchaseItems: itemRows(purchaseBills),
        saleItems: itemRows(saleBills),
        channels: { retail: channelSplit(retailBills), wholesale: channelSplit(wholesaleBills), purchase: channelSplit(purchaseBills) },
        dayBills: dayBillRows({ purchase: purchaseBills, wholesale: wholesaleBills, retail: retailBills })
    };
}
