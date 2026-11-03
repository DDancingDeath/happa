/**
 * @fileoverview The Money / Insights calculation layer (utils/business-metrics.js),
 * function by function: spec IDs PERIOD, PERIOD-CUSTOM, CMP, BILL-TIME, M1–M19,
 * I1–I12 and M15's accounts (#74) in docs/calculations.md, worked by hand
 * (#160: these cases kill the mutants the oracle suites let through).
 */
import {
    accountEntry, accountId, accountsFromPhone, accountsList, accountsTotal, addsUp, belowCostSales, biggestChange,
    billCount, billTime, change, comparisonRanges, customRangePreset, expenseCategories, itemSummary, lowProfitItems,
    MAX_WORTH_ACCOUNTS, moneySummary, netMoneyByDay, netWorth, outstandingTotals, overdueParties, partySummary,
    periodRange, profitPerDay, purchaseItems, recordTime, seasonIndex, seasonKgTotal, sharePct, soldKgByMonth,
    stockUpItems, stoppedComingCheck, topShare, weeklyKgByItem, weeklyKgWindow
} from '../utils/business-metrics.js';
import { INSIGHTS_DEFAULTS } from '../utils/insights-config.js';

const DAY = 86400000;
const at = (day, hour = 10, month = 9, year = 2026) => new Date(year, month, day, hour).getTime();
const d = (y, m, day = 1, h = 0, min = 0) => new Date(y, m, day, h, min).getTime();
const NOW = new Date(2026, 9, 15, 14, 30);
const ALL = { from: -Infinity, to: Infinity };
const FULL = { state: {}, from: -Infinity };
const ITEMS = [{ id: 'rice', name: 'Rice', hindiName: 'चावल' }, { id: 'dal', name: 'Dal' }];
const line = (itemId, name, qty, rate, total = qty * rate) => ({ itemId, name, qty, rate, total });
const iso = (t) => new Date(t).toISOString();

describe('BILL-TIME', () => {
    test('a bill counts at its timestamp, else its date; undated is null', () => {
        expect(billTime({ timestamp: at(3) })).toBe(at(3));
        expect(billTime({ date: '03/10/2026' })).toBe(d(2026, 9, 3));
        expect(billTime({})).toBeNull();
        expect(billTime({ date: 'not a date' })).toBeNull();
        expect(recordTime('2026-10-03')).toBe(d(2026, 9, 3));
        expect(recordTime('')).toBeNull();
    });

    test('BILL-COUNT counts activity bills of the period by type', () => {
        const src = {
            purchases: [{ timestamp: at(2) }],
            retailSales: [{ timestamp: at(2) }, { timestamp: at(3), voided: true }, { timestamp: at(3), openingBalance: { amount: 5 } }],
            wholesaleSales: [{ timestamp: at(4) }, { timestamp: at(9) }]
        };
        expect(billCount(src, at(1), at(5))).toEqual({ purchases: 1, retail: 1, wholesale: 1, sales: 2 });
        expect(billCount({}, -Infinity, Infinity)).toEqual({ purchases: 0, retail: 0, wholesale: 0, sales: 0 });
    });
});

describe('PERIOD: periodRange', () => {
    const endOfToday = d(2026, 9, 16);

    test('calendar periods run up to the end of today', () => {
        expect(periodRange('this-month', NOW)).toEqual({ preset: 'this-month', from: d(2026, 9, 1), to: endOfToday, month: '2026-10' });
        expect(periodRange('last-month', NOW)).toEqual({ preset: 'last-month', from: d(2026, 8, 1), to: d(2026, 9, 1), month: '2026-09' });
        expect(periodRange('last-month', new Date(2027, 0, 5))).toMatchObject({ from: d(2026, 11, 1), to: d(2027, 0, 1), month: '2026-12' });
        expect(periodRange('this-year', NOW)).toEqual({ preset: 'this-year', from: d(2026, 0, 1), to: endOfToday });
        expect(periodRange('last-year', NOW)).toEqual({ preset: 'last-year', from: d(2025, 0, 1), to: d(2026, 0, 1) });
        expect(periodRange('last-30', NOW)).toEqual({ preset: 'last-30', from: d(2026, 8, 16), to: endOfToday });
        expect(periodRange('all', NOW)).toEqual({ preset: 'all', from: -Infinity, to: Infinity });
    });

    test('"This month" as the last 30 days, and an April year (settings)', () => {
        expect(periodRange('this-month', NOW, { ...INSIGHTS_DEFAULTS, monthMode: 'last30' }))
            .toEqual({ preset: 'this-month', from: d(2026, 8, 16), to: endOfToday });
        const april = { ...INSIGHTS_DEFAULTS, yearStartMonth: 3 };
        expect(periodRange('this-year', NOW, april)).toMatchObject({ from: d(2026, 3, 1), to: endOfToday });
        expect(periodRange('last-year', NOW, april)).toMatchObject({ from: d(2025, 3, 1), to: d(2026, 3, 1) });
        expect(periodRange('this-year', new Date(2027, 1, 10), april)).toMatchObject({ from: d(2026, 3, 1) });
        expect(periodRange('this-year', new Date(2027, 3, 1, 9), april)).toMatchObject({ from: d(2027, 3, 1) });
    });

    test('a chosen month: whole, or up to today, or empty when it has not started', () => {
        expect(periodRange('month:2026-08', NOW)).toEqual({ preset: 'month:2026-08', from: d(2026, 7, 1), to: d(2026, 8, 1), month: '2026-08' });
        expect(periodRange('month:2026-10', NOW)).toMatchObject({ from: d(2026, 9, 1), to: endOfToday });
        expect(periodRange('month:2026-11', NOW)).toMatchObject({ from: d(2026, 10, 1), to: d(2026, 10, 1) });
    });

    test('PERIOD-CUSTOM: both days included, either order, never past today', () => {
        expect(periodRange('range:2026-10-03:2026-10-01', NOW)).toEqual({
            preset: 'range:2026-10-03:2026-10-01', from: d(2026, 9, 1), to: d(2026, 9, 4), custom: true, first: '2026-10-01', last: '2026-10-03'
        });
        expect(periodRange('range:2026-10-10:2026-10-20', NOW)).toMatchObject({ from: d(2026, 9, 10), to: endOfToday, last: '2026-10-15' });
    });

    test('anything else is this month', () => {
        const thisMonth = { from: d(2026, 9, 1), to: endOfToday, month: '2026-10' };
        ['bogus', 'xmonth:2026-08', 'month:2026-08x', 'range:2026-13-01:2026-10-01', 'range:2026-10-00:2026-10-01',
            'range:2026-02-29:2026-03-01', 'xrange:2026-10-01:2026-10-02', 'range:2026-10-01:2026-10-02x']
            .forEach(p => expect(periodRange(p, NOW)).toEqual({ preset: p, ...thisMonth }));
    });

    test('customRangePreset: two chosen days as a preset, or null', () => {
        expect(customRangePreset('2026-10-05', '2026-10-01', NOW)).toBe('range:2026-10-01:2026-10-05');
        expect(customRangePreset('2026-10-15', '2026-10-20', NOW)).toBe('range:2026-10-15:2026-10-20');
        expect(customRangePreset('2026-10-16', '2026-10-20', NOW)).toBeNull();
        expect(customRangePreset('2026-10-01', 'x', NOW)).toBeNull();
        expect(customRangePreset('x', '2026-10-01', NOW)).toBeNull();
        expect(customRangePreset('x2026-10-01', '2026-10-02', NOW)).toBeNull();
        expect(customRangePreset('2026-10-01', '2026-10-02x', NOW)).toBeNull();
        expect(customRangePreset('2026-02-30', '2026-03-01', NOW)).toBeNull();
    });
});

describe('CMP: comparisonRanges and change', () => {
    test('open-ended periods have nothing to compare with', () => {
        expect(comparisonRanges({ from: -Infinity, to: at(5) })).toEqual({ previous: null, lastYear: null });
        expect(comparisonRanges({ from: at(5), to: Infinity })).toEqual({ previous: null, lastYear: null });
    });

    test('a month so far: the same days of the previous month, to the same time of day', () => {
        const r = comparisonRanges({ preset: 'this-month', month: '2026-10', from: d(2026, 9, 1), to: d(2026, 9, 15, 14, 30) });
        expect(r.previous).toEqual({ from: d(2026, 8, 1), to: d(2026, 8, 15, 14, 30) });
        expect(r.lastYear).toEqual({ from: d(2025, 9, 1), to: d(2025, 9, 15, 14, 30) });
    });

    test('1–28 March compares with all of February', () => {
        expect(comparisonRanges({ preset: 'month:2026-03', month: '2026-03', from: d(2026, 2, 1), to: d(2026, 2, 29) }).previous)
            .toEqual({ from: d(2026, 1, 1), to: d(2026, 2, 1) });
    });

    test('rolling 30 days compare with the 30 days just before, even from the 1st', () => {
        const r = { preset: 'last-30', from: d(2026, 2, 1), to: d(2026, 2, 31) };
        expect(comparisonRanges(r).previous).toEqual({ from: d(2026, 0, 30), to: d(2026, 2, 1) });
        const rolling = { preset: 'this-month', from: d(2026, 2, 1), to: d(2026, 2, 31) };
        expect(comparisonRanges(rolling).previous).toEqual({ from: d(2026, 0, 30), to: d(2026, 2, 1) });
    });

    test('a period not starting on the 1st, or longer than a month: the same length just before', () => {
        expect(comparisonRanges({ preset: 'range:x', from: d(2026, 9, 1, 6), to: d(2026, 9, 11, 6) }).previous)
            .toEqual({ from: d(2026, 8, 21, 6), to: d(2026, 9, 1, 6) });
        expect(comparisonRanges({ preset: 'range:x', from: d(2026, 7, 1), to: d(2026, 8, 11) }).previous)
            .toEqual({ from: d(2026, 7, 1) - 41 * DAY, to: d(2026, 7, 1) });
    });

    test('% change: rounded, "about the same" under 2 %, none without a base', () => {
        expect(change(102, 100)).toEqual({ pct: 2, diff: 2, dir: 'up' });
        expect(change(101, 100)).toEqual({ pct: 1, diff: 1, dir: 'same' });
        expect(change(98, 100)).toEqual({ pct: -2, diff: -2, dir: 'down' });
        expect(change(-50, -100)).toEqual({ pct: 50, diff: 50, dir: 'up' });
        expect(change(5, 0)).toBeNull();
        expect(change(NaN, 5)).toBeNull();
        expect(change(5, Infinity)).toBeNull();
        expect(change(null, 5)).toBeNull();
        expect(change(5, undefined)).toBeNull();
    });
});

describe('moneySummary: M1–M17 of a small week', () => {
    const input = () => ({
        items: ITEMS,
        base: FULL,
        purchases: [
            // ₹1,200 of rice less ₹20 labour; ₹700 cash + ₹300 online at the bill, ₹80 later
            { id: 'p1', supplierName: 'Mohan', timestamp: at(5, 12), items: [line('rice', 'Rice', 20, 60)], laborCharges: 20, grandTotal: 1180,
                payment: { cash: 730, online: 350, due: 100 }, payments: [{ id: 'pp', at: at(9), cash: 30, online: 50 }] }
        ],
        retailSales: [{ id: 'r1', timestamp: at(6), items: [line('rice', 'Rice', 10, 100)], total: 1000, payment: { cash: 600, online: 400, due: 0 } }],
        wholesaleSales: [
            { id: 'w1', customerName: 'Asha', timestamp: at(7), items: [line('rice', 'Rice', 5, 100)], total: 500,
                payment: { cash: 50, online: 400, due: 50 }, payments: [{ id: 'wp', at: at(8), cash: 50, online: 100 }] }
        ],
        expenses: [
            { id: 'e1', date: iso(at(6)), amount: 200, category: 'business', type: 'Rent', paymentMode: 'online' },
            { id: 'e2', date: iso(at(6)), amount: 30, type: 'Tea' },
            { id: 'e3', date: iso(at(6)), amount: 100, category: 'personal' }
        ],
        sessions: [{ id: 's', duePayments: [{ id: 'leg', type: 'received', cash: 25, at: at(8) }] }]
    });

    test('every figure, cash and online apart', () => {
        const m = moneySummary(input(), ALL);
        expect(m.range).toEqual(ALL);
        expect(m.M1).toEqual({ total: 1500, count: 2, due: 50, retail: { total: 1000, count: 1 }, wholesale: { total: 500, count: 1 } });
        expect(m.M2).toBe(900);
        expect(m.M3).toEqual({ total: 600, per100: 40 });
        expect(m.M4).toMatchObject({ total: 230, count: 2, uncategorised: 30 });
        expect(m.M5).toBe(0);
        expect(m.M6).toEqual({ total: 370, per100: 24.67 });
        expect(m.M7).toBe(20);
        expect(m.M8).toEqual({ total: 100, count: 1 });
        expect(m.M9).toBe(0);
        expect(m.M10).toBe(270);
        expect(m.M12).toEqual({ cash: 675, online: 800, atSale: 1300, dueReceived: 175, total: 1475 });
        expect(m.M13).toEqual({ cash: 860, online: 550, atPurchase: 1000, duePaid: 80, expenses: 330, expensesCash: 130, expensesOnline: 200, total: 1410 });
        expect(m.M14).toBe(65);
        expect(m.M16).toEqual({ total: 1180, count: 1, lineValue: 1200, labour: 20 });
        expect(m.M17).toEqual({ opening: 0, purchases: 1200, cogs: 900, adjustments: 0, closing: 300, now: 300, gap: 0 });
        expect(m.stockNow).toBe(300);
        expect(m.caveats).toEqual([{ key: 'untagged', ids: ['M4'], amount: 30 }]);
    });

    test('caveats: cost not known, dues may be missing', () => {
        const m = moneySummary({ ...input(), base: null, duesComplete: false }, ALL);
        expect(m.caveats).toEqual([
            { key: 'history', ids: ['M2', 'M3', 'M6', 'M10', 'M17'] },
            { key: 'untagged', ids: ['M4'], amount: 30 },
            { key: 'dues', ids: ['M5', 'M12', 'M13', 'M14'] }
        ]);
        expect(m).toMatchObject({ M2: null, M3: { total: null, per100: null }, M6: { total: null, per100: null }, M17: null, stockNow: null });
    });

    test('caveats: goods sold before they were bought (uncosted, check line off)', () => {
        const m = moneySummary({
            items: ITEMS, base: FULL,
            retailSales: [{ id: 'r', timestamp: at(2), items: [line('rice', 'Rice', 4, 100)], total: 400 }],
            purchases: [{ id: 'p', timestamp: at(3), items: [line('rice', 'Rice', 10, 60)], grandTotal: 600 }]
        }, { from: at(1), to: at(5) });
        expect(m.caveats).toEqual([
            { key: 'uncosted', ids: ['M2', 'M3', 'M6'], qty: 4, estimate: 240 },
            { key: 'gap', ids: ['M17'], gap: 240 }
        ]);
    });

    test('no bills of a kind given: nothing counted, no profit per ₹100 without sales', () => {
        const m = moneySummary({ base: FULL, purchases: [{ id: 'p', timestamp: at(3), grandTotal: 90 }] }, ALL);
        expect(m.M1).toEqual({ total: 0, count: 0, due: 0, retail: { total: 0, count: 0 }, wholesale: { total: 0, count: 0 } });
        expect(m.M16).toEqual({ total: 90, count: 1, lineValue: 0, labour: 0 });
        expect(m.M3.per100).toBeNull();
        expect(m.caveats).toEqual([]);
    });
});

describe('M4 by category: expenseCategories', () => {
    test('business expenses of the period per type; tagged business without a type is "other", untagged "untagged"', () => {
        const ex = [
            { date: iso(at(1, 0)), amount: 200, category: 'business', type: 'Rent' },
            { date: iso(at(3)), amount: 100, type: ' Rent ' },
            { date: iso(at(3)), amount: '30', type: 'Tea' },
            { date: iso(at(3)), amount: 50, category: 'business' },
            { date: iso(at(3)), amount: 40 },
            { date: iso(at(3)), amount: 999, category: 'personal', type: 'Rent' },
            { date: iso(at(3)), amount: 999, type: 'Rent', voided: true },
            { date: iso(at(5, 0)), amount: 999, type: 'Rent' },
            { date: iso(at(1, 0) - 1), amount: 999, type: 'Rent' },
            { amount: 7, type: 'Undated' }
        ];
        expect(expenseCategories(ex, at(1, 0), at(5, 0))).toEqual([
            { category: 'Rent', total: 300, count: 2 },
            { category: 'other', total: 50, count: 1 },
            { category: 'untagged', total: 40, count: 1 },
            { category: 'Tea', total: 30, count: 1 }
        ]);
        expect(expenseCategories(ex, -Infinity, at(5, 0)).find(r => r.category === 'Undated')).toBeUndefined();
        expect(expenseCategories(ex, -Infinity, Infinity).find(r => r.category === 'Undated')).toEqual({ category: 'Undated', total: 7, count: 1 });
    });
});

describe('outstandingTotals (O3, O4)', () => {
    test('open dues to pay and to receive, with bill counts', () => {
        const src = {
            purchases: [{ payment: { due: 100 } }, { payment: { due: 0 } }],
            retailSales: [{ payment: { due: 30 } }],
            wholesaleSales: [{ payment: { due: 20 } }, { payment: { due: 50 }, cleared: true }]
        };
        expect(outstandingTotals(src)).toEqual({ payable: { total: 100, count: 1 }, receivable: { total: 50, count: 2 } });
        expect(outstandingTotals({})).toEqual({ payable: { total: 0, count: 0 }, receivable: { total: 0, count: 0 } });
    });
});

describe('Items: I1, I2, I7, I8', () => {
    // Rice at ₹100/kg and dal at ₹50/kg; some lines sold below cost; r1 has ₹10 off.
    const data = {
        items: ITEMS, base: FULL,
        purchases: [{ id: 'p1', timestamp: at(1), items: [line('rice', 'Rice', 10, 100), line('dal', 'Dal', 10, 50)], grandTotal: 1500 }],
        retailSales: [
            { id: 'r1', timestamp: at(2), items: [line('rice', 'Rice', 2, 80), line('dal', 'Dal', 1, 60)], total: 210 },
            { id: 'r2', timestamp: at(4), items: [line('dal', 'Dal', 2, 40)], total: 80 },
            { id: 'r3', timestamp: at(5), items: [line('rice', 'Rice', 1, 90)], total: 90 }
        ],
        wholesaleSales: [
            { id: 'w1', timestamp: at(3, 10), items: [line('rice', 'Rice', 3, 120)], total: 360 },
            { id: 'w2', timestamp: at(3, 12), items: [line('rice', 'Rice', 1, 100)], total: 100 }
        ]
    };
    const rice = { itemKey: 'rice', item: 'Rice', itemHi: 'चावल', adjustment: false };
    const dal = { itemKey: 'dal', item: 'Dal', itemHi: 'Dal', adjustment: false };
    const rest = { itemKey: '', item: '', itemHi: '', sales: -10, qty: 0, cogs: 0, profit: -10, per100: expect.any(Number), retail: -10, wholesale: 0, adjustment: true };

    test('I1 / I2: sales, cost and profit per item, retail and wholesale apart, best profit first', () => {
        const m = moneySummary(data, ALL, { detail: true });
        expect(itemSummary(m)).toEqual([
            { ...rice, sales: 710, qty: 7, cogs: 700, profit: 10, per100: 1.41, retail: 250, wholesale: 460 },
            { ...dal, sales: 140, qty: 3, cogs: 150, profit: -10, per100: -7.14, retail: 140, wholesale: 0 },
            rest
        ]);
        expect(itemSummary(m, { type: 'retail' })).toEqual([
            { ...dal, sales: 140, qty: 3, cogs: 150, profit: -10, per100: -7.14, retail: 140, wholesale: 0 },
            rest,
            { ...rice, sales: 250, qty: 3, cogs: 300, profit: -50, per100: -20, retail: 250, wholesale: 0 }
        ]);
        expect(itemSummary(m, { type: 'wholesale' })).toEqual([
            { ...rice, sales: 460, qty: 4, cogs: 400, profit: 60, per100: 13.04, retail: 0, wholesale: 460 }
        ]);
    });

    test('without the cost, items are by sales and have no profit', () => {
        const m = moneySummary({ ...data, base: null }, ALL, { detail: true });
        expect(itemSummary(m).map(r => [r.itemKey, r.sales, r.cogs, r.profit, r.per100])).toEqual([
            ['rice', 710, null, null, null], ['dal', 140, null, null, null], ['', -10, null, null, null]
        ]);
        expect(belowCostSales(m)).toEqual([]);
        expect(itemSummary({})).toEqual([]);
        expect(belowCostSales({})).toEqual([]);
    });

    test('I8: lines sold below their cost, per item, biggest loss first', () => {
        const m = moneySummary(data, ALL, { detail: true });
        expect(belowCostSales(m)).toEqual([
            { itemKey: 'rice', item: 'Rice', itemHi: 'चावल', times: 2, qty: 3, lost: 50 },
            { itemKey: 'dal', item: 'Dal', itemHi: 'Dal', times: 1, qty: 2, lost: 20 }
        ]);
    });

    test('M11 days: profit per local day adds up to M6', () => {
        const m = moneySummary(data, ALL, { detail: true });
        const days = profitPerDay(m);
        expect(days).toEqual({ '2026-10-02': -40, '2026-10-03': 60, '2026-10-04': -20, '2026-10-05': -10 });
        expect(Object.values(days).reduce((a, b) => a + b, 0)).toBe(m.M6.total);
    });

    test('I7: enough sales and under ₹3 profit per ₹100 (or a loss), worst first', () => {
        const rows = [
            { itemKey: 'a', sales: 5000, per100: 2.9 },
            { itemKey: 'b', sales: 6000, per100: 3 },
            { itemKey: 'c', sales: 4999, per100: 1 },
            { itemKey: '', sales: 9000, per100: 1 },
            { itemKey: 'd', sales: 9000, per100: null },
            { itemKey: 'e', sales: 5000, per100: -5 }
        ];
        expect(lowProfitItems(rows).map(r => r.itemKey)).toEqual(['e', 'a']);
        expect(lowProfitItems(undefined)).toEqual([]);
    });
});

describe('I11: purchaseItems', () => {
    test('labour shared by line value; a bill whose lines differ from its total adds a "bill adjustments" row', () => {
        const purchases = [
            { id: 'p1', timestamp: at(2), items: [line('rice', 'Rice', 10, 100), line('dal', 'Dal', 5, 100)], laborCharges: 30, grandTotal: 1470 },
            { id: 'p2', timestamp: at(3), items: [{ name: 'Gur', qty: 2, rate: 50, total: 100 }], grandTotal: 90 },
            { id: 'p3', timestamp: at(3), grandTotal: 100 },
            { id: 'p4', timestamp: at(9), items: [line('rice', 'Rice', 1, 1)], grandTotal: 1 }
        ];
        const rows = purchaseItems(purchases, ITEMS, { from: at(1), to: at(5) });
        expect(rows).toEqual([
            { itemKey: 'rice', item: 'Rice', itemHi: 'चावल', lineValue: 1000, labour: 20, amount: 980, qty: 10 },
            { itemKey: 'dal', item: 'Dal', itemHi: 'Dal', lineValue: 500, labour: 10, amount: 490, qty: 5 },
            { itemKey: 'gur', item: 'Gur', itemHi: 'Gur', lineValue: 100, labour: 0, amount: 100, qty: 2 },
            { itemKey: '', item: '', itemHi: '', lineValue: 0, labour: 0, amount: 90, qty: 0 }
        ]);
        expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(1660);
        expect(purchaseItems(purchases.slice(1, 2), null, ALL)).toEqual([
            { itemKey: 'gur', item: 'Gur', itemHi: 'Gur', lineValue: 100, labour: 0, amount: 100, qty: 2 },
            { itemKey: '', item: '', itemHi: '', lineValue: 0, labour: 0, amount: -10, qty: 0 }
        ]);
    });
});

describe('PARTY: partySummary (I3, I4)', () => {
    test('I3: per customer (case and spaces ignored), the most used spelling, biggest first', () => {
        const src = {
            retailSales: [
                { customerName: 'Asha', timestamp: at(3), total: 100, items: [line('rice', 'Rice', 1, 100)] },
                { customerName: 'Ravi  Kumar', timestamp: at(4), total: 50, items: [] },
                { customerName: 'ravi kumar', date: 'not a date', total: 20 },
                { timestamp: at(2), total: 30 },
                { customerName: 'Asha', timestamp: at(9, 10, 8), total: 1, voided: true }
            ],
            wholesaleSales: [{ customerName: 'asha  ', timestamp: at(5), total: 200, items: [line('rice', 'Rice', 2, 100), line('dal', 'Dal', 1.5, 0)] }]
        };
        expect(partySummary(src, 'sales', ALL)).toEqual([
            { key: 'asha', name: 'Asha', total: 300, count: 2, labour: 0, qty: 4.5, last: at(5) },
            { key: 'ravi kumar', name: 'Ravi Kumar', total: 70, count: 2, labour: 0, qty: 0, last: at(4) },
            { key: '', name: '', total: 30, count: 1, labour: 0, qty: 0, last: at(2) }
        ]);
        expect(partySummary({ retailSales: [{ customerName: 'X', date: 'n/a', total: 5 }] }, 'sales', ALL)[0].last).toBeNull();
    });

    test('I4: per supplier, with labour and kg', () => {
        const src = {
            purchases: [
                { supplierName: 'Mohan', timestamp: at(2), grandTotal: 970, laborCharges: 30, items: [line('rice', 'Rice', 10, 100)] },
                { supplierName: 'mohan', timestamp: at(3), grandTotal: 495, laborCharges: 5, items: [line('dal', 'Dal', 5, 100)] },
                { supplierName: 'Gopal', timestamp: at(1), grandTotal: 1000, items: [] }
            ]
        };
        expect(partySummary(src, 'purchases', { from: at(1, 12), to: at(5) })).toEqual([
            { key: 'mohan', name: 'Mohan', total: 1465, count: 2, labour: 35, qty: 15, last: at(3) }
        ]);
        expect(partySummary({}, 'sales', ALL)).toEqual([]);
    });
});

describe('Stopped coming (I3): stoppedComingCheck', () => {
    const now = NOW;
    const cutoff = now.getTime() - 60 * DAY;
    const b = (name, ...times) => times.map(t => ({ customerName: name, timestamp: t }));
    const ly = (m) => d(2025, m, 10, 10);
    const src = {
        retailSales: [
            ...b('Asha', ly(8), ly(9), ly(10), d(2026, 6, 1, 10)),
            ...b('Ravi', ly(8), ly(9), ly(10), d(2026, 9, 1, 10)),
            ...b('Mohan', ly(8), ly(9)),
            ...b('', ly(8), ly(9), ly(10), d(2026, 1, 1)),
            { customerName: 'Hari', timestamp: ly(8), openingBalance: { amount: 5 } }
        ],
        wholesaleSales: [...b('Gita  Devi', ly(8), ly(9), ly(10), d(2026, 7, 1, 10)), ...b('Hari', ly(9), ly(10))]
    };

    test('bought in each of the same 3 months last year, no bill for 60 days; latest first', () => {
        expect(stoppedComingCheck(src, now)).toEqual({
            list: [
                { key: 'gita devi', name: 'Gita Devi', last: d(2026, 7, 1, 10) },
                { key: 'asha', name: 'Asha', last: d(2026, 6, 1, 10) }
            ],
            known: true
        });
    });

    test('not known when the bills of the last 60 days are not all loaded', () => {
        expect(stoppedComingCheck(src, now, INSIGHTS_DEFAULTS, { loadedFrom: cutoff + 1 })).toEqual({ list: [], known: false });
        const empty = { '2025-09': [], '2025-10': [], '2025-11': [] };
        expect(stoppedComingCheck(src, now, INSIGHTS_DEFAULTS, { loadedFrom: cutoff, snapshotCustomers: empty }).known).toBe(true);
    });

    test('months last year that are not loaded come from that month\'s snapshot, else not known', () => {
        const loadedFrom = d(2025, 9, 1);
        const loaded = (from) => ({ retailSales: src.retailSales.filter(x => x.timestamp >= from), wholesaleSales: src.wholesaleSales.filter(x => x.timestamp >= from) });
        expect(stoppedComingCheck(loaded(loadedFrom), now, INSIGHTS_DEFAULTS, { loadedFrom })).toEqual({ list: [], known: false });
        expect(stoppedComingCheck(loaded(d(2025, 8, 1)), now, INSIGHTS_DEFAULTS, { loadedFrom: d(2025, 8, 1) }).known).toBe(true);
        const sep = [{ key: 'asha', name: 'Asha' }, { name: 'Ravi' }, { name: '' }];
        expect(stoppedComingCheck(loaded(loadedFrom), now, INSIGHTS_DEFAULTS, { loadedFrom, snapshotCustomers: { '2025-09': sep } }).list)
            .toEqual([{ key: 'asha', name: 'Asha', last: d(2026, 6, 1, 10) }]);
    });

    test('a regular known only from the snapshots, with the snapshot spelling', () => {
        const months = { '2025-09': [{ key: 'gopal', name: 'Gopal' }], '2025-10': [{ name: 'Gopal' }], '2025-11': [{ key: 'GOPAL', name: 'gopal' }] };
        expect(stoppedComingCheck({}, now, INSIGHTS_DEFAULTS, { loadedFrom: d(2025, 11, 1), snapshotCustomers: months }))
            .toEqual({ list: [{ key: 'gopal', name: 'Gopal', last: null }], known: true });
    });
});

describe('I10: overdueParties', () => {
    test('parties with a due older than 30 days: count, total, oldest', () => {
        const bills = [
            { customerName: 'Asha', timestamp: d(2026, 8, 14, 18), payment: { due: 100 } },
            { customerName: 'asha ', timestamp: d(2026, 8, 1, 9), payment: { due: 50 } },
            { customerName: 'Ravi', timestamp: d(2026, 8, 15, 9), payment: { due: 70 } },
            { customerName: 'Paid', timestamp: d(2026, 5, 1), payment: { due: 0 } },
            { customerName: 'Undated', payment: { due: 40 } }
        ];
        expect(overdueParties(bills, NOW)).toEqual({ parties: 1, total: 150, oldestDays: 44 });
        expect(overdueParties(undefined, NOW)).toEqual({ parties: 0, total: 0, oldestDays: 0 });
    });
});

describe('Seasons: I5, I9', () => {
    test('soldKgByMonth: retail + wholesale kg per item and month from the rateStats year docs', () => {
        const docs = [
            { itemId: 'rice', months: { 'm2026-01': { retail: { kg: 10 }, wholesale: { kg: 5 } }, '2026-02': { retail: { kg: '3' } }, mx: { retail: { kg: 9 } }, 'm2026-1': { retail: { kg: 9 } }, 'm2026-03x': { retail: { kg: 9 } } } },
            { itemId: 'rice', months: { 'm2026-01': { wholesale: { kg: 1 } }, 'm2026-04': { retail: { kg: 'x' } } } },
            { itemId: 'dal' }, { months: {} }, null
        ];
        const out = soldKgByMonth(docs);
        expect([...out.entries()]).toEqual([['rice', { '2026-01': 16, '2026-02': 3, '2026-04': 0 }], ['dal', {}]]);
        expect(soldKgByMonth(undefined).size).toBe(0);
    });

    test('seasonKgTotal: kg over all months', () => {
        expect(seasonKgTotal({ '2026-01': 10, '2026-02': 2.5 })).toBe(12.5);
        expect(seasonKgTotal(undefined)).toBe(0);
    });

    test('seasonIndex: a month\'s kg over the average month, needs 12 months', () => {
        const kg = { total: 500, '2027-01': Infinity, 'x2025-07': 99, '2025-08x': 99 };
        for (let m = 1; m <= 12; m++) kg[`2025-${String(m).padStart(2, '0')}`] = 10;
        kg['2025-06'] = 40;
        kg['2026-06'] = 20;
        const idx = seasonIndex(kg);
        // 13 months, 170 kg: average 13.08; June (40 + 20) / 2 = 30 → 2.29; other months 10 → 0.76
        expect(idx).toEqual([0.76, 0.76, 0.76, 0.76, 0.76, 2.29, 0.76, 0.76, 0.76, 0.76, 0.76, 0.76]);
        const eleven = Object.fromEntries(Object.entries(kg).filter(([k]) => k.startsWith('2025-') && k !== '2025-12'));
        expect(seasonIndex(eleven)).toBeNull();
        const none = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}`, 0]));
        expect(seasonIndex(none)).toBeNull();
        const gaps = { ...none, '2025-03': 12 };
        delete gaps['2025-04'];
        gaps['2024-01'] = 0;
        expect(seasonIndex(gaps)[3]).toBeNull();
    });

    test('stockUpItems: a busy month in the next 8 weeks and stock for fewer weeks than it takes + 4', () => {
        const index = (busy) => Array.from({ length: 12 }, (_, i) => busy[i] ?? 1);
        const rows = [
            { itemKey: 'A', index: index({ 10: 1.5 }), qty: 10, weeklyKg: 5 },
            { itemKey: 'B', index: index({ 11: 2 }), qty: 100, weeklyKg: 10 },
            { itemKey: 'C', index: index({ 0: 3 }), qty: 1, weeklyKg: 10 },
            { itemKey: 'D', index: index({ 10: 2 }), qty: 100, weeklyKg: 5 },
            { itemKey: 'E', index: null, qty: 0, weeklyKg: 5 },
            { itemKey: 'F', index: index({ 10: 2 }), qty: 0, weeklyKg: 0 },
            { itemKey: 'G', index: index({ 10: null, 11: 1.6 }), qty: -5, weeklyKg: 5 },
            { itemKey: 'H', index: index({ 10: 1.5 }), qty: 30, weeklyKg: 5 },
            { itemKey: 'I', index: index({ 10: 1.49 }), qty: 1, weeklyKg: 5 }
        ];
        expect(stockUpItems(rows, NOW)).toEqual([
            { ...rows[6], busyMonth: 11, weeksToBusy: 7, coverWeeks: 0 },
            { ...rows[0], busyMonth: 10, weeksToBusy: 2, coverWeeks: 2 },
            { ...rows[1], busyMonth: 11, weeksToBusy: 7, coverWeeks: 10 }
        ]);
        expect(stockUpItems(undefined, NOW)).toEqual([]);
    });

    test('stockUpItems: the busy month being this week is 0 weeks away', () => {
        const rows = [{ itemKey: 'A', index: Array.from({ length: 12 }, (_, i) => (i === 10 ? 2 : 1)), qty: 1, weeklyKg: 1 }];
        expect(stockUpItems(rows, new Date(2026, 9, 31, 12))[0]).toMatchObject({ weeksToBusy: 0, coverWeeks: 1 });
    });

    test('weeklyKgWindow: the last 8 weeks, or from the first loaded bill; none under 2 weeks', () => {
        const end = NOW.getTime();
        expect(weeklyKgWindow(NOW)).toEqual({ from: end - 56 * DAY, to: end + 1, weeks: 8 });
        expect(weeklyKgWindow(end, end - 21 * DAY)).toEqual({ from: end - 21 * DAY, to: end + 1, weeks: 3 });
        expect(weeklyKgWindow(end, end - 14 * DAY)).toEqual({ from: end - 14 * DAY, to: end + 1, weeks: 2 });
        expect(weeklyKgWindow(end, end - 13 * DAY)).toBeNull();
        expect(weeklyKgWindow(end, -Infinity, { weeksBack: 4 })).toEqual({ from: end - 28 * DAY, to: end + 1, weeks: 4 });
        expect(weeklyKgByItem([{ itemKey: 'a', qty: 16 }, { itemKey: 'b', qty: 2 }], 8)).toEqual(new Map([['a', 2], ['b', 0.25]]));
        expect(weeklyKgByItem(undefined, 8)).toEqual(new Map());
    });
});

describe('Shares and checks: I2, I12, AC10 / AC11', () => {
    test('sharePct: whole-number %, 0 of nothing', () => {
        expect(sharePct(25, 200)).toBe(13);
        expect(sharePct(5, 0)).toBe(0);
    });

    test('I12 topShare: the biggest named parties\' share of all parties', () => {
        const rows = [{ key: 'a', total: 500 }, { key: '', total: 300 }, { key: 'b', total: 150 }, { key: 'c', total: 50 }];
        expect(topShare(rows)).toEqual({ total: 1000, top: 700, pct: 70 });
        expect(topShare(rows, 1)).toEqual({ total: 1000, top: 500, pct: 50 });
        expect(topShare(undefined)).toEqual({ total: 0, top: 0, pct: null });
        expect(topShare([{ key: 'a', total: -5 }])).toEqual({ total: -5, top: -5, pct: null });
    });

    test('addsUp: rows add up to the total within ₹1', () => {
        const rows = [{ amount: 100 }, { amount: 50.5 }];
        expect(addsUp(rows, 'amount', 150.5)).toBe(true);
        expect(addsUp(rows, 'amount', 151.5)).toBe(true);
        expect(addsUp(rows, 'amount', 149.4)).toBe(false);
        expect(addsUp(rows, 'amount', 152, 2)).toBe(true);
        expect(addsUp(undefined, 'amount', 0)).toBe(true);
        expect(addsUp(undefined, 'amount', 2)).toBe(false);
    });
});

describe('M14 per day: netMoneyByDay', () => {
    test('money in − money out of each local day, to paise', () => {
        const detail = {
            receivedAtSale: [{ t: d(2026, 9, 1, 9), amount: 100.1 }, { t: null, amount: 999 }],
            dueReceived: [{ t: d(2026, 9, 1, 23), amount: 50.2 }],
            paidAtPurchase: [{ t: d(2026, 9, 2, 1), amount: 80 }],
            duePaid: [{ t: d(2026, 9, 2, 9), amount: '20' }],
            business: [{ t: d(2026, 9, 1, 12), amount: 10 }],
            personal: [{ t: d(2026, 9, 3), amount: 5 }, { t: d(2026, 9, 3), amount: 'x' }]
        };
        expect(netMoneyByDay(detail, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])).toEqual([140.3, -100, -5, 0]);
        expect(netMoneyByDay(undefined, ['2026-10-01'])).toEqual([0]);
        expect(netMoneyByDay(detail, undefined)).toEqual([]);
    });
});

describe('M15: net worth and the shared accounts (#74)', () => {
    test('only the chosen terms count; payables are always taken off', () => {
        const t = { stock: 1000, receivable: 300, payable: 200, accounts: 50, drawer: 25 };
        expect(netWorth(t)).toBe(1175);
        const stockOnly = { ...INSIGHTS_DEFAULTS, netWorthTerms: ['stock'] };
        expect(netWorth(t, stockOnly)).toBe(800);
        expect(netWorth({ ...t, accounts: null }, stockOnly)).toBe(800);
        expect(netWorth({ ...t, stock: null }, { ...INSIGHTS_DEFAULTS, netWorthTerms: ['receivable'] })).toBe(100);
        expect(netWorth({ ...t, stock: undefined })).toBeNull();
        expect(netWorth({ ...t, accounts: null })).toBeNull();
    });

    test('accountsTotal: assets minus liabilities', () => {
        expect(accountsTotal([{ balance: 100 }, { balance: '50', type: 'liability' }, { balance: 'x' }, { balance: 0.004 }])).toBe(50);
        expect(accountsTotal(undefined)).toBe(0);
    });

    test('accountId: FNV-1a of the name, case and spaces ignored', () => {
        expect(accountId('')).toBe('a811c9dc5');
        expect(accountId('a')).toBe('ae40c292c');
        expect(accountId('  FooBar ')).toBe('abf9cf968');
        expect(accountId(' SBI   Savings')).toBe(accountId('sbi savings'));
        expect(accountId(undefined)).toBe('a811c9dc5');
    });

    test('accountEntry: a name of 1–40 characters and a balance of 0 or more, in whole rupees', () => {
        expect(accountEntry({ name: ' SBI  Savings ', balance: '1234.6' }))
            .toEqual({ id: accountId('sbi savings'), entry: { name: 'SBI Savings', balance: 1235, type: 'asset' } });
        expect(accountEntry({ name: 'Loan', balance: 10, type: 'liability' }).entry.type).toBe('liability');
        expect(accountEntry({ name: 'Loan', balance: 10, type: 'other' }).entry.type).toBe('asset');
        expect(Object.is(accountEntry({ name: 'Zero', balance: -0.4 }).entry.balance, 0)).toBe(true);
        expect(accountEntry({ name: 'x'.repeat(40), balance: 1 })).not.toBeNull();
        expect(accountEntry({ name: 'Max', balance: 1e10 })).not.toBeNull();
        [
            { name: '', balance: 1 }, { name: '   ', balance: 1 }, { name: 'x'.repeat(41), balance: 1 },
            { name: 'A', balance: '' }, { name: 'A', balance: null }, { name: 'A', balance: 'abc' },
            { name: 'A', balance: -1 }, { name: 'A', balance: 1e10 + 1 }, { name: 'A' }, undefined
        ].forEach(input => expect(accountEntry(input)).toBeNull());
    });

    test('accountsList: readable accounts sorted by name, whole rupees', () => {
        const map = {
            a1: { name: ' Zed ', balance: 10.6 }, a2: { name: 'abc', balance: 'x', type: 'liability' }, a3: null,
            a4: { name: '  ' }, a5: 'bad', a0: { name: 'abc', balance: 5 }
        };
        expect(accountsList(map)).toEqual([
            { id: 'a0', name: 'abc', balance: 5, type: 'asset' },
            { id: 'a2', name: 'abc', balance: 0, type: 'liability' },
            { id: 'a1', name: 'Zed', balance: 11, type: 'asset' }
        ]);
        expect(accountsList(null)).toEqual([]);
        expect(accountsList('x')).toEqual([]);
    });

    test('accountsFromPhone: names in another case are one account with their total; the rest stay on the phone', () => {
        const long = `${'L'.repeat(39)} tail`;
        const list = [
            { name: 'SBI', balance: 100 }, { name: ' sbi ', balance: '50' },
            { name: 'Loan', balance: 300, type: 'liability' },
            { name: 'Card', balance: -20 },
            { name: 'Gold', balance: 100 }, { name: 'gold', balance: 150, type: 'liability' },
            { name: 'Even', balance: 40 }, { name: 'even', balance: 40, type: 'liability' },
            { name: '', balance: 5 }, { name: 'X', balance: '' }, { name: 'Y', balance: null }, { name: 'Z', balance: 'abc' }, null,
            { name: 'Big', balance: 2e10 },
            { name: long, balance: 1 }
        ];
        const { map, skipped } = accountsFromPhone(list);
        expect(map).toEqual({
            [accountId('SBI')]: { name: 'SBI', balance: 150, type: 'asset' },
            [accountId('Loan')]: { name: 'Loan', balance: 300, type: 'liability' },
            [accountId('Card')]: { name: 'Card', balance: 20, type: 'liability' },
            [accountId('Gold')]: { name: 'Gold', balance: 50, type: 'liability' },
            [accountId('Even')]: { name: 'Even', balance: 0, type: 'asset' },
            [accountId('L'.repeat(39))]: { name: 'L'.repeat(39), balance: 1, type: 'asset' }
        });
        expect(skipped).toEqual([list[8], list[9], list[10], list[11], list[13]]);
        expect(accountsFromPhone('x')).toEqual({ map: {}, skipped: [] });
    });

    test('accountsFromPhone: at most 30 accounts move', () => {
        const list = Array.from({ length: MAX_WORTH_ACCOUNTS + 1 }, (_, i) => ({ name: `Acc ${i}`, balance: i }));
        const { map, skipped } = accountsFromPhone(list);
        expect(Object.keys(map)).toHaveLength(MAX_WORTH_ACCOUNTS);
        expect(skipped).toEqual([list[MAX_WORTH_ACCOUNTS]]);
    });
});

describe('I6: biggestChange', () => {
    const v = (r) => r.v;

    test('the named row with the largest change either way', () => {
        const now = [{ key: 'a', v: 10 }, { key: 'b', v: 5 }, { key: '', v: 100 }];
        const then = [{ key: 'a', v: 4 }, { key: 'c', v: 9 }];
        expect(biggestChange(now, then, v)).toEqual({ key: 'c', row: then[1], diff: -9 });
        expect(biggestChange(now, undefined, v)).toEqual({ key: 'a', row: now[0], diff: 10 });
    });

    test('a tie keeps the first; no change is no answer', () => {
        expect(biggestChange([{ key: 'a', v: 10 }, { key: 'b', v: 10 }], [], v).key).toBe('a');
        expect(biggestChange([{ key: 'a', v: 3 }], [{ key: 'a', v: 3 }], v)).toBeNull();
        expect(biggestChange(undefined, undefined, v)).toBeNull();
    });
});
