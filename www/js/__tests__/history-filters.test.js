/**
 * @fileoverview #160: History type filter, IST date-range presets, search
 * and the remembered session filter (pure helpers).
 * Timezone is pinned to Asia/Kolkata in jest.config.js.
 */

import {
    billDateOf, billTimeMs, matchesHistoryType, resolveHistoryRange, isBillInRange,
    matchesHistorySearch, filterHistoryBills, normalizeHistoryFilter, formatHistoryRange,
    validateCustomRange, olderMonthsToLoad, normalizeHistoryTab, isWholesaleHistoryLink
} from '../utils/history-filters.js';

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('billDateOf', () => {
    test('prefers the numeric timestamp, then date, then createdAt', () => {
        expect(billTimeMs({ timestamp: 5, date: '01/01/2020' })).toBe(5);
        expect(billTimeMs({ date: '2026-10-21T18:45:00.000Z' })).toBe(Date.UTC(2026, 9, 21, 18, 45));
        expect(billTimeMs({ createdAt: { seconds: 10, nanoseconds: 0 } })).toBe(10000);
        expect(billDateOf({})).toBeNull();
    });

    test('legacy DD/MM/YYYY en-IN dates are day-first', () => {
        expect(billTimeMs({ date: '03/10/2026, 11:30:00 pm' })).toBe(local(2026, 10, 3, 23, 30));
        expect(billTimeMs({ date: '25/12/2025' })).toBe(local(2025, 12, 25));
    });
});

describe('matchesHistoryType', () => {
    const p = { type: 'purchase' };
    const r = { type: 'retail' };
    const w = { type: 'wholesale' };
    test.each([
        ['all', [true, true, true]],
        ['purchase', [true, false, false]],
        ['retail', [false, true, false]],
        ['wholesale', [false, false, true]],
        ['sale', [false, true, false]]
    ])('%s', (type, expected) => {
        expect([p, r, w].map(b => matchesHistoryType(b, type))).toEqual(expected);
    });
});

describe('resolveHistoryRange (IST)', () => {
    // Thursday 22 Oct 2026, 00:30 IST (= 21 Oct 19:00 UTC: a UTC-based day would be wrong)
    const now = new Date(2026, 9, 22, 0, 30);

    test('today / yesterday use local midnight', () => {
        expect(resolveHistoryRange('today', now)).toEqual({ from: local(2026, 10, 22), to: local(2026, 10, 23) });
        expect(resolveHistoryRange('yesterday', now)).toEqual({ from: local(2026, 10, 21), to: local(2026, 10, 22) });
    });

    test('this week starts on Monday (also when today is Sunday)', () => {
        expect(resolveHistoryRange('week', now).from).toBe(local(2026, 10, 19));
        expect(resolveHistoryRange('week', new Date(2026, 9, 25, 21)).from).toBe(local(2026, 10, 19));
        expect(resolveHistoryRange('week', new Date(2026, 9, 19, 0, 1)).from).toBe(local(2026, 10, 19));
    });

    test('this month / last month, across a year boundary', () => {
        expect(resolveHistoryRange('month', now)).toEqual({ from: local(2026, 10, 1), to: local(2026, 11, 1) });
        expect(resolveHistoryRange('lastMonth', now)).toEqual({ from: local(2026, 9, 1), to: local(2026, 10, 1) });
        expect(resolveHistoryRange('lastMonth', new Date(2027, 0, 5))).toEqual({ from: local(2026, 12, 1), to: local(2027, 1, 1) });
    });

    test('custom range is inclusive, swaps reversed dates, allows open ends', () => {
        expect(resolveHistoryRange('custom', now, { from: '2026-10-05', to: '2026-10-01' }))
            .toEqual({ from: local(2026, 10, 1), to: local(2026, 10, 6) });
        expect(resolveHistoryRange('custom', now, { from: '2026-10-05' })).toEqual({ from: local(2026, 10, 5), to: null });
        expect(resolveHistoryRange('custom', now, { from: 'junk', to: '' })).toEqual({ from: null, to: null });
    });

    test('all = unbounded', () => {
        expect(resolveHistoryRange('all', now)).toEqual({ from: null, to: null });
    });
});

describe('isBillInRange', () => {
    const today = resolveHistoryRange('today', new Date(2026, 9, 22, 12));
    test('a bill at 23:59 IST is today, 00:00 next day is not', () => {
        expect(isBillInRange({ timestamp: local(2026, 10, 22, 23, 59) }, today)).toBe(true);
        expect(isBillInRange({ timestamp: local(2026, 10, 23) }, today)).toBe(false);
        expect(isBillInRange({ date: '22/10/2026, 12:05:00 am' }, today)).toBe(true);
        expect(isBillInRange({ date: '21/10/2026, 11:59:00 pm' }, today)).toBe(false);
    });

    test('bills without a date only show for All dates', () => {
        expect(isBillInRange({}, today)).toBe(false);
        expect(isBillInRange({}, { from: null, to: null })).toBe(true);
    });
});

describe('filterHistoryBills', () => {
    const bills = [
        { id: 'a', type: 'purchase', billNumber: 'P1', customerName: 'Ram', timestamp: local(2026, 10, 20), items: [{ name: 'Wheat' }] },
        { id: 'b', type: 'retail', billNumber: 'S1', customerName: 'Shyam', date: '22/10/2026, 9:00:00 am', items: [{ name: 'Rice' }] },
        { id: 'c', type: 'wholesale', billNumber: 'W1', customerName: 'Ram', date: '21/10/2026, 6:00:00 pm', items: [{ name: 'Wheat' }] },
        { id: 'd', type: 'wholesale', billNumber: 'W0', customerName: 'Old', timestamp: local(2026, 8, 1), items: [] }
    ];

    test('type + range + search combine; newest first', () => {
        const thisWeek = resolveHistoryRange('week', new Date(2026, 9, 22, 10));
        expect(filterHistoryBills(bills, { type: 'all', range: thisWeek }).map(b => b.id)).toEqual(['b', 'c', 'a']);
        expect(filterHistoryBills(bills, { type: 'wholesale', range: thisWeek }).map(b => b.id)).toEqual(['c']);
        expect(filterHistoryBills(bills, { type: 'all', range: thisWeek, search: 'wheat' }).map(b => b.id)).toEqual(['c', 'a']);
        expect(filterHistoryBills(bills, { type: 'wholesale' }).map(b => b.id)).toEqual(['c', 'd']);
    });

    test('search matches bill number, customer and item', () => {
        expect(matchesHistorySearch(bills[0], 'p1')).toBe(true);
        expect(matchesHistorySearch(bills[1], 'SHYAM')).toBe(true);
        expect(matchesHistorySearch(bills[1], 'rice')).toBe(true);
        expect(matchesHistorySearch(bills[1], 'wheat')).toBe(false);
        expect(matchesHistorySearch({ id: 12345, items: [{}] }, '123')).toBe(true);
    });
});

describe('normalizeHistoryFilter / formatHistoryRange', () => {
    test('restores a saved filter and rejects junk', () => {
        expect(normalizeHistoryFilter('{"type":"retail","preset":"custom","from":"2026-10-01","to":"bad"}'))
            .toEqual({ type: 'sale', preset: 'custom', from: '2026-10-01', to: '' });
        expect(normalizeHistoryFilter('not json')).toEqual({ type: 'purchase', preset: 'all', from: '', to: '' });
        expect(normalizeHistoryFilter({ type: 'x', preset: 'y' })).toEqual({ type: 'purchase', preset: 'all', from: '', to: '' });
        expect(normalizeHistoryFilter({ preset: 'custom', from: '0202-08-03', to: '1999-12-31' }))
            .toEqual({ type: 'purchase', preset: 'custom', from: '', to: '' });
    });

    test('History tabs are Purchase | Sale; old "all" / "retail" map to them, "wholesale" is a Wholesale-page link', () => {
        expect(['purchase', 'sale', 'retail', 'all', 'wholesale', undefined].map(normalizeHistoryTab))
            .toEqual(['purchase', 'sale', 'sale', 'purchase', 'purchase', 'purchase']);
        expect(isWholesaleHistoryLink('wholesale')).toBe(true);
        expect(isWholesaleHistoryLink('{"type":"wholesale","preset":"all"}')).toBe(true);
        expect(isWholesaleHistoryLink({ type: 'retail' })).toBe(false);
        expect(isWholesaleHistoryLink('not json')).toBe(false);
    });

    test('label uses DD/MM/YYYY and the inclusive end day', () => {
        const now = new Date(2026, 9, 22);
        expect(formatHistoryRange(resolveHistoryRange('today', now))).toBe('22/10/2026');
        expect(formatHistoryRange(resolveHistoryRange('lastMonth', now))).toBe('01/09/2026 – 30/09/2026');
        expect(formatHistoryRange({ from: null, to: null })).toBe('');
    });
});

describe('validateCustomRange / olderMonthsToLoad (quota guard)', () => {
    const now = new Date(2026, 9, 22, 1, 0);
    test('a year being typed (0002 → 0020 → 0202 → 2026) is rejected until complete', () => {
        for (const partial of ['0002-08-03', '0020-08-03', '0202-08-03']) {
            expect(validateCustomRange(partial, '', now).ok).toBe(false);
        }
        expect(validateCustomRange('2026-08-03', '', now)).toEqual({ ok: true, from: '2026-08-03', to: '' });
    });

    test('before 2020, after tomorrow, invalid and empty are rejected with a hint', () => {
        expect(validateCustomRange('2019-12-31', '', now).error).toBe('Dates before 2020 are not allowed');
        expect(validateCustomRange('2020-01-01', '2026-10-23', now).ok).toBe(true);
        expect(validateCustomRange('', '2026-10-24', now).error).toBe('Date is in the future');
        expect(validateCustomRange('2026-02-31', '', now).ok).toBe(false);
        expect(validateCustomRange('', '', now).ok).toBe(false);
    });

    test('months older than the loaded window', () => {
        const window = local(2026, 9, 1);
        expect(olderMonthsToLoad(local(2026, 9, 15), window)).toBe(0);
        expect(olderMonthsToLoad(local(2026, 8, 20), window)).toBe(1);
        expect(olderMonthsToLoad(local(2026, 1, 1), window)).toBe(8);
        expect(olderMonthsToLoad(local(2020, 1, 1), 0)).toBe(0);
    });
});