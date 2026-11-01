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
    formatDateTimeIN,
    addLocalDays,
    daysInMonth,
    monthStart,
    addMonths,
    monthRange,
    latestMonthStart,
    periodBounds,
    localDayKeys,
    endUpToNow,
    displayLocale,
    formatDay,
    formatMonth,
    formatTimeOfDay,
    formatDayTime
} from '../utils/dates.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const day = (d) => toLocalISODate(d);

describe('calendar steps (IST month ends and leap years)', () => {
    test('addMonths keeps the date and time, clipped to the target month', () => {
        expect(addMonths(at(2027, 1, 31, 15, 30), 1)).toEqual(at(2027, 2, 28, 15, 30));
        expect(addMonths(at(2028, 1, 31), 1)).toEqual(at(2028, 2, 29));
        expect(addMonths(at(2028, 2, 29), 12)).toEqual(at(2029, 2, 28));
        expect(addMonths(at(2027, 3, 31), -1)).toEqual(at(2027, 2, 28));
        expect(addMonths(at(2028, 3, 31), -1)).toEqual(at(2028, 2, 29));
        expect(addMonths(at(2027, 1, 1), -1)).toEqual(at(2026, 12, 1));
        expect(addMonths(at(2026, 12, 31), 2)).toEqual(at(2027, 2, 28));
        expect(addMonths('31/01/2027', 1)).toEqual(at(2027, 2, 28));
        expect(addMonths('not a date', 1)).toBeNull();
    });

    test('monthStart steps whole months from the 1st (no 31st overflow)', () => {
        expect(monthStart(at(2027, 1, 31, 15), 1)).toEqual(at(2027, 2, 1));
        expect(monthStart(at(2027, 3, 31), -1)).toEqual(at(2027, 2, 1));
        expect(monthStart(at(2027, 1, 1, 9), -1)).toEqual(at(2026, 12, 1));
        expect(monthStart(at(2026, 12, 15), 1)).toEqual(at(2027, 1, 1));
        expect(monthStart(at(2027, 1, 1), -13)).toEqual(at(2025, 12, 1));
        expect(monthStart(at(2028, 2, 29))).toEqual(at(2028, 2, 1));
        expect(monthStart(null)).toBeNull();
    });

    test('daysInMonth and monthRange know leap February', () => {
        expect([daysInMonth(at(2028, 2, 10)), daysInMonth(at(2027, 2, 10)), daysInMonth(at(2027, 1, 31)), daysInMonth(at(2027, 4, 1))]).toEqual([29, 28, 31, 30]);
        expect(daysInMonth('')).toBeNaN();
        expect(monthRange(at(2028, 2, 29, 12))).toEqual({ from: at(2028, 2, 1).getTime(), to: at(2028, 3, 1).getTime() });
        expect(monthRange(at(2027, 1, 1), -1)).toEqual({ from: at(2026, 12, 1).getTime(), to: at(2027, 1, 1).getTime() });
        expect(monthRange(undefined, 0)).toEqual(monthRange(new Date()));
        expect(monthRange('x')).toBeNull();
    });

    test('addLocalDays crosses month and year ends at local midnight', () => {
        expect(addLocalDays(at(2028, 3, 1, 10), -1)).toEqual(at(2028, 2, 29));
        expect(addLocalDays(at(2028, 2, 29, 12), -30)).toEqual(at(2028, 1, 30));
        expect(addLocalDays(at(2026, 12, 31, 23, 59), 1)).toEqual(at(2027, 1, 1));
        expect(addLocalDays('nope', 1)).toBeNull();
    });

    test('latestMonthStart: a month not started yet this year is last year\'s', () => {
        expect(latestMonthStart(11, at(2027, 1, 1))).toEqual(at(2026, 12, 1));
        expect(latestMonthStart(0, at(2027, 1, 31))).toEqual(at(2027, 1, 1));
        expect(latestMonthStart(1, at(2028, 2, 29))).toEqual(at(2028, 2, 1));
        expect(latestMonthStart(2, at(2028, 2, 29))).toEqual(at(2027, 3, 1));
        expect(latestMonthStart(0, null)).toBeNull();
    });

    test('periodBounds, localDayKeys and endUpToNow', () => {
        const feb = monthRange(at(2028, 2, 1));
        expect(periodBounds(feb.from, feb.to)).toEqual({ first: '2028-02-01', last: '2028-02-29' });
        expect(periodBounds(feb.from, feb.from)).toEqual({ first: '2028-02-01', last: '2028-02-01' });
        const keys = localDayKeys(feb.from, feb.to);
        expect([keys.length, keys[0], keys[28]]).toEqual([29, '2028-02-01', '2028-02-29']);
        expect(localDayKeys(at(2027, 3, 31, 18).getTime(), at(2027, 4, 2, 1).getTime())).toEqual(['2027-03-31', '2027-04-01', '2027-04-02']);
        expect(localDayKeys(at(2027, 1, 1).getTime(), at(2027, 1, 1).getTime())).toEqual([]);
        const now = at(2027, 1, 31, 15, 30);
        expect(endUpToNow(at(2027, 2, 1).getTime(), now)).toBe(now.getTime() + 1);
        expect(endUpToNow(at(2027, 1, 1).getTime(), now)).toBe(at(2027, 1, 1).getTime());
        expect(day(new Date(endUpToNow(Infinity, now.getTime()) - 1))).toBe('2027-01-31');
    });
});

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

describe('formatters and parse edge cases (#160: mutation score of dates.js)', () => {
    afterEach(() => { setLang('en'); resetLangForTests(); });
    const d = new Date(2026, 9, 25, 20, 59);

    test('displayLocale and formatDateTimeIN follow the app language', () => {
        expect(displayLocale()).toBe('en-IN');
        expect(formatDateTimeIN(d)).toMatch(/^25 Oct, 8:59 pm$|^25 Oct 2026, 8:59 pm$/);
        setLang('hi');
        expect(displayLocale()).toBe('hi-IN');
        expect(formatDateTimeIN(d)).toMatch(/अक्तू॰.*8:59 अपराह्न$/);
        expect(formatDateTimeIN('junk', undefined, '—')).toBe('—');
    });

    test('formatDay, formatMonth, formatTimeOfDay, formatDayTime in both languages', () => {
        expect(formatDay(d)).toBe('25 Oct 2026');
        expect(formatDay(d, { year: false })).toBe('25 Oct');
        expect(formatDay(d, { lang: 'hi' })).toBe('25 अक्तू॰ 2026');
        expect(formatDay('junk')).toBe('');
        expect(formatMonth(d)).toBe('Oct 2026');
        expect(formatMonth(d, { year: false })).toBe('Oct');
        expect(formatMonth(new Date(2026, 1, 3), { lang: 'hi' })).toBe('फ़र॰ 2026');
        expect(formatMonth(null)).toBe('');
        expect(formatTimeOfDay(d)).toBe('8:59 pm');
        expect(formatTimeOfDay(d, { lang: 'hi' })).toBe('8:59 अपराह्न');
        expect(formatTimeOfDay(new Date(2026, 9, 25, 0, 5))).toBe('12:05 am');
        expect(formatTimeOfDay(new Date(2026, 9, 25, 0, 5), { lang: 'hi' })).toBe('12:05 पूर्वाह्न');
        expect(formatTimeOfDay(new Date(2026, 9, 25, 12, 0))).toBe('12:00 pm');
        expect(formatTimeOfDay(new Date(2026, 9, 25, 11, 7))).toBe('11:07 am');
        expect(formatTimeOfDay(undefined)).toBe('');
        expect(formatDayTime(d, { now: new Date(2026, 0, 1) })).toBe('25 Oct, 8:59 pm');
        expect(formatDayTime(d, { now: new Date(2027, 0, 1) })).toBe('25 Oct 2026, 8:59 pm');
        expect(formatDayTime(d, { lang: 'hi', now: new Date(2026, 0, 1) })).toBe('25 अक्तू॰, 8:59 अपराह्न');
        expect(formatDayTime('junk')).toBe('');
    });

    test('parseLocalDate and parseAnyBillDate: trimming, anchors, epoch strings, am/pm', () => {
        expect(parseLocalDate(' 2026-10-21 ')).toEqual(new Date(2026, 9, 21));
        expect(parseLocalDate('x2026-10-21')).toBeNull();
        expect(parseLocalDate('2026-10-21x')).toBeNull();
        expect(parseLocalDate(20261021)).toBeNull();
        ['', null, undefined, {}, true].forEach(v => expect(parseAnyBillDate(v)).toBeNull());
        expect(parseAnyBillDate({ seconds: 10, nanoseconds: 5e6 }).getTime()).toBe(10005);
        expect(parseAnyBillDate({ seconds: 10 }).getTime()).toBe(10000);
        expect(parseAnyBillDate(' 1792663200000 ').getTime()).toBe(1792663200000);
        expect(parseAnyBillDate('x1792663200000')).toBeNull();
        expect(parseAnyBillDate('1792663200000x')).toBeNull();
        expect(parseAnyBillDate(NaN)).toBeNull();
        expect(parseAnyBillDate(new Date(NaN))).toBeNull();
        expect(parseAnyBillDate(' 21/10/2026 ')).toEqual(new Date(2026, 9, 21));
        expect(parseAnyBillDate('21/10/2026, 12:30 am')).toEqual(new Date(2026, 9, 21, 0, 30));
        expect(parseAnyBillDate('21/10/2026, 12:30 pm')).toEqual(new Date(2026, 9, 21, 12, 30));
        expect(parseAnyBillDate('21/10/2026 9:05 PM')).toEqual(new Date(2026, 9, 21, 21, 5));
        expect(parseAnyBillDate('21/10/2026, 9:05:07 am')).toEqual(new Date(2026, 9, 21, 9, 5, 7));
        expect(parseAnyBillDate('21/10/2026,9:05')).toEqual(new Date(2026, 9, 21, 9, 5));
        expect(parseAnyBillDate('21/10/2026, 11:15')).toEqual(new Date(2026, 9, 21, 11, 15));
        expect(parseAnyBillDate('x21/10/2026')).toBeNull();
        expect(startOfLocalDay('junk')).toBeNull();
        expect(endOfLocalDayExclusive('junk')).toBeNull();
        expect(addLocalDays('junk', 1)).toBeNull();
    });

    test('toJsDate: {_seconds}, DD-MM-YYYY (trimmed, no overflow), invalid dates', () => {
        expect(toJsDate({ _seconds: 10, _nanoseconds: 2e6 }).getTime()).toBe(10002);
        expect(toJsDate({ _seconds: 10 }).getTime()).toBe(10000);
        expect(toJsDate({ seconds: 5, _seconds: 99 }).getTime()).toBe(5000);
        expect(toJsDate({ toDate: () => new Date(7), _seconds: 99 }).getTime()).toBe(7);
        expect(toJsDate({ toDate: () => new Date(NaN) })).toBeNull();
        expect(toJsDate(' 21-10-2026 ')).toEqual(new Date(2026, 9, 21));
        expect(toJsDate('31-02-2026')).toBeNull();
        expect(toJsDate('x21-10-2026')).toBeNull();
        expect(toJsDate('21-10-2026x')).toBeNull();
        expect(toJsDate(null)).toBeNull();
    });

    test('localDayKeys includes the day of the last instant before `to`', () => {
        const from = new Date(2026, 9, 21).getTime();
        expect(localDayKeys(from, new Date(2026, 9, 23).getTime())).toEqual(['2026-10-21', '2026-10-22']);
        expect(localDayKeys(from, new Date(2026, 9, 23).getTime() + 1)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
        expect(localDayKeys(from, from + 1)).toEqual(['2026-10-21']);
    });
});