import {
    addBillToAcc, aggregateBills, billMonth, billsToYearDocs, createCatalogueResolver, estimateBackfillReads, explainOutlook,
    finalizeStats, istMonthKey, istWeekStart, lineKg, monthBuckets, monthSeries, newCursor, parseCursor, planRollForward,
    rollForwardFromMonth, rollForwardWindow, runBackfillReads, seasonalOutlook, seasonalOutlookCombined, combinedChange,
    trendRows, weekBuckets, yearOverlay, addMonths, addWeeks, istMonthStartMs, istDayStartMs, itemsByUsage
} from '../utils/rate-trends.js';

const items = [
    { id: 'wheat', name: 'Wheat', hindiName: 'गेहूं' },
    { id: 'rice', name: 'Rice', hindiName: 'चावल' }
];
// 2026-10-15 10:00 IST
const OCT15 = Date.UTC(2026, 9, 15, 4, 30);

describe('IST months', () => {
    test('a bill just after midnight IST on the 1st belongs to the new month (UTC says the previous one)', () => {
        const t = Date.UTC(2026, 9, 31, 18, 45); // 2026-11-01 00:15 IST
        expect(istMonthKey(t)).toBe('2026-11');
        expect(billMonth({ timestamp: t })).toBe('2026-11');
    });

    test('month helpers', () => {
        expect(addMonths('2026-01', -1)).toBe('2025-12');
        expect(addMonths('2026-11', 14)).toBe('2028-01');
        expect(istMonthKey(istMonthStartMs('2026-03'))).toBe('2026-03');
        expect(istMonthKey(istMonthStartMs('2026-03') - 1)).toBe('2026-02');
    });

    test('legacy bills: en-IN locale date string without timestamp, Firestore Timestamp, unparseable', () => {
        expect(billMonth({ date: '05/03/2025, 2:15:00 pm' })).toBe('2025-03');
        expect(billMonth({ timestamp: { toMillis: () => OCT15 } })).toBe('2026-10');
        expect(billMonth({ date: 'yesterday' })).toBeNull();
    });
});

describe('IST weeks', () => {
    test('weeks start on Monday in IST; a week spanning two years belongs to the year of its Monday', () => {
        expect(istWeekStart(OCT15)).toBe('2026-10-12');                       // Thursday → Monday 12th
        expect(istWeekStart(Date.UTC(2026, 9, 18, 18, 29))).toBe('2026-10-12'); // Sun 23:59 IST
        expect(istWeekStart(Date.UTC(2026, 9, 18, 18, 31))).toBe('2026-10-19'); // Mon 00:01 IST (UTC still Sunday)
        expect(istWeekStart(Date.UTC(2026, 0, 2, 6))).toBe('2025-12-29');
        expect(addWeeks('2025-12-29', 1)).toBe('2026-01-05');
        expect(istDayStartMs('2026-10-19')).toBe(Date.UTC(2026, 9, 18, 18, 30));
    });
});

describe('aggregation (one doc per item per year, weekly + monthly buckets)', () => {
    test('kg-weighted average, min/max, bills; wholesale reads `quantity`; Hindi line names map by itemId', () => {
        const acc = aggregateBills({
            purchase: [
                { id: 'p1', timestamp: OCT15, items: [{ itemId: 'wheat', name: 'गेहूं', rate: 20, qty: 100, total: 2000 }] },
                { id: 'p2', timestamp: OCT15 + 1000, items: [{ itemId: 'wheat', name: 'Wheat', rate: 30, qty: 300, total: 9000 }] }
            ],
            retail: [{ id: 'r1', timestamp: OCT15, items: [{ itemId: 'wheat', name: 'गेहूं', rate: 35, qty: 10 }] }],
            wholesale: [{ id: 'w1', date: '15/10/2026, 11:00:00 am', timestamp: OCT15, items: [{ itemId: 'wheat', name: 'Wheat', rate: 32, quantity: 50 }] }]
        }, items);
        const doc = finalizeStats(acc)['wheat_2026'];
        expect(Object.keys(doc)).toEqual(['itemId', 'year', 'weeks', 'months']);
        const month = doc.months['m2026-10'];
        // (20×100 + 30×300) / 400 = 27.5, not the simple mean 25
        expect(month.purchase).toEqual({ kg: 400, amount: 11000, min: 20, max: 30, avg: 27.5, bills: 2 });
        expect(month.wholesale).toEqual({ kg: 50, amount: 1600, min: 32, max: 32, avg: 32, bills: 1 });
        expect(month.retail.avg).toBe(35);
        expect(month.bills).toBe(4);
        expect(doc.weeks['w2026-10-12']).toEqual(month);
    });

    test('a bill on Fri 2 Jan 2026: month bucket in the 2026 doc, week bucket in the 2025 doc; DD/MM legacy date', () => {
        const docs = billsToYearDocs({ purchase: [{ date: '02/01/2026', items: [{ name: 'Rice', rate: 40, qty: 10 }] }] }, items);
        expect(Object.keys(docs).sort()).toEqual(['rice_2025', 'rice_2026']);
        expect(docs.rice_2025.weeks['w2025-12-29'].purchase.kg).toBe(10);
        expect(docs.rice_2025.months).toEqual({});
        expect(docs.rice_2026.months['m2026-01'].purchase.kg).toBe(10);
        expect(docs.rice_2026.weeks).toEqual({});
    });

    test('legacy lines: no itemId (matched by English or Hindi name), rate from total, junk and deleted bills skipped', () => {
        const acc = {};
        const resolve = createCatalogueResolver(items);
        addBillToAcc(acc, {
            timestamp: OCT15,
            items: [
                { name: 'चावल', qty: '20', total: 600 },       // rate = 30 from total / kg
                { name: 'Rice', rate: 40, qty: 20 },
                { name: 'Rice', rate: 40, qty: 20 },          // same bill: counted once
                { name: 'Unknown', rate: 50, qty: 5 },
                { itemId: 'rice', rate: 0, qty: 5 },
                { itemId: 'rice', rate: 10, qty: 0 },
                null
            ]
        }, 'purchase', resolve);
        expect(addBillToAcc(acc, { deleted: true, timestamp: OCT15, items: [{ itemId: 'rice', rate: 99, qty: 1 }] }, 'purchase', resolve)).toBe(false);
        const doc = finalizeStats(acc)['rice_2026'];
        expect(doc.months['m2026-10'].purchase).toEqual({ kg: 60, amount: 2200, min: 30, max: 40, avg: 36.67, bills: 1 });
        expect(Object.keys(acc)).toEqual(['rice_2026']);
        expect(lineKg({ qty: '', quantity: 7 })).toBe(7);
    });

    test('kinds without lines get empty sections; buckets flatten to sorted lists', () => {
        const docs = Object.entries(finalizeStats(aggregateBills({ purchase: [
            { timestamp: OCT15, items: [{ itemId: 'rice', rate: 30, qty: 1 }] },
            { timestamp: OCT15 + 7 * 86400000, items: [{ itemId: 'rice', rate: 32, qty: 1 }] }
        ] }, items))).map(([id, d]) => ({ id, ...d }));
        expect(docs[0].months['m2026-10'].retail).toEqual({ kg: 0, amount: 0, min: null, max: null, avg: 0, bills: 0 });
        expect(weekBuckets(docs).map(b => b.week)).toEqual(['2026-10-12', '2026-10-19']);
        expect(monthBuckets(docs).map(b => b.month)).toEqual(['2026-10']);
        expect(trendRows(weekBuckets(docs), 'week').map(r => [r.period, r.purchase])).toEqual([['2026-10-12', 30], ['2026-10-19', 32]]);
    });

    test('items by usage: most used first', () => {
        const order = itemsByUsage(items, { purchase: [{ items: [{ itemId: 'rice' }, { itemId: 'rice' }, { itemId: 'wheat' }] }] });
        expect(order.map(o => o.item.id)).toEqual(['rice', 'wheat']);
    });
});

describe('roll-forward', () => {
    test('covered months start at the loaded window when it begins on an IST month start', () => {
        expect(rollForwardFromMonth(istMonthStartMs('2026-09'), OCT15)).toBe('2026-09');
        expect(rollForwardFromMonth(istMonthStartMs('2026-09') + 5, OCT15)).toBe('2026-10');
        expect(rollForwardFromMonth(0, OCT15)).toBe('2026-09');
    });

    test('window: weeks from the week of the first month, unless that week started before the loaded bills', () => {
        // 1 Sep 2026 is a Tuesday: its week starts Mon 31 Aug
        expect(rollForwardWindow(0, OCT15)).toEqual({ fromMonth: '2026-09', fromWeek: '2026-08-31', fromYear: '2026' });
        expect(rollForwardWindow(istMonthStartMs('2026-09'), OCT15).fromWeek).toBe('2026-09-07');
        // In January the window reaches back into last year's doc
        expect(rollForwardWindow(0, Date.UTC(2026, 0, 10, 6)).fromYear).toBe('2025');
    });

    test('replaces only buckets in the window, keeps older ones, drops emptied ones; writes changed docs only', () => {
        const computed = finalizeStats(aggregateBills({
            purchase: [{ timestamp: OCT15, items: [{ itemId: 'wheat', rate: 25, qty: 10 }, { itemId: 'rice', rate: 40, qty: 5 }] }]
        }, items));
        const old = { purchase: { kg: 5, amount: 100, min: 20, max: 20, avg: 20, bills: 1 }, retail: {}, wholesale: {}, bills: 1 };
        const stored = [
            { id: 'wheat_2026', ...computed.wheat_2026, updatedAt: 1 },
            { id: 'rice_2026', itemId: 'rice', year: '2026', weeks: { 'w2026-01-05': old, 'w2026-09-07': old }, months: { 'm2026-01': old, 'm2026-10': old } },
            { id: 'rice_2025', itemId: 'rice', year: '2025', weeks: { 'w2025-03-03': old }, months: {} }
        ];
        const win = { fromMonth: '2026-09', fromWeek: '2026-08-31', fromYear: '2026' };
        const writes = planRollForward(computed, stored, win);
        expect(writes.map(w => w.id)).toEqual(['rice_2026']);
        const rice = writes[0].data;
        expect(Object.keys(rice.weeks)).toEqual(['w2026-01-05', 'w2026-10-12']);
        expect(Object.keys(rice.months)).toEqual(['m2026-01', 'm2026-10']);
        expect(rice.months['m2026-10'].purchase.kg).toBe(5);
        expect(rice.months['m2026-01']).toBe(old);
    });
});

describe('backfill cursor', () => {
    const bills = {
        purchases: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, timestamp: OCT15, items: [{ itemId: 'wheat', rate: 20 + i, qty: 10 }] })),
        retailSales: [{ id: 'r0', timestamp: OCT15, items: [{ itemId: 'wheat', rate: 30, qty: 1 }] }],
        wholesaleSales: []
    };
    const fetchFrom = (failAt = null) => {
        let calls = 0;
        return async (coll, after, limit) => {
            calls++;
            if (failAt && calls === failAt) {
                const e = new Error('Quota exceeded.');
                e.code = 'resource-exhausted';
                throw e;
            }
            const all = bills[coll];
            const start = after ? all.findIndex(b => b.id === after) + 1 : 0;
            const docs = all.slice(start, start + limit);
            return { docs, reads: Math.max(1, docs.length) };
        };
    };
    const quota = (e) => e?.code === 'resource-exhausted';

    test('stops on a quota error and resumes from the stored cursor with the same result as one run', async () => {
        let stored = null;
        const saveCursor = (c) => { stored = JSON.stringify(c); };
        const cursor = newCursor(OCT15);
        const first = await runBackfillReads({ cursor, items, pageSize: 2, fetchPage: fetchFrom(2), saveCursor, isQuotaError: quota, now: () => OCT15 });
        expect(first.status).toBe('quota');
        const resumed = parseCursor(stored);
        expect(resumed.after).toBe('p1');
        expect(resumed.bills).toBe(2);

        const second = await runBackfillReads({ cursor: resumed, items, pageSize: 2, fetchPage: fetchFrom(), saveCursor, isQuotaError: quota, now: () => OCT15 });
        expect(second.status).toBe('read-done');
        expect(resumed.phase).toBe('write');

        const once = newCursor(OCT15);
        await runBackfillReads({ cursor: once, items, pageSize: 2, fetchPage: fetchFrom(), saveCursor: () => {}, isQuotaError: quota, now: () => OCT15 });
        expect(finalizeStats(resumed.acc)).toEqual(finalizeStats(once.acc));
        expect(finalizeStats(once.acc).wheat_2026.months['m2026-10'].purchase.avg).toBe(22);
        expect(resumed.bills).toBe(6);
    });

    test('stops at the daily read budget and continues the next IST day', async () => {
        const cursor = newCursor(OCT15);
        let now = OCT15;
        const r1 = await runBackfillReads({ cursor, items, pageSize: 2, budget: 3, fetchPage: fetchFrom(), saveCursor: () => {}, isQuotaError: quota, now: () => now });
        expect(r1.status).toBe('budget');
        expect(cursor.readsToday).toBe(3);
        const r2 = await runBackfillReads({ cursor, items, pageSize: 2, budget: 3, fetchPage: fetchFrom(), saveCursor: () => {}, isQuotaError: quota, now: () => now });
        expect(r2.status).toBe('budget');
        now = OCT15 + 86400000;
        let r = r2;
        for (let day = 2; r.status !== 'read-done' && day < 10; day++) {
            r = await runBackfillReads({ cursor, items, pageSize: 2, budget: 3, fetchPage: fetchFrom(), saveCursor: () => {}, isQuotaError: quota, now: () => now });
            now += 86400000;
        }
        expect(r.status).toBe('read-done');
        expect(cursor.bills).toBe(6);
    });

    test('a corrupt or old cursor is ignored', () => {
        expect(parseCursor('{bad')).toBeNull();
        expect(parseCursor(JSON.stringify({ v: 1, phase: 'read', acc: {} }))).toBeNull();
    });

    test('read estimate extrapolates the loaded window back to the oldest bill', () => {
        const day = 86400000;
        const now = OCT15;
        expect(estimateBackfillReads({ loadedBills: 300, loadedFrom: now - 30 * day, oldest: now - 900 * day, now })).toBe(9003);
        expect(estimateBackfillReads({ loadedBills: 300, loadedFrom: 0, oldest: 0, now })).toBe(303);
        expect(estimateBackfillReads({ loadedBills: 300, loadedFrom: 0, oldest: 0, now, items: 40 })).toBe(343);
    });
});

describe('seasonal estimate', () => {
    const doc = (month, purchase) => ({ month, purchase: { kg: 100, amount: purchase * 100 }, retail: { kg: 50, amount: (purchase + 5) * 50 } });
    // October → November change in past years; "now" = mid-Oct 2026, 4 weeks ahead ends in November.
    const docs = [doc('2023-10', 20), doc('2023-11', 21), doc('2024-10', 22), doc('2024-11', 22.66), doc('2025-10', 24), doc('2025-11', 25.2)];

    test('UP with high confidence when 3 years agree', () => {
        const o = seasonalOutlook(monthSeries(docs, 'purchase'), { now: OCT15, weeks: 4 });
        expect(o.status).toBe('ok');
        expect(o.fromMonth).toBe('2026-10');
        expect(o.toMonth).toBe('2026-11');
        expect(o.perYear.map(y => y.pct)).toEqual([5, 3, 5]);
        expect(o.direction).toBe('up');
        expect(o.pct).toBe(4.33);
        expect(o.confidence).toBe('high');
        expect(explainOutlook(o, 'en')).toMatch(/UP about 4%; 3 of 3 years agree/);
    });

    test('mixed years lower the confidence; small changes are "about the same"', () => {
        const mixed = monthSeries([doc('2024-10', 20), doc('2024-11', 22), doc('2025-10', 20), doc('2025-11', 19)], 'purchase');
        const o = seasonalOutlook(mixed, { now: OCT15, weeks: 4 });
        expect(o.direction).toBe('up');
        expect(o.confidence).toBe('low');
        const flat = seasonalOutlook(monthSeries([doc('2024-10', 20), doc('2024-11', 20.2), doc('2025-10', 20), doc('2025-11', 19.9)], 'purchase'), { now: OCT15 });
        expect(flat.direction).toBe('flat');
        expect(flat.confidence).toBe('medium');
    });

    test('not enough history with fewer than 2 seasons', () => {
        const o = seasonalOutlook(monthSeries([doc('2025-10', 20), doc('2025-11', 22), doc('2024-10', 20)], 'purchase'), { now: OCT15 });
        expect(o.status).toBe('not-enough');
        expect(o.seasons).toBe(1);
        expect(explainOutlook(o, 'en')).toMatch(/Not enough history/);
    });

    test('8 weeks ahead from late November compares with January across the year end', () => {
        const nov25 = Date.UTC(2026, 10, 25, 6);
        const s = monthSeries([doc('2024-11', 20), doc('2025-01', 22), doc('2025-11', 20), doc('2026-01', 23)], 'purchase');
        const o = seasonalOutlook(s, { now: nov25, weeks: 8 });
        expect(o.toMonth).toBe('2027-01');
        expect(o.perYear.map(y => y.pct)).toEqual([15, 10]);
    });

    test('sale series is kg-weighted across retail and wholesale; table rows carry margin per kg', () => {
        const d = { month: '2026-10', purchase: { kg: 100, amount: 2000 }, retail: { kg: 10, amount: 300 }, wholesale: { kg: 90, amount: 2250 }, bills: 3 };
        expect(monthSeries([d], 'sale')['2026-10']).toBe(25.5);
        const [row] = trendRows([d]);
        expect(row.margin).toBe(5.5);
        expect(row.kgSold).toBe(100);
        expect(yearOverlay({ '2026-10': 20 }, [2026])[2026][9]).toBe(20);
    });
});

describe('seasonal estimate over bills + Items-page rate', () => {
    // Bills average ~20 ₹/kg; the Items-page (first) rate sits ~50% higher. Cutoff in Oct 2025.
    const combined = {
        cutoffMonth: '2025-10',
        bills: { '2023-10': 20, '2023-11': 21, '2024-10': 20, '2024-11': 21, '2025-10': 20 },
        items: { '2025-10': 30, '2025-11': 31.5 }
    };

    test('a level jump at the cutoff is not counted as a seasonal change', () => {
        const now = Date.UTC(2026, 9, 10, 6);
        const o = seasonalOutlookCombined(combined, { now, weeks: 4 });
        expect(o.perYear.map(y => y.pct)).toEqual([5, 5, 5]);
        expect(o.direction).toBe('up');
        expect(o.confidence).toBe('high');
        // naive join (bills before, Items page after) would read +57.5% for 2025
        const naive = seasonalOutlook({ ...combined.bills, '2025-11': 31.5 }, { now, weeks: 4 });
        expect(naive.perYear[0].pct).toBe(57.5);
    });

    test('a change crossing the cutoff is chained through the cutoff month', () => {
        const c = { cutoffMonth: '2025-11', bills: { '2025-10': 20, '2025-11': 22 }, items: { '2025-11': 33, '2025-12': 36.3 } };
        expect(combinedChange(c, '2025-10', '2025-12').ratio).toBeCloseTo(1.1 * 1.1, 10);
        expect(combinedChange(c, '2025-10', '2025-11').ratio).toBeCloseTo(1.1, 10);
        expect(combinedChange({ ...c, bills: {} }, '2025-10', '2025-12')).toBeNull();
    });

    test('before the history is built it is the bills-only estimate', () => {
        const now = Date.UTC(2026, 9, 10, 6);
        const bills = { '2024-10': 20, '2024-11': 21, '2025-10': 20, '2025-11': 22 };
        expect(seasonalOutlookCombined({ bills, items: {}, cutoffMonth: null }, { now, weeks: 4 })).toEqual(seasonalOutlook(bills, { now, weeks: 4 }));
    });
});
