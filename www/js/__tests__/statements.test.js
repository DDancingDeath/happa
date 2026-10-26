/**
 * @fileoverview Statements (redesign phase 4): each statement closes on the
 * figure of its home page (day book = Today, month statement = Money, party
 * ledger = Outstanding, item ledger = Stock, CSV = Money's sales/purchases),
 * and the page shares, prints and downloads them.
 */
import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import * as O from '../../../tests/oracle/oracle.js';
import { generateShop } from '../../../tests/fixtures/generator.js';
import { StatementsManager } from '../modules/statements.js';
import { AppState } from '../utils/state.js';
import { dayBook, partyLedger, partyChoices, itemLedger, exportLines, toCsv } from '../utils/statements.js';
import { moneySummary } from '../utils/business-metrics.js';
import { normalizePartyName } from '../utils/aging.js';
import { computeStock } from '../utils/stock-replay.js';
import * as openExternalMod from '../utils/open-external.js';

const ROOT = path.resolve(__dirname, '../../..');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const copy = (v) => JSON.parse(JSON.stringify(v));
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'www/templates/statements.html'), 'utf8');
const DAY = [new Date(2026, 9, 21).getTime(), new Date(2026, 9, 22).getTime()];

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(NOW));
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
    document.body.innerHTML = TEMPLATE;
    Object.assign(StatementsManager, { kind: null, day: null, month: null, partyKind: 'customer', partyKey: null, itemKey: null, csvFrom: null, csvTo: null, current: null });
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('statements close on their home figures', () => {
    test('day book (ST1) totals = Today (T1, T2, T13, T14) for 21 Oct', () => {
        const { totals, rows } = dayBook(data, { from: DAY[0], to: DAY[1] });
        const w = O.today(data, NOW);
        expect(totals.sales).toBe(w.T2_sales);
        expect(totals.salesCount).toBe(w.T2_saleCount);
        expect(totals.purchases).toBe(w.T1_purchases);
        expect(totals.dueReceived).toBe(w.T13_dueReceived);
        expect(totals.duePaid).toBe(w.T14_duePaid);
        expect(totals.expenses).toBe(w.T4_businessExpenses + w.T5_personalExpenses);
        expect(rows.map(r => r.t)).toEqual([...rows.map(r => r.t)].sort((a, b) => a - b));
    });

    test('party ledger (ST3) closes on Outstanding for every party (customers and suppliers)', () => {
        ['customer', 'supplier'].forEach(kind => {
            partyChoices(data, kind).forEach(p => {
                const l = partyLedger(data, p.key, kind);
                expect(l.closing).toBeCloseTo(l.due, 0);
                const bills = kind === 'supplier' ? data.purchases : [...data.retailSales, ...data.wholesaleSales];
                const want = bills.filter(b => normalizePartyName(b.customerName) === p.key).reduce((a, b) => a + O.openDue(b), 0);
                expect(l.due).toBeCloseTo(want, 2);
            });
        });
    });

    test('party ledger with a start date carries the earlier balance as the opening line', () => {
        const p = partyChoices(data, 'customer')[0];
        const all = partyLedger(data, p.key, 'customer');
        const later = partyLedger(data, p.key, 'customer', { from: new Date(2026, 9, 15).getTime() });
        expect(later.closing).toBe(all.closing);
        const before = all.rows.filter(r => r.t < new Date(2026, 9, 15).getTime());
        expect(later.opening).toBe(before.length ? before[before.length - 1].balance : 0);
    });

    test('item ledger (ST4) closes on Stock (S1, S3) and flags a sale before the stock was bought', () => {
        const stock = computeStock(data, data.items);
        data.items.forEach(it => {
            const l = itemLedger(data, data.items, it.id);
            const s = stock[it.id] || { quantity: 0, rate: 0 };
            expect(l.closing.qty).toBeCloseTo(s.quantity, 2);
            if (s.quantity > 0) expect(l.closing.value).toBeCloseTo(s.quantity * s.rate, 1);
        });
        const shop = {
            items: [{ id: 'i', name: 'Rice' }],
            retailSales: [{ id: 'r', date: '2026-10-01', timestamp: 1, total: 50, items: [{ itemId: 'i', qty: 2, rate: 25, total: 50 }] }],
            purchases: [{ id: 'p', date: '2026-10-02', timestamp: 2, grandTotal: 300, items: [{ itemId: 'i', qty: 10, rate: 30, total: 300 }] }],
            wholesaleSales: [], stockAdjustments: []
        };
        expect(itemLedger(shop, shop.items, 'i').rows[0].beforeBought).toBe(true);
    });

    test('CSV lines (ST5): amounts after labour add up to Money\'s sales and purchases (#47)', () => {
        const r = { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 };
        const lines = exportLines(data, data.items, r);
        const m = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, r);
        const sum = (type) => lines.filter(x => type.includes(x.type)).reduce((a, x) => a + Number(x.amount), 0);
        expect(sum(['retail', 'wholesale'])).toBeCloseTo(m.M1.total, 2);
        expect(sum(['purchase'])).toBeCloseTo(m.M16.total, 2);
        expect(lines.filter(x => x.type === 'purchase').reduce((a, x) => a + Number(x.labour || 0), 0)).toBeCloseTo(m.M7, 2);
    });

    test('generated histories: every party ledger closes on Outstanding; CSV adds up (property)', () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 1e6 }), (seed) => {
            const s = generateShop({ seed, years: 1, openingRate: 0.5 });
            const okParties = ['customer', 'supplier'].every(kind => partyChoices(s, kind).every(p => {
                const l = partyLedger(s, p.key, kind);
                const bills = kind === 'supplier' ? s.purchases : [...s.retailSales, ...s.wholesaleSales];
                return Math.abs(l.closing - l.due) <= 1 || bills.some(b => normalizePartyName(b.customerName) === p.key
                    && Math.abs(O.billValue(b) - O.payState(b).cash - O.payState(b).online - O.payState(b).due) > 1);
            }));
            const r = { from: -Infinity, to: Infinity };
            const lines = exportLines(s, s.items, r);
            const m = moneySummary({ ...s, base: { state: {}, from: -Infinity } }, r);
            const sales = lines.filter(x => x.type !== 'purchase').reduce((a, x) => a + Number(x.amount), 0);
            return okParties && Math.abs(sales - m.M1.total) <= 0.05;
        }), { seed: 404, numRuns: 3 });
    });

    test('toCsv quotes commas, quotes and new lines', () => {
        expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 3]])).toBe('\uFEFFa,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",3\r\n');
    });
});

describe('Statements page', () => {
    const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

    test('the list opens a statement and Back returns to the list', () => {
        StatementsManager.init();
        expect(document.getElementById('statementsList').hidden).toBe(false);
        StatementsManager.open('day');
        expect(document.getElementById('statementsList').hidden).toBe(true);
        expect(document.getElementById('statementsDoc').textContent).toMatch(/For today, see Today/);
        StatementsManager.back();
        expect(document.getElementById('statementsView').hidden).toBe(true);
    });

    test('month statement shows Money\'s figures (export totals)', () => {
        StatementsManager.open('month');
        const m = moneySummary({ ...data, base: { state: {}, from: -Infinity } }, { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 });
        const val = (id) => num(document.querySelector(`#statementsDoc [data-metric-export="${id}"]`).textContent);
        expect(val('M1')).toBe(Math.round(m.M1.total));
        expect(val('M6')).toBe(Math.round(m.M6.total));
        expect(val('M14')).toBe(Math.round(m.M14));
    });

    test('party ledger: balance in words and the Outstanding check', () => {
        StatementsManager.open('party');
        const text = document.getElementById('statementsDoc').textContent;
        expect(text).toMatch(/to receive/);
        expect(text).toMatch(/Matches Outstanding/);
    });

    test('WhatsApp shares a short text; CSV downloads; Print opens a printable page', () => {
        const open = jest.spyOn(openExternalMod, 'openExternal').mockImplementation(() => 'tab');
        StatementsManager.open('month');
        StatementsManager.shareWhatsApp();
        expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
        expect(decodeURIComponent(open.mock.calls[0][0])).toMatch(/Month statement · Oct 2026/);
        global.URL.createObjectURL = jest.fn(() => 'blob:x');
        global.URL.revokeObjectURL = jest.fn();
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        StatementsManager.downloadCsv();
        expect(click).toHaveBeenCalled();
        const doc = { write: jest.fn(), close: jest.fn() };
        jest.spyOn(window, 'open').mockReturnValue({ document: doc, print: jest.fn() });
        StatementsManager.print();
        expect(doc.write.mock.calls[0][0]).toMatch(/Month statement/);
    });

    test('a day before the loaded bills offers to load them', () => {
        AppState.historyLoadedFrom = new Date(2026, 9, 1).getTime();
        StatementsManager.open('day');
        StatementsManager.set('day', '2026-09-30');
        expect(document.getElementById('statementsDoc').textContent).toMatch(/not loaded/);
    });
});
