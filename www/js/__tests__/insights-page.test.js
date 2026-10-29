/**
 * @fileoverview Insights page (redesign phase 3): items and parties on screen
 * equal the oracle and add up to Money's sales (AC10, AC11); the to-do list
 * comes from the calculation layer; Seasons hosts the SAME Rate trends /
 * Product traffic view (moved, never copied) on the shared item and month.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../../tests/oracle/oracle.js';
import { InsightsManager, soldKgByMonth, heatLevel } from '../modules/insights.js';
import { MoneyManager } from '../modules/money.js';
import { RateTrendsManager } from '../modules/rate-trends.js';
import { AppState } from '../utils/state.js';
import { getInsightsContext, setInsightsContext, resetInsightsContextForTests } from '../utils/insights-context.js';
import { seasonIndex } from '../utils/business-metrics.js';

const ROOT = path.resolve(__dirname, '../../..');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const copy = (v) => JSON.parse(JSON.stringify(v));
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'www/templates/insights.html'), 'utf8');
const RT_TEMPLATE = fs.readFileSync(path.join(ROOT, 'www/templates/rate-trends.html'), 'utf8');
const OCT = [new Date(2026, 9, 1).getTime(), new Date(2026, 9, 22).getTime()];
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

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
    AppState.settings = {};
    AppState.stock = {};
    resetInsightsContextForTests();
    document.body.innerHTML = TEMPLATE + RT_TEMPLATE;
    document.getElementById('insights').classList.add('active');
    MoneyManager.snapshots = {};
    jest.spyOn(MoneyManager, 'loadSnapshots').mockResolvedValue();
    Object.assign(InsightsManager, { section: 'actions', seasonView: 'calendar', itemsType: 'both', partyKind: 'sales', seasonDocs: null, seasonLoading: null });
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('items and parties == oracle (I1, I3, I4) and add up', () => {
    test('Items table: sales per item equal the oracle and add up to M1 (AC10)', () => {
        InsightsManager.init('items');
        const w = O.metrics(data, OCT);
        const rows = [...document.querySelectorAll('#insightsItemsTable tbody tr')];
        expect(rows.length).toBeGreaterThan(0);
        const sum = rows.reduce((a, tr) => a + num(tr.children[1].textContent), 0);
        rows.forEach(tr => expect(num(tr.children[1].textContent)).toBe(Math.round(w.I1_itemSales[tr.dataset.item] || 0)));
        expect(Math.abs(sum - w.M1_sales)).toBeLessThanOrEqual(rows.length);
        expect(document.getElementById('insightsItemsTakeaway').textContent).toMatch(/earned the most profit/);
    });

    test('Retail / wholesale split adds up to sales (I2)', () => {
        InsightsManager.init('items');
        const w = O.metrics(data, OCT);
        const vals = [...document.querySelectorAll('#insightsSplit .ins-row span:last-child')].map(el => num(el.textContent.split('·')[0]));
        expect(vals).toEqual([Math.round(w.M1_retail), Math.round(w.M1_wholesale)]);
    });

    test('Bought table shares labour, so items add up to purchases after labour (#47)', () => {
        InsightsManager.init('items');
        const w = O.metrics(data, OCT);
        const vals = [...document.querySelectorAll('#insightsBoughtTable tbody tr')].map(tr => num(tr.children[2].textContent));
        expect(Math.abs(vals.reduce((a, b) => a + b, 0) - w.M16_purchases)).toBeLessThanOrEqual(vals.length);
    });

    test('Customers and suppliers equal the oracle and add up (AC11)', () => {
        InsightsManager.init('parties');
        const w = O.metrics(data, OCT);
        const cust = [...document.querySelectorAll('#insightsCustomersTable tbody tr')];
        cust.forEach(tr => expect(num(tr.children[1].textContent)).toBe(Math.round(w.I3_customers[tr.dataset.party])));
        InsightsManager.setPartyKind('purchases');
        const sup = [...document.querySelectorAll('#insightsSuppliersTable tbody tr')];
        sup.forEach(tr => expect(num(tr.children[1].textContent)).toBe(Math.round(w.I4_suppliers[tr.dataset.party])));
        expect(document.getElementById('insightsSuppliersTable').hidden).toBe(false);
        expect(document.getElementById('insightsCustomersTable').hidden).toBe(true);
    });

    test('checks line: items and parties add up to Money\'s sales', () => {
        InsightsManager.init('items');
        expect(document.getElementById('insightsChecks').textContent).toMatch(/add up/);
    });
});

describe('to-do list (I7, I8, overdue)', () => {
    test('overdue receivables older than 30 days become one card with the Outstanding button', () => {
        InsightsManager.init('actions');
        const dues = document.getElementById('insightsActionsDues');
        const owed = [...(AppState.retailSalesHistory), ...(AppState.salesHistory)];
        const expected = owed.some(b => O.openDue(b) > 0 && (NOW - O.timeOf(b.date)) / 86400000 > 31);
        expect(/owe you/.test(dues.textContent)).toBe(expected);
        expect(document.getElementById('insightsActionsLinks').textContent).toMatch(/anomalies/);
    });

    test('a sale below its cost shows with the item and kg', () => {
        AppState.purchaseHistory.push({ id: 'pz', date: '2026-10-02', timestamp: new Date(2026, 9, 2).getTime(), grandTotal: 1000, items: [{ itemId: FIX.items[0].id, name: FIX.items[0].name, qty: 20, rate: 50, total: 1000 }] });
        AppState.retailSalesHistory.push({ id: 'rz', date: '2026-10-03', timestamp: new Date(2026, 9, 3).getTime(), total: 20, payment: { cash: 20 }, items: [{ itemId: FIX.items[0].id, name: FIX.items[0].name, qty: 1, rate: 20, total: 20 }] });
        InsightsManager.init('actions');
        expect(document.getElementById('insightsActionsBelow').textContent).toMatch(/below its cost/);
    });

    test('a role without the profit permission gets no ₹-lost / per-₹100 cards, and no Seasons', () => {
        AppState.purchaseHistory.push({ id: 'pz', date: '2026-10-02', timestamp: new Date(2026, 9, 2).getTime(), grandTotal: 1000, items: [{ itemId: FIX.items[0].id, name: FIX.items[0].name, qty: 20, rate: 50, total: 1000 }] });
        AppState.retailSalesHistory.push({ id: 'rz', date: '2026-10-03', timestamp: new Date(2026, 9, 3).getTime(), total: 20, payment: { cash: 20 }, items: [{ itemId: FIX.items[0].id, name: FIX.items[0].name, qty: 1, rate: 20, total: 20 }] });
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { analytics: true, profit: false } } };
        InsightsManager.init('trends');
        expect(InsightsManager.section).toBe('actions');
        expect(document.getElementById('insightsActionsBelow').textContent).toBe('');
        expect(document.getElementById('insightsActionsLow').textContent).toBe('');
        expect(document.querySelector('#insights [data-insights-section="seasons"]').hidden).toBe(true);
        InsightsManager.setSection('seasons');
        expect(InsightsManager.section).toBe('actions');
    });
});

describe('honest comparisons (review fixes)', () => {
    test('a part month is not compared with last year\'s whole month from snapshots ("—")', () => {
        AppState.historyLoadedFrom = new Date(2026, 6, 1).getTime();
        MoneyManager.snapshots = { '2025-10': { month: '2025-10', m: { M1: 1 }, items: { [FIX.items[0].id]: { s: 999999, c: 1, q: 1 } } } };
        InsightsManager.init('items');
        const cells = [...document.querySelectorAll('#insightsItemsTable tbody tr')].map(tr => tr.lastElementChild.textContent);
        expect(cells.length).toBeGreaterThan(0);
        cells.forEach(c => expect(c).toBe('—'));
    });

    test('"stopped coming" never says all-clear without last year\'s data; uses month snapshots when bills are not loaded', () => {
        AppState.historyLoadedFrom = new Date(2026, 6, 1).getTime();
        InsightsManager.init('parties');
        expect(document.getElementById('insightsStopped').textContent).toMatch(/older bills/i);
        expect(document.getElementById('insightsStopped').textContent).not.toMatch(/every regular/i);
        const regular = [{ k: 'ramesh', n: 'Ramesh', t: 100, c: 1 }];
        MoneyManager.snapshots = { '2025-09': { customers: regular }, '2025-10': { customers: regular }, '2025-11': { customers: regular } };
        InsightsManager.render();
        expect(document.getElementById('insightsStopped').textContent).toMatch(/Ramesh/);
    });

    test('stock-up works out weekly kg with one summary for all items', async () => {
        const { stoppedComingCheck } = await import('../utils/business-metrics.js');
        expect(typeof stoppedComingCheck).toBe('function');
        const spy = jest.spyOn(InsightsManager, 'input');
        InsightsManager.seasonDocs = [];
        InsightsManager.renderStockUp();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('single home: every ₹ on the rendered Insights page is tagged', async () => {
        const { unexplainedValues } = await import('../utils/metric-registry.js');
        ['actions', 'items', 'parties'].forEach(s => InsightsManager.init(s));
        InsightsManager.setPartyKind('purchases');
        expect(unexplainedValues(document.getElementById('insights'))).toEqual([]);
    });
});

describe('Seasons: one Rate trends view, two entry points', () => {
    test('mount() moves the same view into Insights and home() puts it back on Rates', () => {
        const view = document.querySelector('.rt-page');
        const host = document.getElementById('insightsTrendsHost');
        jest.spyOn(RateTrendsManager, 'init').mockResolvedValue();
        RateTrendsManager.mount(host, { section: 'traffic', itemId: 'x1', month: '2026-09' });
        expect(host.contains(view)).toBe(true);
        expect(document.querySelectorAll('.rt-page').length).toBe(1);
        expect(RateTrendsManager.section).toBe('traffic');
        expect([RateTrendsManager.itemId, RateTrendsManager.trafficItemId, RateTrendsManager.trafficMonth]).toEqual(['x1', 'x1', '2026-09']);
        RateTrendsManager.open('rates');
        expect(document.getElementById('rate-trends').contains(view)).toBe(true);
    });

    test('tapping an item opens Seasons › Rate trends on that item (shared picker)', async () => {
        const mount = jest.spyOn(RateTrendsManager, 'mount').mockResolvedValue();
        InsightsManager.rateTrends = RateTrendsManager;
        InsightsManager.init('items');
        const row = document.querySelector('#insightsItemsTable tbody tr[data-item]');
        row.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(getInsightsContext().itemId).toBe(row.dataset.item);
        expect(mount).toHaveBeenCalledWith(document.getElementById('insightsTrendsHost'), expect.objectContaining({ section: 'rates', itemId: row.dataset.item, month: '2026-10' }));
    });

    test('Product traffic opens on the period\'s month', async () => {
        const mount = jest.spyOn(RateTrendsManager, 'mount').mockResolvedValue();
        InsightsManager.rateTrends = RateTrendsManager;
        setInsightsContext({ preset: 'month:2026-09' });
        InsightsManager.init('traffic');
        await Promise.resolve();
        await Promise.resolve();
        expect(mount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ section: 'traffic', month: '2026-09' }));
    });

    test('Calendar: heat map from rateStats month buckets (I5) and a season takeaway', async () => {
        const months = {};
        for (let y = 2024; y <= 2025; y++) {
            for (let m = 1; m <= 12; m++) {
                months[`m${y}-${String(m).padStart(2, '0')}`] = { retail: { kg: m === 11 ? 400 : 100 }, wholesale: { kg: 0 } };
            }
        }
        const id = FIX.items[0].id;
        InsightsManager.seasonDocs = [{ itemId: id, months }];
        InsightsManager.init('seasons');
        const cells = document.querySelectorAll(`#insightsCalendar td[data-item="${id}"]`);
        expect(cells.length).toBe(12);
        expect(cells[10].className).toBe('h4');
        expect(document.getElementById('insightsSeasonTakeaway').textContent).toMatch(/usually sells/);
    });

    test('soldKgByMonth and heatLevel', () => {
        const kg = soldKgByMonth([{ itemId: 'a', months: { 'm2025-01': { retail: { kg: 5 }, wholesale: { kg: 7 } } } }]).get('a');
        expect(kg).toEqual({ '2025-01': 12 });
        expect([heatLevel(null), heatLevel(0.3), heatLevel(1), heatLevel(1.3), heatLevel(2)]).toEqual([0, 1, 2, 3, 4]);
        expect(seasonIndex(kg)).toBeNull();
    });
});

describe('round-2 review fixes', () => {
    test('"stopped coming" is unknown when a snapshot\'s customer list was cut to the top customers', async () => {
        const { snapshotCustomers, TOP_PARTIES } = await import('../utils/month-snapshots.js');
        const full = Array.from({ length: TOP_PARTIES }, (_, i) => ({ k: `c${i}`, n: `C${i}`, t: 10, c: 1 }));
        expect(snapshotCustomers({ customers: full, m: { Cc: TOP_PARTIES + 7 } })).toBeNull();
        expect(snapshotCustomers({ customers: full })).toBeNull();
        expect(snapshotCustomers({ customers: full, m: { Cc: TOP_PARTIES } })).toHaveLength(TOP_PARTIES);
        expect(snapshotCustomers({ customers: full.slice(0, 3) })).toHaveLength(3);

        AppState.historyLoadedFrom = new Date(2026, 6, 1).getTime();
        const regular = [{ k: 'ramesh', n: 'Ramesh', t: 100, c: 1 }];
        MoneyManager.snapshots = {
            '2025-09': { customers: regular, m: { Cc: 1 } },
            '2025-10': { customers: [...regular, ...full.slice(1)], m: { Cc: 80 } },
            '2025-11': { customers: regular, m: { Cc: 1 } }
        };
        InsightsManager.init('parties');
        expect(document.getElementById('insightsStopped').textContent).toMatch(/older bills/i);
        expect(document.getElementById('insightsStopped').textContent).not.toMatch(/every regular/i);
    });

    test('a built snapshot records how many customers the month had (m.Cc)', async () => {
        const { buildSnapshot } = await import('../utils/month-snapshots.js');
        const { moneySummary } = await import('../utils/business-metrics.js');
        const sep = { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime() };
        const doc = buildSnapshot('2026-09', moneySummary({ ...data, base: { state: {}, from: -Infinity } }, sep, { detail: true }), data, NOW);
        expect(doc.m.Cc).toBe(doc.customers.length);
    });

    test('weekly kg divides by the weeks actually loaded; under 2 weeks there is no stock-up card', async () => {
        const { moneySummary, itemSummary } = await import('../utils/business-metrics.js');
        const from = NOW - 28 * 86400000;
        AppState.historyLoadedFrom = from;
        const weekly = InsightsManager.weeklySoldKg(new Date(NOW));
        const want = itemSummary(moneySummary(InsightsManager.input(from), { from, to: NOW + 1 }, { detail: true }));
        expect(want.some(r => r.qty > 0)).toBe(true);
        want.forEach(r => expect(weekly.get(r.itemKey)).toBeCloseTo(r.qty / 4, 6));

        AppState.historyLoadedFrom = NOW - 10 * 86400000;
        expect(InsightsManager.weeklySoldKg(new Date(NOW))).toBeNull();
        InsightsManager.seasonDocs = [];
        document.getElementById('insightsActionsStock').innerHTML = '<p>old</p>';
        InsightsManager.renderStockUp();
        expect(document.getElementById('insightsActionsStock').innerHTML).toBe('');
    });

    test('"What you bought" shows what was paid only with the purchase rates permission', () => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { analytics: true, purchaseRates: false } } };
        InsightsManager.init('items');
        const rows = [...document.querySelectorAll('#insightsBoughtTable tbody tr')];
        expect(rows.length).toBeGreaterThan(0);
        rows.forEach(tr => expect(tr.children.length).toBe(2));
        expect(document.getElementById('insightsBoughtTable').textContent).not.toMatch(/₹/);
        AppState.settings = { roleAccess: { staff: { analytics: true, purchaseRates: true } } };
        InsightsManager.render();
        document.querySelectorAll('#insightsBoughtTable tbody tr').forEach(tr => expect(tr.children.length).toBe(3));
    });
});
