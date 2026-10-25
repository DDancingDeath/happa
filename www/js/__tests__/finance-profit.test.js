/**
 * @fileoverview Finance profit / stock value / cash flow (#215) and the card
 * breakdowns. Expected numbers are worked out by hand in the fixtures
 * (tests/fixtures/finance/*.json, #45 oracle style); the app's pure functions
 * and the rendered dashboard must produce exactly those.
 */
import fs from 'fs';
import path from 'path';
import { computeFinanceSummary, pickReplayBase, stockMovement, profitByDay } from '../utils/finance-calc.js';
import {
    CARDS, buildBreakdown, cardRows, sumRows, groupRows, searchRows, sortRows, groupOptions
} from '../utils/finance-breakdown.js';
import {
    buildCheckpointState, collectEvents, createItemKeyResolver, replayWithValues
} from '../utils/stock-replay.js';
import { FinanceManager } from '../modules/finance.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { FinanceBreakdownSheet } from '../ui/finance-breakdown-sheet.js';
import { AppState } from '../utils/state.js';

const DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'finance');
const FIXTURES = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byName = Object.fromEntries(FIXTURES.map(f => [f.name, f]));

const localMs = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
};
const rangeOf = (p) => (p.range ? { from: localMs(p.range[0]), to: localMs(p.range[1]) } : { from: -Infinity, to: Infinity });
const sourcesOf = (f) => ({
    purchases: f.purchases, wholesaleSales: f.wholesaleSales, retailSales: f.retailSales, stockAdjustments: f.stockAdjustments
});
const summarize = (f, range, { base = { state: {}, from: -Infinity }, detail = true } = {}) => computeFinanceSummary({
    sources: sourcesOf(f), items: f.items, base, expenses: f.expenses, withdrawals: f.withdrawals, ...range, detail
});

const cases = FIXTURES.flatMap(f => Object.entries(f.periods).map(([period, p]) => [`${f.name} / ${period}`, f, p]));

describe.each(cases)('finance summary: %s', (_label, f, p) => {
    const s = summarize(f, rangeOf(p));
    const e = p.expected;

    test('profit = sales − cost of goods sold − business expenses; personal and withdrawals below it', () => {
        expect(s.sales.total).toBe(e.sales);
        expect(s.cogs).toBe(e.cogs);
        expect(s.grossProfit).toBe(e.grossProfit);
        expect(s.expenses.business).toBe(e.business);
        expect(s.badDebts).toBe(e.badDebts ?? 0);
        expect(s.purchases.labour).toBe(e.labour ?? 0);
        expect(s.profit).toBe(e.profit);
        expect(s.expenses.personal).toBe(e.personal);
        expect(s.afterPersonal).toBe(e.afterPersonal);
        expect(s.withdrawn).toBe(e.withdrawn);
        expect(s.afterWithdrawals).toBe(e.afterWithdrawals);
    });

    test('stock value movement and check line', () => {
        const { detail, saleLines, uncosted, deficitRefilled, ...stock } = s.stock;
        expect(stock).toEqual(e.stock);
        expect(s.stockMismatch).toBe(e.stockMismatch);
        expect(s.mismatchFromEarlierSales).toBe(e.mismatchFromEarlierSales ?? false);
        expect({ qty: uncosted.qty, estimate: uncosted.estimate }).toEqual(e.uncosted ?? { qty: 0, estimate: 0 });
        expect(s.uncostedWarning).toBe((e.uncosted?.qty ?? 0) > 0);
    });

    test('cash flow', () => {
        expect(s.cash).toEqual(e.cash);
    });

    test('profit per day (Analytics trend, #36) adds up to the period profit', () => {
        const days = profitByDay(s.detail, (t) => new Date(t).toDateString());
        expect(Object.values(days).reduce((x, v) => x + v, 0)).toBeCloseTo(s.profit, 2);
    });

    test.each(Object.keys(CARDS))('breakdown rows of "%s" add up to the card value', (cardId) => {
        const b = buildBreakdown(s, cardId);
        expect(b.available).toBe(true);
        expect(b.total).toBeCloseTo(b.value, 2);
        expect(sumRows(b.rows)).toBeCloseTo(CARDS[cardId].value(s), 2);
    });

    test('grouped subtotals add up to the card value', () => {
        ['sales', 'cogs', 'profit', 'netCash', 'stockNow', 'uncosted'].forEach(cardId => {
            const b = buildBreakdown(s, cardId);
            groupOptions(b.rows).filter(g => g !== 'none').forEach(by => {
                const groups = groupRows(b.rows, by);
                expect(groups.reduce((a, g) => a + g.subtotal, 0)).toBeCloseTo(b.value, 2);
                expect(groups.reduce((a, g) => a + g.count, 0)).toBe(b.rows.length);
            });
        });
    });
});

describe('finance summary: periods and replay start', () => {
    const f = byName['mixed-shapes'];

    test('profit for All = sum of the calendar months', () => {
        const all = summarize(f, rangeOf(f.periods.all));
        const months = ['september', 'october'].map(m => summarize(f, rangeOf(f.periods[m])));
        expect(months.reduce((a, s) => a + s.profit, 0)).toBe(all.profit);
        expect(months.reduce((a, s) => a + s.cogs, 0)).toBe(all.cogs);
        expect(months.reduce((a, s) => a + s.cash.net, 0)).toBe(all.cash.net);
    });

    test('a period starting at the stock checkpoint gives the same numbers as a full replay', () => {
        const range = rangeOf(f.periods.october);
        const { state } = buildCheckpointState(sourcesOf(f), range.from, f.items);
        // Records before the checkpoint must not matter: drop them from the sources.
        const later = (bills) => bills.filter(b => !['p1', 'p2'].includes(b.id));
        const fromCheckpoint = computeFinanceSummary({
            sources: { ...sourcesOf(f), purchases: later(f.purchases) },
            items: f.items,
            base: pickReplayBase({ checkpoint: { state, asOf: range.from }, fullHistory: false, from: range.from }),
            expenses: f.expenses, withdrawals: f.withdrawals, ...range
        });
        const full = summarize(f, range, { detail: false });
        expect(fromCheckpoint.profit).toBe(full.profit);
        expect(fromCheckpoint.stock.closing).toBe(full.stock.closing);
        expect(fromCheckpoint.stock.opening).toBe(4000);
    });

    test('without a checkpoint covering the period and without full history, cost and profit are unknown (no guess)', () => {
        const range = rangeOf(f.periods.october);
        expect(pickReplayBase({ checkpoint: { state: {}, asOf: range.from + 1 }, fullHistory: false, from: range.from })).toBeNull();
        const s = summarize(f, range, { base: null });
        expect(s.cogs).toBeNull();
        expect(s.profit).toBeNull();
        expect(s.stock).toBeNull();
        expect(s.sales.total).toBe(2260);
        expect(s.cash.net).toBe(-440);
        expect(buildBreakdown(s, 'profit').available).toBe(false);
    });

    test('a stock movement can not start before its base', () => {
        expect(stockMovement({ base: { state: {}, from: 10 }, sources: sourcesOf(f), items: f.items, from: 5 })).toBeNull();
    });
});

describe('review fixes: uncosted units, bad debts, labour, old-bill payments', () => {
    const g = byName['sold-before-bought'];

    test('units sold before their purchase show in the SALE\'s period, estimated at the next purchase rate', () => {
        const oct1 = summarize(g, rangeOf(g.periods.oct1));
        expect(oct1.uncostedWarning).toBe(true);
        expect(oct1.stockMismatch).toBe(false);
        const b = buildBreakdown(oct1, 'uncosted');
        expect(b.rows.map(r => [r.billId, r.qty, r.rate, r.amount])).toEqual([['r1', 10, 20, 200]]);
        expect(buildBreakdown(oct1, 'profit').notes).toEqual([expect.objectContaining({ cardId: 'uncosted', value: 200 })]);
        // The later purchase's period keeps the check-line warning, labelled as the same cause.
        const oct2 = summarize(g, rangeOf(g.periods.oct2));
        expect(oct2.uncostedWarning).toBe(false);
        expect(oct2.stockMismatch).toBe(true);
        expect(oct2.mismatchFromEarlierSales).toBe(true);
        expect(oct2.stock.deficitRefilled).toEqual({ qty: 10, value: 200 });
    });

    test('with no later purchase, the last known cost is used; with none at all the cost is unknown', () => {
        const h = JSON.parse(JSON.stringify(byName['buy-then-sell']));
        h.retailSales.push({ ...h.retailSales[0], id: 'r2', date: '2026-10-06T10:00:00', items: [{ itemId: 'item-rice', name: 'Rice', qty: 50, rate: 25, total: 1250 }], total: 1250 });
        const s = summarize(h, { from: -Infinity, to: Infinity });
        expect(s.stock.uncosted).toEqual({ qty: 10, estimate: 200, unknownCost: 0 });
        const k = JSON.parse(JSON.stringify(g));
        k.purchases = [];
        expect(summarize(k, { from: -Infinity, to: Infinity }).stock.uncosted).toEqual({ qty: 10, estimate: 0, unknownCost: 10 });
    });

    test('written-off receivables are a bad debt line in profit; labour is shown, not in cost', () => {
        const w = byName['write-off-and-labour'];
        const s = summarize(w, rangeOf(w.periods.all));
        expect(buildBreakdown(s, 'profit').formula.map(term => [term.cardId, term.value])).toEqual([['sales', 1500], ['cogs', 1000], ['business', 0], ['badDebts', 200]]);
        expect(buildBreakdown(s, 'badDebts').rows).toEqual([expect.objectContaining({ billId: 'r1', billType: 'retail', amount: 200, writeOff: true })]);
        expect(buildBreakdown(s, 'labour').rows).toEqual([expect.objectContaining({ billId: 'p1', amount: 60 })]);
        expect(buildBreakdown(s, 'cogs').notes).toEqual([expect.objectContaining({ cardId: 'labour', value: 60 })]);
        // A write-off in another period does not touch this one.
        const before = summarize(w, { from: localMs('2026-10-01'), to: localMs('2026-10-06') });
        expect(before.badDebts).toBe(0);
    });

    test('cash flow counts the final payment on an old bill (not in memory) from the period\'s cash sessions, once', () => {
        const f = byName['buy-then-sell'];
        const range = { from: localMs('2026-10-05'), to: localMs('2026-10-06') };
        const leg = { id: 'pay-old', billId: 'old-bill', customer: 'Gupta', type: 'received', cash: 700, online: 0, at: localMs('2026-10-05') + 3600000 };
        const sessions = [{ id: 's1', date: '2026-10-05', duePayments: [leg] }];
        const withSessions = computeFinanceSummary({ sources: sourcesOf(f), items: f.items, base: { state: {}, from: -Infinity }, sessions, ...range, detail: true });
        expect(withSessions.cash.dueReceived).toBe(700);
        expect(withSessions.duesApproximate).toBe(false);
        expect(buildBreakdown(withSessions, 'dueReceived').rows).toEqual([expect.objectContaining({ party: 'Gupta', amount: 700, billId: null })]);
        // The same payment also on a bill in memory: counted once.
        const r = JSON.parse(JSON.stringify(f.retailSales[0]));
        r.payments = [{ id: 'pay-old', date: '2026-10-05T11:00:00', cash: 700 }];
        const both = computeFinanceSummary({ sources: { ...sourcesOf(f), retailSales: [r] }, items: f.items, base: { state: {}, from: -Infinity }, sessions, ...range });
        expect(both.cash.dueReceived).toBe(700);
        // Without sessions (and without full history) the cash flow is marked approximate.
        const without = computeFinanceSummary({ sources: sourcesOf(f), items: f.items, base: { state: {}, from: -Infinity }, duesComplete: false, ...range });
        expect(without.cash.dueReceived).toBe(0);
        expect(without.duesApproximate).toBe(true);
    });

    test('FinanceManager loads the period\'s cash sessions once (no full read) and marks cash flow approximate until then', async () => {
        AppState.historyLoadedFrom = Date.now() - 86400000 * 40;
        const load = jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([{ id: 's', date: '2026-10-05', duePayments: [] }]);
        FinanceManager.sessionCache = new Map();
        const range = { from: Date.now() - 7 * 86400000, to: Infinity };
        expect(FinanceManager.periodSessions(range).complete).toBe(false);
        expect(FinanceManager.periodSessions(range).complete).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(FinanceManager.periodSessions(range)).toEqual({ sessions: [{ id: 's', date: '2026-10-05', duePayments: [] }], complete: true });
        // A year is too long to read session by session: approximate, no read.
        expect(FinanceManager.periodSessions({ from: Date.now() - 365 * 86400000, to: Infinity }).complete).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
        AppState.historyLoadedFrom = 0;
        expect(FinanceManager.periodSessions(range)).toEqual({ sessions: [], complete: true });
    });
});

describe('replayWithValues: cost of each sale at the average cost at that moment', () => {
    test('emits −value change per sale line', () => {
        const sources = {
            purchases: [
                { date: '2026-10-01T09:00:00', items: [{ itemId: 'r', qty: 100, rate: 20 }] },
                { date: '2026-10-03T09:00:00', items: [{ itemId: 'r', qty: 100, rate: 26 }] }
            ],
            retailSales: [
                { date: '2026-10-02T09:00:00', items: [{ itemId: 'r', qty: 50 }] },
                { date: '2026-10-04T09:00:00', items: [{ itemId: 'r', qty: 75 }] }
            ]
        };
        const costs = [];
        replayWithValues({}, collectEvents(sources), createItemKeyResolver([{ id: 'r', name: 'Rice' }]), (ev, key, delta) => {
            if (ev.kind === 'sale') costs.push(Math.round(-delta * 100) / 100);
        });
        // 50 @ 20; then (50×20 + 100×26) / 150 = 24 avg → 75 × 24
        expect(costs).toEqual([1000, 1800]);
    });
});

describe('breakdown details', () => {
    const f = byName['mixed-shapes'];
    const oct = summarize(f, rangeOf(f.periods.october));

    test('cost of goods sold: per line qty × average cost, grouped by item', () => {
        const b = buildBreakdown(oct, 'cogs');
        expect(b.rows.map(r => [r.billNo, r.itemKey, r.qty, r.rate, r.amount]).sort()).toEqual([
            ['S20261003-001', 'item-gram', 10, 40, 400],
            ['S20261006-001', 'item-wheat', 20, 20, 400],
            ['W20261002-001', 'item-wheat', 40, 20, 800]
        ]);
        const groups = groupRows(b.rows, 'item');
        expect(groups.map(g => [g.key, g.subtotal, g.count])).toEqual([['item-wheat', 1200, 2], ['item-gram', 400, 1]]);
        expect(groupRows(b.rows, 'item', { lang: 'hi' })[1].label).toBe('चना');
    });

    test('sales rows link to their bills (type + id) and group by name and day', () => {
        const b = buildBreakdown(oct, 'sales');
        expect(b.rows.find(r => r.billNo === 'W20261002-001')).toMatchObject({ billType: 'wholesale', billId: 'w1', party: 'Gupta Traders', amount: 1200 });
        expect(groupRows(b.rows, 'party').map(g => [g.label, g.subtotal])).toEqual([['Gupta Traders', 1200], ['Sita', 560], ['', 500]]);
        expect(groupRows(b.rows, 'day').map(g => g.key)).toEqual(['2026-10-06', '2026-10-03', '2026-10-02']);
    });

    test('formula terms drill into their own breakdowns with the same numbers', () => {
        const b = buildBreakdown(oct, 'profit');
        expect(b.formula.map(term => [term.cardId, term.sign, term.value])).toEqual([['sales', 1, 2260], ['cogs', -1, 1600], ['business', -1, 350]]);
        b.formula.forEach(term => {
            const sub = buildBreakdown(oct, term.cardId);
            expect(sub.value).toBe(term.value);
            expect(sub.total).toBeCloseTo(term.value, 2);
        });
        expect(b.formula.reduce((a, term) => a + term.sign * term.value, 0)).toBe(b.value);
        expect(groupRows(b.rows, 'term').map(g => [g.key, g.subtotal])).toEqual([['sales', 2260], ['cogs', -1600], ['business', -350]]);
    });

    test('expenses: untagged counts as business; personal is its own card', () => {
        expect(buildBreakdown(oct, 'business').rows.map(r => [r.category, r.amount])).toEqual([['business', 300], ['', 50]]);
        expect(buildBreakdown(oct, 'personal').rows.map(r => r.amount)).toEqual([150]);
        expect(oct.expenses.uncategorised).toBe(50);
    });

    test('cash flow rows: bill-time payments and later due payments', () => {
        expect(buildBreakdown(oct, 'dueReceived').rows).toEqual([expect.objectContaining({ billId: 'r2', billType: 'retail', amount: 560, party: 'Sita' })]);
        expect(buildBreakdown(oct, 'duePaid').rows).toEqual([expect.objectContaining({ billId: 'p1', billType: 'purchase', amount: 1000 })]);
        expect(buildBreakdown(oct, 'receivedAtSale').rows.map(r => [r.billId, r.cash, r.online])).toEqual([['r1', 200, 300]]);
    });

    test('stock value now: per item qty × average cost', () => {
        const rows = buildBreakdown(oct, 'stockNow').rows.map(r => [r.itemKey, r.qty, r.rate, r.amount]);
        expect(rows.sort()).toEqual([['item-gram', 40, 40, 1600], ['item-wheat', 30, 20, 600]]);
    });

    test('check-line mismatch: per-item differences', () => {
        const g = byName['sold-before-bought'];
        const s = summarize(g, rangeOf(g.periods.all));
        const b = buildBreakdown(s, 'stockCheck');
        const byItem = Object.fromEntries(b.rows.map(r => [r.itemKey, Math.round(r.amount * 100) / 100]));
        expect(byItem).toEqual(g.periods.all.expected.gapByItem);
        expect(b.formula.map(term => term.cardId)).toEqual(['stockOpening', 'stockPurchases', 'cogs', 'stockAdjustments', 'stockClosing']);
    });

    test('search, sort', () => {
        const rows = buildBreakdown(oct, 'sales').rows;
        expect(searchRows(rows, 'gupta').map(r => r.billId)).toEqual(['w1']);
        expect(searchRows(rows, 'गेहूं').length).toBe(2);
        expect(searchRows(rows, '2026-10-03').map(r => r.billId)).toEqual(['r1']);
        expect(sortRows(rows, 'amount').map(r => r.amount)).toEqual([1200, 560, 500]);
        expect(sortRows(rows, 'date-asc').map(r => r.billId)).toEqual(['w1', 'r1', 'r2']);
    });

    test('bill total differing from its lines gets a balancing row', () => {
        const g = { ...byName['buy-then-sell'] };
        g.retailSales = [{ ...g.retailSales[0], total: 1490 }];
        const s = summarize(g, { from: -Infinity, to: Infinity });
        const rows = cardRows(s, 'sales');
        expect(rows.map(r => r.amount)).toEqual([1500, -10]);
        expect(sumRows(rows)).toBe(s.sales.total);
    });
});

describe('Finance dashboard + breakdown sheet (rendered)', () => {
    const f = byName['buy-then-sell'];
    beforeEach(() => {
        AppState.historyLoadedFrom = 0;
        AppState.items = f.items;
        AppState.purchaseHistory = JSON.parse(JSON.stringify(f.purchases));
        AppState.salesHistory = [];
        AppState.retailSalesHistory = JSON.parse(JSON.stringify(f.retailSales));
        AppState.stockAdjustments = [];
        AppState.expensesHistory = [];
        AppState.withdrawalsHistory = [];
        FinanceManager.currentDateFilter = 'all';
        jest.spyOn(FirebaseService, 'getStockCheckpointState').mockReturnValue(null);
        const tpl = fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'finance.html'), 'utf8');
        document.body.innerHTML = tpl;
        window.app = { history: { viewBill: jest.fn() } };
    });
    afterEach(() => {
        FinanceBreakdownSheet.close();
        ['items', 'purchaseHistory', 'retailSalesHistory'].forEach(k => { AppState[k] = []; });
        delete window.app;
    });

    test('cards show profit on goods sold, cost and stock value; tapping a card opens its breakdown', () => {
        jest.spyOn(FinanceManager, 'renderMonthlyChart').mockImplementation(() => {});
        FinanceManager.setupBreakdownTaps();
        FinanceManager.renderDashboard();
        const text = (id) => document.getElementById(id).textContent;
        expect(text('financeNetProfit')).toBe('₹300');
        expect(text('financeRevenue')).toBe('₹1,500');
        expect(text('financeCogs')).toBe('₹1,200');
        expect(text('financeStockNow')).toBe('₹800');
        expect(document.getElementById('financeStockCheck').style.display).toBe('none');

        document.querySelector('[data-finance-card="profit"] .finance-hero-value').click();
        const sheet = document.getElementById('financeBreakdownSheet');
        expect(sheet.classList.contains('active')).toBe(true);
        expect(sheet.querySelector('.fin-sheet-value').textContent).toBe('₹300');
        expect(sheet.querySelector('.fin-sheet-total strong').textContent).toBe('₹300');
        expect([...sheet.querySelectorAll('.fin-term')].map(b => b.getAttribute('data-card'))).toEqual(['sales', 'cogs', 'business']);

        // Drill into cost of goods sold, then open the bill.
        sheet.querySelector('.fin-term[data-card="cogs"]').click();
        expect(sheet.querySelector('.fin-sheet-value').textContent).toBe('₹1,200');
        const row = sheet.querySelector('.fin-row-tappable');
        expect(row.textContent).toContain('S20261005-001');
        row.click();
        expect(window.app.history.viewBill).toHaveBeenCalledWith('id:r1', 'retail');
        sheet.querySelector('[data-action="back"]').click();
        expect(sheet.querySelector('.fin-sheet-value').textContent).toBe('₹300');
    });

    test('the uncosted warning shows on the dashboard in the sale\'s period and opens its breakdown', () => {
        jest.spyOn(FinanceManager, 'renderMonthlyChart').mockImplementation(() => {});
        const g = byName['sold-before-bought'];
        AppState.purchaseHistory = JSON.parse(JSON.stringify(g.purchases));
        AppState.retailSalesHistory = JSON.parse(JSON.stringify(g.retailSales));
        FinanceManager.currentDateFilter = 'custom';
        FinanceManager.customStartDate = '2026-10-01';
        FinanceManager.customEndDate = '2026-10-01';
        FinanceManager.setupBreakdownTaps();
        FinanceManager.renderDashboard();
        const warn = document.getElementById('financeProfitWarning');
        expect(warn.style.display).toBe('block');
        expect(warn.textContent).toContain('10 kg');
        expect(warn.textContent).toContain('₹200');
        expect(document.getElementById('financeStockCheck').style.display).toBe('none');
        warn.click();
        expect(document.querySelector('#financeBreakdownSheet .fin-sheet-value').textContent).toBe('₹200');
        FinanceManager.customEndDate = '2026-10-02';
        FinanceManager.customStartDate = '2026-10-02';
        FinanceManager.renderDashboard();
        expect(warn.style.display).toBe('none');
        expect(document.getElementById('financeStockCheck').textContent).toContain('10 kg');
        FinanceManager.currentDateFilter = 'all';
    });

    test('long lists show 50 rows at a time; text is escaped', () => {
        const bills = Array.from({ length: 120 }, (_, i) => ({
            id: `r${i}`, billNumber: `S${i}`, date: '2026-10-05T10:00:00', customerName: '<img src=x onerror=alert(1)>',
            items: [{ itemId: 'item-rice', name: 'Rice', qty: 0.5, rate: 25, total: 12.5 }], total: 12.5, payment: { cash: 12.5, online: 0, due: 0 }
        }));
        AppState.retailSalesHistory = bills;
        FinanceManager.openBreakdown('sales');
        const sheet = document.getElementById('financeBreakdownSheet');
        expect(sheet.querySelectorAll('.fin-row').length).toBe(50);
        expect(sheet.querySelector('img')).toBeNull();
        sheet.querySelector('[data-action="more"]').click();
        expect(sheet.querySelectorAll('.fin-row').length).toBe(100);
        expect(sheet.querySelector('.fin-sheet-total strong').textContent).toBe('₹1,500');
    });
});
