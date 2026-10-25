/**
 * @fileoverview Tests for local (IST) date helpers
 * Timezone is pinned to Asia/Kolkata in jest.config.js.
 */

import {
    todayLocalISO,
    toLocalISODate,
    parseLocalDate,
    parseAnyBillDate,
    startOfLocalDay,
    endOfLocalDayExclusive,
    localISODaysAgo,
    toJsDate,
    formatDateTimeIN
} from '../utils/dates.js';

describe('todayLocalISO (IST)', () => {
    afterEach(() => jest.useRealTimers());

    test('00:30 IST is already the new day (UTC is still previous day)', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-13T19:00:00Z')); // 00:30 IST 14 Oct
        expect(new Date().toISOString().split('T')[0]).toBe('2026-10-13');
        expect(todayLocalISO()).toBe('2026-10-14');
    });

    test('23:59 IST stays on the same day', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-14T18:29:00Z')); // 23:59 IST 14 Oct
        expect(todayLocalISO()).toBe('2026-10-14');
    });

    test('localISODaysAgo crosses month boundary in local time', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-31T19:00:00Z')); // 00:30 IST 1 Nov
        expect(localISODaysAgo(1)).toBe('2026-10-31');
        expect(localISODaysAgo(-1)).toBe('2026-11-02');
    });
});

describe('parseLocalDate', () => {
    test('YYYY-MM-DD is local midnight, not 05:30 IST', () => {
        const d = parseLocalDate('2026-10-14');
        expect(d.getHours()).toBe(0);
        expect(d.getDate()).toBe(14);
        expect(d.toISOString()).toBe('2026-10-13T18:30:00.000Z');
    });

    test('rejects invalid input', () => {
        expect(parseLocalDate('2026-02-31')).toBeNull();
        expect(parseLocalDate('14/10/2026')).toBeNull();
        expect(parseLocalDate(undefined)).toBeNull();
    });
});

describe('parseAnyBillDate', () => {
    test('DD/MM/YYYY with en-IN time', () => {
        const d = parseAnyBillDate('14/10/2026, 7:55:07 pm');
        expect(toLocalISODate(d)).toBe('2026-10-14');
        expect(d.getHours()).toBe(19);
        expect(d.getMinutes()).toBe(55);
    });

    test('DD/MM/YYYY 12 am is midnight and date-only works', () => {
        expect(parseAnyBillDate('01/02/2026, 12:10:00 am').getHours()).toBe(0);
        const d = parseAnyBillDate('05/03/2026');
        expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 5]);
    });

    test('ISO date-only, ISO datetime, epoch ms and Firestore Timestamp', () => {
        expect(parseAnyBillDate('2026-10-14').getHours()).toBe(0);
        expect(parseAnyBillDate('2026-10-13T19:00:00.000Z').getTime()).toBe(Date.UTC(2026, 9, 13, 19));
        expect(parseAnyBillDate(1760382000000).getTime()).toBe(1760382000000);
        expect(parseAnyBillDate('1760382000000').getTime()).toBe(1760382000000);
        const ts = { toDate: () => new Date(Date.UTC(2026, 0, 1)) };
        expect(parseAnyBillDate(ts).getTime()).toBe(Date.UTC(2026, 0, 1));
        expect(parseAnyBillDate({ seconds: 10, nanoseconds: 5e6 }).getTime()).toBe(10005);
    });

    test('invalid values return null', () => {
        expect(parseAnyBillDate('')).toBeNull();
        expect(parseAnyBillDate(null)).toBeNull();
        expect(parseAnyBillDate('not a date')).toBeNull();
    });
});

describe('startOfLocalDay / endOfLocalDayExclusive', () => {
    test('bill at 00:30 IST belongs to that IST day', () => {
        const billIso = '2026-10-13T19:00:00.000Z'; // 00:30 IST 14 Oct
        const start = startOfLocalDay(billIso);
        const end = endOfLocalDayExclusive(billIso);
        expect(toLocalISODate(start)).toBe('2026-10-14');
        expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
        const t = parseAnyBillDate(billIso).getTime();
        expect(t >= start.getTime() && t < end.getTime()).toBe(true);
    });
});

describe('toJsDate / formatDateTimeIN (#114)', () => {
    const ms = new Date(2026, 9, 21, 14, 30).getTime();

    test('handles Timestamp, {seconds}, {_seconds}, ms, ISO and DD-MM strings', () => {
        expect(toJsDate({ toDate: () => new Date(ms) }).getTime()).toBe(ms);
        expect(toJsDate({ seconds: ms / 1000, nanoseconds: 0 }).getTime()).toBe(ms);
        expect(toJsDate({ _seconds: ms / 1000, _nanoseconds: 0 }).getTime()).toBe(ms);
        expect(toJsDate(ms).getTime()).toBe(ms);
        expect(toJsDate(new Date(ms).toISOString()).getTime()).toBe(ms);
        expect(toJsDate('21/10/2026').getDate()).toBe(21);
        const dash = toJsDate('21-10-2026');
        expect([dash.getFullYear(), dash.getMonth(), dash.getDate()]).toEqual([2026, 9, 21]);
    });

    test('never yields "Invalid Date"', () => {
        expect(toJsDate({ foo: 1 })).toBeNull();
        expect(toJsDate('not a date')).toBeNull();
        expect(toJsDate('31-02-2026')).toBeNull();
        expect(formatDateTimeIN({ seconds: ms / 1000 })).not.toMatch(/Invalid/);
        expect(formatDateTimeIN({ seconds: ms / 1000 })).toMatch(/^21 Oct(?: 2026)?, \d{1,2}:\d{2} (am|pm)$/);
        expect(formatDateTimeIN(undefined)).toBe('Unknown');
        expect(formatDateTimeIN('garbage', undefined, '-')).toBe('-');
    });
});