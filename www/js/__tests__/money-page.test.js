/**
 * @fileoverview Money page (redesign phase 2): every figure on screen equals the
 * independent oracle, comparisons use month snapshots, takeaways explain the
 * number, taps open the breakdown, and snapshots round-trip.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../../tests/oracle/oracle.js';
import { MoneyManager, compareHtml, barsSvg, takeawayHtml } from '../modules/money.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { FinanceBreakdownSheet } from '../ui/finance-breakdown-sheet.js';
import { AppState } from '../utils/state.js';
import { moneySummary, change, comparisonRanges, periodRange } from '../utils/business-metrics.js';
import {
    buildSnapshot, figuresFromSnapshot, partialFigures, sumFigures, rangeFigures, monthsToRoll, monthKeysBetween, lastMonthKeys, monthBounds, SNAPSHOT_VERSION
} from '../utils/month-snapshots.js';
import { profitTakeaways, cashTakeaways, spendingTakeaways, worthTakeaways } from '../utils/takeaways.js';
import { setInsightsContext, resetInsightsContextForTests, getInsightsContext, contextMonth } from '../utils/insights-context.js';
import { t } from '../i18n/index.js';

const ROOT = path.resolve(__dirname, '../../..');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const copy = (v) => JSON.parse(JSON.stringify(v));
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'www/templates/money.html'), 'utf8');

/** Number in an element's text: "₹1,274" / "-₹90.96" / "₹6,712 · 2 bills" → number. */
function shown(id) {
    const text = document.getElementById(id).textContent.replace(/[,\s₹]/g, '');
    const m = text.match(/^([+\-−]?)(\d+(?:\.\d+)?)/);
    if (!m) return NaN;
    return (m[1] === '-' || m[1] === '−' ? -1 : 1) * Number(m[2]);
}
const rupee = (v) => Math.round(v);

function load() {
    AppState.items = copy(FIX.items);
    AppState.purchaseHistory = copy(FIX.purchases);
    AppState.salesHistory = copy(FIX.wholesaleSales);
    AppState.retailSalesHistory = copy(FIX.retailSales);
    AppState.stockAdjustments = copy(FIX.stockAdjustments);
    AppState.expensesHistory = copy(FIX.expenses);
    AppState.withdrawalsHistory = copy(FIX.withdrawals);
    AppState.historyLoadedFrom = 0;
    AppState.userRole = 'owner';
    AppState.settings = {};
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    load();
    resetInsightsContextForTests();
    document.body.innerHTML = TEMPLATE;
    document.getElementById('money').classList.add('active');
    MoneyManager.snapshots = {};
    MoneyManager.snapshotsLoaded = true;
    MoneyManager.sessionCache = new Map();
    MoneyManager.section = 'profit';
    MoneyManager.summaryCache = { sig: null, map: new Map(), computed: 0 };
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const OCT = [new Date(2026, 9, 1).getTime(), new Date(2026, 9, 22).getTime()];

describe('figures on screen == oracle (this month)', () => {
    test('Profit section: M1, M2, M3, M5, M6, M7, M16', () => {
        MoneyManager.init('profit');
        const w = O.metrics(data, OCT);
        expect(shown('moneyProfitValue')).toBe(rupee(w.M6_profit));
        expect(shown('moneySales')).toBe(rupee(w.M1_sales));
        expect(shown('moneyCogs')).toBe(rupee(w.M2_cogs));
        expect(shown('moneyGross')).toBe(rupee(w.M3_gross));
        expect(shown('moneyBadDebts')).toBe(rupee(w.M5_badDebts));
        expect(shown('moneyLabour')).toBe(rupee(w.M7_labour));
        expect(shown('moneyPurchases')).toBe(rupee(w.M16_purchases));
        expect(document.getElementById('moneyPeriodLabel').textContent).toBe('Oct 2026 (to the 21)');
    });

    test('Cash section: M12, M13, M14', () => {
        MoneyManager.init('cash');
        const w = O.metrics(data, OCT);
        expect(shown('moneyIn')).toBe(rupee(w.M12_inCash + w.M12_inOnline));
        expect(shown('moneyOut')).toBe(rupee(w.M13_outCash + w.M13_outOnline));
        expect(shown('moneyNetCash')).toBe(rupee(w.M14_net));
        expect(document.querySelectorAll('#moneyCashChart rect.ins-bar').length).toBe(21);
    });

    test('Spending section: M4, M8, M9, M10 and categories adding up to M4', () => {
        MoneyManager.init('spending');
        const w = O.metrics(data, OCT);
        expect(shown('moneyBusiness')).toBe(rupee(w.M4_businessExpenses));
        expect(shown('moneyPersonal')).toBe(rupee(w.M8_personalExpenses));
        expect(shown('moneyWithdrawn')).toBe(rupee(w.M9_withdrawals));
        expect(shown('moneyKept')).toBe(rupee(w.M10_kept));
        const cats = [...document.querySelectorAll('#moneyCategories .ins-barval')].map(el => Number(el.textContent.replace(/[^\d.-]/g, '')));
        expect(cats.reduce((a, b) => a + b, 0)).toBe(rupee(w.M4_businessExpenses));
    });

    test('Worth section: M15 = stock + to receive + accounts + drawer − to pay; dues equal Outstanding\'s rule (AC12)', async () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 1000, type: 'asset' }, { name: 'Loan', balance: 300, type: 'liability' }]));
        // Full history is loaded (historyLoadedFrom 0): the drawer still comes from its own session load.
        const load = jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([
            { date: '2026-10-20', signedOut: true, closingBalance: 250 },
            { date: '2026-10-19', signedOut: true, closingBalance: 999 }
        ]);
        MoneyManager.drawerCache = null;
        MoneyManager.init('worth');
        await Promise.resolve();
        await Promise.resolve();
        expect(load).toHaveBeenCalled();
        const dues = O.dueTotals(data);
        const stock = O.stockReplay(data).closing;
        expect(shown('moneyWorthValue')).toBe(rupee(stock + dues.receivable + 700 + 250 - dues.payable));
        const refs = [...document.querySelectorAll('#moneyWorthTerms [data-metric-ref]')].map(el => el.dataset.metricRef);
        expect(refs).toEqual(['S4', 'O4', 'C9', 'O3', 'M15']);
        localStorage.removeItem('financeCustomAccounts');
    });

    test('a past month and the period stepper', () => {
        MoneyManager.init('profit');
        MoneyManager.step(-1);
        expect(getInsightsContext().preset).toBe('month:2026-09');
        const w = O.metrics(data, [new Date(2026, 8, 1).getTime(), new Date(2026, 9, 1).getTime()]);
        expect(shown('moneySales')).toBe(rupee(w.M1_sales));
        expect(document.getElementById('moneyPeriodLabel').textContent).toBe('Sep 2026');
        MoneyManager.step(1);
        expect(getInsightsContext().preset).toBe('this-month');
        MoneyManager.step(1);
        expect(getInsightsContext().preset).toBe('this-month');
    });
});

describe('comparisons and takeaways', () => {
    test('vs last year from the month snapshot (same days) when last year is not loaded', () => {
        const sepStart = new Date(2026, 8, 1).getTime();
        AppState.historyLoadedFrom = sepStart;
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue({ state: {}, asOf: sepStart });
        const lastYear = buildSnapshot('2025-10', moneySummary({ ...data, base: { state: {}, from: -Infinity } },
            { from: sepStart, to: new Date(2026, 9, 1).getTime() }, { detail: true }), data, NOW);
        lastYear.days = { 3: { s: 500, p: 200 }, 25: { s: 9999, p: 9999 } };
        MoneyManager.snapshots = { '2025-10': { ...lastYear, month: '2025-10' } };
        MoneyManager.init('profit');
        const text = document.getElementById('moneyProfitCompare').textContent;
        // 1–21 Oct last year: only day 3 counts → profit 200
        const m = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, { from: OCT[0], to: OCT[1] });
        const c = change(m.M6.total, 200);
        expect(text).toContain(`${Math.abs(c.pct)}% vs Oct 2025`);
    });

    test('a loss is said in words and the uncosted kg are explained (gut check)', () => {
        const list = profitTakeaways({ profit: -110.96, vsLastYear: null, vsPrevious: null, uncosted: { qty: 12, estimate: 360 } });
        expect(list.map(x => x.key)).toEqual(['ui.tk.loss', 'ui.tk.gut_uncosted']);
        expect(t(list[0].key, list[0].params)).toBe('Loss of ₹111 in this period.');
        expect(t(list[1].key, list[1].params, 'hi')).toContain('12 किलो');
    });

    test('profit takeaways prefer last year, name the biggest item change and flag sales up / profit down', () => {
        const list = profitTakeaways({
            profit: 48200, vsLastYear: { pct: -3, dir: 'down' }, vsPrevious: { pct: 12, dir: 'up' }, lastYearLabel: 'Oct 2025', previousLabel: 'Sep',
            driver: { name: 'Rice', diff: -6100 }, salesVsLastYear: { pct: 8, dir: 'up' }
        });
        expect(list.map(x => t(x.key, x.params))).toEqual([
            'Profit ₹48200, 3% less than Oct 2025.',
            'Biggest drop: Rice (−₹6100).',
            'Sales went up but profit went down: goods cost more. Check item margins.'
        ]);
    });

    test('cash, spending and worth takeaways', () => {
        expect(cashTakeaways({ net: -1574, out: { atPurchase: 1274, duePaid: 400, expenses: 250 }, profit: 100, salesDue: 250 }).map(x => x.key))
            .toEqual(['ui.tk.cash_out', 'ui.tk.biggest_out_purchases', 'ui.tk.gut_dues']);
        expect(spendingTakeaways({ business: 670, vsLastYear: { pct: 8, dir: 'up' }, topCategory: 'rent', withdrawn: 2000, kept: -3170, personal: 1080, show: { profit: true, personal: true } }).map(x => x.key))
            .toEqual(['ui.tk.expenses_up', 'ui.tk.kept_negative']);
        expect(worthTakeaways({ worth: null }).map(x => x.key)).toEqual(['ui.tk.worth_unknown']);
        expect(worthTakeaways({ worth: 5000, change: { dir: 'up', diff: 1000 }, receivable: 200, sinceLabel: 'Oct 2025' }).map(x => x.key))
            .toEqual(['ui.tk.worth_up', 'ui.tk.worth_receivable']);
    });

    test('compareHtml uses arrows and words; nothing to compare is said', () => {
        expect(compareHtml([{ c: { pct: 12, dir: 'up' }, label: 'Sep' }])).toContain('▲ 12% vs Sep');
        expect(compareHtml([{ c: { pct: 1, dir: 'same' }, label: 'Sep' }])).toContain('about the same as Sep');
        expect(compareHtml([{ c: null, label: 'Sep' }])).toContain('Nothing to compare with yet');
    });
});

describe('taps, caveats and checks', () => {
    test('single home: every ₹ on the rendered page is a tagged figure, link, takeaway or typed amount', async () => {
        const { unexplainedValues } = await import('../utils/metric-registry.js');
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 1000, type: 'asset' }]));
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([{ date: '2026-10-20', signedOut: true, closingBalance: 250 }]);
        ['profit', 'cash', 'spending', 'worth'].forEach(s => MoneyManager.init(s));
        await Promise.resolve();
        expect(unexplainedValues(document.getElementById('money'))).toEqual([]);
        localStorage.removeItem('financeCustomAccounts');
    });

    test('retail/wholesale split lives on Insights › Items: Money only links to it, and hides the link until that page exists', () => {
        MoneyManager.init('profit');
        expect(document.getElementById('moneySalesSplit').textContent).not.toMatch(/₹/);
        expect(document.querySelector('#moneySalesSplit [data-go="insights-items"]')).toBeNull();
        document.body.insertAdjacentHTML('beforeend', '<div id="insights"></div>');
        MoneyManager.render();
        expect(document.querySelector('#moneySalesSplit [data-go="insights-items"]').dataset.metricRef).toBe('I2');
    });

    test('takeaway links to a page that is not in the app are hidden', () => {
        expect(takeawayHtml([{ key: 'ui.tk.gut_sales_up_profit_down', link: 'insights-items' }])).not.toMatch(/data-go/);
        expect(takeawayHtml([{ key: 'ui.tk.gut_sales_up_profit_down', link: 'money-cash' }])).toMatch(/data-go="money-cash"/);
    });
    test('every number opens its breakdown with the same figures', () => {
        const open = jest.spyOn(FinanceBreakdownSheet, 'open').mockImplementation(() => {});
        MoneyManager.init('profit');
        document.querySelector('#moneyProfit [data-breakdown="sales"]').click();
        expect(open).toHaveBeenCalledWith('sales', expect.any(Object));
        const summary = open.mock.calls[0][1].getSummary();
        expect(rupee(summary.sales.total)).toBe(shown('moneySales'));
    });

    test('profit shows "—" and says why when the cost is not known', () => {
        AppState.historyLoadedFrom = new Date(2026, 9, 1).getTime();
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue(null);
        MoneyManager.init('profit');
        expect(document.getElementById('moneyProfitValue').textContent).toBe('—');
        expect(document.getElementById('moneyProfitTakeaway').textContent).toMatch(/cost of what was sold is not known/);
        expect(document.getElementById('moneyProfitCaveats').textContent).toMatch(/Build month history/);
    });

    test('a period before the loaded bills offers to load them instead of showing ₹0', () => {
        AppState.historyLoadedFrom = new Date(2026, 9, 1).getTime();
        setInsightsContext({ preset: 'month:2026-01' });
        MoneyManager.init('profit');
        expect(document.getElementById('moneyProfitValue').textContent).toBe('—');
        expect(document.getElementById('moneyProfitTakeaway').textContent).toMatch(/not loaded/);
    });

    test('the checks line says the page adds up', () => {
        MoneyManager.init('profit');
        expect(document.getElementById('moneyChecks').textContent).toMatch(/Numbers match/);
    });
});

describe('month snapshots', () => {
    const input = { ...data, base: { state: {}, from: -Infinity } };
    const sep = { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime() };

    test('a snapshot reads back the same figures; items add up to sales; days add up to sales and profit', () => {
        const m = moneySummary(input, sep, { detail: true });
        const doc = buildSnapshot('2026-09', m, data, NOW);
        const f = figuresFromSnapshot(doc);
        expect(doc.v).toBe(SNAPSHOT_VERSION);
        expect([f.M1, f.M2, f.M6, f.M14, f.M16]).toEqual([m.M1.total, m.M2, m.M6.total, m.M14, m.M16.total]);
        expect(f.items.reduce((a, x) => a + x.sales, 0)).toBeCloseTo(m.M1.total, 2);
        const all = partialFigures(doc, 31);
        expect(all.M1).toBeCloseTo(m.M1.total, 2);
        expect(all.M6).toBeCloseTo(m.M6.total, 2);
        expect(JSON.stringify(doc)).not.toMatch(/undefined/);
    });

    test('sum of months, missing months make the sum unknown', () => {
        expect(sumFigures([{ M1: 1, M6: 2 }, { M1: 3, M6: 4 }]).M1).toBe(4);
        expect(sumFigures([{ M1: 1 }, null])).toBeNull();
    });

    // A doc where every day of the month sold 10 and made 1 profit; whole-month M1 = 10 × days.
    const dailyDoc = (key) => {
        const b = monthBounds(key);
        const n = Math.round((b.to - b.from) / 86400000);
        const days = {};
        for (let d = 1; d <= n; d++) days[d] = { s: 10, p: 1 };
        return { month: key, v: SNAPSHOT_VERSION, m: { M1: 10 * n, M6: n, M4: 5 }, days };
    };

    test('a range starting mid-month adds only its days, not the whole first month (last 30 days)', () => {
        const docs = { '2026-08': dailyDoc('2026-08'), '2026-09': dailyDoc('2026-09'), '2026-10': dailyDoc('2026-10') };
        // "Last 30 days" on 21 Oct → previous = 22 Aug … 21 Sep (30 days).
        const r = comparisonRanges(periodRange('last-30', new Date(2026, 9, 21, 15))).previous;
        const f = rangeFigures(docs, r.from, r.to);
        expect(f.M1).toBe(300);
        expect(f.M6).toBe(30);
    });

    test('"This year" previous (same length before 1 Jan) is not padded with whole months', () => {
        const docs = {};
        ['2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'].forEach(k => { docs[k] = dailyDoc(k); });
        const cur = periodRange('this-year', new Date(2026, 9, 21, 15));
        const r = comparisonRanges(cur).previous;
        const days = Math.round((cur.to - cur.from) / 86400000);
        const f = rangeFigures(docs, r.from, r.to);
        expect(f.M1).toBe(10 * days);
        expect(f.M6).toBe(days);
        // Whole months only: all figures, summed.
        expect(rangeFigures(docs, monthBounds('2025-11').from, monthBounds('2025-12').to).M4).toBe(10);
        // A missing month → no comparison.
        expect(rangeFigures({ '2025-12': docs['2025-12'] }, r.from, r.to)).toBeNull();
    });

    test('only the current and previous month roll, every 6 hours, inside the loaded bills', () => {
        const now = new Date(2026, 9, 21, 15).getTime();
        expect(monthsToRoll({}, { now, loadedFrom: 0 })).toEqual(['2026-09', '2026-10']);
        expect(monthsToRoll({ '2026-09': { v: SNAPSHOT_VERSION, builtAt: now - 1000 } }, { now, loadedFrom: 0 })).toEqual(['2026-10']);
        expect(monthsToRoll({}, { now, loadedFrom: new Date(2026, 9, 1).getTime() })).toEqual(['2026-10']);
        expect(monthsToRoll({ '2026-10': { v: SNAPSHOT_VERSION, builtAt: now, stale: true } }, { now, loadedFrom: 0 })).toEqual(['2026-09', '2026-10']);
    });

    test('month keys', () => {
        expect(monthKeysBetween(new Date(2025, 10, 15).getTime(), new Date(2026, 1, 2).getTime())).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
        expect(lastMonthKeys(new Date(2026, 0, 5).getTime(), 3)).toEqual(['2025-11', '2025-12', '2026-01']);
        expect(monthBounds('2026-02')).toEqual({ from: new Date(2026, 1, 1).getTime(), to: new Date(2026, 2, 1).getTime() });
    });

    test('opening the page rolls the current and previous month and saves them (≤ 2 writes)', async () => {
        const load = jest.spyOn(FirebaseService, 'loadMonthStats').mockResolvedValue({});
        const save = jest.spyOn(FirebaseService, 'saveMonthStats').mockResolvedValue();
        MoneyManager.snapshotsLoaded = false;
        MoneyManager.init('profit');
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(load).toHaveBeenCalledWith('2024-10', 40);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0].map(d => d.month)).toEqual(['2026-09', '2026-10']);
    });
});

describe('shared period', () => {
    test('contextMonth', () => {
        const now = new Date(2026, 9, 21);
        expect(contextMonth('this-month', now)).toBe('2026-10');
        expect(contextMonth('last-month', now)).toBe('2025-09'.replace('2025', '2026'));
        expect(contextMonth('month:2025-03', now)).toBe('2025-03');
    });

    test('barsSvg draws one bar per value and a faint last-year line', () => {
        const svg = barsSvg([1, -2, NaN, 4], { faint: [1, 1, 1, 1] });
        expect((svg.match(/<rect/g) || []).length).toBe(3);
        expect(svg).toContain('polyline');
    });
});

describe('what each role sees (Roles & access)', () => {
    const asMember = (perms) => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { finance: true, profit: true, personalExpenses: true, stockValue: true, ...perms } } };
    };
    const spendText = () => document.getElementById('moneySpendTakeaway').textContent;
    const w = () => O.metrics(data, OCT);
    const amount = (v) => `₹${Math.abs(Math.round(v))}`;

    test('owner: the spending takeaway says what went to personal use and what stays of the profit', () => {
        MoneyManager.init('spending');
        expect(spendText()).toContain(t('ui.tk.kept_negative', { taken: Math.round(w().M9_withdrawals + w().M8_personalExpenses), kept: Math.abs(Math.round(w().M10_kept)) }));
    });
    test('without profit: personal use only, nothing about the profit', () => {
        asMember({ profit: false });
        MoneyManager.init('spending');
        expect(spendText()).toContain(t('ui.tk.taken', { taken: Math.round(w().M9_withdrawals + w().M8_personalExpenses) }));
        expect(spendText()).not.toMatch(/profit/i);
        expect(spendText()).not.toContain(amount(w().M10_kept));
    });
    test('without personal expenses: no personal use and no profit in the sentence', () => {
        asMember({ personalExpenses: false });
        MoneyManager.init('spending');
        expect(spendText()).not.toMatch(/personal|profit/i);
        expect(spendText()).not.toContain(amount(w().M9_withdrawals + w().M8_personalExpenses));
        expect(spendText()).not.toContain(amount(w().M10_kept));
    });
    test('without either: only the business expenses sentence', () => {
        asMember({ profit: false, personalExpenses: false });
        MoneyManager.init('spending');
        expect(document.querySelectorAll('#moneySpendTakeaway p').length).toBe(1);
        expect(spendText()).not.toMatch(/personal|profit/i);
    });
    test('without profit the cash takeaway does not compare with the profit', () => {
        MoneyManager.init('cash');
        expect(document.getElementById('moneyCashTakeaway').textContent).toMatch(/below profit/);
        asMember({ profit: false });
        MoneyManager.render();
        expect(document.getElementById('moneyCashTakeaway').textContent).not.toMatch(/profit/i);
    });
    test('Worth without stock value: no stock row (S4), no net worth (M15)', async () => {
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        asMember({ stockValue: false });
        MoneyManager.drawerCache = null;
        MoneyManager.init('worth');
        await Promise.resolve();
        const refs = [...document.querySelectorAll('#moneyWorthTerms [data-metric-ref]')].map(el => el.dataset.metricRef);
        expect(refs).not.toContain('S4');
        expect(refs).not.toContain('M15');
        expect(refs).toEqual(expect.arrayContaining(['O4', 'O3']));
        expect(document.getElementById('moneyWorthValue').textContent).toBe('—');
        expect(document.getElementById('moneyWorthTakeaway').textContent).toBe('');
        AppState.settings = { roleAccess: { staff: { finance: true, stockValue: true } } };
        MoneyManager.render();
        const again = [...document.querySelectorAll('#moneyWorthTerms [data-metric-ref]')].map(el => el.dataset.metricRef);
        expect(again).toEqual(expect.arrayContaining(['S4', 'M15']));
    });
});

describe('render cost', () => {
    test('a tab switch reuses the summaries; the chart and item driver are worked out on Profit only', () => {
        MoneyManager.init('cash');
        const onCash = MoneyManager.summaryCache.computed;
        MoneyManager.setSection('profit');
        const afterProfit = MoneyManager.summaryCache.computed;
        expect(afterProfit).toBeGreaterThan(onCash);
        ['cash', 'spending', 'worth', 'profit', 'cash', 'profit'].forEach(s => MoneyManager.setSection(s));
        expect(MoneyManager.summaryCache.computed).toBe(afterProfit);
        AppState.dataVersion = (AppState.dataVersion || 0) + 1;
        MoneyManager.setSection('cash');
        expect(MoneyManager.summaryCache.computed).toBeGreaterThan(afterProfit);
    });
});