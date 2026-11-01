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
import { drawerDay, expectedCash, savedDifference } from '../../www/js/utils/calc/cash.js';
import { itemValue, stockValue } from '../../www/js/utils/calc/stock.js';
import { StockManager } from '../../www/js/modules/stock.js';
import { InsightsManager } from '../../www/js/modules/insights.js';
import { UIManager } from '../../www/js/ui/ui-manager.js';
import { isPersonalExpense } from '../../www/js/utils/money.js';
import { dayDocTotals, personalDaysFromRows, personalOnlineFromRows } from '../../www/js/utils/personal-expenses.js';
import { moneySummary } from '../../www/js/utils/business-metrics.js';

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

/**
 * VOID (#75): screens-voided.test.js runs this file again with a voided copy of every bill
 * (old-app dues included) in AppState. The oracle's data stays without them, so every
 * figure below must be unchanged: a voided bill counts nowhere.
 */
const WITH_VOIDED = !!global.__ORACLE_WITH_VOIDED__;
const withVoided = (list) => (WITH_VOIDED
    ? [...list, ...list.map(b => ({
        ...copy(b), id: `${b.id}-void`, billNumber: `${b.billNumber || b.id}-V`,
        voided: true, voidedAt: NOW - 60000, voidedBy: 'u-void', voidedByName: 'Test', voidReason: 'Entered twice', openDue: false
    }))]
    : list);

function loadAppState() {
    AppState.items = copy(FIX.items);
    AppState.purchaseHistory = withVoided(copy(FIX.purchases));
    AppState.salesHistory = withVoided(copy(FIX.wholesaleSales));
    AppState.retailSalesHistory = withVoided(copy(FIX.retailSales));
    AppState.stockAdjustments = copy(FIX.stockAdjustments);
    // Voided expenses (#99) count nowhere either
    AppState.expensesHistory = withVoided(copy(FIX.expenses));
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

describe('Today › By bill type (T18): paid later, write-off, voided, wholesale (today-channels.json)', () => {
    const CH = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/today-channels.json'), 'utf8'));
    const CH_NOW = O.timeOf(CH.now);
    const chData = { purchases: CH.purchases, wholesaleSales: CH.wholesaleSales, retailSales: CH.retailSales, expenses: [] };
    const KEYS = { retail: 'Retail', wholesale: 'Wholesale', purchase: 'Purchase' };

    test('the oracle reproduces the hand-worked split (voided bill out, yesterday\'s bill out)', () => {
        expect(O.todayChannels(O.withoutVoided(chData), CH_NOW).T18).toEqual(CH.expected);
    });

    specTest('T18')('todaySummary().channels == hand-worked split; each type adds up to its total', () => {
        const s = todaySummary({ bills: { purchase: copy(CH.purchases), wholesale: copy(CH.wholesaleSales), retail: copy(CH.retailSales) }, today: CH_NOW });
        expect(s.channels).toEqual(CH.expected);
        Object.values(s.channels).forEach(c => expect(O.r2(c.cash + c.online + c.paidLater + c.writtenOff + c.due)).toBe(c.total));
    });

    specTest('T18')('on screen: every part, the written-off line only where there is one', () => {
        jest.setSystemTime(new Date(CH_NOW));
        AppState.purchaseHistory = copy(CH.purchases);
        AppState.salesHistory = copy(CH.wholesaleSales);
        AppState.retailSalesHistory = copy(CH.retailSales);
        AppState.expensesHistory = [];
        CashManagementManager.todaySession = null;
        document.body.innerHTML = fs.readFileSync(path.resolve(__dirname, '../../www/templates/day.html'), 'utf8');
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        DayManager.loadTodayData();
        Object.entries(KEYS).forEach(([type, k]) => {
            const c = CH.expected[type];
            [['Total', 'total'], ['Cash', 'cash'], ['Online', 'online'], ['PaidLater', 'paidLater'], ['Due', 'due'], ['WrittenOff', 'writtenOff']]
                .forEach(([id, f]) => expect([type, f, shown(`todayCh${k}${id}`)]).toEqual([type, f, rupee(c[f])]));
            expect(document.getElementById(`todayCh${k}WrittenOffRow`).hidden).toBe(!(c.writtenOff > 0));
        });
        expect(document.querySelectorAll('#todayBillsList .today-bill-row')).toHaveLength(4);
    });
});
describe("Today › By bill type (T18) and Today's bills (T19) == oracle", () => {
    const want = O.todayChannels(data, NOW);
    const KEYS = { retail: 'Retail', wholesale: 'Wholesale', purchase: 'Purchase' };
    const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../www/templates/day.html'), 'utf8');

    test('the fixture has bills of more than one type today', () => {
        expect(Object.values(want.T18).filter(c => c.count > 0).length).toBeGreaterThan(1);
    });

    specTest('T18')('T18 todaySummary().channels, to the paise; dues add up to T15 / T16', () => {
        const s = todaySummary({
            bills: { purchase: copy(FIX.purchases), wholesale: copy(FIX.wholesaleSales), retail: copy(FIX.retailSales) },
            expenses: copy(FIX.expenses), sessions: FIX.session ? [copy(FIX.session)] : [], settings: {}, today: NOW
        });
        expect(s.channels).toEqual(want.T18);
        const today = O.today(data, NOW, FIX.session);
        expect(O.r2(want.T18.retail.due + want.T18.wholesale.due)).toBe(today.T15_dueToReceive);
        expect(want.T18.purchase.due).toBe(today.T16_dueToPay);
    });

    describe('on screen', () => {
        beforeEach(() => {
            document.body.innerHTML = TEMPLATE;
            jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
            CashManagementManager.todaySession = copy(FIX.session);
            DayManager.showAllBills = true;
            DayManager.loadTodayData();
        });
        afterEach(() => { DayManager.showAllBills = false; });

        specTest('T18')('T18 cards', () => {
            Object.entries(KEYS).forEach(([type, k]) => {
                const c = want.T18[type];
                ['Total', 'Cash', 'Online', 'Due'].forEach(f => expect([type, f, shown(`todayCh${k}${f}`)]).toEqual([type, f, rupee(c[f.toLowerCase()])]));
                expect(shown(`todayCh${k}Count`)).toBe(c.count);
            });
        });

        specTest('T19')('T19 rows: every bill of today once, newest first, with its total; a row opens that bill', () => {
            const rows = [...document.querySelectorAll('#todayBillsList .today-bill-row')];
            const ids = rows.map(r => /id:([^']+)'/.exec(r.getAttribute('onclick'))[1]);
            expect([...ids].sort()).toEqual(want.T19.map(r => r.id).sort());
            const byId = Object.fromEntries(want.T19.map(r => [r.id, r]));
            const times = ids.map(id => byId[id].at);
            expect(times).toEqual([...times].sort((a, b) => b - a));
            rows.forEach((r, i) => expect(Number(r.querySelector('.today-bill-total').textContent.replace(/[^\d.-]/g, ''))).toBe(rupee(byId[ids[i]].total)));
        });
    });
});
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
    test('calc/cash drawerDay() alone == oracle C1–C7, C8 = counted − C7', () => {
        const day = drawerDay({
            date: FIX.session.date,
            bills: { wholesale: copy(FIX.wholesaleSales), retail: copy(FIX.retailSales), purchase: copy(FIX.purchases) },
            expenses: copy(FIX.expenses),
            session: copy(FIX.session)
        });
        Object.entries(MAP).forEach(([id, field]) => expect([id, day[field]]).toEqual([id, want[id]]));
        expect(expectedCash(FIX.session, day)).toBe(want.C7_expected);
        expect(savedDifference(want.C7_expected - 12.5, want.C7_expected)).toBe(-12.5);
    });
});

// ------------------------------------------------- a role that can't read personal expenses (#98)

describe('Cash drawer and Today without the personal expense rows (#98) == oracle', () => {
    // The phone has only the business rows; personalExpenseDays holds each day's total as the
    // app's own rebuild (personalDaysFromRows) makes it. The figures must not change.
    const docs = personalDaysFromRows(FIX.expenses.filter(isPersonalExpense).map((e, i) => ({ id: `p${i}`, ...e })));
    const days = Object.fromEntries(Object.entries(docs).map(([d, amounts]) => [d, dayDocTotals({ amounts })]));
    beforeEach(() => {
        AppState.userRole = 'staff';
        AppState.settings = { showHindi: false, roleAccess: { staff: { personalExpenses: false } } };
        AppState.expensesHistory = copy(FIX.expenses).filter(e => !isPersonalExpense(e));
        jest.spyOn(FirebaseService, 'personalRowsLoaded').mockReturnValue(false);
        jest.spyOn(FirebaseService, 'personalExpenseDay').mockImplementation(d => days[d] || null);
        jest.spyOn(FirebaseService, 'loadPersonalExpenseDay').mockResolvedValue(null);
    });

    test('C3 personal and C7 expected', () => {
        const want = O.drawer(data, FIX.session);
        const tx = CashManagementManager.calculateTransactionsForDate(FIX.session.date, copy(FIX.session));
        expect(tx.personalExpenses).toBe(want.C3_personalExpenses);
        expect(tx.businessExpenses).toBe(want.C3_businessExpenses);
        expect(sessionTotals(FIX.session, tx).expected).toBe(want.C7_expected);
        const day = drawerDay({
            date: FIX.session.date,
            bills: { wholesale: FIX.wholesaleSales, retail: FIX.retailSales, purchase: FIX.purchases },
            expenses: copy(FIX.expenses).filter(e => !isPersonalExpense(e)),
            session: copy(FIX.session),
            personalReadable: false,
            personalDay: days[FIX.session.date]
        });
        expect(day).toEqual(tx);
    });

    test('T5 personal expenses and T11 total out on Today', () => {
        const want = O.today(data, NOW, FIX.session);
        document.body.innerHTML = ['todayPersonalExpenses', 'todayPersonalExpenseCount', 'todayBusinessExpenses', 'todayTotalOut']
            .map(id => `<div id="${id}"></div>`).join('');
        jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
        CashManagementManager.todaySession = copy(FIX.session);
        DayManager.loadTodayData();
        expect(shown('todayPersonalExpenses')).toBe(rupee(want.T5_personalExpenses));
        expect(shown('todayTotalOut')).toBe(rupee(want.T11_totalOut));
    });

    test('todaySummary with the day total == oracle T5, T8, T11', () => {
        const want = O.today(data, NOW, FIX.session);
        const s = todaySummary({
            bills: { purchase: FIX.purchases, wholesale: FIX.wholesaleSales, retail: FIX.retailSales },
            expenses: copy(FIX.expenses).filter(e => !isPersonalExpense(e)),
            personalDay: days[FIX.now.slice(0, 10)],
            sessions: [copy(FIX.session)], settings: {}, today: new Date(NOW)
        });
        expect(s.personalExpenses).toBe(want.T5_personalExpenses);
        expect(s.cashOut).toBe(want.T8_cashOut);
        expect(s.totalOut).toBe(want.T11_totalOut);
    });
});

// ------------------------------------------------- expenses paid online (EXP-MODE, #118)

describe('Expenses paid online (#118) == oracle', () => {
    // The same month with today's business and personal expense and an older one paid online;
    // e4 says cash, e5 has no mode (= cash).
    const MODES = { e1: 'online', e2: 'online', e3: 'online', e4: 'cash' };
    const online = FIX.expenses.map(e => (MODES[e.id] ? { ...e, paymentMode: MODES[e.id] } : { ...e }));
    const dataOnline = { ...data, expenses: online };
    const bills = () => ({ purchase: copy(FIX.purchases), wholesale: copy(FIX.wholesaleSales), retail: copy(FIX.retailSales) });
    beforeEach(() => { AppState.expensesHistory = copy(online); });

    test('Today: T8 counts cash expenses, T9 online ones; T4, T5 and T11 unchanged', () => {
        const want = O.today(dataOnline, NOW, FIX.session);
        const before = O.today(data, NOW, FIX.session);
        expect([want.T4_businessExpenses, want.T5_personalExpenses, want.T11_totalOut])
            .toEqual([before.T4_businessExpenses, before.T5_personalExpenses, before.T11_totalOut]);
        expect(want.T8_cashOut).toBe(O.r2(before.T8_cashOut - 200));
        expect(want.T9_onlineOut).toBe(O.r2(before.T9_onlineOut + 200));
        const s = todaySummary({ bills: bills(), expenses: copy(online), sessions: [copy(FIX.session)], settings: {}, today: new Date(NOW) });
        expect([s.businessExpenses, s.personalExpenses, s.cashOut, s.onlineOut, s.totalOut, s.expensesCash, s.expensesOnline])
            .toEqual([want.T4_businessExpenses, want.T5_personalExpenses, want.T8_cashOut, want.T9_onlineOut, want.T11_totalOut, 50, 200]);
    });

    test('Drawer: C3 and C7 count only cash expenses', () => {
        const want = O.drawer(dataOnline, FIX.session);
        expect(want.C7_expected).toBe(O.r2(O.drawer(data, FIX.session).C7_expected + 200));
        const tx = CashManagementManager.calculateTransactionsForDate(FIX.session.date, copy(FIX.session));
        expect([tx.businessExpenses, tx.personalExpenses, sessionTotals(FIX.session, tx).expected])
            .toEqual([want.C3_businessExpenses, want.C3_personalExpenses, want.C7_expected]);
    });

    test('Money: M13 split by mode, M4, M8 and M13 total unchanged', () => {
        const input = { ...dataOnline, base: { state: {}, from: -Infinity } };
        const m = moneySummary(input, { from: -Infinity, to: Infinity });
        const w = O.metrics(dataOnline, [-Infinity, Infinity]);
        const before = O.metrics(data, [-Infinity, Infinity]);
        expect(m.M13.cash).toBeCloseTo(w.M13_outCash, 2);
        expect(m.M13.online).toBeCloseTo(w.M13_outOnline, 2);
        expect(m.M13.expensesOnline).toBe(700);
        expect(m.M13.total).toBeCloseTo(before.M13_outCash + before.M13_outOnline, 2);
        expect([m.M4.total, m.M8.total]).toEqual([before.M4_businessExpenses, before.M8_personalExpenses]);
    });

    test('A role without the personal rows: the day doc flags the online one', () => {
        const rows = online.filter(isPersonalExpense).map(e => ({ ...e }));
        const amounts = personalDaysFromRows(rows)[FIX.session.date];
        const flags = personalOnlineFromRows(rows)[FIX.session.date];
        const day = dayDocTotals({ amounts, online: flags });
        expect(day).toMatchObject({ total: 80, online: 80 });
        const business = copy(online).filter(e => !isPersonalExpense(e));
        const wantToday = O.today(dataOnline, NOW, FIX.session);
        const s = todaySummary({ bills: bills(), expenses: business, personalDay: day, sessions: [copy(FIX.session)], settings: {}, today: new Date(NOW) });
        expect([s.personalExpenses, s.cashOut, s.onlineOut]).toEqual([wantToday.T5_personalExpenses, wantToday.T8_cashOut, wantToday.T9_onlineOut]);
        const wantDrawer = O.drawer(dataOnline, FIX.session);
        const tx = drawerDay({ date: FIX.session.date, bills: bills(), expenses: business, session: copy(FIX.session), personalReadable: false, personalDay: day });
        expect([tx.businessExpenses, tx.personalExpenses]).toEqual([wantDrawer.C3_businessExpenses, wantDrawer.C3_personalExpenses]);
    });
});
