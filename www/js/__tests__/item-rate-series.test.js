import {
    BASE_RATE_INDEX, baseRate, dailyRates, itemRateSeries, mergeHistoryEntries, monthlyStepAverage, rateChangeRows,
    rateSteps, weeklyStepAverage
} from '../utils/item-rate-series.js';
import { historyDocId } from '../utils/rate-history.js';

const IST = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 330 * 60000;
const entry = (field, old, nu, at, seq = 0, index) => ({ id: historyDocId('wheat', at, seq), field, old, new: nu, at, ...(index === undefined ? {} : { index }) });

describe('base rate', () => {
    test('is the first valid rate in the list', () => {
        expect(BASE_RATE_INDEX).toBe(0);
        expect(baseRate([28, 30])).toBe(28);
        expect(baseRate(['', 0, '27'])).toBe(27);
        expect(baseRate([])).toBeNull();
        expect(baseRate(undefined)).toBeNull();
    });
});

describe('step series rebuilt from the current list and history entries', () => {
    const T1 = IST(2026, 10, 5, 10);
    const T2 = IST(2026, 10, 12, 9);

    test('inline change, then one save that adds a rate and changes the first', () => {
        // [25] → (T1) [26] → (T2) [28, 30]
        const entries = [
            entry('purchase', 26, 28, T2, 0), entry('purchase', null, 30, T2, 1),
            entry('purchase', 25, 26, T1), entry('retail', 40, 41, T1), entry('name', 'Gehu', 'Wheat', T1, 1)
        ];
        expect(rateSteps([28, 30], entries, 'purchase')).toEqual([
            { at: -Infinity, rate: 25 }, { at: T1, rate: 26 }, { at: T2, rate: 28 }
        ]);
        expect(rateSteps([41], entries, 'retail')).toEqual([{ at: -Infinity, rate: 40 }, { at: T1, rate: 41 }]);
    });

    test('list positions: deleting the first rate makes the next one the base', () => {
        // [20, 22] → (T1) delete 20 at 0 → [22] ; (T2) 25 added at 1 → [22, 25]
        const entries = [entry('wholesale', null, 25, T2, 0, 1), entry('wholesale', 20, null, T1, 0, 0)];
        expect(rateSteps([22, 25], entries, 'wholesale')).toEqual([{ at: -Infinity, rate: 20 }, { at: T1, rate: 22 }]);
    });

    test('list positions: a value that already exists elsewhere makes no fake step', () => {
        // [10, 12] → (T1) second rate 12 → 10 → [10, 10]: base stays 10
        expect(rateSteps([10, 10], [entry('purchase', 12, 10, T1, 0, 1)], 'purchase')).toEqual([{ at: -Infinity, rate: 10 }]);
        // older entries without a position fall back to the first equal value
        expect(rateSteps([10, 10], [entry('purchase', 12, 10, T1)], 'purchase')).toEqual([{ at: -Infinity, rate: 12 }, { at: T1, rate: 10 }]);
    });

    test('older entries without a position: a removed rate goes back at the end', () => {
        expect(rateSteps([22], [entry('wholesale', 20, null, T1)], 'wholesale')).toEqual([{ at: -Infinity, rate: 22 }]);
    });

    test('blank slots on the Items page keep inline positions aligned', () => {
        // ['', 30] → (T1) blank slot 0 filled with 28 → [28, 30]
        expect(rateSteps([28, 30], [entry('retail', null, 28, T1, 0, 0)], 'retail')).toEqual([{ at: -Infinity, rate: 30 }, { at: T1, rate: 28 }]);
    });

    test('no entries (history not readable): the current rate throughout', () => {
        expect(rateSteps([31, 33], [], 'purchase')).toEqual([{ at: -Infinity, rate: 31 }]);
    });
});

describe('time-weighted averages of the daily step rate', () => {
    const cutoff = IST(2026, 10, 1, 0, 0);
    const steps = [{ at: -Infinity, rate: 20 }, { at: IST(2026, 10, 11, 10), rate: 30 }];
    const end = IST(2026, 10, 31, 23);

    test('a day takes the rate set by its end (IST days)', () => {
        const days = dailyRates(steps, cutoff, end);
        expect(days).toHaveLength(31);
        expect(days[9]).toEqual({ day: '2026-10-10', rate: 20 });
        expect(days[10]).toEqual({ day: '2026-10-11', rate: 30 });
    });

    test('monthly: 10 days at ₹20 and 21 days at ₹30 → ₹26.77', () => {
        expect(monthlyStepAverage(steps, cutoff, end)).toEqual({ '2026-10': 26.77 });
    });

    test('weekly (Monday–Sunday), from the cutoff day only', () => {
        const w = weeklyStepAverage(steps, cutoff, end);
        expect(w['2026-09-28']).toBe(20);              // Thu 1 – Sun 4 Oct only
        expect(w['2026-10-05']).toBe(21.43);           // 6 days at 20, Sun 11th at 30
        expect(w['2026-10-12']).toBe(30);
        expect(Object.keys(w)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    });

    test('item series for every rate type; change rows newest first', () => {
        const at = IST(2026, 10, 20, 12);
        const item = { id: 'wheat', rates: [24, 26], wholesaleRates: [27], saleRates: [] };
        const s = itemRateSeries(item, [entry('purchase', 22, 24, at), entry('purchase', 21, 22, cutoff - 1)], { cutoffMs: cutoff, now: end });
        expect(s.purchase.steps).toEqual([{ at: -Infinity, rate: 22 }, { at, rate: 24 }]);
        expect(s.purchase.current).toBe(24);
        expect(s.wholesale.monthly).toEqual({ '2026-10': 27 });
        expect(s.retail.monthly).toEqual({});
        expect(rateChangeRows(s)).toEqual([{ at, kind: 'purchase', from: 22, to: 24 }]);
    });
});

test('cached and new history entries merge by id, newest first', () => {
    const a = entry('purchase', 1, 2, 100);
    const b = entry('purchase', 2, 3, 200);
    expect(mergeHistoryEntries([a], [b, a]).map(e => e.at)).toEqual([200, 100]);
});
