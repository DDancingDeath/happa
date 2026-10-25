import {
    dailyDetailAvailable, dailyTraffic, isSettledYear, monthBucketsFor, pctChange, trafficRows, weeklyItemRows
} from '../utils/product-traffic.js';
import { billsToYearDocs, istMonthStartMs, weekBuckets } from '../utils/rate-trends.js';

const items = [
    { id: 'wheat', name: 'Wheat', hindiName: 'गेहूं' },
    { id: 'rice', name: 'Rice', hindiName: 'चावल' }
];
const IST = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 330 * 60000;
const docsOf = (sources) => Object.entries(billsToYearDocs(sources, items)).map(([id, d]) => ({ id, ...d }));

describe('month overview', () => {
    const sources = {
        purchase: [{ timestamp: IST(2026, 10, 3, 10), items: [{ itemId: 'wheat', rate: 25, qty: 100 }, { itemId: 'rice', rate: 40, qty: 10 }] }],
        wholesale: [{ timestamp: IST(2026, 10, 4, 10), items: [{ itemId: 'wheat', rate: 28, quantity: 60 }] }],
        retail: [
            { timestamp: IST(2026, 10, 5, 10), items: [{ name: 'चावल', rate: 50, qty: 4 }] },
            { timestamp: IST(2026, 9, 5, 10), items: [{ itemId: 'wheat', rate: 30, qty: 80 }] },
            { timestamp: IST(2025, 10, 5, 10), items: [{ itemId: 'rice', rate: 45, qty: 28 }] }
        ]
    };
    const docs = docsOf(sources);

    test('items ranked by kg moved with per-type kg, bills and amount, vs last month and last year', () => {
        const rows = trafficRows(monthBucketsFor(docs, '2026-10'), monthBucketsFor(docs, '2026-09'), monthBucketsFor(docs, '2025-10'));
        expect(rows.map(r => r.itemId)).toEqual(['wheat', 'rice']);
        const [wheat, rice] = rows;
        expect(wheat.kg).toBe(160);
        expect(wheat.purchase).toEqual({ kg: 100, bills: 1, amount: 2500 });
        expect(wheat.wholesale).toEqual({ kg: 60, bills: 1, amount: 1680 });
        expect(wheat.bills).toBe(2);
        expect(wheat.amount).toBe(4180);
        expect(wheat.vsPrev).toBe(100);          // 160 vs 80 kg
        expect(wheat.vsLastYear).toBeNull();     // nothing last October
        expect(rice.kg).toBe(14);
        expect(rice.vsLastYear).toBe(-50);       // 14 vs 28 kg
        expect(rice.vsPrev).toBeNull();
    });

    test('empty buckets are left out; no comparison data gives null', () => {
        const empty = [{ itemId: 'x', month: '2026-10', purchase: { kg: 0 }, bills: 0 }];
        expect(trafficRows(empty)).toEqual([]);
        expect(pctChange(10, 0)).toBeNull();
    });
});

describe('day by day for one item (loaded bills only)', () => {
    test('IST day boundaries, DD/MM legacy dates, wholesale quantity, Hindi / no-itemId names, deleted bills out', () => {
        const sources = {
            purchase: [
                { timestamp: Date.UTC(2026, 9, 1, 18, 29), items: [{ itemId: 'wheat', rate: 25, qty: 10 }] }, // 1 Oct 23:59 IST
                { timestamp: Date.UTC(2026, 9, 1, 18, 31), items: [{ itemId: 'wheat', rate: 25, qty: 20 }] }, // 2 Oct 00:01 IST
                { date: '09/10/2026', items: [{ name: 'गेहूं', rate: 26, qty: 5 }, { name: 'Wheat', rate: 26, qty: 5 }] },
                { timestamp: IST(2026, 10, 9, 9), deleted: true, items: [{ itemId: 'wheat', rate: 25, qty: 999 }] },
                { timestamp: IST(2026, 11, 1, 9), items: [{ itemId: 'wheat', rate: 25, qty: 7 }] }
            ],
            wholesale: [{ timestamp: IST(2026, 10, 30, 12), items: [{ itemId: 'wheat', rate: 28, quantity: 40 }, { itemId: 'rice', rate: 40, quantity: 3 }] }],
            retail: [{ timestamp: IST(2026, 10, 2, 12), items: [{ itemId: 'wheat', rate: 0, qty: 3 }] }]
        };
        const d = dailyTraffic(sources, items, 'wheat', '2026-10');
        expect(d.days).toHaveLength(31);
        expect(d.days[0].purchase).toEqual({ kg: 10, bills: 1 });
        expect(d.days[1].purchase).toEqual({ kg: 20, bills: 1 });
        expect(d.days[1].retail).toEqual({ kg: 0, bills: 0 });   // no rate: not counted (as in the monthly stats)
        expect(d.days[8].purchase).toEqual({ kg: 10, bills: 1 });
        expect(d.days[29].wholesale).toEqual({ kg: 40, bills: 1 });
        expect(d.weeks.map(w => [w.week, w.from, w.to, w.purchase.kg])).toEqual([[1, 1, 7, 30], [2, 8, 14, 10], [3, 15, 21, 0], [4, 22, 28, 0], [5, 29, 31, 0]]);
        expect(d.total.purchase).toEqual({ kg: 40, bills: 3 });

        const month = monthBucketsFor(docsOf(sources), '2026-10').find(b => b.itemId === 'wheat');
        expect(d.total.purchase.kg).toBe(month.purchase.kg);
        expect(d.total.wholesale.kg).toBe(month.wholesale.kg);
    });

    test('only for months the loaded history fully covers', () => {
        expect(dailyDetailAvailable('2026-01', 0)).toBe(true);
        expect(dailyDetailAvailable('2026-08', istMonthStartMs('2026-08'))).toBe(true);
        expect(dailyDetailAvailable('2026-07', istMonthStartMs('2026-08'))).toBe(false);
    });
});

describe('week by week for one item', () => {
    test('every week in the range, newest first, zeros where nothing moved', () => {
        const docs = docsOf({ purchase: [
            { timestamp: IST(2026, 10, 6, 10), items: [{ itemId: 'rice', rate: 40, qty: 10 }] },
            { timestamp: IST(2026, 10, 20, 10), items: [{ itemId: 'rice', rate: 41, qty: 6 }] }
        ] });
        const rows = weeklyItemRows(weekBuckets(docs), '2026-09-28', '2026-10-19');
        expect(rows.map(r => [r.week, r.kg])).toEqual([['2026-10-19', 6], ['2026-10-12', 0], ['2026-10-05', 10], ['2026-09-28', 0]]);
        expect(rows[0].purchase).toEqual({ kg: 6, bills: 1 });
    });

    test('a year doc is kept on the device only when the roll-forward can no longer change it', () => {
        const now = IST(2026, 10, 25, 12);
        expect(isSettledYear('2025', now)).toBe(true);
        expect(isSettledYear('2026', now)).toBe(false);
        expect(isSettledYear('2025', IST(2026, 1, 10, 12))).toBe(false);
    });
});
