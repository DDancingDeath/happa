/**
 * @fileoverview Money page (redesign phase 2): every figure on screen equals the
 * independent oracle, comparisons use month snapshots, takeaways explain the
 * number, taps open the breakdown, and snapshots round-trip.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../../tests/oracle/oracle.js';
import { MoneyManager, compareHtml, vsItem, barsSvg, takeawayHtml } from '../modules/money.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { FinanceBreakdownSheet } from '../ui/finance-breakdown-sheet.js';
import { AppState } from '../utils/state.js';
import { moneySummary, change, comparisonRanges, periodRange, netMoneyByDay, accountsTotal, accountEntry, accountsList, accountsFromPhone, accountId, netWorth } from '../utils/business-metrics.js';
import {
    buildSnapshot, figuresFromSnapshot, partialFigures, sumFigures, rangeFigures, monthsToRoll, monthKeysBetween, lastMonthKeys, monthBounds, SNAPSHOT_VERSION, outdatedOlderMonths,
    snapshotCustomers
} from '../utils/month-snapshots.js';
import { profitTakeaways, cashTakeaways, spendingTakeaways, worthTakeaways } from '../utils/takeaways.js';
import { setInsightsContext, resetInsightsContextForTests, getInsightsContext, contextMonth } from '../utils/insights-context.js';
import { t, setLang } from '../i18n/index.js';
import { formatAmount } from '../utils/money.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

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
    // an owner phone whose personal expense listener delivered its rows (#98)
    jest.spyOn(FirebaseService, 'personalRowsLoaded').mockReturnValue(true);
    load();
    resetInsightsContextForTests();
    document.body.innerHTML = TEMPLATE;
    document.getElementById('money').classList.add('active');
    MoneyManager.snapshots = {};
    MoneyManager.snapshotsLoaded = true;
    MoneyManager.sessionCache = new Map();
    MoneyManager.section = 'profit';
    MoneyManager.summaryCache = { sig: null, map: new Map(), computed: 0 };
    MoneyManager.sharedAccounts = { state: 'idle', list: null, map: null };
    MoneyManager.accountEdits = 0;
    jest.spyOn(FirebaseService, 'loadWorthAccounts').mockResolvedValue({});
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const OCT = [new Date(2026, 9, 1).getTime(), new Date(2026, 9, 22).getTime()];

describe('figures on screen == oracle (this month)', () => {
    test('Profit section: M1, M2, M3, M5, M6, M16', () => {
        MoneyManager.init('profit');
        const w = O.metrics(data, OCT);
        expect(shown('moneyProfitValue')).toBe(rupee(w.M6_profit));
        expect(shown('moneySales')).toBe(rupee(w.M1_sales));
        expect(shown('moneyCogs')).toBe(rupee(w.M2_cogs));
        expect(shown('moneyGross')).toBe(rupee(w.M3_gross));
        expect(shown('moneyBadDebts')).toBe(rupee(w.M5_badDebts));
        expect(shown('moneyPurchases')).toBe(rupee(w.M16_purchases));
        expect(document.getElementById('moneyPeriodLabel').textContent).toBe('1–21 Oct 2026');
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
        expect(shown('moneyLabour')).toBe(rupee(w.M7_labour));
        const cats = [...document.querySelectorAll('#moneyCategories .ins-barval')].map(el => Number(el.textContent.replace(/[^\d.-]/g, '')));
        expect(cats.reduce((a, b) => a + b, 0)).toBe(rupee(w.M4_businessExpenses));
    });

    test('Worth section: M15 = stock + to receive + accounts + drawer − to pay; dues equal Outstanding\'s rule (AC12)', async () => {
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 1000, type: 'asset' }, a2: { name: 'Loan', balance: 300, type: 'liability' } });
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
        expect(FirebaseService.loadWorthAccounts).toHaveBeenCalledTimes(1);
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
        expect(t(list[1].key, list[1].params, 'hi')).toContain('12 kg');
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

    test('a comparison that is not known is said for each period, never dropped', () => {
        const html = compareHtml([vsItem(120, 100, 'Sep'), vsItem(120, null, 'Oct 2025')]);
        expect(html).toContain('▲ 20% vs Sep');
        expect(html).toContain('vs Oct 2025: not known');
        expect(compareHtml([vsItem(120, undefined, 'Sep'), vsItem(120, null, 'Oct 2025')])).toBe(
            '<span class="ins-cmp ins-cmp-none">vs Sep: not known</span><span class="ins-dot"> · </span><span class="ins-cmp ins-cmp-none">vs Oct 2025: not known</span>');
        // Last year known but 0: no % is possible, as before.
        expect(compareHtml([vsItem(120, 0, 'Oct 2025')])).toContain('Nothing to compare with yet');
        setLang('hi');
        try {
            expect(compareHtml([vsItem(120, null, 'अक्टू 2025')])).toContain('अक्टू 2025 से तुलना: पता नहीं');
        } finally {
            setLang('en');
        }
    });

    test('on screen: last year not loaded and no snapshot says "not known" next to "vs previous" (Profit, Cash, Spending, Worth; en + hi)', () => {
        const sepStart = new Date(2026, 8, 1).getTime();
        AppState.historyLoadedFrom = sepStart;
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue({ state: {}, asOf: sepStart });
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        AppState.expensesHistory.push({ id: 'eSep', date: '2026-09-10', amount: 100, category: 'business', type: 'rent' });
        MoneyManager.init('profit');
        const text = (id) => document.getElementById(id).textContent;
        expect(text('moneyProfitCompare')).toContain('vs Oct 2025: not known');
        MoneyManager.setSection('cash');
        expect(text('moneyCashCompare')).toContain('vs Oct 2025: not known');
        MoneyManager.setSection('spending');
        expect(text('moneySpendCompare')).toMatch(/^[▲▼＝] .*(% vs Sep|about the same as Sep) · vs Oct 2025: not known$/);
        MoneyManager.setSection('worth');
        expect(text('moneyWorthCompare')).toBe('stock vs Oct 2025: not known');
        setLang('hi');
        try {
            MoneyManager.setSection('spending');
            expect(text('moneySpendCompare')).toContain('2025 से तुलना: पता नहीं');
            expect(text('moneySpendCompare')).toMatch(/%/);
            expect(text('moneySpendCompare')).not.toMatch(/[A-Za-z]/);
        } finally {
            setLang('en');
        }
    });
});

describe('taps, caveats and checks', () => {
    test('single home: every ₹ on the rendered page is a tagged figure, link, takeaway or typed amount', async () => {
        const { unexplainedValues } = await import('../utils/metric-registry.js');
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 1000, type: 'asset' } });
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([{ date: '2026-10-20', signedOut: true, closingBalance: 250 }]);
        ['profit', 'cash', 'spending', 'worth'].forEach(s => MoneyManager.init(s));
        await Promise.resolve();
        MoneyManager.render();
        expect(document.getElementById('moneyAccounts').textContent).toMatch(/Bank/);
        expect(unexplainedValues(document.getElementById('money'))).toEqual([]);
    });

    test('retail/wholesale split lives on Insights › Items: Money only links to it, and hides the link until that page exists', () => {
        MoneyManager.init('profit');
        expect(document.getElementById('moneySalesSplit').textContent).not.toMatch(/₹/);
        expect(document.querySelector('#moneySalesSplit [data-go="insights-items"]')).toBeNull();
        document.body.insertAdjacentHTML('beforeend', '<div id="insights"></div>');
        MoneyManager.render();
        expect(document.querySelector('#moneySalesSplit [data-go="insights-items"]').dataset.metricRef).toBe('I2');
    });

    test('takeaway amounts are grouped like the cards (₹4,927, not ₹4927)', () => {
        expect(takeawayHtml(profitTakeaways({ profit: -4927.4 }))).toContain('Loss of ₹4,927 in this period.');
        expect(takeawayHtml(spendingTakeaways({ business: 0, withdrawn: 120000, personal: 500, kept: 2500, show: { profit: true, personal: true } })))
            .toContain('₹1,20,500 went to personal use; ₹2,500 of the profit stays in the business.');
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
        expect(document.getElementById('moneyBody').hidden).toBe(true);
        expect(document.getElementById('moneyNotLoaded').textContent).toMatch(/not loaded/);
    });

    test('stepping to an unloaded month leaves no figure of the month before on screen', () => {
        AppState.historyLoadedFrom = new Date(2026, 8, 1).getTime();
        const visibleRupees = () => {
            const out = [];
            const walk = (el) => {
                if (el.hidden) return;
                if (el.children.length === 0 && /₹|\d/.test(el.textContent)) out.push(el.textContent);
                [...el.children].forEach(walk);
            };
            walk(document.getElementById('money'));
            return out.filter(s => /₹/.test(s));
        };
        for (const section of ['profit', 'cash', 'spending', 'worth']) {
            resetInsightsContextForTests();
            MoneyManager.init(section);
            MoneyManager.step(-1);
            expect(shown('moneySales')).not.toBeNaN();
            expect(visibleRupees().length).toBeGreaterThan(0);
            MoneyManager.step(-1);
            expect(document.getElementById('moneyPeriodLabel').textContent).toBe('Aug 2026');
            expect(document.getElementById('moneyBody').hidden).toBe(true);
            expect(document.getElementById('moneyNotLoaded').hidden).toBe(false);
            expect(document.getElementById('moneyNotLoaded').textContent).toMatch(/not loaded/);
            expect(document.getElementById('moneyChecks').textContent).toBe('');
            expect(visibleRupees()).toEqual([]);
            MoneyManager.step(1);
            expect(document.getElementById('moneyBody').hidden).toBe(false);
            expect(document.getElementById('moneyNotLoaded').hidden).toBe(true);
        }
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

    test('#129: older months built by another version are rebuilt once (stale ones go the stale way)', () => {
        const now = new Date(2026, 9, 21, 15).getTime();
        const docs = {
            '2026-06': { v: SNAPSHOT_VERSION - 1 }, '2026-07': { v: SNAPSHOT_VERSION }, '2026-08': { v: SNAPSHOT_VERSION - 1, stale: true },
            '2026-09': { v: SNAPSHOT_VERSION - 1 }, '2026-10': { v: SNAPSHOT_VERSION - 1 }
        };
        expect(outdatedOlderMonths(docs, now)).toEqual(['2026-06']);
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

describe('stale month snapshots (a bill of an older month changed after the snapshot was built)', () => {
    const input = { ...data, base: { state: {}, from: -Infinity } };
    const sep = { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime() };
    const built = (month) => ({ ...buildSnapshot(month, moneySummary(input, sep, { detail: true }), data, NOW), month });
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

    test('a stale snapshot gives no figures, days or customers: every comparison from it is not known', () => {
        const doc = { ...built('2025-10'), stale: true, staleAt: 5 };
        expect(figuresFromSnapshot(built('2025-10'))).not.toBeNull();
        expect(figuresFromSnapshot(doc)).toBeNull();
        expect(partialFigures(doc, 31)).toBeNull();
        expect(snapshotCustomers(doc)).toBeNull();
        const b = monthBounds('2025-10');
        expect(rangeFigures({ '2025-10': doc }, b.from, b.to)).toBeNull();
        expect(rangeFigures({ '2025-10': doc }, b.from, b.from + 10 * 86400000)).toBeNull();
    });

    test('on screen: vs last year from a stale snapshot is "not known" with the rebuild hint; rebuilt it is a %', () => {
        const sepStart = new Date(2026, 8, 1).getTime();
        AppState.historyLoadedFrom = sepStart;
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue({ state: {}, asOf: sepStart });
        const doc = built('2025-10');
        doc.days = { 3: { s: 500, p: 200 } };
        MoneyManager.snapshots = { '2025-10': { ...doc, stale: true, staleAt: 5 } };
        MoneyManager.init('profit');
        const text = (id) => document.getElementById(id).textContent;
        expect(text('moneyProfitCompare')).toContain('vs Oct 2025: not known');
        expect(text('moneyBuildHistory')).toContain(t('ui.money.stale_hint'));
        expect(document.querySelector('#moneyBuildHistory button')).not.toBeNull();
        MoneyManager.snapshots = { '2025-10': doc };
        MoneyManager.render();
        expect(text('moneyProfitCompare')).toMatch(/% vs Oct 2025/);
        expect(text('moneyBuildHistory')).not.toContain(t('ui.money.stale_hint'));
    });

    test('a stale mark written on this phone shows at once ("aadhat:monthstale")', () => {
        const sepStart = new Date(2026, 8, 1).getTime();
        AppState.historyLoadedFrom = sepStart;
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue({ state: {}, asOf: sepStart });
        const doc = built('2025-10');
        doc.days = { 3: { s: 500, p: 200 } };
        MoneyManager.snapshots = { '2025-10': doc };
        MoneyManager.staleSeen = {};
        MoneyManager.listenSnapshots();
        MoneyManager.init('profit');
        expect(document.getElementById('moneyProfitCompare').textContent).toMatch(/% vs Oct 2025/);
        window.dispatchEvent(new CustomEvent('aadhat:monthstale', { detail: { months: ['2025-10'], at: 77 } }));
        expect(MoneyManager.snapshots['2025-10']).toMatchObject({ stale: true, staleAt: 77, m: doc.m });
        expect(MoneyManager.staleSeen['2025-10']).toBe(NOW);
        expect(document.getElementById('moneyProfitCompare').textContent).toContain('vs Oct 2025: not known');
    });

    test('rebuild: an older stale month is rebuilt from full history read after the mark was seen, clearing the flag', async () => {
        jest.spyOn(FirebaseService, 'saveMonthStats').mockResolvedValue();
        const rebuild = jest.spyOn(FirebaseService, 'rebuildMonthStat').mockImplementation(async (d) => ({ status: 'written', doc: d }));
        const fetchedAt = jest.spyOn(FirebaseService, 'getFullHistoryFetchedAt');
        const fresh = { v: SNAPSHOT_VERSION, builtAt: NOW };
        const setup = () => {
            MoneyManager.snapshots = { '2026-09': { ...fresh, month: '2026-09' }, '2026-10': { ...fresh, month: '2026-10' }, '2026-05': { month: '2026-05', stale: true, staleAt: 42 } };
            MoneyManager.staleSeen = { '2026-05': NOW - 1000 };
        };
        // History read before the mark was seen here: it may not hold the change, so no rebuild.
        setup();
        fetchedAt.mockReturnValue(NOW - 5000);
        await MoneyManager.rollSnapshots();
        expect(rebuild).not.toHaveBeenCalled();
        expect(MoneyManager.snapshots['2026-05'].stale).toBe(true);
        // Read after: rebuilt from the loaded bills (no bill reads), flag gone.
        fetchedAt.mockReturnValue(NOW - 500);
        await MoneyManager.rollSnapshots();
        expect(rebuild).toHaveBeenCalledTimes(1);
        const [doc, staleAt] = rebuild.mock.calls[0];
        expect(staleAt).toBe(42);
        expect(doc.month).toBe('2026-05');
        expect(doc.stale).toBeUndefined();
        const may = { from: new Date(2026, 4, 1).getTime(), to: new Date(2026, 5, 1).getTime() };
        expect(doc.m.M1).toBe(moneySummary(input, may).M1.total);
        expect(MoneyManager.snapshots['2026-05'].stale).toBeUndefined();
        expect(MoneyManager.staleSeen['2026-05']).toBeUndefined();
        // Marked again meanwhile on another phone: kept stale, seen again now.
        setup();
        rebuild.mockImplementation(async () => ({ status: 'newer', doc: { month: '2026-05', stale: true, staleAt: 43 } }));
        await MoneyManager.rollSnapshots();
        expect(MoneyManager.snapshots['2026-05']).toMatchObject({ stale: true, staleAt: 43 });
        expect(MoneyManager.staleSeen['2026-05']).toBe(NOW);
    });

    test('rebuild waits for full history: with only the recent window loaded the stale month stays', async () => {
        AppState.historyLoadedFrom = new Date(2026, 8, 1).getTime();
        const rebuild = jest.spyOn(FirebaseService, 'rebuildMonthStat');
        jest.spyOn(FirebaseService, 'getFullHistoryFetchedAt').mockReturnValue(NOW);
        MoneyManager.snapshots = { '2026-05': { month: '2026-05', stale: true, staleAt: 42 } };
        MoneyManager.staleSeen = { '2026-05': NOW - 1000 };
        expect(await MoneyManager.rebuildStale(NOW)).toBe(0);
        expect(rebuild).not.toHaveBeenCalled();
    });

    /** A March and a May sale, so Build month history has older months to write (on the in-memory Firestore). */
    const withOlderMonths = () => {
        AppState.salesHistory.push({ ...copy(FIX.wholesaleSales[0]), id: 'wMar', date: '2026-03-10T12:00:00' },
            { ...copy(FIX.wholesaleSales[0]), id: 'wMay', date: '2026-05-10T12:00:00' });
        const fake = createFakeFirestore();
        const before = global.firebase;
        global.firebase = fake.firebase;
        return { fake, restore: () => { global.firebase = before; } };
    };
    const build = async () => {
        MoneyManager.building = false;
        window.FirebaseService = FirebaseService;
        try {
            await MoneyManager.buildHistory();
        } finally {
            delete window.FirebaseService;
        }
        await flush();
    };

    test('Build month history never overwrites a stale mark another phone set after this one loaded the snapshots', async () => {
        const { fake, restore } = withOlderMonths();
        try {
            let fetched = NOW - 5000;
            jest.spyOn(FirebaseService, 'getFullHistoryFetchedAt').mockImplementation(() => fetched);
            const refresh = jest.spyOn(FirebaseService, 'refreshOnDemandHistory').mockImplementation(async () => { fetched = Date.now(); return true; });
            // This phone loaded a good March; another phone then edits a March bill and marks it.
            const march = { ...built('2026-03'), month: '2026-03' };
            MoneyManager.snapshots = { '2026-03': march };
            MoneyManager.staleSeen = {};
            fake.seed('monthStats', [{ id: '2026-03', ...march, stale: true, staleAt: 99 }]);
            await build();
            expect(refresh).not.toHaveBeenCalled();
            expect(fake.raw('monthStats').get('2026-03')).toEqual({ ...march, stale: true, staleAt: 99 });
            expect(fake.raw('monthStats').get('2026-05').stale).toBeUndefined();
            expect(fake.raw('monthStats').get('2026-10').month).toBe('2026-10');
            expect(MoneyManager.snapshots['2026-03']).toMatchObject({ stale: true, staleAt: 99 });
            expect(MoneyManager.staleSeen['2026-03']).toBe(NOW);
            // Seen now: the next build reads the bills again, then rebuilds March over that mark.
            jest.setSystemTime(new Date(NOW + 60000));
            await build();
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(fake.raw('monthStats').get('2026-03').stale).toBeUndefined();
            expect(fake.raw('monthStats').get('2026-03').builtAt).toBe(NOW + 60000);
            expect(MoneyManager.snapshots['2026-03'].stale).toBeUndefined();
            expect(MoneyManager.staleSeen['2026-03']).toBeUndefined();
        } finally {
            restore();
        }
    });

    test('Build month history: a mark this phone saw and re-read the bills for is replaced; one set meanwhile is kept', async () => {
        const { fake, restore } = withOlderMonths();
        try {
            jest.spyOn(FirebaseService, 'getFullHistoryFetchedAt').mockReturnValue(NOW - 500);
            MoneyManager.snapshots = { '2026-05': { month: '2026-05', stale: true, staleAt: 42 }, '2026-03': { month: '2026-03', stale: true, staleAt: 7 } };
            MoneyManager.staleSeen = { '2026-05': NOW - 1000, '2026-03': NOW - 1000 };
            fake.seed('monthStats', [{ id: '2026-05', month: '2026-05', stale: true, staleAt: 42 }, { id: '2026-03', month: '2026-03', stale: true, staleAt: 8 }]);
            await build();
            expect(fake.raw('monthStats').get('2026-05').stale).toBeUndefined();
            expect(fake.raw('monthStats').get('2026-03')).toEqual({ month: '2026-03', stale: true, staleAt: 8 });
            expect(MoneyManager.snapshots['2026-03'].staleAt).toBe(8);
            expect(MoneyManager.staleSeen['2026-03']).toBe(NOW);
        } finally {
            restore();
        }
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

    test('barsSvg stretches only the last-year line, so the month labels keep their shape', () => {
        const box = document.createElement('div');
        box.innerHTML = barsSvg([1, 2], { faint: [1, 2], labels: [{ key: '2026-09', tick: 'Sep' }, { key: '2026-10', tick: 'Oct' }] });
        const outer = box.firstElementChild;
        expect(outer.getAttribute('viewBox')).toBeNull();
        expect(outer.getAttribute('preserveAspectRatio')).toBeNull();
        const stretched = outer.querySelector('svg');
        expect(stretched.getAttribute('preserveAspectRatio')).toBe('none');
        expect(stretched.querySelector('polyline')).not.toBeNull();
        expect([...outer.querySelectorAll('text')].map(el => el.parentNode)).toEqual([outer, outer]);
        expect([...outer.querySelectorAll('rect')].map(el => el.parentNode)).toEqual([outer, outer]);
    });
});

describe('what each role sees (Roles & access)', () => {
    const asMember = (perms) => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { finance: true, profit: true, personalExpenses: true, stockValue: true, ...perms } } };
    };
    const spendText = () => document.getElementById('moneySpendTakeaway').textContent;
    const w = () => O.metrics(data, OCT);
    const amount = (v) => `₹${formatAmount(Math.abs(v))}`;

    test('owner: the spending takeaway says what went to personal use and what stays of the profit', () => {
        MoneyManager.init('spending');
        expect(spendText()).toContain(t('ui.tk.kept_negative', { taken: formatAmount(w().M9_withdrawals + w().M8_personalExpenses), kept: formatAmount(Math.abs(w().M10_kept)) }));
    });
    test('without profit: personal use only, nothing about the profit', () => {
        asMember({ profit: false });
        MoneyManager.init('spending');
        expect(spendText()).toContain(t('ui.tk.taken', { taken: formatAmount(w().M9_withdrawals + w().M8_personalExpenses) }));
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

describe('labour on Money › Spending (T-LAB-1, T-LAB-2 for the period)', () => {
    let unexplainedValuesOf;
    beforeAll(async () => {
        const { unexplainedValues } = await import('../utils/metric-registry.js');
        unexplainedValuesOf = (id) => unexplainedValues(document.getElementById(id));
    });
    test('deducted = M7 and to pay = each day\'s packages × rate, with the more / less line', () => {
        AppState.settings = { laborRate: 6, labourPackageKg: 35 };
        MoneyManager.init('spending');
        const w = O.metrics(data, OCT);
        expect(shown('moneyLabour')).toBe(rupee(w.M7_labour));
        const kgByDay = {};
        FIX.purchases.filter(b => !O.isOpening(b)).forEach(b => {
            const t = O.timeOf(b.timestamp ?? b.date);
            if (t < OCT[0] || t >= OCT[1]) return;
            const d = new Date(t).toDateString();
            kgByDay[d] = (kgByDay[d] || 0) + b.items.reduce((a, l) => a + Number(l.qty ?? l.quantity ?? 0), 0);
        });
        const toPay = Object.values(kgByDay).reduce((a, kg) => a + Math.ceil(kg / 35) * 6, 0);
        expect(shown('moneyLabourToPay')).toBe(toPay);
        expect(document.getElementById('moneyLabourCalc').textContent).toMatch(/35 kg/);
        expect(document.getElementById('moneyLabourDiff').textContent).toMatch(toPay > w.M7_labour ? /more than deducted/ : /less than deducted|matches/);
        expect(document.querySelector('#moneyProfit [data-metric="M7"]')).toBeNull();
        expect(unexplainedValuesOf('money')).toEqual([]);
    });

    test('an old bill with only `labour` gives the same M7 on Spending, its breakdown, the snapshot, items and parties', async () => {
        const { purchaseItems, partySummary } = await import('../utils/business-metrics.js');
        AppState.purchaseHistory = AppState.purchaseHistory.map(b => {
            if (b.id !== 'p3') return b;
            const { laborCharges, ...old } = b;
            return { ...old, labour: laborCharges };
        });
        const open = jest.spyOn(FinanceBreakdownSheet, 'open').mockImplementation(() => {});
        MoneyManager.init('spending');
        expect(shown('moneyLabour')).toBe(6);
        document.querySelector('#moneySpending [data-breakdown="labour"]').click();
        const fin = open.mock.calls[0][1].getSummary();
        expect(fin.purchases.labour).toBe(6);
        expect(fin.detail.labour.reduce((a, r) => a + r.amount, 0)).toBe(6);
        const src = { ...data, purchases: AppState.purchaseHistory };
        const m = moneySummary({ ...src, base: { state: {}, from: -Infinity } }, { from: OCT[0], to: OCT[1] });
        expect(m.M7).toBe(6);
        expect(figuresFromSnapshot(buildSnapshot('2026-10', m, src, NOW)).M7).toBe(6);
        const range = { from: OCT[0], to: OCT[1] };
        expect(purchaseItems(src.purchases, src.items, range).reduce((a, r) => a + r.labour, 0)).toBe(6);
        expect(partySummary(src, 'purchases', range).reduce((a, r) => a + r.labour, 0)).toBe(6);
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
describe('Money calc helpers (M14 per day, M15 accounts)', () => {
    test('netMoneyByDay: in − out of each local day, to the paise, in key order', () => {
        const t = (d, h) => new Date(2028, 1, d, h).getTime();
        const detail = {
            receivedAtSale: [{ t: t(28, 10), amount: 100.25 }, { t: t(29, 23), amount: 50 }],
            dueReceived: [{ t: t(29, 0), amount: '20' }, { t: NaN, amount: 999 }],
            paidAtPurchase: [{ t: t(28, 11), amount: 30 }],
            duePaid: [{ t: t(29, 9), amount: 5 }],
            business: [{ t: t(1, 9), amount: 7 }],
            personal: [{ t: t(29, 9), amount: 'x' }]
        };
        expect(netMoneyByDay(detail, ['2028-02-01', '2028-02-28', '2028-02-29', '2028-03-01'])).toEqual([-7, 70.25, 65, 0]);
        expect(netMoneyByDay(undefined, ['2028-02-01'])).toEqual([0]);
    });

    test('accountsTotal: assets − liabilities, unreadable balances count 0', () => {
        expect(accountsTotal([{ balance: 12345.678, type: 'asset' }, { balance: 5000.5, type: 'liability' }, { balance: 'x' }])).toBe(7345.18);
        expect(accountsTotal(null)).toBe(0);
    });
});

describe('Money › Worth shared accounts (#74, settings/accounts)', () => {
    const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
    const openWorth = async () => {
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        MoneyManager.drawerCache = null;
        MoneyManager.init('worth');
        await flush();
    };
    const accountsRow = () => [...document.querySelectorAll('#moneyWorthTerms .ins-row')].find(el => el.querySelector('[data-input]'));
    afterEach(() => localStorage.removeItem('financeCustomAccounts'));

    test('until the shared accounts load, their term and net worth say "—"; then the shared values count', async () => {
        let resolve;
        FirebaseService.loadWorthAccounts.mockReturnValue(new Promise(r => { resolve = r; }));
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        MoneyManager.init('worth');
        expect(accountsRow().querySelector('[data-input]').textContent).toBe('—');
        expect(document.getElementById('moneyWorthValue').textContent).toBe('—');
        expect(document.getElementById('moneyAccounts').textContent).toBe(t('ui.money.accounts_loading'));
        resolve({ x: { name: 'Bank', balance: 2500, type: 'asset' } });
        await flush();
        const dues = O.dueTotals(data);
        expect(shown('moneyWorthValue')).toBe(rupee(O.stockReplay(data).closing + dues.receivable + 2500 - dues.payable));
    });

    test('a load that fails says so, and net worth stays "—" (never a total without the accounts)', async () => {
        FirebaseService.loadWorthAccounts.mockRejectedValue(new Error('offline'));
        await openWorth();
        expect(document.getElementById('moneyAccounts').textContent).toBe(t('ui.money.accounts_not_loaded'));
        expect(document.getElementById('moneyWorthValue').textContent).toBe('—');
        expect(document.getElementById('moneyAccForm').hidden).toBe(true);
    });

    test('this phone\'s old accounts are not counted; each Money open reads the shared doc again', async () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Phone bank', balance: 9999, type: 'asset' }]));
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 100, type: 'asset' } });
        await openWorth();
        expect(MoneyManager.accountsTotal()).toBe(100);
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 300, type: 'asset' } });
        await openWorth();
        expect(FirebaseService.loadWorthAccounts).toHaveBeenCalledTimes(2);
        expect(MoneyManager.accountsTotal()).toBe(300);
    });

    test('the owner saves an account in whole rupees for all phones; a name saved again replaces it', async () => {
        const save = jest.spyOn(FirebaseService, 'saveWorthAccount').mockResolvedValue();
        await openWorth();
        expect(document.getElementById('moneyAccForm').hidden).toBe(false);
        document.getElementById('moneyAccName').value = ' Bank ';
        document.getElementById('moneyAccBalance').value = '1234.6';
        MoneyManager.saveAccount();
        expect(save).toHaveBeenCalledWith(accountId('Bank'), { name: 'Bank', balance: 1235, type: 'asset' });
        expect(MoneyManager.accountsTotal()).toBe(1235);
        document.getElementById('moneyAccName').value = 'bank';
        document.getElementById('moneyAccBalance').value = '500';
        document.getElementById('moneyAccType').value = 'liability';
        MoneyManager.saveAccount();
        expect(save).toHaveBeenLastCalledWith(accountId('Bank'), { name: 'bank', balance: 500, type: 'liability' });
        expect(MoneyManager.accountsTotal()).toBe(-500);
        document.getElementById('moneyAccName').value = 'Cash box';
        document.getElementById('moneyAccBalance').value = '-5';
        MoneyManager.saveAccount();
        expect(save).toHaveBeenCalledTimes(2);
    });

    test('a refused save shows a failure (never "Saved") and reloads the shared list', async () => {
        const toast = jest.spyOn(require('../ui/ui-manager.js').UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(FirebaseService, 'saveWorthAccount').mockRejectedValue(new Error('permission-denied'));
        await openWorth();
        document.getElementById('moneyAccName').value = 'Bank';
        document.getElementById('moneyAccBalance').value = '10';
        MoneyManager.saveAccount();
        await flush();
        expect(toast).toHaveBeenCalledWith(t('msg.money.accounts_not_saved'), 'error');
        expect(FirebaseService.loadWorthAccounts).toHaveBeenCalledTimes(2);
        expect(MoneyManager.accountsTotal()).toBe(0);
    });

    test('remove: by the account\'s id', async () => {
        const remove = jest.spyOn(FirebaseService, 'removeWorthAccount').mockResolvedValue();
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 100, type: 'asset' }, a2: { name: 'Loan', balance: 40, type: 'liability' } });
        await openWorth();
        expect(MoneyManager.accountsTotal()).toBe(60);
        expect(document.querySelector('#moneyAccounts [onclick*="removeAccount(\'a2\')"]')).not.toBeNull();
        MoneyManager.removeAccount('a2');
        expect(remove).toHaveBeenCalledWith('a2');
        expect(MoneyManager.accountsTotal()).toBe(100);
    });

    test('a member with Money on sees the accounts but cannot change them; a manager with Money can', async () => {
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 100, type: 'asset' } });
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { finance: true, stockValue: true } } };
        await openWorth();
        expect(document.getElementById('moneyAccounts').textContent).toMatch(/Bank/);
        expect(document.querySelector('#moneyAccounts [onclick]')).toBeNull();
        expect(document.getElementById('moneyAccForm').hidden).toBe(true);
        const save = jest.spyOn(FirebaseService, 'saveWorthAccount').mockResolvedValue();
        MoneyManager.saveAccount();
        expect(save).not.toHaveBeenCalled();
        AppState.userRole = 'manager';
        AppState.settings = {};
        MoneyManager.render();
        expect(document.getElementById('moneyAccForm').hidden).toBe(false);
        AppState.settings = { roleAccess: { manager: { finance: false } } };
        MoneyManager.render();
        expect(document.getElementById('moneyAccForm').hidden).toBe(true);
    });

    test('migration: the owner gets one tap to use this phone\'s accounts for all phones while the shared list is empty', async () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([
            { name: 'Bank', balance: 2500.4, type: 'asset' }, { name: 'Loan', balance: 1000, type: 'liability' }, { name: '', balance: 5 }
        ]));
        const move = jest.spyOn(FirebaseService, 'useAccountsForAllPhones').mockResolvedValue(true);
        await openWorth();
        expect(document.getElementById('moneyAccountsMove').hidden).toBe(false);
        expect(document.getElementById('moneyAccountsMoveText').textContent).toBe(t('ui.money.accounts_on_phone', { n: 2 }));
        FirebaseService.loadWorthAccounts.mockResolvedValue({ [accountId('Bank')]: { name: 'Bank', balance: 2500, type: 'asset' } });
        await MoneyManager.useThisPhonesAccounts();
        expect(move).toHaveBeenCalledWith({
            [accountId('Bank')]: { name: 'Bank', balance: 2500, type: 'asset' },
            [accountId('Loan')]: { name: 'Loan', balance: 1000, type: 'liability' }
        });
        // the nameless one can't be moved and stays on the phone
        expect(JSON.parse(localStorage.getItem('financeCustomAccounts'))).toEqual([{ name: '', balance: 5 }]);
        expect(document.getElementById('moneyAccountsMove').hidden).toBe(true);
    });

    test('migration is not offered once the shared list has accounts, nor to managers', async () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 1, type: 'asset' }]));
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Other', balance: 5, type: 'asset' } });
        await openWorth();
        expect(document.getElementById('moneyAccountsMove').hidden).toBe(true);
        FirebaseService.loadWorthAccounts.mockResolvedValue({});
        AppState.userRole = 'manager';
        await openWorth();
        expect(document.getElementById('moneyAccountsMove').hidden).toBe(true);
    });

    test('migration keeps the accounts it could not move on the phone and says how many', async () => {
        const toast = jest.spyOn(require('../ui/ui-manager.js').UIManager, 'showToast').mockImplementation(() => {});
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 1, type: 'asset' }, { name: 'Odd', balance: 'x' }]));
        jest.spyOn(FirebaseService, 'useAccountsForAllPhones').mockResolvedValue(true);
        await openWorth();
        await MoneyManager.useThisPhonesAccounts();
        expect(JSON.parse(localStorage.getItem('financeCustomAccounts'))).toEqual([{ name: 'Odd', balance: 'x' }]);
        expect(toast).toHaveBeenCalledWith(t('msg.money.accounts_moved_some_one', { n: 1 }), 'warning');
    });

    test('Money opened again after a failed load reads again; a refresh never undoes a save made meanwhile', async () => {
        FirebaseService.loadWorthAccounts.mockRejectedValueOnce(new Error('offline'));
        await openWorth();
        expect(MoneyManager.sharedAccounts.state).toBe('error');
        FirebaseService.loadWorthAccounts.mockResolvedValue({ a1: { name: 'Bank', balance: 5, type: 'asset' } });
        await openWorth();
        expect(MoneyManager.accountsTotal()).toBe(5);
        let resolve;
        FirebaseService.loadWorthAccounts.mockReturnValue(new Promise(r => { resolve = r; }));
        jest.spyOn(FirebaseService, 'saveWorthAccount').mockResolvedValue();
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        MoneyManager.init('worth');
        expect(document.getElementById('moneyAccForm').hidden).toBe(false);
        document.getElementById('moneyAccName').value = 'Cash box';
        document.getElementById('moneyAccBalance').value = '20';
        MoneyManager.saveAccount();
        resolve({ a1: { name: 'Bank', balance: 5, type: 'asset' } });
        await flush();
        expect(MoneyManager.accountsTotal()).toBe(25);
    });

    test('saving an account unchanged writes nothing', async () => {
        FirebaseService.loadWorthAccounts.mockResolvedValue({ [accountId('Bank')]: { name: 'Bank', balance: 5, type: 'asset' } });
        const save = jest.spyOn(FirebaseService, 'saveWorthAccount').mockResolvedValue();
        await openWorth();
        document.getElementById('moneyAccName').value = 'Bank';
        document.getElementById('moneyAccBalance').value = '5';
        MoneyManager.saveAccount();
        expect(save).not.toHaveBeenCalled();
    });

    test('while the accounts are not loaded the takeaway says so (not "stock value")', async () => {
        FirebaseService.loadWorthAccounts.mockRejectedValue(new Error('offline'));
        await openWorth();
        expect(document.getElementById('moneyWorthTakeaway').textContent).toBe(t('ui.tk.worth_accounts_unknown'));
    });

    test('migration that lost the race (another phone saved first) keeps this phone\'s list and changes nothing', async () => {
        localStorage.setItem('financeCustomAccounts', JSON.stringify([{ name: 'Bank', balance: 1, type: 'asset' }]));
        jest.spyOn(FirebaseService, 'useAccountsForAllPhones').mockResolvedValue(false);
        await openWorth();
        await MoneyManager.useThisPhonesAccounts();
        expect(localStorage.getItem('financeCustomAccounts')).not.toBeNull();
    });
});

describe('shared accounts helpers (#74)', () => {
    test('accountEntry: trimmed name (1–40), balance 0 or more in whole rupees, asset unless "liability"', () => {
        expect(accountEntry({ name: '  SBI  savings ', balance: '1999.5', type: 'x' })).toEqual({ id: accountId('sbi savings'), entry: { name: 'SBI savings', balance: 2000, type: 'asset' } });
        expect(accountEntry({ name: 'Loan', balance: 0, type: 'liability' }).entry).toEqual({ name: 'Loan', balance: 0, type: 'liability' });
        ['', ' ', 'x'.repeat(41)].forEach(name => expect(accountEntry({ name, balance: 1 })).toBeNull());
        ['', null, 'abc', -1, 1e11].forEach(balance => expect(accountEntry({ name: 'A', balance })).toBeNull());
    });
    test('accountId: same for the same name in any case or spacing; a safe field name', () => {
        expect(accountId('Bank  A')).toBe(accountId(' bank a'));
        expect(accountId('बैंक')).toMatch(/^a[0-9a-f]{8}$/);
        expect(accountId('Bank')).not.toBe(accountId('Bank 2'));
    });
    test('accountsList: whole rupees, sorted by name, unreadable entries dropped', () => {
        expect(accountsList({ b: { name: 'Zed', balance: 10.6, type: 'liability' }, a: { name: 'Abc', balance: 'x' }, c: null, d: { name: ' ' } }))
            .toEqual([{ id: 'a', name: 'Abc', balance: 0, type: 'asset' }, { id: 'b', name: 'Zed', balance: 11, type: 'liability' }]);
        expect(accountsList(null)).toEqual([]);
    });
    test('accountsFromPhone: old phone list → shared map; nothing is lost without being returned', () => {
        const long = 'स्टेट बैंक ऑफ़ इंडिया बचत खाता रमेश कुमार शर्मा';
        const b = { name: 'B', balance: 'x' };
        const huge = { name: 'Huge', balance: 2e10 };
        const { map, skipped } = accountsFromPhone([
            { name: 'A', balance: -50, type: 'asset' }, b, { name: 'C', balance: 7.4, type: 'liability' },
            { name: 'SBI', balance: 100 }, { name: ' sbi ', balance: 30, type: 'liability' }, { name: long, balance: 5 }, huge, { name: '', balance: 1 }
        ]);
        // negative = the other side; same name in another case = one account with the total; long names cut to 40
        expect(map).toEqual({
            [accountId('A')]: { name: 'A', balance: 50, type: 'liability' }, [accountId('C')]: { name: 'C', balance: 7, type: 'liability' },
            [accountId('SBI')]: { name: 'SBI', balance: 70, type: 'asset' }, [accountId(long.slice(0, 40))]: { name: long.slice(0, 40).trim(), balance: 5, type: 'asset' }
        });
        expect(skipped).toEqual([b, { name: '', balance: 1 }, huge]);
        const many = Array.from({ length: 32 }, (_, i) => ({ name: `N${i}`, balance: i }));
        const r = accountsFromPhone(many);
        expect(Object.keys(r.map)).toHaveLength(30);
        expect(r.skipped).toEqual(many.slice(30));
        expect(accountsFromPhone('x')).toEqual({ map: {}, skipped: [] });
    });
    test('netWorth (M15): unknown while the accounts are not loaded', () => {
        expect(netWorth({ stock: 100, receivable: 0, payable: 0, accounts: null, drawer: 0 })).toBeNull();
        expect(netWorth({ stock: 100, receivable: 0, payable: 0, accounts: 5, drawer: 0 })).toBe(105);
    });
});
describe('settings/accounts repository (#74, in-memory Firestore)', () => {
    test('load / save one / remove one / first move only while empty', async () => {
        jest.restoreAllMocks();
        const fake = createFakeFirestore();
        const before = global.firebase;
        global.firebase = fake.firebase;
        AppState.currentUser = { uid: 'owner1' };
        try {
            expect(await FirebaseService.loadWorthAccounts()).toEqual({});
            expect(await FirebaseService.useAccountsForAllPhones({ a1: { name: 'Bank', balance: 10, type: 'asset' } })).toBe(true);
            await FirebaseService.saveWorthAccount('a2', { name: 'Loan', balance: 5, type: 'liability' });
            const doc = fake.raw('settings').get('accounts');
            expect(doc.changedId).toBe('a2');
            expect(doc.updatedBy).toBe('owner1');
            expect(await FirebaseService.loadWorthAccounts()).toEqual({ a1: { name: 'Bank', balance: 10, type: 'asset' }, a2: { name: 'Loan', balance: 5, type: 'liability' } });
            await FirebaseService.removeWorthAccount('a1');
            expect(await FirebaseService.loadWorthAccounts()).toEqual({ a2: { name: 'Loan', balance: 5, type: 'liability' } });
            expect(await FirebaseService.useAccountsForAllPhones({ a9: { name: 'X', balance: 1, type: 'asset' } })).toBe(false);
            expect(Object.keys(await FirebaseService.loadWorthAccounts())).toEqual(['a2']);
        } finally {
            global.firebase = before;
            AppState.currentUser = null;
        }
    });
});