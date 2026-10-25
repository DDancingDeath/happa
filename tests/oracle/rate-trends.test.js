/**
 * @fileoverview Rate trends and product traffic (#65) == the independent oracle
 * (docs/calculations.md RT1, RT2, RT4, PT1, PT3, PT4).
 */
import * as O from './oracle.js';
import { billsToYearDocs, monthBuckets, weekBuckets } from '../../www/js/utils/rate-trends.js';
import { itemRateSeries } from '../../www/js/utils/item-rate-series.js';
import { dailyTraffic, monthBucketsFor, trafficRows, weeklyItemRows } from '../../www/js/utils/product-traffic.js';
import { historyDocId } from '../../www/js/utils/rate-history.js';

const items = [
    { id: 'rice', name: 'Rice', hindiName: 'चावल', rates: [34], wholesaleRates: [38], saleRates: [40] },
    { id: 'wheat', name: 'Wheat', hindiName: 'गेहूं', rates: [27], wholesaleRates: [], saleRates: [31] }
];
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h).getTime(); // TZ is Asia/Kolkata in Jest
const sources = {
    purchase: [
        { timestamp: at(2025, 12, 30), items: [{ itemId: 'rice', rate: 30, qty: 100 }, { name: 'गेहूं', rate: 24, qty: 40 }] },
        { timestamp: at(2026, 1, 2), items: [{ name: 'rice ', rate: 32, qty: 50 }, { itemId: 'rice', rate: 31, qty: 10 }] },
        { date: '05/01/2026', items: [{ itemId: 'wheat', qty: 20, total: 520 }] },
        { timestamp: at(2026, 1, 6), deleted: true, items: [{ itemId: 'rice', rate: 99, qty: 99 }] },
        { timestamp: at(2026, 1, 12, 0), items: [{ itemId: 'rice', rate: 33, qty: 0 }, { itemId: 'gone', rate: 1, qty: 1 }] }
    ],
    wholesale: [
        { timestamp: at(2026, 1, 4, 23), items: [{ itemId: 'rice', rate: 36, quantity: 70 }] },
        { timestamp: at(2026, 1, 5, 0), items: [{ itemId: 'rice', rate: 37, quantity: 30 }] }
    ],
    retail: [
        { date: '2026-01-11T18:00:00', items: [{ name: 'Wheat', rate: 30, qty: 5 }, { itemId: 'rice', rate: 40, qty: 2 }] }
    ]
};
const docs = Object.entries(billsToYearDocs(sources, items)).map(([id, d]) => ({ id, ...d }));

const appBuckets = (list, key) => {
    const out = {};
    list.forEach(b => {
        ['purchase', 'retail', 'wholesale'].forEach(k => {
            if (!(b[k]?.kg > 0)) return;
            ((out[b.itemId] ||= {})[b[key]] ||= {})[k] = { kg: b[k].kg, amount: b[k].amount, avg: b[k].avg, bills: b[k].bills };
        });
    });
    return out;
};

test('RT1/RT4 weekly buckets (Monday weeks, across the year end) == oracle', () => {
    expect(appBuckets(weekBuckets(docs), 'week')).toEqual(O.rateBuckets(sources, items, O.weekOf));
});

test('RT1/RT4 monthly buckets == oracle', () => {
    expect(appBuckets(monthBuckets(docs), 'month')).toEqual(O.rateBuckets(sources, items, O.monthOf));
});

test('PT1 month overview kg and amount == oracle', () => {
    const want = O.rateBuckets(sources, items, O.monthOf);
    const rows = trafficRows(monthBucketsFor(docs, '2026-01'));
    rows.forEach(r => {
        const w = want[r.itemId]['2026-01'];
        const kg = O.r2(['purchase', 'retail', 'wholesale'].reduce((a, k) => a + (w[k]?.kg || 0), 0));
        const amount = O.r2(['purchase', 'retail', 'wholesale'].reduce((a, k) => a + (w[k]?.amount || 0), 0));
        expect([r.kg, r.amount]).toEqual([kg, amount]);
    });
    expect(rows.map(r => r.itemId)).toEqual(['rice', 'wheat']);
});

test('PT3 day by day == oracle', () => {
    const app = dailyTraffic(sources, items, 'rice', '2026-01');
    const got = {};
    app.days.forEach(d => ['purchase', 'retail', 'wholesale'].forEach(k => {
        if (d[k].kg > 0) (got[d.day] ||= {})[k] = d[k];
    }));
    expect(got).toEqual(O.dailyKg(sources, items, 'rice', '2026-01'));
});

test('PT4 week by week == oracle', () => {
    const want = O.rateBuckets(sources, items, O.weekOf).wheat;
    const rows = weeklyItemRows(weekBuckets(docs).filter(b => b.itemId === 'wheat'), '2025-12-29', '2026-01-12');
    expect(rows.map(r => [r.week, r.purchase.kg, r.retail.kg])).toEqual(
        ['2026-01-12', '2026-01-05', '2025-12-29'].map(w => [w, want[w]?.purchase?.kg || 0, want[w]?.retail?.kg || 0]));
});

test('RT2 Items-page rate per week and month == oracle', () => {
    const cutoff = at(2026, 1, 3, 15);
    const now = at(2026, 2, 20, 12);
    const changes = [{ at: at(2026, 1, 9, 11), old: 30, new: 32 }, { at: at(2026, 1, 28, 9), old: 32, new: 34 }];
    const entries = changes.map(c => ({ id: historyDocId('rice', c.at), field: 'purchase', old: c.old, new: c.new, at: c.at }));
    const s = itemRateSeries(items[0], entries, { cutoffMs: cutoff, now });
    expect(s.purchase.weekly).toEqual(O.itemsPageRate(changes, 34, cutoff, now, O.weekOf));
    expect(s.purchase.monthly).toEqual(O.itemsPageRate(changes, 34, cutoff, now, O.monthOf));
    expect(s.wholesale.monthly).toEqual(O.itemsPageRate([], 38, cutoff, now, O.monthOf));
});
