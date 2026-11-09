/**
 * @fileoverview Oracle for Ask (#88, docs/calculations.md ASK-1..ASK-7): the
 * answers to typed questions equal the independent oracle's Today (T1, T2,
 * T4), Outstanding (O1–O4), Stock (S1), purchases per item, sales per item (I1, I2) and per
 * party (I3, I4), and Money (M1, M16) numbers on the worked example.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { answerQuestion, parseQuestion } from '../../www/js/utils/ask.js';
import { quickItemSummary, quickPeriodOk, reportPeriod } from '../../www/js/utils/ask-report.js';
import { billsToYearDocs } from '../../www/js/utils/rate-trends.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses
};
const want = O.stockReplay(data);
const src = {
    bills: { purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales },
    expenses: FIX.expenses,
    items: FIX.items,
    stock: Object.fromEntries(Object.entries(want.perItem).map(([k, v]) => [k, { quantity: v.qty, rate: v.rate }]))
};
const ask = (text, opts = {}) => answerQuestion(parseQuestion(text), src, { role: 'owner', wholesale: true, today: new Date(NOW), ...opts });

describe('ASK-1: today = Today T1, T2, T4', () => {
    const today = O.today(data, NOW);
    test.each([
        ['aaj ki bikri', 'T2_sales', 'T2_saleCount'],
        ["today's purchases", 'T1_purchases', 'T1_purchaseCount'],
        ['आज का खर्च', 'T4_businessExpenses', null]
    ])('%s', (q, amount, count) => {
        const a = ask(q);
        expect(O.r2(a.amount)).toBe(today[amount]);
        if (count) expect(a.count).toBe(today[count]);
    });
});

describe('ASK-2 / ASK-3: dues = Outstanding O1–O4', () => {
    const out = O.outstanding(data);
    test('every party to receive and to pay, by its name', () => {
        Object.entries(out.O2_receivableByParty).forEach(([name, due]) => expect(ask(`${name} ka baaki`).receive.total).toBe(due));
        Object.entries(out.O1_payableByParty).forEach(([name, due]) => expect(ask(`${name} due`).pay.total).toBe(due));
    });
    test('totals', () => {
        const a = ask('kul baaki');
        expect([a.receive, a.pay]).toEqual([out.O4_receivableTotal, out.O3_payableTotal]);
    });
    test('a role without Wholesale: retail only (O2 Retail list)', () => {
        expect(ask('total due', { wholesale: false }).receive).toBe(out.O4_retailTotal);
    });
});

describe('ASK-4: one item = Stock S1', () => {
    test.each([['Rice stock', 'i-rice'], ['chawal ka stock', 'i-rice'], ['गेहूं का स्टॉक', 'i-wheat'], ['stock of wheat', 'i-wheat']])('%s', (q, id) => {
        const qty = Math.max(0, want.perItem[id]?.qty || 0);
        expect(ask(q).quantity).toBeCloseTo(qty, 6);
    });
});

describe('ASK-5: one item\'s purchases = Insights › Items purchases (oracle), adding up to M16 / R1', () => {
    const clean = O.withoutVoided(data);
    const all = [-Infinity, Infinity];
    const want = O.purchaseItems(clean, all);
    test.each([['chawal kitna kharida ab tak', 'i-rice'], ['गेहूं कितना खरीदा अब तक', 'i-wheat']])('%s', (q, id) => {
        const a = ask(q);
        const g = a.report.groups.find(x => x.key === id);
        expect([g.totals.kg, g.totals.amount]).toEqual([want[id].qty, want[id].lineValue]);
        // labour in whole paise per line (labourShares): within a paisa per bill of the unrounded share
        expect(Math.abs(g.totals.labour - want[id].labour)).toBeLessThan(0.01 * g.totals.bills + 1e-9);
        expect(Math.abs(g.totals.net - want[id].amount)).toBeLessThan(0.01 * g.totals.bills + 1e-9);
        expect(g.totals.avgRate).toBe(O.r2(want[id].lineValue / want[id].qty));
    });
    test('every kind after labour, with the bills\' adjustments, = the purchases total (M16 / R1)', () => {
        const nets = ['chawal kitna kharida ab tak', 'gehu kitna kharida ab tak'].map(q => ask(q).report.totals.net);
        expect(O.r2(nets[0] + nets[1] + (want['']?.amount || 0))).toBe(O.reports(clean, all).R1_purchases);
    });
    test('a manager with Statements gets the same kg, and no money', () => {
        const g = ask('chawal kitna kharida ab tak', { role: 'manager', reports: true }).report.groups.find(x => x.key === 'i-rice');
        expect(g.totals).toEqual({ kg: want['i-rice'].qty, bills: expect.any(Number) });
    });
});

describe('ASK-6: sales by item = Insights › Items (I1, I2); every item by party = Parties (I3, I4), by month = Money (M1, M16) (oracle)', () => {
    const clean = O.withoutVoided(data);
    const all = [-Infinity, Infinity];
    const m = O.metrics(clean, all);
    test.each([
        ['chawal kitna becha ab tak', 'I1_itemSales'],
        ['khudra chawal kitna becha ab tak', 'I2_itemRetail'],
        ['thok me chawal kitna becha ab tak', 'I2_itemWholesale'],
        ['गेहूं कितना बेचा अब तक', 'I1_itemSales']
    ])('%s', (q, key) => {
        const a = ask(q);
        expect(a.spec).toBe('ASK-6');
        expect(a.report.groups.filter(g => g.totals.amount > 0).length).toBeGreaterThan(0);
        a.report.groups.forEach(g => expect(g.totals.amount).toBe(m[key][g.key] ?? 0));
    });
    test('sales by party: each party\'s bills total = I3; all parties = M1, with its bill count', () => {
        const a = ask('ab tak ki bikri party wise');
        expect(Object.fromEntries(a.report.groups.map(g => [g.key, g.totals.billsTotal]))).toEqual(m.I3_customers);
        expect([a.report.totals.billsTotal, a.report.totals.bills]).toEqual([m.M1_sales, m.M1_saleCount]);
    });
    test('purchases by party = I4; all parties = M16', () => {
        const a = ask('ab tak ki kharid party wise');
        expect(Object.fromEntries(a.report.groups.map(g => [g.key, g.totals.billsTotal]))).toEqual(m.I4_suppliers);
        expect([a.report.totals.billsTotal, a.report.totals.bills]).toEqual([m.M16_purchases, m.M16_purchaseCount]);
    });
    test('by month: each month\'s sales and purchases = M1 / M16 of that month', () => {
        const s = ask('ab tak ki bikri mahine wise');
        expect(s.period.preset).toBe('all');
        const sales = s.report.groups;
        const buys = ask('ab tak ki kharid mahine wise').report.groups;
        expect(O.r2(sales.reduce((a, g) => a + g.totals.billsTotal, 0))).toBe(m.M1_sales);
        expect(sales.length).toBeGreaterThan(1);
        sales.forEach(g => expect(g.totals.billsTotal).toBe(O.metrics(clean, O.monthRange(g.month)).M1_sales));
        buys.forEach(g => expect(g.totals.billsTotal).toBe(O.metrics(clean, O.monthRange(g.month)).M16_purchases));
    });
    test('one party, every item: its bills total = I3 of that party', () => {
        const [key, total] = Object.entries(m.I3_customers).find(([k]) => k === 'sita');
        const a = ask('Sita ko kya kya becha ab tak');
        expect(a.party).toBe('Sita');
        expect(a.report.totals.billsTotal).toBe(total);
        expect(key).toBe('sita');
    });
});

describe('ASK-7: the quick figure = Insights › Seasons month stats (RT4, PT1; oracle) summed over the period', () => {
    const clean = O.withoutVoided(data);
    const keep = (bills) => bills.filter(b => !O.isOpening(b));
    const lines = { purchase: keep(clean.purchases), retail: keep(clean.retailSales), wholesale: keep(clean.wholesaleSales) };
    const want = O.rateBuckets(lines, FIX.items, O.monthOf);
    // the stored stats as the history from bills built them; the phone keeps every bill (voided ones too)
    const stored = Object.entries(billsToYearDocs(lines, FIX.items)).map(([id, d]) => ({ id, ...d }));
    const phone = { purchase: FIX.purchases, retail: FIX.retailSales, wholesale: FIX.wholesaleSales };
    const kinds = FIX.items.map(i => ({ key: i.id, name: i.name, hindiName: i.hindiName || '' }));
    const ALL = { from: -Infinity, to: Infinity };
    const quick = (types, windowFrom, period = ALL, stats = stored, now = new Date()) => quickItemSummary({
        kinds, items: FIX.items, stats, sources: types.map(type => ({ type, bills: phone[type] })), period, windowFrom, now
    });
    const expected = (id, types, months = null) => {
        const s = { kg: 0, amount: 0, bills: 0 };
        Object.entries(want[id] || {}).filter(([m]) => !months || months.includes(m)).forEach(([, byKind]) => types.forEach(k => {
            s.kg += byKind[k]?.kg || 0;
            s.amount += byKind[k]?.amount || 0;
            s.bills += byKind[k]?.bills || 0;
        }));
        return { kg: O.r2(s.kg), amount: O.r2(s.amount), avgRate: s.kg > 0 ? O.r2(s.amount / s.kg) : null, bills: s.bills };
    };
    const byKey = (q) => Object.fromEntries(q.groups.map(g => [g.key, g.totals]));
    const OCT_1 = new Date(2026, 9, 1).getTime();

    test('all-time purchases: older months from the stats, the loaded month from the bills on the phone', () => {
        const q = quick(['purchase'], OCT_1);
        expect(Object.keys(want).length).toBeGreaterThan(0);
        q.groups.forEach(g => expect(g.totals).toEqual(expected(g.key, ['purchase'])));
        expect(q.groups.length).toBe(Object.keys(want).filter(id => expected(id, ['purchase']).kg > 0).length);
        // a stored month the phone has every bill of is never used (it may be stale)
        const stale = stored.map(d => ({ ...d, months: { ...d.months, 'm2026-10': { purchase: { kg: 9999, amount: 9999, bills: 99 } } } }));
        expect(quick(['purchase'], OCT_1, ALL, stale)).toEqual(q);
    });

    test('all sales, the window starting mid-month: that whole month from the stats too', () => {
        const q = quick(['retail', 'wholesale'], new Date(2026, 9, 12).getTime());
        expect(q.groups.length).toBeGreaterThan(0);
        q.groups.forEach(g => expect(g.totals).toEqual(expected(g.key, ['retail', 'wholesale'])));
        expect(q.totals.kg).toBe(O.r2(q.groups.reduce((a, g) => a + g.totals.kg, 0)));
    });

    test('one period: only its months', () => {
        const q = quick(['retail'], OCT_1, { from: new Date(2026, 0, 1).getTime(), to: new Date(2026, 1, 1).getTime() });
        expect(byKey(q)).toEqual(Object.fromEntries(Object.keys(want).map(id => [id, expected(id, ['retail'], ['2026-01'])]).filter(([, x]) => x.kg > 0)));
    });

    test('a period that does not fit whole months (this month as the last 30 days) gets none; one ending today does', () => {
        const now = new Date(NOW);
        const last30 = reportPeriod('this-month', now, { monthMode: 'last30' });
        expect(new Date(last30.from).getDate()).not.toBe(1);
        expect(quickPeriodOk(last30, now)).toBe(false);
        expect(quick(['purchase'], OCT_1, last30, stored, now)).toBeNull();
        const since = reportPeriod('since-last-month', now);
        expect(quickPeriodOk(since, now)).toBe(true);
        const q = quick(['purchase'], OCT_1, since, stored, now);
        expect(q.groups.length).toBeGreaterThan(0);
        q.groups.forEach(g => expect(g.totals).toEqual(expected(g.key, ['purchase'], ['2026-09', '2026-10'])));
        expect(quickPeriodOk({ from: since.from, to: since.to - 3600000 }, now)).toBe(false);
    });
    test('a kind not in the item list has no stats: it is listed as left out', () => {
        const q = quickItemSummary({ kinds: [...kinds, { key: 'unmatched lah', name: 'Unmatched Lah', hindiName: '' }], items: FIX.items, stats: stored,
            sources: [{ type: 'purchase', bills: phone.purchase }], period: ALL, windowFrom: OCT_1 });
        expect(q.left.map(k => k.name)).toEqual(['Unmatched Lah']);
        expect(q.groups.map(g => g.key)).not.toContain('unmatched lah');
    });
});
