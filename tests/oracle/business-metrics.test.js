/**
 * @fileoverview Oracle tests for the calculation layer (utils/business-metrics.js):
 * spec IDs M*, I*, BILL-COUNT, CMP and PERIOD in docs/calculations.md.
 *
 * 1. Hand-worked numbers from the worked example (shop-month.json).
 * 2. The app's layer == the independent oracle for all time, October, September
 *    and single days, including per-item and per-party rows.
 */
import fs from 'fs';
import path from 'path';
import * as O from './oracle.js';
import {
    moneySummary, itemSummary, partySummary, purchaseItems, billCount, outstandingTotals,
    periodRange, comparisonRanges, change, netWorth, seasonIndex, lowProfitItems, belowCostSales,
    biggestChange, overdueParties, stoppedComing, expenseCategories, profitPerDay, stockUpItems, recordTime
} from '../../www/js/utils/business-metrics.js';
import { INSIGHTS_DEFAULTS, insightsSettings } from '../../www/js/utils/insights-config.js';

const FIX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/calculations/shop-month.json'), 'utf8'));
const NOW = O.timeOf(FIX.now);
const data = {
    items: FIX.items, purchases: FIX.purchases, wholesaleSales: FIX.wholesaleSales, retailSales: FIX.retailSales,
    stockAdjustments: FIX.stockAdjustments, expenses: FIX.expenses, withdrawals: FIX.withdrawals
};
const input = { ...data, base: { state: {}, from: -Infinity } };
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const ALL = { from: -Infinity, to: Infinity };
const OCT = { from: new Date(2026, 9, 1).getTime(), to: NOW + 1 };
const SEP = { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime() };
const DAY = { from: new Date(2026, 9, 21).getTime(), to: new Date(2026, 9, 22).getTime() };

describe('hand-worked example (docs/calculations.md, Worked example)', () => {
    test('M1–M10, M14, M17 all time', () => {
        const m = moneySummary(input, ALL);
        expect(m.M1.total).toBe(3290);
        expect(m.M1.count).toBe(5);
        expect(m.M2).toBeCloseTo(2710.96, 2);
        expect(m.M3.total).toBeCloseTo(579.04, 2);
        expect(m.M4.total).toBe(670);
        expect(m.M6.total).toBeCloseTo(-90.96, 2);
        expect(m.M8.total).toBe(1080);
        expect(m.M9).toBe(2000);
        expect(m.M10).toBeCloseTo(-3170.96, 2);
        expect(m.M14).toBe(-4902);
        expect(m.M12.total).toBe(1810);
        expect(m.M13.total).toBe(6712);
        expect(m.M17.closing).toBeCloseTo(2817.04, 2);
    });

    test('October to date: M1 = 3,210 over 4 bills, M16 = 2,574 over 2, labour M7 = 6, profit M6 = −110.96', () => {
        const m = moneySummary(input, OCT);
        expect(m.M1.total).toBe(3210);
        expect(m.M1.count).toBe(4);
        expect(m.M16.total).toBe(2574);
        expect(m.M16.count).toBe(2);
        expect(m.M7).toBe(6);
        expect(m.M16.lineValue).toBe(2580);
        expect(m.M6.total).toBeCloseTo(-110.96, 2);
    });

    test('O3 / O4 with counts (#220: cleared bills left out, dueAmount-only bills in)', () => {
        const d = outstandingTotals(data);
        expect(d).toEqual({ payable: { total: 5600, count: 2 }, receivable: { total: 253500, count: 6 } });
    });
});

describe('layer == oracle', () => {
    const ranges = { all: ALL, oct: OCT, sep: SEP, day21: DAY };
    test.each(Object.entries(ranges))('M1–M16 for %s', (_, r) => {
        const m = moneySummary(input, r);
        const w = O.metrics(data, [r.from, r.to]);
        expect(m.M1.total).toBeCloseTo(w.M1_sales, 2);
        expect(m.M1.count).toBe(w.M1_saleCount);
        expect(m.M1.retail.total).toBeCloseTo(w.M1_retail, 2);
        expect(m.M1.retail.count).toBe(w.M1_retailCount);
        expect(m.M1.wholesale.total).toBeCloseTo(w.M1_wholesale, 2);
        expect(m.M2).toBeCloseTo(w.M2_cogs, 2);
        expect(m.M3.total).toBeCloseTo(w.M3_gross, 2);
        expect(m.M4.total).toBeCloseTo(w.M4_businessExpenses, 2);
        expect(m.M5).toBeCloseTo(w.M5_badDebts, 2);
        expect(m.M6.total).toBeCloseTo(w.M6_profit, 2);
        expect(m.M7).toBeCloseTo(w.M7_labour, 2);
        expect(m.M8.total).toBeCloseTo(w.M8_personalExpenses, 2);
        expect(m.M9).toBeCloseTo(w.M9_withdrawals, 2);
        expect(m.M10).toBeCloseTo(w.M10_kept, 2);
        expect(m.M12.cash).toBeCloseTo(w.M12_inCash, 2);
        expect(m.M12.online).toBeCloseTo(w.M12_inOnline, 2);
        expect(m.M13.cash).toBeCloseTo(w.M13_outCash, 2);
        expect(m.M13.online).toBeCloseTo(w.M13_outOnline, 2);
        expect(m.M14).toBeCloseTo(w.M14_net, 2);
        expect(m.M16.total).toBeCloseTo(w.M16_purchases, 2);
        expect(m.M16.count).toBe(w.M16_purchaseCount);
    });

    test.each(Object.entries(ranges))('BILL-COUNT for %s (AC14)', (_, r) => {
        const c = billCount(data, r.from, r.to);
        const w = O.metrics(data, [r.from, r.to]);
        expect(c.sales).toBe(w.M1_saleCount);
        expect(c.purchases).toBe(w.M16_purchaseCount);
    });

    test.each(Object.entries(ranges))('I1/I2 per item sales and cost of goods sold for %s; AC10 rows add up', (_, r) => {
        const m = moneySummary(input, r, { detail: true });
        const rows = itemSummary(m);
        const w = O.metrics(data, [r.from, r.to]);
        rows.forEach(x => {
            expect(x.sales).toBeCloseTo(w.I1_itemSales[x.itemKey] || 0, 2);
            expect(x.cogs).toBeCloseTo(w.I1_itemCogs[x.itemKey] || 0, 2);
        });
        expect(rows.reduce((a, x) => a + x.sales, 0)).toBeCloseTo(m.M1.total, 2);
        expect(rows.reduce((a, x) => a + x.cogs, 0)).toBeCloseTo(m.M2, 2);
        const both = rows.reduce((a, x) => a + x.retail + x.wholesale, 0);
        expect(both).toBeCloseTo(m.M1.total, 2);
    });

    test.each(Object.entries(ranges))('I3 / I4 per party for %s; AC11 rows add up', (_, r) => {
        const w = O.metrics(data, [r.from, r.to]);
        const cust = partySummary(data, 'sales', r);
        const sup = partySummary(data, 'purchases', r);
        cust.forEach(p => expect(p.total).toBeCloseTo(w.I3_customers[p.key], 2));
        sup.forEach(p => expect(p.total).toBeCloseTo(w.I4_suppliers[p.key], 2));
        expect(cust.reduce((a, p) => a + p.total, 0)).toBeCloseTo(w.M1_sales, 2);
        expect(sup.reduce((a, p) => a + p.total, 0)).toBeCloseTo(w.M16_purchases, 2);
    });

    test('I11 purchase item rows share labour and add up to M16 (#47)', () => {
        const rows = purchaseItems(data.purchases, data.items, OCT);
        const m = moneySummary(input, OCT);
        expect(rows.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(m.M16.total, 2);
        expect(rows.reduce((a, x) => a + x.labour, 0)).toBeCloseTo(m.M7, 2);
        expect(rows.reduce((a, x) => a + x.lineValue, 0)).toBeCloseTo(m.M16.lineValue, 2);
    });

    test('O3 / O4 == oracle', () => {
        const d = outstandingTotals(data);
        const w = O.dueTotals(data);
        expect(d.payable.total).toBeCloseTo(w.payable, 2);
        expect(d.payable.count).toBe(w.payableCount);
        expect(d.receivable.total).toBeCloseTo(w.receivable, 2);
        expect(d.receivable.count).toBe(w.receivableCount);
    });

    test('profit per day adds up to M6 (M11 by day)', () => {
        const m = moneySummary(input, OCT, { detail: true });
        const days = profitPerDay(m);
        expect(Object.values(days).reduce((a, b) => a + b, 0)).toBeCloseTo(m.M6.total, 2);
    });

    test('expense categories add up to M4; D/M/YYYY expense dates are read (#49)', () => {
        const m = moneySummary(input, OCT);
        const cats = expenseCategories(data.expenses, OCT.from, OCT.to);
        expect(cats.reduce((a, c) => a + c.total, 0)).toBeCloseTo(m.M4.total, 2);
        expect(recordTime('20/10/2026, 6:15:00 pm')).toBe(new Date(2026, 9, 20, 18, 15).getTime());
    });
});

describe('PERIOD and CMP', () => {
    const now = new Date(2026, 9, 26, 15, 0);
    test('this month is the calendar month to the end of today (#43 default)', () => {
        const r = periodRange('this-month', now);
        expect(new Date(r.from)).toEqual(new Date(2026, 9, 1));
        expect(new Date(r.to)).toEqual(new Date(2026, 9, 27));
        expect(r.month).toBe('2026-10');
    });
    test('the owner can switch "this month" to the last 30 days', () => {
        const r = periodRange('this-month', now, insightsSettings({ monthMode: 'last30' }));
        expect(new Date(r.from)).toEqual(new Date(2026, 8, 27));
    });
    test('this year = 1 Jan (default); April with yearStartMonth 3', () => {
        expect(new Date(periodRange('this-year', now).from)).toEqual(new Date(2026, 0, 1));
        expect(new Date(periodRange('this-year', now, insightsSettings({ yearStartMonth: 3 })).from)).toEqual(new Date(2026, 3, 1));
        expect(new Date(periodRange('last-year', now).to)).toEqual(new Date(2026, 0, 1));
    });
    test('month:YYYY-MM and last month', () => {
        const r = periodRange('month:2026-02', now);
        expect([new Date(r.from), new Date(r.to)]).toEqual([new Date(2026, 1, 1), new Date(2026, 2, 1)]);
        expect(periodRange('last-month', now).month).toBe('2026-09');
    });
    test('a partial month compares with the same days of last month and last year', () => {
        const c = comparisonRanges(periodRange('this-month', now));
        expect([new Date(c.previous.from), new Date(c.previous.to)]).toEqual([new Date(2026, 8, 1), new Date(2026, 8, 27)]);
        expect([new Date(c.lastYear.from), new Date(c.lastYear.to)]).toEqual([new Date(2025, 9, 1), new Date(2025, 9, 27)]);
    });
    test('a whole month compares with the whole previous month', () => {
        const c = comparisonRanges(periodRange('month:2026-03', now));
        expect([new Date(c.previous.from), new Date(c.previous.to)]).toEqual([new Date(2026, 1, 1), new Date(2026, 2, 1)]);
    });
    test('change(): %, direction, "about the same" under 2%, null when nothing to compare', () => {
        expect(change(112, 100)).toEqual({ pct: 12, diff: 12, dir: 'up' });
        expect(change(99, 100).dir).toBe('same');
        expect(change(50, -100).dir).toBe('up');
        expect(change(10, 0)).toBeNull();
        expect(change(null, 5)).toBeNull();
    });
});

describe('insights rules', () => {
    test('M15 net worth = stock + receivable + accounts + drawer − payable (#39 default); null without stock value', () => {
        expect(netWorth({ stock: 1000, receivable: 500, payable: 300, accounts: 200, drawer: 100 })).toBe(1500);
        expect(netWorth({ stock: null, receivable: 500, payable: 300, accounts: 0, drawer: 0 })).toBeNull();
        expect(netWorth({ stock: 1000, receivable: 500, payable: 300, accounts: 200, drawer: 100 },
            insightsSettings({ netWorthTerms: ['stock', 'receivable'] }))).toBe(1200);
    });

    test('I7 low-profit items: under ₹3 per ₹100 with at least ₹5,000 sales (owner default)', () => {
        const rows = [
            { itemKey: 'a', sales: 10000, per100: 2 },
            { itemKey: 'b', sales: 10000, per100: 5 },
            { itemKey: 'c', sales: 1000, per100: -10 },
            { itemKey: 'd', sales: 9000, per100: -1 },
            { itemKey: '', sales: 9000, per100: -1 }
        ];
        expect(lowProfitItems(rows).map(r => r.itemKey)).toEqual(['d', 'a']);
        expect(INSIGHTS_DEFAULTS.lowMarginPer100).toBe(3);
    });

    test('I8 below-cost sales come from the same bill line costs', () => {
        const items = [{ id: 'i1', name: 'Rice' }];
        const shop = {
            items,
            purchases: [{ id: 'p', date: '2026-10-01', timestamp: new Date(2026, 9, 1).getTime(), grandTotal: 300, items: [{ itemId: 'i1', name: 'Rice', qty: 10, rate: 30, total: 300 }] }],
            retailSales: [{ id: 'r', date: '2026-10-02', timestamp: new Date(2026, 9, 2).getTime(), total: 50, items: [{ itemId: 'i1', name: 'Rice', qty: 2, rate: 25, total: 50 }] }],
            wholesaleSales: [], stockAdjustments: [], expenses: [], withdrawals: [], base: { state: {}, from: -Infinity }
        };
        const m = moneySummary(shop, ALL, { detail: true });
        expect(belowCostSales(m)).toEqual([{ itemKey: 'i1', item: 'Rice', itemHi: 'Rice', times: 1, qty: 2, lost: 10 }]);
    });

    test('I10 overdue parties: open dues older than 30 days, one count per party', () => {
        const now = new Date(2026, 9, 26);
        const bills = [
            { customerName: 'A', date: '2026-09-01', payment: { due: 100 } },
            { customerName: ' a ', date: '2026-09-10', payment: { due: 50 } },
            { customerName: 'B', date: '2026-10-20', payment: { due: 70 } },
            { customerName: 'C', date: '2026-08-01', payment: { due: 70 }, cleared: true }
        ];
        expect(overdueParties(bills, now)).toEqual({ parties: 1, total: 150, oldestDays: 55 });
    });

    test('stopped coming: regular in the same 3 months last year, no bill for 60 days', () => {
        const now = new Date(2026, 9, 26);
        const sale = (name, y, m) => ({ customerName: name, date: `${y}-${String(m).padStart(2, '0')}-10`, total: 10 });
        const src = {
            retailSales: [sale('Ram', 2025, 9), sale('Ram', 2025, 10), sale('Ram', 2025, 11), sale('Ram', 2026, 7),
                sale('Shyam', 2025, 9), sale('Shyam', 2025, 10), sale('Shyam', 2025, 11), sale('Shyam', 2026, 10)],
            wholesaleSales: []
        };
        expect(stoppedComing(src, now).map(r => r.name)).toEqual(['Ram']);
    });

    test('I5 season index needs 12 months and averages each calendar month', () => {
        const kg = {};
        for (let m = 1; m <= 12; m++) kg[`2025-${String(m).padStart(2, '0')}`] = m === 12 ? 300 : 100;
        const idx = seasonIndex(kg);
        expect(idx[11]).toBeCloseTo(300 / (1400 / 12), 2);
        expect(seasonIndex({ '2025-01': 5 })).toBeNull();
    });

    test('I9 stock up: busy month ahead and stock covers fewer weeks than it takes to get there + 4', () => {
        const index = Array(12).fill(1);
        index[11] = 2;
        const now = new Date(2026, 9, 26);
        const rows = [
            { itemKey: 'a', index, qty: 50, weeklyKg: 100 },
            { itemKey: 'b', index, qty: 10000, weeklyKg: 100 }
        ];
        expect(stockUpItems(rows, now).map(r => r.itemKey)).toEqual(['a']);
    });

    test('biggest change picks the largest absolute difference (I6)', () => {
        const now = [{ key: 'x', v: 10 }, { key: 'y', v: 50 }];
        const then = [{ key: 'x', v: 40 }, { key: 'z', v: 5 }];
        expect(biggestChange(now, then, r => r.v)).toMatchObject({ key: 'y', diff: 50 });
    });
});
