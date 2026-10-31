/**
 * @fileoverview Every figure on the Today page for one local day
 * (docs/calculations.md T1–T17, T-LAB-1..3). Pure: no DOM, no AppState, no
 * Firestore; "today" is a parameter. modules/day.js gathers the inputs and
 * renders the result.
 * @module utils/calc/today
 */

import { activityBills, outstandingDue, round2 } from '../money.js';
import { endOfLocalDayExclusive, parseAnyBillDate, startOfLocalDay } from '../dates.js';
import { dueEvents, saleTimePayment, sumDueEvents } from '../due-payments.js';
import { labourGap, labourSummary } from '../labour.js';

/** Field of todaySummary() → its spec ID in docs/calculations.md. */
export const TODAY_SPEC = Object.freeze({
    purchases: 'T1', purchaseCount: 'T1',
    sales: 'T2', saleCount: 'T2',
    labour: 'T3, T-LAB-1, T-LAB-2, T-LAB-3',
    businessExpenses: 'T4', businessExpenseCount: 'T4',
    personalExpenses: 'T5', personalExpenseCount: 'T5',
    expenses: 'T8',
    cashIn: 'T6', onlineIn: 'T7', cashOut: 'T8', onlineOut: 'T9',
    totalIn: 'T10', totalOut: 'T11',
    net: 'T12', netOutflow: 'T12', netAmount: 'T12', isOutflow: 'T12',
    dueReceived: 'T13', duePaid: 'T14',
    dueToReceive: 'T15', dueToPay: 'T16',
    purchaseItems: 'T17', saleItems: 'T17'
});

// Today's own BILL-TOTAL field order (differs from money.billTotal for some legacy shapes; kept as shown).
const purchaseTotal = (p) => Number(p.grandTotal) || Number(p.amountPayable) || Number(p.billTotal) || Number(p.total) || 0;
const saleTotal = (s) => Number(s.grandTotal) || Number(s.total) || Number(s.saleTotal) || 0;
const expenseAmount = (e) => Number(e.amount) || Number(e.total) || 0;

/** EXP-KIND: personal only when tagged personal; untagged counts as business (#219). */
const isPersonal = (e) => String(e.category || e.type || '').toLowerCase() === 'personal';

const sumOf = (list, valueOf) => list.reduce((sum, x) => sum + valueOf(x), 0);

/**
 * T17 item cards: the day's lines grouped by item name, highest value first.
 * @param {Object[]} bills
 * @returns {Array<{name: string, count: number, quantity: number, totalValue: number, avgRate: ?number}>}
 */
export function itemRows(bills) {
    const byName = {};
    bills.forEach(bill => {
        (bill.items || []).forEach(item => {
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
 * Every Today figure for the local day containing `today`.
 * @param {Object} src
 * @param {{purchase?: Object[], wholesale?: Object[], retail?: Object[]}} src.bills All loaded bills (due payments on older bills count too)
 * @param {?Object[]} [src.expenses]
 * @param {Object[]} [src.sessions] Cash sessions of the day whose due legs count (each payment id once)
 * @param {Object} [src.settings] Labour settings (laborRate, labourPackageKg)
 * @param {*} [src.today=new Date()] Any instant of the day (Date, ms or a bill date)
 */
export function todaySummary({ bills = {}, expenses = [], sessions = [], settings = {}, today = new Date() } = {}) {
    const from = startOfLocalDay(today);
    const to = endOfLocalDayExclusive(today);
    const onDay = (record) => {
        const date = parseAnyBillDate(record.date);
        return date && date >= from && date < to;
    };

    const purchaseBills = activityBills(bills.purchase).filter(onDay);
    const wholesaleBills = activityBills(bills.wholesale).filter(onDay);
    const retailBills = activityBills(bills.retail).filter(onDay);
    const saleBills = [...wholesaleBills, ...retailBills];
    const dayExpenses = (expenses || []).filter(onDay);

    const purchases = sumOf(purchaseBills, purchaseTotal);
    const sales = sumOf(wholesaleBills, saleTotal) + sumOf(retailBills, saleTotal);

    const business = dayExpenses.filter(e => !isPersonal(e));
    const personal = dayExpenses.filter(isPersonal);
    const businessExpenses = sumOf(business, expenseAmount);
    const personalExpenses = sumOf(personal, expenseAmount);
    const expensesTotal = businessExpenses + personalExpenses;

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
    const cashOut = round2(cashPaid + expensesTotal + dues.paidCash);
    const onlineOut = round2(onlinePaid + dues.paidOnline);
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
        personalExpenses, personalExpenseCount: personal.length,
        expenses: expensesTotal,
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
        saleItems: itemRows(saleBills)
    };
}
