/**
 * @fileoverview Oracle tests (#45, stock + outstanding parts): an independent,
 * deliberately simple re-implementation recomputes stock per item and money
 * owed per party straight from raw bill fixtures, and the app's own functions
 * must produce the same numbers.
 *
 * The oracle shares no code with the app (no money.js / stock-replay.js /
 * dates.js). It encodes the app's current rules:
 *  - stock: purchases add, wholesale AND retail sales subtract (decision #33
 *    may change the retail rule), adjustments add / remove / set, in date order;
 *  - a bill's due: 0 if `cleared`; else nested `payment.due` when present
 *    (canonical), else top-level `dueAmount`, else total − amount paid;
 *  - lines resolve to a catalogue item by itemId, else by trimmed,
 *    case-insensitive English or Hindi name.
 * Profit is covered in tests/oracle (decision #36); "week" waits on #43.
 */
import fs from 'fs';
import path from 'path';
import { FirebaseService } from '../firebase/firestore-service.js';
import { FinanceManager } from '../modules/finance.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { AppState } from '../utils/state.js';

const DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'scenarios');
const SCENARIOS = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

// ---------------- the oracle ----------------

function oracleTime(rec) {
    if (typeof rec.timestamp === 'number') return rec.timestamp;
    const s = String(rec.date || '');
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]).getTime();
    return new Date(s).getTime();
}

function oracleItemId(catalogue, line) {
    if (line.itemId && catalogue.some(i => i.id === line.itemId)) return line.itemId;
    const n = String(line.name ?? line.itemName ?? '').trim().toLowerCase();
    const hit = catalogue.find(i => i.name.trim().toLowerCase() === n || (i.hindiName || '').trim().toLowerCase() === n);
    return hit ? hit.id : n;
}

function oracleStock(s) {
    const events = [];
    s.purchases.forEach(b => b.items.forEach(l => events.push({ t: oracleTime(b), id: oracleItemId(s.items, l), op: 'add', q: Number(l.qty) })));
    [...s.wholesaleSales, ...s.retailSales].forEach(b => b.items.forEach(l => events.push({ t: oracleTime(b), id: oracleItemId(s.items, l), op: 'remove', q: Number(l.qty) })));
    s.stockAdjustments.forEach(a => events.push({ t: oracleTime(a), id: oracleItemId(s.items, a), op: a.adjustType === 'remove' ? 'adjust-remove' : a.adjustType, q: Number(a.quantity) }));
    events.sort((a, b) => a.t - b.t);
    const qty = {};
    for (const e of events) {
        const cur = qty[e.id] || 0;
        // Stock adjustments that remove are capped at the stock on hand (#72); bill lines are not.
        if (e.op === 'adjust-remove') { qty[e.id] = cur - Math.min(e.q, Math.max(0, cur)); continue; }
        qty[e.id] = e.op === 'add' ? cur + e.q : e.op === 'remove' ? cur - e.q : e.q;
    }
    return qty;
}

function oracleDue(bill) {
    if (bill.cleared) return 0;
    if (bill.payment && bill.payment.due !== undefined) return Number(bill.payment.due);
    if (bill.dueAmount !== undefined) return Number(bill.dueAmount);
    const total = Number(bill.grandTotal ?? bill.total ?? 0);
    const paid = Number(bill.amountPaid ?? 0) + Number(bill.onlinePayment ?? 0);
    return Math.max(0, total - paid);
}

function oracleByParty(bills, nameField) {
    const out = {};
    bills.forEach(b => {
        const due = oracleDue(b);
        if (due > 0) out[b[nameField]] = (out[b[nameField]] || 0) + due;
    });
    return out;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ---------------- app side ----------------

function loadIntoAppState(s) {
    AppState.items = s.items.map(i => ({ ...i }));
    AppState.purchaseHistory = JSON.parse(JSON.stringify(s.purchases));
    AppState.salesHistory = JSON.parse(JSON.stringify(s.wholesaleSales));
    AppState.retailSalesHistory = JSON.parse(JSON.stringify(s.retailSales));
    AppState.stockAdjustments = JSON.parse(JSON.stringify(s.stockAdjustments));
}

/** Per-party dues as the Outstanding screen shows them (rows: "<name> … Due: ₹N"). */
function outstandingScreenByParty(filter) {
    document.body.innerHTML = '<div id="dueList"></div>';
    AppState.currentDueFilter = filter;
    OutstandingManager.renderDue();
    const out = {};
    document.querySelectorAll('#dueList .history-item').forEach(row => {
        const name = row.querySelector('.history-header strong')?.textContent || '';
        const due = Number(row.querySelector('.history-header').textContent.match(/Due: ₹(\d+)/)[1]);
        out[name] = (out[name] || 0) + due;
    });
    return out;
}

afterAll(() => {
    ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'stockAdjustments', 'items'].forEach(k => { AppState[k] = []; });
});

describe.each(SCENARIOS.map(s => [s.name, s]))('oracle: %s', (_name, s) => {
    beforeEach(() => loadIntoAppState(s));

    test('oracle agrees with the hand-computed expectation in the fixture', () => {
        expect(oracleStock(s)).toEqual(s.expected.stock);
        expect(oracleByParty(s.purchases, 'customerName')).toEqual(s.expected.payable);
        expect({ ...oracleByParty(s.retailSales, 'customerName'), ...oracleByParty(s.wholesaleSales, 'customer') }).toEqual(s.expected.receivable);
    });

    test('stock per item: app calculateStock() == oracle', async () => {
        const app = await FirebaseService.calculateStock();
        const appQty = {};
        Object.entries(app).forEach(([k, v]) => { appQty[k] = Math.round(v.quantity * 1000) / 1000; });
        expect(appQty).toEqual(oracleStock(s));
    });

    test('outstanding per party: Outstanding screen == oracle (purchases payable, retail receivable)', () => {
        expect(outstandingScreenByParty('purchase')).toEqual(oracleByParty(s.purchases, 'customerName'));
        expect(outstandingScreenByParty('sale')).toEqual(oracleByParty(s.retailSales, 'customerName'));
    });

    test('outstanding totals: Finance == oracle (wholesale + retail receivable, purchases payable)', () => {
        const receivable = sum(oracleByParty(s.retailSales, 'customerName')) + sum(oracleByParty(s.wholesaleSales, 'customer'));
        expect(FinanceManager.calculateOutstanding()).toEqual({ dueToReceive: receivable, dueToPay: sum(oracleByParty(s.purchases, 'customerName')) });
    });
});

/**
 * Seeded multi-year dataset (deterministic): mixes every bill shape the app
 * has written — nested payment vs top-level only vs amountPaid-only, ISO vs
 * DD/MM dates, itemId vs English/Hindi/odd-cased names, cleared bills,
 * partial payments and all adjustment types.
 */
function generateHistory(seed, years) {
    let x = seed >>> 0;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const items = [
        { id: 'i-rice', name: 'Rice', hindiName: 'चावल' }, { id: 'i-wheat', name: 'Wheat', hindiName: 'गेहूं' },
        { id: 'i-maize', name: 'Maize', hindiName: 'मक्का' }, { id: 'i-gram', name: 'Gram', hindiName: 'चना' }
    ];
    const parties = ['Sita', 'Ravi', 'Kamla', 'Gupta', 'Mohan', 'Shyam'];
    const start = new Date(2023, 0, 1).getTime();
    const day = 86400000;
    const s = { name: 'seeded', items, purchases: [], wholesaleSales: [], retailSales: [], stockAdjustments: [] };
    const lineFor = (it, qty, rate) => {
        const r = rnd();
        const ref = r < 0.6 ? { itemId: it.id, name: it.name } : r < 0.75 ? { name: it.name.toUpperCase() + ' ' }
            : r < 0.9 ? { name: it.hindiName } : { itemId: 'deleted-' + it.id, name: it.name.toLowerCase() };
        return { ...ref, qty, rate, total: Math.round(qty * rate) };
    };
    const dateFor = (t) => {
        const d = new Date(t);
        return rnd() < 0.3
            ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
            : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(8 + Math.floor(rnd() * 10)).padStart(2, '0')}:00:00`;
    };
    const money = (total, bill) => {
        const due = rnd() < 0.4 ? Math.round(total * rnd()) : 0;
        const paid = total - due;
        const shape = rnd();
        if (shape < 0.7) Object.assign(bill, { cashPayment: paid, onlinePayment: 0, dueAmount: due, payment: { cash: paid, online: 0, due, total } });
        else if (shape < 0.85) Object.assign(bill, { cashPayment: paid, dueAmount: due });
        else Object.assign(bill, { amountPaid: paid });
        if (due > 0 && rnd() < 0.15) bill.cleared = true;
        return bill;
    };
    let n = 0;
    for (let t = start; t < start + years * 365 * day; t += day) {
        const bills = 1 + Math.floor(rnd() * 3);
        for (let b = 0; b < bills; b++) {
            const kind = rnd();
            const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => lineFor(pick(items), Math.round(rnd() * 800) / 10 + 1, 20 + Math.round(rnd() * 400) / 10));
            const total = lines.reduce((a, l) => a + l.total, 0);
            const bill = { id: `b${++n}`, date: dateFor(t), items: lines };
            if (kind < 0.45) s.purchases.push(money(total, { ...bill, customerName: pick(parties), grandTotal: total }));
            else if (kind < 0.85) s.retailSales.push(money(total, { ...bill, customerName: pick(parties), total }));
            else {
                const due = rnd() < 0.5 ? Math.round(total * rnd()) : 0;
                s.wholesaleSales.push({ ...bill, customer: pick(parties), total, payment: { cash: total - due, online: 0, due, total: total - due } });
            }
        }
        if (rnd() < 0.05) {
            const it = pick(items);
            s.stockAdjustments.push({ id: `a${++n}`, itemId: it.id, itemName: it.name, adjustType: pick(['add', 'remove', 'set']),
                quantity: Math.round(rnd() * 500) / 10 + 1, rate: 0, timestamp: t + 20 * 3600000, date: dateFor(t) });
        }
    }
    return s;
}

describe('oracle: seeded 3-year history', () => {
    const s = generateHistory(45, 3);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const r2 = (v) => Math.round(v * 100) / 100;
    beforeAll(() => loadIntoAppState(s));

    test('dataset is large and mixed', () => {
        expect(s.purchases.length + s.retailSales.length + s.wholesaleSales.length).toBeGreaterThan(1500);
        expect(s.purchases.some(b => b.amountPaid !== undefined && !b.payment)).toBe(true);
        expect(s.retailSales.some(b => /^\d\d\/\d\d\/\d{4}$/.test(b.date))).toBe(true);
    });

    test('stock per item == oracle', async () => {
        const app = await FirebaseService.calculateStock();
        const appQty = {};
        Object.entries(app).forEach(([k, v]) => { appQty[k] = r3(v.quantity); });
        const want = {};
        Object.entries(oracleStock(s)).forEach(([k, v]) => { want[k] = r3(v); });
        expect(appQty).toEqual(want);
    });

    test('per-party payable / retail receivable on the Outstanding screen == oracle', () => {
        // Generated amounts are whole rupees, so the screen's per-bill rounding is exact.
        expect(outstandingScreenByParty('purchase')).toEqual(oracleByParty(s.purchases, 'customerName'));
        expect(outstandingScreenByParty('sale')).toEqual(oracleByParty(s.retailSales, 'customerName'));
    });

    test('Finance outstanding totals == oracle', () => {
        const receivable = sum(oracleByParty(s.retailSales, 'customerName')) + sum(oracleByParty(s.wholesaleSales, 'customer'));
        const { dueToReceive, dueToPay } = FinanceManager.calculateOutstanding();
        expect(r2(dueToReceive)).toBe(r2(receivable));
        expect(r2(dueToPay)).toBe(r2(sum(oracleByParty(s.purchases, 'customerName'))));
    });
});
