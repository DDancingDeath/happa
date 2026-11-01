/**
 * @fileoverview Same figure, two pages (docs/calculations.md EXP-KIND, BILL-DUE,
 * BILL-TOTAL). Each case is a synthetic record that two pages used to read
 * differently; every page must now give the oracle's number.
 *   A. EXP-KIND: Today and the drawer read `category || type` (any case); Money,
 *      Statements and finance-calc read only `category === 'personal'`.
 *   B. BILL-DUE: Wholesale › Outstanding used `payment.due || total − received`.
 *   C. BILL-TOTAL: Today read `billTotal` before `total` on purchases; billTotal()
 *      skipped a present 0.
 *   History cards / bill details and the Expenses lists use the same rules.
 */
import * as O from './oracle.js';
import { DayManager } from '../../www/js/modules/day.js';
import { AnomaliesManager } from '../../www/js/modules/anomalies.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { WholesaleSalesManager } from '../../www/js/modules/wholesale-sales.js';
import { FirebaseService } from '../../www/js/firebase/firestore-service.js';
import { moneySummary, expenseCategories, outstandingTotals } from '../../www/js/utils/business-metrics.js';
import { dayBook } from '../../www/js/utils/statements.js';
import { billListAmount, paymentChipsHtml } from '../../www/js/ui/bill-row.js';
import { HistoryManager } from '../../www/js/modules/history.js';
import { ExpensesManager } from '../../www/js/modules/miscellaneous.js';
import { billTotal, isPersonalExpense, outstandingDue } from '../../www/js/utils/money.js';
import { billQrText, receiptPayable } from '../../www/js/utils/bill-share.js';
import { AppState } from '../../www/js/utils/state.js';

const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();
const at = (d, h) => new Date(2026, 9, d, h, 0, 0).getTime();
const DAY = O.dayRange(NOW);

const EXPENSES = [
    { id: 'e1', date: '2026-10-21', timestamp: at(21, 9), amount: 100, type: 'personal' },
    { id: 'e2', date: '2026-10-21', timestamp: at(21, 9), amount: 50, category: 'Personal', type: 'Food' },
    { id: 'e3', date: '2026-10-21', timestamp: at(21, 9), amount: 20, category: 'business', type: 'personal' },
    { id: 'e4', date: '2026-10-21', timestamp: at(21, 9), amount: 200, category: 'business', type: 'Rent' },
    { id: 'e5', date: '2026-10-21', timestamp: at(21, 9), amount: 10 }
];
// Legacy purchase: line value 1,000 in `billTotal`, 970 after labour in `total`, no grandTotal.
const PURCHASES = [
    { id: 'p1', billNumber: 'P-1', customerName: 'Old Supplier', date: '2026-10-21', timestamp: at(21, 10),
        billTotal: 1000, total: 970, laborCharges: 30, items: [], payment: { cash: 970, online: 0, due: 0 } }
];
const WHOLESALE = [
    // Legacy: no payment object; 700 paid, 300 due.
    { id: 'w1', billNumber: 'W-1', source: 'sales-tab', customerName: 'Ram', date: '2026-09-02', timestamp: new Date(2026, 8, 2, 11).getTime(),
        total: 1000, cashPayment: 700, onlinePayment: 0, dueAmount: 300, items: [] },
    // Saved with 50 paise short (inside the split tolerance), due 0.
    { id: 'w2', billNumber: 'W-2', source: 'sales-tab', customerName: 'Shyam', date: '2026-09-03', timestamp: new Date(2026, 8, 3, 11).getTime(),
        total: 1000, payment: { cash: 999.5, online: 0, due: 0 }, items: [] },
    // Old-app opening record.
    { id: 'opening-wholesale-x', billNumber: 'W-OLD', source: 'sales-tab', customerName: 'Mohan', date: '2026-01-10', timestamp: new Date(2026, 0, 10).getTime(),
        total: 0, items: [], cashPayment: 0, onlinePayment: 0, dueAmount: 2000, payment: { cash: 0, online: 0, due: 2000, total: 0 },
        openingBalance: { migrated: true, amount: 2000, billTotal: 5000, paidBefore: 3000 } }
];
const data = { items: [], purchases: PURCHASES, wholesaleSales: WHOLESALE, retailSales: [], stockAdjustments: [], expenses: EXPENSES, withdrawals: [] };
const copy = (v) => JSON.parse(JSON.stringify(v));
const shown = (id) => Number(document.getElementById(id).textContent.replace(/[^\d.-]/g, ''));
const summary = (range) => moneySummary({ ...copy(data), base: { state: {}, from: -Infinity } }, range);

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(AppState, {
        items: [], purchaseHistory: copy(PURCHASES), salesHistory: copy(WHOLESALE), retailSalesHistory: [],
        stockAdjustments: [], expensesHistory: copy(EXPENSES), withdrawalsHistory: [], historyLoadedFrom: 0,
        userRole: 'owner', settings: { showHindi: false }
    });
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
});

function renderToday() {
    jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
    const ids = ['todayTotalPurchases', 'todayPurchaseCount', 'todayTotalSales', 'todaySaleCount', 'todayLaborCost', 'todayBusinessExpenses',
        'todayBusinessExpenseCount', 'todayPersonalExpenses', 'todayPersonalExpenseCount', 'todayCashReceived', 'todayOnlineReceived',
        'todayCashPaid', 'todayOnlinePaid', 'todayTotalIn', 'todayTotalOut', 'todayDueReceived', 'todayDuePaid', 'todayDueToReceive',
        'todayDueToPay', 'todayNetCashFlow', 'todayCashFlowLabel', 'todayTotalCashFlow', 'todayPurchaseItems', 'todaySaleItems'];
    document.body.innerHTML = ids.map(id => `<span id="${id}"></span>`).join('');
    DayManager.loadTodayData();
}

describe('A. EXP-KIND: one rule on Today, the drawer, Money, Statements', () => {
    const want = O.today(data, NOW);

    test('oracle: untagged and business-tagged are business; `type` personal without a category and any-case "Personal" are personal', () => {
        expect([want.T4_businessExpenses, want.T5_personalExpenses]).toEqual([230, 150]);
        expect(EXPENSES.map(isPersonalExpense)).toEqual([true, true, false, false, false]);
    });
    test('Today T4 / T5', () => {
        renderToday();
        expect([shown('todayBusinessExpenses'), shown('todayPersonalExpenses')]).toEqual([want.T4_businessExpenses, want.T5_personalExpenses]);
    });
    test('Cash drawer C3', () => {
        const tx = CashManagementManager.calculateTransactionsForDate('2026-10-21', { date: '2026-10-21' });
        expect([tx.businessExpenses, tx.personalExpenses]).toEqual([want.T4_businessExpenses, want.T5_personalExpenses]);
    });
    test('Money M4 / M8 and the M4 category rows', () => {
        const m = summary({ from: DAY[0], to: DAY[1] });
        expect([m.M4.total, m.M8.total]).toEqual([want.T4_businessExpenses, want.T5_personalExpenses]);
        expect(expenseCategories(EXPENSES, DAY[0], DAY[1]).reduce((a, r) => a + r.total, 0)).toBe(want.T4_businessExpenses);
    });
    test('Statements day book (ST1): personal rows, and a role without personal expenses sees business only', () => {
        const all = dayBook(copy(data), { from: DAY[0], to: DAY[1] });
        expect(all.rows.filter(r => r.kind === 'personal').reduce((a, r) => a + r.amount, 0)).toBe(want.T5_personalExpenses);
        expect(dayBook(copy(data), { from: DAY[0], to: DAY[1] }, { personal: false }).totals.expenses).toBe(want.T4_businessExpenses);
    });
});

describe('B. BILL-DUE: Wholesale › Outstanding = Outstanding / Money', () => {
    const due = Object.fromEntries(WHOLESALE.map(b => [b.id, O.openDue(b)]));

    test('oracle: legacy top-level due, the 50 paise inside the tolerance is not a due, opening record carries its amount', () => {
        expect(due).toEqual({ w1: 300, w2: 0, 'opening-wholesale-x': 2000 });
    });
    test('Wholesale › Outstanding lists each open bill with its BILL-DUE', () => {
        document.body.innerHTML = '<div id="salesOutstandingList"></div>';
        WholesaleSalesManager.outstandingParty = null;
        WholesaleSalesManager.renderSalesOutstanding();
        const rows = Object.fromEntries([...document.querySelectorAll('#salesOutstandingList .history-item')].map(row => {
            const id = row.querySelector('input[id^="payment_"]').id.slice('payment_'.length);
            return [id, Number(row.querySelector('.history-header').textContent.match(/₹([\d,.]+)/)[1].replace(/,/g, ''))];
        }));
        expect(rows).toEqual({ w1: due.w1, 'opening-wholesale-x': due['opening-wholesale-x'] });
        expect(Object.values(rows).reduce((a, v) => a + v, 0)).toBe(outstandingTotals(data).receivable.total);
    });
    test('the legacy bill shows what was received on it', () => {
        document.body.innerHTML = '<div id="salesOutstandingList"></div>';
        WholesaleSalesManager.renderSalesOutstanding();
        const text = document.getElementById('payment_w1').closest('.history-item').textContent.replace(/\s+/g, ' ');
        expect(text).toMatch(/₹1000.*₹700.*₹300/);
    });
    test('openDue (the phone\'s dues query) uses the same rule', () => {
        WHOLESALE.forEach(b => expect(FirebaseService.billHasOpenDue('wholesaleSales', b)).toBe(due[b.id] > 0));
        WHOLESALE.forEach(b => expect(outstandingDue(b)).toBe(due[b.id]));
    });
});

describe('C. BILL-TOTAL: one field order on Today, Money and History', () => {
    const want = O.today(data, NOW);

    test('oracle: a legacy purchase is worth its `total` (after labour), not the line value in `billTotal`', () => {
        expect(want.T1_purchases).toBe(970);
        expect(billTotal(PURCHASES[0])).toBe(970);
    });
    test('Today T1 = Money M16 for the same day', () => {
        renderToday();
        const m = summary({ from: DAY[0], to: DAY[1] });
        expect(shown('todayTotalPurchases')).toBe(want.T1_purchases);
        expect(m.M16.total).toBe(want.T1_purchases);
    });
    test('a present 0 counts: labour equal to the line value makes the payable ₹0', () => {
        const zero = { id: 'p0', date: '2026-10-21', timestamp: at(21, 11), billTotal: 600, laborCharges: 600, grandTotal: 0, amountPayable: 0,
            items: [], payment: { cash: 0, online: 0, due: 0 } };
        expect(O.billValue(zero)).toBe(0);
        expect(billTotal(zero)).toBe(0);
        AppState.purchaseHistory = [...copy(PURCHASES), copy(zero)];
        renderToday();
        const m = moneySummary({ ...copy(data), purchases: [...copy(PURCHASES), copy(zero)], base: { state: {}, from: -Infinity } }, { from: DAY[0], to: DAY[1] });
        expect([shown('todayTotalPurchases'), m.M16.total]).toEqual([want.T1_purchases, want.T1_purchases]);
    });
    test('Today T2 and History rows read the sale total the same way', () => {
        const sale = { id: 'r1', date: '2026-10-21', timestamp: at(21, 12), saleTotal: 500, total: 480, items: [], payment: { cash: 480, online: 0, due: 0 } };
        AppState.retailSalesHistory = [copy(sale)];
        renderToday();
        expect(shown('todayTotalSales')).toBe(O.billValue(sale));
        expect(billListAmount(sale)).toBe(O.billValue(sale));
    });
    test('the printed receipt and its bill QR (#107) show the same payable, in rupees as printed', () => {
        const sale = { id: 'r2', billNumber: 'R-2', date: '2026-10-21', timestamp: at(21, 12), total: 487.5, items: [], payment: { cash: 487.5, online: 0, due: 0 } };
        [PURCHASES[0], sale].forEach((b) => {
            expect(receiptPayable(b)).toBe(O.billValue(b));
            expect(billQrText(b).endsWith(`| ₹${Math.round(O.billValue(b))}`)).toBe(true);
        });
    });
});

describe('History cards, bill details and the Expenses lists use the same rules', () => {
    // Marked cleared with a due left on it; and a payment.cash of 0 next to an old top-level cashPayment.
    const CLEARED = { id: 'c1', billNumber: 'R-9', date: '2026-10-20', timestamp: at(20, 10), total: 1000, items: [],
        payment: { cash: 700, online: 0, due: 300 }, dueAmount: 300, cleared: true };
    const STALE = { id: 's1', billNumber: 'R-8', date: '2026-10-20', timestamp: at(20, 11), total: 1000, items: [],
        payment: { cash: 0, online: 1000, due: 0 }, cashPayment: 1000 };
    const modal = () => document.getElementById('billDetailsContent').textContent.replace(/\s+/g, ' ');
    beforeEach(() => {
        document.body.innerHTML = '<div id="billDetailsOverlay"><div id="billDetailsContent"></div></div>';
    });

    test('History card chips: BILL-DUE (0 when cleared) and BILL-PAY (payment.cash 0 wins)', () => {
        expect(O.openDue(CLEARED)).toBe(0);
        expect(paymentChipsHtml(CLEARED)).not.toContain('payment-due');
        expect(paymentChipsHtml(STALE)).not.toContain('payment-cash');
        expect(paymentChipsHtml(STALE)).toContain('payment-online');
    });
    test('History bill details show no due on a cleared bill', async () => {
        AppState.retailSalesHistory = [copy(CLEARED)];
        await HistoryManager.viewBill(0, 'retail');
        expect(modal()).toContain('₹700');
        expect(modal()).not.toContain('Due:');
    });
    test('Wholesale bill details show no due on a cleared bill', async () => {
        AppState.salesHistory = [copy({ ...CLEARED, source: 'sales-tab' })];
        await WholesaleSalesManager.reprintSale(0);
        expect(modal()).toContain('₹700');
        expect(modal()).not.toContain('Due:');
    });
    test('Expenses page lists: EXP-KIND (untagged → business, type "personal" with no category → personal)', () => {
        document.body.innerHTML = '<div id="businessExpenseHistoryList"></div><div id="personalExpenseHistoryList"></div>';
        ExpensesManager.renderBusinessExpenseHistory();
        ExpensesManager.renderPersonalExpenseHistory();
        const ids = (el) => [...document.getElementById(el).innerHTML.matchAll(/viewExpenseDetails\('(\w+)'/g)].map(m => m[1]).sort();
        expect(ids('personalExpenseHistoryList')).toEqual(EXPENSES.filter(e => O.isPersonalExpenseOracle(e)).map(e => e.id).sort());
        expect(ids('businessExpenseHistoryList')).toEqual(EXPENSES.filter(e => !O.isPersonalExpenseOracle(e)).map(e => e.id).sort());
    });
});
