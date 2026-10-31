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
import { itemValue, stockValue } from '../../www/js/utils/calc/stock.js';
import { StockManager } from '../../www/js/modules/stock.js';
import { InsightsManager } from '../../www/js/modules/insights.js';
import { UIManager } from '../../www/js/ui/ui-manager.js';

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
        expect(O.r2(stockValue(stock))).toBe(want.closing);
        expect(O.r2(Object.values(stock).reduce((a, x) => a + itemValue(x), 0))).toBe(want.closing);
    });
});

describe('Stock screen == oracle (S1, S2, S3, S5)', () => {
    const want = O.stockReplay(data);
    const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../www/templates/stock.html'), 'utf8');
    beforeEach(async () => {
        document.body.innerHTML = TEMPLATE;
        const stock = await FirebaseService.calculateStock();
        AppState.stock = stock;
        AppState.stockReady = true;
        jest.spyOn(FirebaseService, 'getStock').mockImplementation(async () => copy(stock));
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
    });
    const rows = () => [...document.querySelectorAll('#stockList .stock-item')].map(el => el.textContent.replace(/\s+/g, ' '));
    const itemOf = (id) => FIX.items.find(i => i.id === id);

    test('each row: kg (S1), rate per kg (S2) and value (S3)', async () => {
        await StockManager.renderStock();
        const shownRows = rows();
        const held = Object.entries(want.perItem).filter(([, v]) => v.qty > 0);
        expect(shownRows).toHaveLength(held.length);
        held.forEach(([id, v]) => {
            const row = shownRows.find(r => r.includes(itemOf(id).name));
            expect(row).toContain(`₹${v.rate.toFixed(2)}/kg`);
            expect(row).toContain(`${v.qty.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kg`);
            expect(row).toContain(`≈ ₹${rupee(v.value).toLocaleString('en-IN')}`);
        });
    });

    test('adjustment cards: value = quantity × its rate, else the average cost now (S5)', async () => {
        AppState.stockAdjustments = [
            ...copy(FIX.stockAdjustments),
            { id: 'a9', itemId: 'i-rice', itemName: 'Rice', adjustType: 'add', quantity: 3, rate: 31.5, previousStock: 60, newStock: 63, date: '2026-10-21T08:00:00', timestamp: NOW - 1 }
        ];
        await StockManager.renderAdjustmentHistory();
        const cards = [...document.querySelectorAll('#adjustmentHistory .history-item')];
        expect(cards).toHaveLength(AppState.stockAdjustments.length);
        AppState.stockAdjustments.forEach(adj => {
            const card = cards.find(c => c.textContent.includes(itemOf(adj.itemId).name) && c.textContent.includes(`${adj.quantity} kg`));
            const value = O.adjustmentValue(adj, want.perItem[adj.itemId]?.rate);
            expect(card.textContent).toContain(`Value: ₹${rupee(value)}`);
        });
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
    test('Worth: other accounts (M15 term) = assets − liabilities', () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 2500.4, type: 'asset' }, { name: 'Loan', balance: 1000, type: 'liability' }]));
        MoneyManager.init('worth');
        const row = [...document.querySelectorAll('#moneyWorthTerms .ins-row')].find(el => el.querySelector('[data-input]'));
        expect(Number(row.querySelector('[data-input]').textContent.replace(/[^\d.-]/g, ''))).toBe(rupee(2500.4 - 1000));
        localStorage.removeItem('financeCustomAccounts');
    });
});

describe('Money › Cash day chart (this month) == oracle (M14 per day)', () => {
    const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../www/templates/money.html'), 'utf8');
    test('each day\'s bar is that day\'s net money in, and the days add up to the month', () => {
        resetInsightsContextForTests();
        setInsightsContext({ preset: 'this-month' });
        document.body.innerHTML = TEMPLATE;
        document.getElementById('money').classList.add('active');
        Object.assign(MoneyManager, { snapshots: {}, snapshotsLoaded: true, sessionCache: new Map(), drawerCache: null, summaryCache: { sig: null, map: new Map(), computed: 0 } });
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        MoneyManager.init('cash');
        const bars = [...document.querySelectorAll('#moneyCashChart rect')];
        const [from] = O.monthRange(NOW);
        const days = [];
        for (let t = from; t <= NOW; t = O.dayRange(t)[1]) days.push(O.finance(data, O.dayRange(t)).F7_cashFlow);
        expect(bars).toHaveLength(days.length);
        bars.forEach((rect, i) => expect(Number(rect.textContent.split(': ')[1].replace(/[^\d.-]/g, ''))).toBe(rupee(days[i]) || 0));
        expect(O.r2(days.reduce((a, v) => a + v, 0))).toBe(O.metrics(data, [from, O.dayRange(NOW)[1]]).M14_net);
    });
});

describe('Insights shares == oracle (I2 split, I12 top-5 share)', () => {
    const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../www/templates/insights.html'), 'utf8');
    const OCT = [O.monthRange(NOW)[0], O.dayRange(NOW)[1]];
    beforeEach(() => {
        resetInsightsContextForTests();
        document.body.innerHTML = TEMPLATE;
        document.getElementById('insights').classList.add('active');
        Object.assign(MoneyManager, { snapshots: {} });
        jest.spyOn(MoneyManager, 'loadSnapshots').mockResolvedValue();
        Object.assign(InsightsManager, { section: 'items', seasonView: 'calendar', itemsType: 'both', partyKind: 'sales', seasonDocs: null, seasonLoading: null });
    });

    test('I2: retail / wholesale % of sales', () => {
        InsightsManager.init('items');
        const w = O.metrics(data, OCT);
        const pcts = [...document.querySelectorAll('#insightsSplit .ins-row span:last-child')].map(el => Number(el.textContent.split('·')[1].replace(/[^\d]/g, '')));
        expect(pcts).toEqual([Math.round((w.M1_retail / w.M1_sales) * 100), Math.round((w.M1_wholesale / w.M1_sales) * 100)]);
    });

    test.each(['sales', 'purchases'])('I12: top-5 %s share', (kind) => {
        InsightsManager.init('parties');
        InsightsManager.setPartyKind(kind);
        const want = O.topShare(data, OCT, kind);
        const text = document.getElementById('insightsPartiesTakeaway').textContent;
        expect(want).not.toBeNull();
        expect(text).toContain(`${want}%`);
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
