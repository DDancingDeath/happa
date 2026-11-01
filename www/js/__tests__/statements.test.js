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
import { MoneyManager } from '../modules/money.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { dayBook, partyLedger, partyChoices, itemLedger, exportLines, accountantLines, toCsv, csvCell, plainLabel, isoMinute, CSV_ENGLISH_KEY } from '../utils/statements.js';
import { t } from '../i18n/index.js';
import { moneySummary } from '../utils/business-metrics.js';
import { normalizePartyName } from '../utils/aging.js';
import { computeStock } from '../utils/stock-replay.js';
import * as openExternalMod from '../utils/open-external.js';
import { UIManager } from '../ui/ui-manager.js';
import { AuditService } from '../services/audit.js';
import { Exporter } from '../services/exporter.js';

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
    MoneyManager.sessionCache = new Map();
    jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
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

    test('accountant CSV (ST6): bill rows add up to Money\'s sales and purchases, payment rows to the dues paid on old bills (#103)', () => {
        const r = { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 };
        const session = {
            id: 's-acc', date: '2026-10-20', signedOut: true,
            duePayments: [
                { id: 'leg-in', billId: 'w-old', billType: 'wholesale', billNumber: 'W-OLD', type: 'received', customer: 'Old Buyer', cash: 300, online: 200, timestamp: '2026-10-20T11:00:00' },
                { id: 'leg-out', billId: 'p-old', billType: 'purchase', billNumber: 'P-OLD', type: 'paid', customer: 'Old Seller', cash: 0, online: 150, timestamp: '2026-10-20T12:00:00' }
            ]
        };
        const lines = accountantLines(data, r, { sessions: [session] });
        const m = moneySummary({ ...data, base: { state: {}, from: -Infinity }, sessions: [session] }, r);
        const sum = (rows, f) => rows.reduce((a, x) => a + f(x), 0);
        const bills = (types) => lines.filter(x => x.entry === 'bill' && types.includes(x.billType));
        expect(sum(bills(['retail', 'wholesale']), x => x.total)).toBeCloseTo(m.M1.total, 2);
        expect(sum(bills(['purchase']), x => x.total)).toBeCloseTo(m.M16.total, 2);
        const received = lines.filter(x => x.entry === 'payment_received');
        expect(sum(bills(['retail', 'wholesale']), x => x.cash + x.online) + sum(received, x => x.payment)).toBeCloseTo(m.M12.total, 2);
        expect(received.find(x => x.billNo === 'W-OLD')).toMatchObject({ party: 'Old Buyer', cash: 300, online: 200, payment: 500, total: null, due: null });
        expect(lines.find(x => x.billNo === 'P-OLD')).toMatchObject({ entry: 'payment_made', payment: 150 });
        lines.filter(x => x.entry === 'bill').forEach(x => expect(x.total).toBeCloseTo(x.cash + x.online + x.due, 2));
        expect(lines.map(x => x.t)).toEqual([...lines.map(x => x.t)].sort((a, b) => a - b));
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

    test('CSV injection: text starting with = + - @ is shown, not run; numbers stay numbers', () => {
        const csv = toCsv(['h'], [['=HYPERLINK("x")'], ['+1'], ['-2+3'], ['@SUM(A1)'], [-50], ['Ram']]);
        expect(csv.split('\r\n').slice(1, 7)).toEqual(['"\'=HYPERLINK(""x"")"', "'+1", "'-2+3", "'@SUM(A1)", '-50', 'Ram']);
        expect(csvCell('− Cost')).toBe('− Cost');
        expect(plainLabel('= Gross profit')).toBe('Gross profit');
        expect(plainLabel('− Business expenses')).toBe('Business expenses');
        expect(isoMinute(new Date(2026, 9, 21, 9, 5).getTime())).toBe('2026-10-21 09:05');
    });
});

describe('Statements: CSV language, dates and permissions', () => {
    const csvOf = () => {
        let text = '';
        global.URL.createObjectURL = jest.fn((blob) => { text = blob; return 'blob:x'; });
        global.URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        StatementsManager.downloadCsv();
        return toCsv(StatementsManager.current.csvHeader, StatementsManager.current.csvRows) && text && StatementsManager.current;
    };

    test('day-book CSV writes ISO dates (YYYY-MM-DD HH:mm); month CSV labels have no = or − signs', () => {
        StatementsManager.open('day');
        const cur = StatementsManager.current;
        cur.csvRows.filter(r => r[0]).forEach(r => expect(r[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
        StatementsManager.open('month');
        StatementsManager.current.csvRows.forEach(r => expect(r[0]).not.toMatch(/^[=−+-]/));
    });

    test('Hindi app: CSV headers in Hindi, or English when "CSV in English" is on (shared device setting)', async () => {
        const i18n = await import('../i18n/index.js');
        const getLang = jest.spyOn(i18n, 'getLang').mockReturnValue('hi');
        localStorage.setItem(CSV_ENGLISH_KEY, '0');
        StatementsManager.open('day');
        expect(document.getElementById('statementsCsvOption').hidden).toBe(false);
        const hiHeader = StatementsManager.current.csvHeader.join(',');
        expect(hiHeader).not.toMatch(/[A-Za-z]{3,}/);
        StatementsManager.setCsvEnglish(true);
        expect(localStorage.getItem(CSV_ENGLISH_KEY)).toBe('1');
        expect(StatementsManager.current.csvHeader[0]).toBe('Time');
        StatementsManager.open('csv');
        expect(StatementsManager.current.csvHeader[0]).toBe(t('ui.statements.csv_date', null, 'en'));
        getLang.mockRestore();
        localStorage.removeItem(CSV_ENGLISH_KEY);
    });

    test('a role without profit / personal expenses / stock value / purchase rates gets none of those lines on screen, WhatsApp or CSV', () => {
        AppState.userRole = 'staff';
        AppState.settings = { roleAccess: { staff: { reports: true, profit: false, personalExpenses: false, stockValue: false, purchaseRates: false } } };
        StatementsManager.open('month');
        const ids = [...document.querySelectorAll('#statementsDoc [data-metric-export]')].map(el => el.dataset.metricExport);
        ['M2', 'M3', 'M6', 'M8', 'M10'].forEach(id => expect(ids).not.toContain(id));
        const words = [t('ui.money.cogs_minus'), t('ui.money.profit_eq'), t('ui.money.personal_expenses'), t('ui.money.closing_stock')].map(plainLabel);
        const share = StatementsManager.current.share;
        const csv = StatementsManager.current.csvRows.map(r => r[0]).join('|');
        words.forEach(w => { expect(share).not.toContain(w); expect(csv).not.toContain(w); });
        StatementsManager.open('day');
        expect(StatementsManager.current.csvRows.some(r => r[1] === t('ui.statements.k_personal'))).toBe(false);
        StatementsManager.open('item');
        expect(StatementsManager.current.csvHeader).not.toContain(t('ui.statements.avg_cost'));
        expect(StatementsManager.current.share).not.toMatch(/₹/);
    });

    test('purchase lines of the CSV export have no rate without purchaseRates', () => {
        AppState.settings = { roleAccess: { staff: { reports: true, purchaseRates: false } } };
        const perms = jest.spyOn(StatementsManager, 'perms').mockReturnValue({ profit: true, personalExpenses: true, stockValue: true, purchaseRates: false });
        StatementsManager.open('csv');
        expect(StatementsManager.current.csvRows.filter(r => r[1] === t('ui.statements.k_purchase')).length).toBeGreaterThan(0);
        StatementsManager.current.csvRows.filter(r => r[1] === t('ui.statements.k_purchase')).forEach(r => expect(r[6]).toBe(''));
        perms.mockRestore();
    });

    test('owner sees every line', () => {
        StatementsManager.open('month');
        const ids = [...document.querySelectorAll('#statementsDoc [data-metric-export]')].map(el => el.dataset.metricExport);
        ['M2', 'M3', 'M6', 'M8', 'M10'].forEach(id => expect(ids).toContain(id));
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

    test('today\'s day book links to Today and lists the bills without repeating Today\'s totals (screen, WhatsApp, CSV)', () => {
        StatementsManager.open('day');
        const doc = document.getElementById('statementsDoc');
        expect(doc.querySelector('.st-totals')).toBeNull();
        expect(doc.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
        const share = StatementsManager.current.share;
        expect(share).not.toMatch(new RegExp(t('ui.statements.t_sales')));
        expect(share.split('\n').length).toBe(1 + doc.querySelectorAll('tbody tr').length);
        expect(StatementsManager.current.csvRows.length).toBe(doc.querySelectorAll('tbody tr').length);
        StatementsManager.set('day', '2026-10-20');
        expect(document.querySelector('#statementsDoc .st-totals')).not.toBeNull();
        expect(StatementsManager.current.share).toMatch(new RegExp(t('ui.statements.t_sales')));
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

    test('WhatsApp shares a short text; CSV downloads; Print opens a printable page', async () => {
        jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        const open = jest.spyOn(openExternalMod, 'openExternal').mockImplementation(() => 'tab');
        StatementsManager.open('month');
        await StatementsManager.shareWhatsApp();
        expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
        expect(decodeURIComponent(open.mock.calls[0][0])).toMatch(/Month statement · Oct 2026/);
        global.URL.createObjectURL = jest.fn(() => 'blob:x');
        global.URL.revokeObjectURL = jest.fn();
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        await StatementsManager.downloadCsv();
        expect(click).toHaveBeenCalled();
        const doc = { write: jest.fn(), close: jest.fn() };
        jest.spyOn(window, 'open').mockReturnValue({ document: doc, print: jest.fn() });
        await StatementsManager.print();
        expect(doc.write.mock.calls[0][0]).toMatch(/Month statement/);
        expect(AuditService.note.mock.calls.map(c => c[1].format)).toEqual(['whatsapp', 'csv', 'print']);
    });

    test('exports are the owner\'s (#103): no export buttons or export-only statements for anyone else', async () => {
        AppState.userRole = 'manager';
        AppState.settings = { roleAccess: { manager: { reports: true } } };
        StatementsManager.init();
        const ownerOnly = [...document.querySelectorAll('#statements [data-owner-only]')];
        expect(ownerOnly.map(el => el.id || el.getAttribute('onclick'))).toEqual(expect.arrayContaining(['statementsActions']));
        expect(ownerOnly.length).toBe(3);
        ownerOnly.forEach(el => expect(el.hidden).toBe(true));
        StatementsManager.open('accountant');
        expect(StatementsManager.kind).toBe(null);
        expect(document.getElementById('statementsView').hidden).toBe(true);
        StatementsManager.open('day');
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        const open = jest.spyOn(openExternalMod, 'openExternal').mockImplementation(() => 'tab');
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        expect(await StatementsManager.shareWhatsApp()).toBe(false);
        expect(open).not.toHaveBeenCalled();
        expect(note).not.toHaveBeenCalled();
        AppState.userRole = 'owner';
        StatementsManager.init();
        ownerOnly.forEach(el => expect(el.hidden).toBe(false));
    });

    test('a statement with names asks first; the shared text and the CSV carry shop, period, time and user (#103)', async () => {
        AppState.settings = { shopName: 'Gupta Traders' };
        AppState.userName = 'Asha';
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValueOnce(false).mockResolvedValue(true);
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        const open = jest.spyOn(openExternalMod, 'openExternal').mockImplementation(() => 'tab');
        StatementsManager.open('day');
        StatementsManager.set('day', '2026-10-20');
        expect(await StatementsManager.shareWhatsApp()).toBe(false);
        expect(open).not.toHaveBeenCalled();
        expect(note).not.toHaveBeenCalled();
        expect(await StatementsManager.shareWhatsApp()).toBe(true);
        const text = decodeURIComponent(open.mock.calls[0][0].replace('https://wa.me/?text=', ''));
        expect(text.split('\n')[0]).toBe('Gupta Traders');
        expect(text).toMatch(/Period: Day book · .* · Exported: \d{4}-\d{2}-\d{2} \d{2}:\d{2} · By: Asha$/);
        expect(note).toHaveBeenLastCalledWith('EXPORT', { exportKind: 'day', format: 'whatsapp', from: '2026-10-20', to: '2026-10-20', rows: StatementsManager.current.csvRows.length });
        const saved = [];
        jest.spyOn(Exporter, 'saveBlob').mockImplementation(async (blob, name) => { saved.push({ blob, name }); return true; });
        const Real = global.Blob;
        global.Blob = class { constructor(parts) { this.text = parts.join(''); } };
        StatementsManager.set('csvFrom', '2026-10-01');
        StatementsManager.open('accountant');
        await StatementsManager.downloadCsv();
        global.Blob = Real;
        const lines = saved[0].blob.text.split('\r\n');
        expect(lines.slice(0, 2)).toEqual(['\uFEFFShop,Gupta Traders', expect.stringMatching(/^Period,Accountant CSV · /)]);
        expect(lines[3]).toBe('By,Asha');
        expect(lines[5]).toBe('date,entry,bill_type,bill_no,party,bill_total,cash,online,due,payment_amount');
        expect(saved[0].name).toMatch(new RegExp(`^Gupta-Traders_accountant_2026-10-01_${StatementsManager.csvTo}_\\d{8}-\\d{4}\\.csv$`));
        expect(modal).toHaveBeenCalledTimes(3);
    });

    test('a day before the loaded bills offers to load them', () => {
        AppState.historyLoadedFrom = new Date(2026, 9, 1).getTime();
        StatementsManager.open('day');
        StatementsManager.set('day', '2026-09-30');
        expect(document.getElementById('statementsDoc').textContent).toMatch(/not loaded/);
    });
});

describe('payments on old bills with part of the history loaded (round-3 review)', () => {
    const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
    const SESSION = {
        id: 's-2026-10-20', date: '2026-10-20', signedOut: true, closingBalance: 0,
        duePayments: [{ id: 'pay-old', billId: 'w-may', billType: 'wholesale', billNumber: 'W-MAY', type: 'received', customer: 'Old Buyer', cash: 500, online: 0, timestamp: '2026-10-20T11:00:00' }]
    };
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    test('a 5-month-old due cleared this month is in the month statement (M12, M14) and the day book, as on Money › Cash', async () => {
        AppState.historyLoadedFrom = new Date(2026, 9, 1).getTime();
        MoneyManager.sessionCache = new Map();
        MoneyManager.summaryCache = { sig: null, map: new Map(), computed: 0 };
        Object.assign(MoneyManager, { snapshots: {}, snapshotsLoaded: true, section: 'cash' });
        const load = jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([SESSION]);
        document.getElementById('statements').classList.add('active');
        const val = (id) => num(document.querySelector(`#statementsDoc [data-metric-export="${id}"]`).textContent);

        StatementsManager.open('month');
        expect(document.getElementById('statementsDoc').textContent).toMatch(/payments on old bills may be missing/);
        await flush();
        expect(load).toHaveBeenCalled();
        expect(document.getElementById('statementsDoc').textContent).not.toMatch(/payments on old bills may be missing/);
        const r = { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 };
        const base = { state: {}, from: -Infinity };
        const before = moneySummary({ ...data, base }, r);
        const after = moneySummary({ ...data, base, sessions: [SESSION] }, r);
        expect(after.M12.total).toBe(before.M12.total + 500);
        expect(val('M12')).toBe(Math.round(after.M12.total));
        expect(val('M14')).toBe(Math.round(after.M14));

        document.body.insertAdjacentHTML('beforeend', fs.readFileSync(path.join(ROOT, 'www/templates/money.html'), 'utf8'));
        document.getElementById('money').classList.add('active');
        MoneyManager.init('cash');
        expect(num(document.getElementById('moneyIn').textContent)).toBe(val('M12'));
        expect(num(document.getElementById('moneyNetCash').textContent)).toBe(val('M14'));

        StatementsManager.open('day');
        StatementsManager.set('day', '2026-10-20');
        await flush();
        const row = [...document.querySelectorAll('#statementsDoc tbody tr')].find(tr => /W-MAY/.test(tr.textContent));
        expect(row.textContent).toMatch(/Old Buyer/);
        const { totals } = dayBook(data, { from: new Date(2026, 9, 20).getTime(), to: DAY[0] }, { sessions: [SESSION] });
        const plain = dayBook(data, { from: new Date(2026, 9, 20).getTime(), to: DAY[0] });
        expect(totals.dueReceived).toBe(plain.totals.dueReceived + 500);
        expect(StatementsManager.current.share).toMatch(new RegExp(`${t('ui.statements.t_due_received')}: ₹${totals.dueReceived.toLocaleString('en-IN')}`));
    });

    test('a payment on a loaded bill and its session leg count once', () => {
        const bill = data.purchases.find(b => b.id === 'p2');
        const leg = { id: bill.payments[0].id, billId: 'p2', type: 'paid', customer: 'Ram Lal', cash: 400, online: 0, timestamp: bill.payments[0].date };
        const plain = dayBook(data, { from: DAY[0], to: DAY[1] });
        const withLeg = dayBook(data, { from: DAY[0], to: DAY[1] }, { sessions: [{ id: 's', date: '2026-10-21', duePayments: [leg] }] });
        expect(withLeg.totals).toEqual(plain.totals);
        expect(withLeg.rows.length).toBe(plain.rows.length);
    });
});

test('CSV labour of an old bill with only `labour` adds up to M7 (round-3 review)', () => {
    const purchases = data.purchases.map(b => {
        if (b.id !== 'p3') return b;
        const { laborCharges, ...old } = b;
        return { ...old, labour: laborCharges };
    });
    const r = { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 };
    const src = { ...data, purchases };
    const lines = exportLines(src, data.items, r).filter(l => l.type === 'purchase');
    const m = moneySummary({ ...src, base: { state: {}, from: -Infinity } }, r);
    expect(m.M7).toBe(6);
    expect(lines.reduce((a, l) => a + l.labour, 0)).toBe(m.M7);
});
