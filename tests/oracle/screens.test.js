/**
 * @fileoverview Oracle tests for every displayed number (#216, #45).
 *
 * For each spec ID in docs/calculations.md:
 *   1. the independent oracle (tests/oracle/oracle.js) must reproduce the
 *      hand-worked number in tests/fixtures/calculations/shop-month.json, and
 *   2. the app's screen (DOM text) or calculation must match the oracle.
 * A spec ID the app currently gets wrong is listed in BUGS with its issue and
 * its test is skipped — delete the entry when the issue is fixed and the test
 * turns on. Screens show whole rupees, so screen values are compared after
 * rounding the oracle to the rupee.
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
import { FirebaseService } from '../../www/js/firebase/firestore-service.js';
import { AppState } from '../../www/js/utils/state.js';
import { sessionTotals } from '../../www/js/utils/cash-session.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const E = FIX.expected;

/**
 * Spec IDs the app gets wrong today. Each entry is a skipped test.
 * Remove the entry when the referenced issue is fixed.
 */
const BUGS = {
    // BUG: see #219 — Today leaves out expenses that are neither 'business' nor 'personal'
    T4_businessExpenses: 219, T8_cashOut: 219, T11_totalOut: 219, T12_net: 219,
    // BUG: see #49 — Analytics parses DD/MM/YYYY dates with new Date()
    A1_revenue: 49, A2_purchases: 49,
    // BUG: see #220 — Analytics outstanding ignores cleared bills and dueAmount-only bills
    A6_receivable: 220, A6_receivableCount: 220
};

/** test, or test.skip for a spec ID listed in BUGS (ORACLE_RUN_SKIPPED=1 runs them all). */
const specTest = (id) => (BUGS[id] && !process.env.ORACLE_RUN_SKIPPED ? test.skip : test);

const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const copy = (v) => JSON.parse(JSON.stringify(v));

/** Number shown in an element: "₹1,274", "-₹52", "+₹350", "1,274.5" → number. */
function shown(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} missing`);
    const text = el.textContent.replace(/[,\s₹]/g, '');
    const m = text.match(/^([+-]?)(\d+(?:\.\d+)?)/);
    if (!m) throw new Error(`#${id} has no number: "${el.textContent}"`);
    return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}
const rupee = (v) => Math.round(v);

function loadAppState() {
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
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    loadAppState();
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'stockAdjustments', 'expensesHistory', 'withdrawalsHistory'].forEach(k => { AppState[k] = []; });
});

// ------------------------------------------------------------------ the oracle itself

describe('oracle reproduces the hand-worked numbers', () => {
    test('Today (T*)', () => expect(O.today(data, NOW, FIX.session)).toEqual(E.today));
    test('Stock (S*) and the check line', () => {
        const s = O.stockReplay(data);
        expect({ opening: s.opening, purchases: s.purchases, cogs: s.cogs, adjustments: s.adjustments, closing: s.closing })
            .toEqual({ opening: E.stock.opening, purchases: E.stock.purchases, cogs: E.stock.cogs, adjustments: E.stock.adjustments, closing: E.stock.closing });
        Object.entries(E.stock.perItem).forEach(([k, v]) => {
            expect(s.perItem[k].qty).toBeCloseTo(v.qty, 6);
            expect(O.r2(s.perItem[k].value)).toBe(v.value);
        });
    });
    test('Finance, all time (F*)', () => {
        const { F8_check, ...rest } = O.finance(data);
        expect(rest).toEqual(E.financeAll);
        expect(O.r2(F8_check.opening + F8_check.purchases - F8_check.cogs + F8_check.adjustments)).toBe(F8_check.closing);
    });
    test('Reports, this month (R*)', () => expect(O.reports(data, [O.monthRange(NOW)[0], O.monthRange(NOW)[1]])).toEqual(E.reportsMonth));
    test('Analytics, this month (A*)', () => expect(O.analyticsMonth(data, NOW)).toEqual(E.analyticsMonth));
    test('Outstanding (O*)', () => expect(O.outstanding(data)).toEqual(E.outstanding));
    test('Cash drawer (C*)', () => expect(O.drawer(data, FIX.session)).toEqual(E.drawer));
});

// ------------------------------------------------------------------ Today

describe('Today screen == oracle', () => {
    const SCREEN = {
        T1_purchases: 'todayTotalPurchases', T2_sales: 'todayTotalSales', T3_labour: 'todayLaborCost',
        T4_businessExpenses: 'todayBusinessExpenses', T5_personalExpenses: 'todayPersonalExpenses',
        T6_cashIn: 'todayCashReceived', T7_onlineIn: 'todayOnlineReceived', T8_cashOut: 'todayCashPaid', T9_onlineOut: 'todayOnlinePaid',
        T10_totalIn: 'todayTotalIn', T11_totalOut: 'todayTotalOut', T13_dueReceived: 'todayDueReceived', T14_duePaid: 'todayDuePaid',
        T15_dueToReceive: 'todayDueToReceive', T16_dueToPay: 'todayDueToPay'
    };
    const want = O.today(data, NOW, FIX.session);
    beforeEach(() => {
        const ids = [...Object.values(SCREEN), 'todayPurchaseCount', 'todaySaleCount', 'todayNetCashFlow', 'todayCashFlowLabel',
            'todayTotalCashFlow', 'todayBusinessExpenseCount', 'todayPersonalExpenseCount', 'todayPurchaseItems', 'todaySaleItems'];
        document.body.innerHTML = ids.map(id => `<div id="${id}"></div>`).join('');
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        CashManagementManager.todaySession = copy(FIX.session);
        DayManager.loadTodayData();
    });

    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(id)(`${id} (#${el})`, () => expect(shown(el)).toBe(rupee(want[id])));
    });
    test('T1/T2 bill counts', () => {
        expect(shown('todayPurchaseCount')).toBe(want.T1_purchaseCount);
        expect(shown('todaySaleCount')).toBe(want.T2_saleCount);
    });
    specTest('T12_net')('T12_net: net flow amount and its in/out label', () => {
        expect(shown('todayNetCashFlow')).toBe(rupee(Math.abs(want.T12_net)));
        expect(document.getElementById('todayCashFlowLabel').textContent).toMatch(want.T12_net < 0 ? /outflow/i : /inflow/i);
    });
});

// ------------------------------------------------------------------ Stock

describe('Stock == oracle', () => {
    const want = O.stockReplay(data);
    let stock;
    beforeEach(async () => { stock = await FirebaseService.calculateStock(); });

    test('S1 quantity per item', () => {
        Object.entries(want.perItem).forEach(([k, v]) => expect(stock[k].quantity).toBeCloseTo(v.qty, 6));
    });
    test('S2 average cost per item', () => {
        Object.entries(want.perItem).forEach(([k, v]) => expect(stock[k].rate).toBeCloseTo(v.rate, 6));
    });
    test('S3/F6 stock value (Finance → Assets "Stock value")', () => {
        AppState.stock = stock;
        expect(O.r2(FinanceManager.calculateStockValue())).toBe(want.closing);
    });
});

// ------------------------------------------------------------------ Finance

describe('Finance == oracle (all time)', () => {
    const want = O.finance(data);
    const SCREEN = {
        F1_sales: 'financeRevenue', F2_cogs: 'financeCogs', F3_businessExpenses: 'financeBusinessExp', F4_profit: 'financeNetProfit',
        F5_personalExpenses: 'financePersonalExp', F6_stockValue: 'financeStockNow', F11_withdrawals: 'financeTotalWithdrawn'
    };
    beforeEach(() => {
        FinanceManager.currentDateFilter = 'all';
        document.body.innerHTML = `<div id="financeDashboardSection">${[...Object.values(SCREEN), 'financeProfitPeriod', 'financeAfterPersonalLine',
            'financeRevenueCount', 'financeBusinessExpCount', 'financePersonalExpCount', 'financeAvailableBalance', 'financeProfitWarning']
            .map(id => `<span id="${id}"></span>`).join('')}</div>`;
        ['renderMonthlyChart', 'renderProfitBreakdown', 'renderStockBreakdown', 'renderCashFlow', 'renderFullHistoryPrompt']
            .forEach(fn => jest.spyOn(FinanceManager, fn).mockImplementation(() => {}));
        FinanceManager.renderDashboard();
    });

    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(id)(`${id} (#${el})`, () => expect(shown(el)).toBe(rupee(want[id])));
    });
    test('F1 sale count', () => expect(shown('financeRevenueCount')).toBe(want.F1_saleCount));
    test('F7 cash flow (money in − money out)', () => {
        const s = FinanceManager.computeSummary({ from: -Infinity, to: Infinity, cashSessions: { sessions: [], complete: true } });
        expect(s.cash.moneyIn).toBeCloseTo(want.F7_moneyIn, 2);
        expect(s.cash.moneyOut).toBeCloseTo(want.F7_moneyOut, 2);
        expect(s.cash.net).toBeCloseTo(want.F7_cashFlow, 2);
    });
    test('F8 check line: opening + purchases − cost of goods sold + adjustments = closing', () => {
        const s = FinanceManager.computeSummary({ from: -Infinity, to: Infinity, cashSessions: { sessions: [], complete: true } }).stock;
        const c = want.F8_check;
        expect([s.opening, s.purchases, s.cogs, s.adjustments, s.closing].map(O.r2)).toEqual([c.opening, c.purchases, c.cogs, c.adjustments, c.closing]);
        expect(s.gap).toBeCloseTo(0, 2);
    });
    test('F9/F10 due to receive / due to pay', () => {
        expect(FinanceManager.calculateOutstanding()).toEqual({ dueToReceive: want.F9_dueToReceive, dueToPay: want.F10_dueToPay });
    });
});

// ------------------------------------------------------------------ Reports

describe('Reports overview (this month) == oracle', () => {
    const SCREEN = {
        R1_purchases: 'reportsTotalPurchases', R2_sales: 'reportsTotalSales', R3_profit: 'reportsGrossProfit',
        R4_cash: 'reportsCashPayment', R5_online: 'reportsOnlinePayment', R6_dueToPay: 'reportsDueToPay',
        R7_dueToReceive: 'reportsDueToReceive', R8_labour: 'reportsTotalLabor'
    };
    const want = O.reports(data, O.monthRange(NOW));
    beforeEach(() => {
        document.body.innerHTML = [...Object.values(SCREEN), 'reportsTotalVolume', 'reportsPurchaseCount', 'reportsSaleCount', 'reportsProfitMargin']
            .map(id => `<span id="${id}"></span>`).join('');
        jest.spyOn(ReportsManager, 'renderTrendChart').mockImplementation(() => {});
        jest.spyOn(ReportsManager, 'renderTopItems').mockImplementation(() => {});
        ReportsManager.currentDateFilter = 'month';
        ReportsManager.renderOverview();
    });
    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(id)(`${id} (#${el})`, () => expect(shown(el)).toBe(rupee(want[id])));
    });
    test('R1/R2 bill counts', () => {
        expect(shown('reportsPurchaseCount')).toBe(want.R1_purchaseCount);
        expect(shown('reportsSaleCount')).toBe(want.R2_saleCount);
    });
});

// ------------------------------------------------------------------ Analytics

describe('Analytics (this month, outstanding) == oracle', () => {
    const SCREEN = {
        A1_revenue: 'monthRevenue', A2_purchases: 'monthPurchases', A3_expenses: 'monthExpenses', A4_profit: 'monthProfit',
        A5_payable: 'totalPayable', A5_payableCount: 'payableCount', A6_receivable: 'totalReceivable', A6_receivableCount: 'receivableCount'
    };
    const want = O.analyticsMonth(data, NOW);
    beforeEach(() => {
        document.body.innerHTML = [...Object.values(SCREEN), 'monthProfitMargin', 'monthExpensesCount', 'monthRevenueGrowth', 'monthPurchasesGrowth']
            .map(id => `<span id="${id}"></span>`).join('');
        AnalyticsManager.renderMonthSummary();
        AnalyticsManager.renderOutstandingDues();
    });
    Object.entries(SCREEN).forEach(([id, el]) => {
        specTest(id)(`${id} (#${el})`, () => expect(shown(el)).toBe(rupee(want[id])));
    });
    test('A3 expense count', () => expect(shown('monthExpensesCount')).toBe(want.A3_expenseCount));
});

// ------------------------------------------------------------------ Outstanding

describe('Outstanding screen == oracle', () => {
    const want = O.outstanding(data);
    /** Per-party dues from the bill rows, plus the aging panel total. */
    function screen(filter) {
        document.body.innerHTML = '<div id="dueAging"></div><div id="dueList"></div>';
        AppState.currentDueFilter = filter;
        OutstandingManager.partyFilter = null;
        OutstandingManager.agingBucket = null;
        OutstandingManager.renderDue();
        const byParty = {};
        document.querySelectorAll('#dueList .history-item').forEach(row => {
            const name = row.querySelector('.history-header strong')?.textContent || '';
            const due = Number(row.querySelector('.history-header').textContent.match(/Due: ₹([\d,.]+)/)[1].replace(/,/g, ''));
            byParty[name] = O.r2((byParty[name] || 0) + due);
        });
        const total = Number(document.querySelector('#dueAging .aging-total').textContent.replace(/[^\d.]/g, ''));
        return { byParty, total };
    }
    test('O1 payable per party', () => expect(screen('purchase').byParty).toEqual(want.O1_payableByParty));
    test('O2 receivable per party (retail)', () => expect(screen('sale').byParty).toEqual(want.O2_receivableByParty));
    test('O3 payable total (aging panel)', () => expect(screen('purchase').total).toBe(rupee(want.O3_payableTotal)));
    test('O4 receivable total (aging panel)', () => expect(screen('sale').total).toBe(rupee(want.O4_receivableTotal)));
});

// ------------------------------------------------------------------ Cash drawer

describe('Cash drawer == oracle', () => {
    const want = O.drawer(data, FIX.session);
    let tx;
    beforeEach(() => { tx = CashManagementManager.calculateTransactionsForDate(FIX.session.date, copy(FIX.session)); });
    const MAP = {
        C1_cashSales: 'cashSales', C2_cashPurchases: 'cashPurchases', C3_businessExpenses: 'businessExpenses',
        C3_personalExpenses: 'personalExpenses', C4_dueReceived: 'dueReceived', C5_duePaid: 'duePaid', C6_deposits: 'cashDeposits'
    };
    Object.entries(MAP).forEach(([id, field]) => {
        specTest(id)(`${id} (${field})`, () => expect(tx[field]).toBe(want[id]));
    });
    test('C7 expected = opening + cash in − cash out', () => {
        expect(sessionTotals(FIX.session, tx).expected).toBe(want.C7_expected);
        CashManagementManager.todaySession = copy(FIX.session);
        CashManagementManager.todayTransactions = tx;
        expect(CashManagementManager.calculateExpectedCash()).toBe(want.C7_expected);
    });
});
