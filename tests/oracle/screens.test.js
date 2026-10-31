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
import { MoneyManager } from '../../www/js/modules/money.js';
import { setInsightsContext, resetInsightsContextForTests } from '../../www/js/utils/insights-context.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { FirebaseService } from '../../www/js/firebase/firestore-service.js';
import { AppState } from '../../www/js/utils/state.js';
import { sessionTotals } from '../../www/js/utils/cash-session.js';
import { todaySummary } from '../../www/js/utils/calc/today.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const E = FIX.expected;

/**
 * Spec IDs the app gets wrong today. Each entry is a skipped test.
 * Remove the entry when the referenced issue is fixed.
 */
const BUGS = {
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

describe('todaySummary() (utils/calc/today.js) == oracle, to the paise', () => {
    const want = O.today(data, NOW, FIX.session);
    const wantItems = O.todayItems(data, NOW);
    const s = todaySummary({
        bills: { purchase: copy(FIX.purchases), wholesale: copy(FIX.wholesaleSales), retail: copy(FIX.retailSales) },
        expenses: copy(FIX.expenses), sessions: FIX.session ? [copy(FIX.session)] : [], settings: {}, today: NOW
    });
    const FIELD = {
        T1_purchases: s.purchases, T1_purchaseCount: s.purchaseCount, T2_sales: s.sales, T2_saleCount: s.saleCount,
        T3_labour: s.labour.deducted.amount, T4_businessExpenses: s.businessExpenses, T5_personalExpenses: s.personalExpenses,
        T6_cashIn: s.cashIn, T7_onlineIn: s.onlineIn, T8_cashOut: s.cashOut, T9_onlineOut: s.onlineOut,
        T10_totalIn: s.totalIn, T11_totalOut: s.totalOut, T12_net: s.net, T13_dueReceived: s.dueReceived, T14_duePaid: s.duePaid,
        T15_dueToReceive: s.dueToReceive, T16_dueToPay: s.dueToPay
    };
    Object.entries(FIELD).forEach(([id, value]) => {
        specTest(id)(id, () => expect(O.r2(value)).toBe(want[id]));
    });
    test('T17 item cards', () => {
        const rows = (list) => list.map(r => ({ name: r.name, lines: r.count, kg: O.r2(r.quantity), value: O.r2(r.totalValue), avgRate: r.avgRate === null ? null : O.r2(r.avgRate) }));
        expect({ purchases: rows(s.purchaseItems), sales: rows(s.saleItems) }).toEqual(wantItems);
        expect(wantItems.purchases.length + wantItems.sales.length).toBeGreaterThan(0);
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
    test('S3/S4 stock value (Stock total, Money › Worth term)', () => {
        const value = Object.values(stock).reduce((a, x) => a + (x.quantity > 0 ? x.quantity * x.rate : 0), 0);
        expect(O.r2(value)).toBe(want.closing);
    });
});

// ------------------------------------------------------------------ Money (replaces Finance, Reports, Analytics)

describe('Money page (all time) == oracle', () => {
    const w = O.metrics(data, [-Infinity, Infinity]);
    const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../www/templates/money.html'), 'utf8');
    beforeEach(() => {
        resetInsightsContextForTests();
        setInsightsContext({ preset: 'all' });
        document.body.innerHTML = TEMPLATE;
        document.getElementById('money').classList.add('active');
        Object.assign(MoneyManager, { snapshots: {}, snapshotsLoaded: true, sessionCache: new Map(), drawerCache: null });
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
    });

    test('Profit: M1, M2, M3, M6, M16', () => {
        MoneyManager.init('profit');
        expect(shown('moneySales')).toBe(rupee(w.M1_sales));
        expect(shown('moneyCogs')).toBe(rupee(w.M2_cogs));
        expect(shown('moneyGross')).toBe(rupee(w.M3_gross));
        expect(shown('moneyProfitValue')).toBe(rupee(w.M6_profit));
        expect(shown('moneyPurchases')).toBe(rupee(w.M16_purchases));
    });
    test('Cash: M12, M13, M14', () => {
        MoneyManager.init('cash');
        expect(shown('moneyIn')).toBe(rupee(w.M12_inCash + w.M12_inOnline));
        expect(shown('moneyOut')).toBe(rupee(w.M13_outCash + w.M13_outOnline));
        expect(shown('moneyNetCash')).toBe(rupee(w.M14_net));
    });
    test('Spending: M4, M7, M8, M9, M10', () => {
        MoneyManager.init('spending');
        expect(shown('moneyBusiness')).toBe(rupee(w.M4_businessExpenses));
        expect(shown('moneyPersonal')).toBe(rupee(w.M8_personalExpenses));
        expect(shown('moneyWithdrawn')).toBe(rupee(w.M9_withdrawals));
        expect(shown('moneyKept')).toBe(rupee(w.M10_kept));
        expect(shown('moneyLabour')).toBe(rupee(w.M7_labour));
    });
    test('Worth: stock, to receive and to pay terms equal Stock and Outstanding (S4, O3, O4)', () => {
        MoneyManager.init('worth');
        const dues = O.dueTotals(data);
        const terms = [...document.querySelectorAll('#moneyWorthTerms [data-metric-ref]')]
            .map(el => [el.dataset.metricRef, Number(el.textContent.replace(/[^\d.-]/g, ''))]);
        expect(Object.fromEntries(terms.filter(([id]) => ['S4', 'O3', 'O4'].includes(id)).map(([id, v]) => [id, Math.abs(v)])))
            .toEqual({ S4: rupee(O.stockReplay(data).closing), O3: rupee(dues.payable), O4: rupee(dues.receivable) });
    });
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
