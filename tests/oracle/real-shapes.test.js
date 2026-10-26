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
import { FinanceManager } from '../../www/js/modules/finance.js';
import { ReportsManager } from '../../www/js/modules/reports.js';
import { AnalyticsManager } from '../../www/js/modules/analytics.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { AppState } from '../../www/js/utils/state.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/real-shapes.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const E = FIX.expected;

/**
 * Spec IDs (prefixed by the screen) the app gets wrong on these shapes. Each entry is a skipped test.
 */
const BUGS = {
    // BUG: see #49 — Analytics reads "D/M/YYYY, h:mm:ss pm" expense dates with new Date()
    'analyticsMonth.A3_expenses': 49, 'analyticsMonth.A3_expenseCount': 49,
    // BUG: see #220 — Analytics outstanding counts cleared bills that still carry their old due
    'analyticsMonth.A5_payable': 220, 'analyticsMonth.A5_payableCount': 220
};
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

describe('Reports == oracle with opening records', () => {
    const SCREEN = {
        R1_purchases: 'reportsTotalPurchases', R1_purchaseCount: 'reportsPurchaseCount', R2_sales: 'reportsTotalSales', R2_saleCount: 'reportsSaleCount',
        R4_cash: 'reportsCashPayment', R5_online: 'reportsOnlinePayment', R6_dueToPay: 'reportsDueToPay', R7_dueToReceive: 'reportsDueToReceive'
    };
    const render = (filter) => {
        jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
        jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
        spans([...Object.values(SCREEN), 'reportsGrossProfit', 'reportsTotalLabor', 'reportsTotalVolume', 'reportsProfitMargin']);
        ReportsManager.currentDateFilter = filter;
        ReportsManager.renderOverview();
    };
    Object.keys(E.reportsDay).forEach(id => {
        specTest(`reportsDay.${id}`)(`today: ${id}`, () => { render('today'); expect(shown(SCREEN[id])).toBe(E.reportsDay[id]); });
    });
    Object.keys(E.reportsAll).forEach(id => {
        specTest(`reportsAll.${id}`)(`all time: ${id}`, () => { render('all'); expect(shown(SCREEN[id])).toBe(E.reportsAll[id]); });
    });
});

describe('Finance == oracle with opening records', () => {
    const summary = () => FinanceManager.computeSummary({ from: -Infinity, to: Infinity, cashSessions: { sessions: [], complete: true } });
    specTest('financeAll.F1_sales')('F1 sales', () => expect(summary().sales.total).toBe(E.financeAll.F1_sales));
    specTest('financeAll.F1_saleCount')('F1 sale count leaves opening records out', () => expect(summary().sales.count).toBe(E.financeAll.F1_saleCount));
    test('F9/F10 dues include opening records', () => {
        expect(FinanceManager.calculateOutstanding()).toEqual({ dueToReceive: E.financeAll.F9_dueToReceive, dueToPay: E.financeAll.F10_dueToPay });
    });
});

describe('Analytics == oracle (D/M/YYYY expense dates, cleared purchase with an old due)', () => {
    const SCREEN = {
        A3_expenses: 'monthExpenses', A3_expenseCount: 'monthExpensesCount', A5_payable: 'totalPayable', A5_payableCount: 'payableCount',
        A6_receivable: 'totalReceivable', A6_receivableCount: 'receivableCount'
    };
    beforeEach(() => {
        spans([...Object.values(SCREEN), 'monthRevenue', 'monthPurchases', 'monthProfit', 'monthProfitMargin', 'monthRevenueGrowth', 'monthPurchasesGrowth']);
        AnalyticsManager.renderMonthSummary();
        AnalyticsManager.renderOutstandingDues();
    });
    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(`analyticsMonth.${id}`)(`${id} (#${el})`, () => expect(shown(el)).toBe(E.analyticsMonth[id]));
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
