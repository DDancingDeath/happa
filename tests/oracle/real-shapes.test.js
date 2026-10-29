/**
 * @fileoverview Regression tests from shapes the real-data number audit found
 * (tools/audit/real-data-audit.js, #216). The fixture
 * (tests/fixtures/calculations/real-shapes.json) is anonymised: made-up names
 * and amounts that reproduce each shape.
 *
 *   1. The oracle must reproduce the hand-worked numbers in the fixture.
 *   2. The app's screens must match the oracle. A spec ID the app gets wrong
 *      today is in BUGS and its test is skipped (ORACLE_RUN_SKIPPED=1 runs
 *      them); delete the entry when the bug is fixed.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { DayManager } from '../../www/js/modules/day.js';
import { AnomaliesManager } from '../../www/js/modules/anomalies.js';
import { moneySummary, outstandingTotals } from '../../www/js/utils/business-metrics.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { AppState } from '../../www/js/utils/state.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/real-shapes.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const E = FIX.expected;

/**
 * Spec IDs (prefixed by the screen) the app gets wrong on these shapes. Each entry is a skipped test.
 */
const BUGS = {};
const specTest = (id) => (BUGS[id] && !process.env.ORACLE_RUN_SKIPPED ? test.skip : test);

const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));
const DAY = O.dayRange(NOW);

function shown(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} missing`);
    const m = el.textContent.replace(/[,\s₹]/g, '').match(/^([+-]?)(\d+(?:\.\d+)?)/);
    if (!m) throw new Error(`#${id} has no number: "${el.textContent}"`);
    return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}
const spans = (ids) => { document.body.innerHTML = ids.map(id => `<span id="${id}"></span>`).join(''); };

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    AppState.items = copy(FIX.items);
    AppState.purchaseHistory = copy(FIX.purchases);
    AppState.salesHistory = copy(FIX.wholesaleSales);
    AppState.retailSalesHistory = copy(FIX.retailSales);
    AppState.stockAdjustments = copy(FIX.stockAdjustments);
    AppState.expensesHistory = copy(FIX.expenses);
    AppState.withdrawalsHistory = copy(FIX.withdrawals);
    AppState.historyLoadedFrom = 0;
    AppState.userRole = 'owner';
    AppState.settings = { showHindi: false };
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
});

describe('oracle reproduces the hand-worked numbers (real-data shapes)', () => {
    test('Today: opening records stay out, the due payment on one counts', () => expect(O.today(data, NOW)).toEqual(E.today));
    test('Reports, that day and all time', () => {
        expect(pick(O.reports(data, DAY), Object.keys(E.reportsDay))).toEqual(E.reportsDay);
        expect(pick(O.reports(data, [-Infinity, Infinity]), Object.keys(E.reportsAll))).toEqual(E.reportsAll);
    });
    test('Finance, all time: dues include opening records', () => expect(pick(O.finance(data), Object.keys(E.financeAll))).toEqual(E.financeAll));
    test('Analytics, this month', () => expect(pick(O.analyticsMonth(data, NOW), Object.keys(E.analyticsMonth))).toEqual(E.analyticsMonth));
    test('Outstanding totals', () => expect(pick(O.outstanding(data), Object.keys(E.outstanding))).toEqual(E.outstanding));
});

describe('Today == oracle with opening records and a legacy later payment', () => {
    const SCREEN = {
        T1_purchases: 'todayTotalPurchases', T1_purchaseCount: 'todayPurchaseCount', T2_sales: 'todayTotalSales', T2_saleCount: 'todaySaleCount',
        T4_businessExpenses: 'todayBusinessExpenses', T6_cashIn: 'todayCashReceived', T7_onlineIn: 'todayOnlineReceived',
        T8_cashOut: 'todayCashPaid', T9_onlineOut: 'todayOnlinePaid', T10_totalIn: 'todayTotalIn', T11_totalOut: 'todayTotalOut',
        T13_dueReceived: 'todayDueReceived', T14_duePaid: 'todayDuePaid', T15_dueToReceive: 'todayDueToReceive', T16_dueToPay: 'todayDueToPay'
    };
    beforeEach(() => {
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        spans([...Object.values(SCREEN), 'todayLaborCost', 'todayPersonalExpenses', 'todayNetCashFlow', 'todayCashFlowLabel', 'todayTotalCashFlow',
            'todayBusinessExpenseCount', 'todayPersonalExpenseCount', 'todayPurchaseItems', 'todaySaleItems']);
        DayManager.loadTodayData();
    });
    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(`today.${id}`)(`${id} (#${el})`, () => expect(shown(el)).toBe(Math.round(E.today[id])));
    });
});

describe('Money (calculation layer) == oracle with opening records (replaces Reports, Finance, Analytics)', () => {
    const summary = (range) => moneySummary({ ...data, base: { state: {}, from: -Infinity } }, range);
    const bills = (m) => ({ R1_purchases: m.M16.total, R1_purchaseCount: m.M16.count, R2_sales: m.M1.total, R2_saleCount: m.M1.count });
    const keys = ['R1_purchases', 'R1_purchaseCount', 'R2_sales', 'R2_saleCount'];
    test('that day: purchases and sales with their bill counts leave opening records out', () => {
        expect(bills(summary({ from: DAY[0], to: DAY[1] }))).toEqual(pick(E.reportsDay, keys));
    });
    test('all time: the same, and F1 sales', () => {
        const m = summary({ from: -Infinity, to: Infinity });
        expect(bills(m)).toEqual(pick(E.reportsAll, keys));
        expect([m.M1.total, m.M1.count]).toEqual([E.financeAll.F1_sales, E.financeAll.F1_saleCount]);
    });
    test('dues include opening records; a cleared purchase with an old due is not counted (#220)', () => {
        const d = outstandingTotals(data);
        expect([d.receivable.total, d.payable.total]).toEqual([E.financeAll.F9_dueToReceive, E.financeAll.F10_dueToPay]);
        expect([d.payable.total, d.payable.count, d.receivable.total, d.receivable.count])
            .toEqual([E.analyticsMonth.A5_payable, E.analyticsMonth.A5_payableCount, E.analyticsMonth.A6_receivable, E.analyticsMonth.A6_receivableCount]);
    });
    test('this month\'s expenses read D/M/YYYY dates (#49)', () => {
        const [from] = O.monthRange(NOW);
        const m = summary({ from, to: NOW + 1 });
        expect(m.M4.total).toBe(E.analyticsMonth.A3_expenses);
        expect(m.M4.count).toBe(E.analyticsMonth.A3_expenseCount);
    });
});

describe('Outstanding == oracle (opening records are dues)', () => {
    const total = (filter) => {
        document.body.innerHTML = '<div id="dueAging"></div><div id="dueList"></div>';
        AppState.currentDueFilter = filter;
        OutstandingManager.partyFilter = null;
        OutstandingManager.agingBucket = null;
        OutstandingManager.renderDue();
        return Number(document.querySelector('#dueAging .aging-total').textContent.replace(/[^\d.]/g, ''));
    };
    test('O3 payables total', () => expect(total('purchase')).toBe(E.outstanding.O3_payableTotal));
    test('O4 receivables total', () => expect(total('sale')).toBe(E.outstanding.O4_receivableTotal));
});
