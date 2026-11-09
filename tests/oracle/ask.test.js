/**
 * @fileoverview Oracle for Ask (#88, docs/calculations.md ASK-1..ASK-6): the
 * answers to typed questions equal the independent oracle's Today (T1, T2,
 * T4), Outstanding (O1–O4), Stock (S1), purchases per item, sales per item (I1, I2) and per
 * party (I3, I4), and Money (M1, M16) numbers on the worked example.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import { answerQuestion, parseQuestion } from '../../www/js/utils/ask.js';

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
        const sales = ask('ab tak ki bikri mahine wise').report.groups;
        const buys = ask('ab tak ki kharid mahine wise').report.groups;
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
