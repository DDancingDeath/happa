/**
 * @fileoverview Local-time date helpers.
 * The business runs in IST, so "today" and day boundaries must use the
 * device's local calendar day, never UTC (toISOString() / new Date('YYYY-MM-DD')
 * are UTC-based and shift the day by 5h30m in India).
 * @module utils/dates
 */

import { getLang, t } from '../i18n/index.js';

/** Locale for dates on screen: Hindi month and day names in Hindi mode (#143). */
export const displayLocale = () => (getLang() === 'hi' ? 'hi-IN' : 'en-IN');

const pad2 = (n) => String(n).padStart(2, '0');

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// DD/MM/YYYY with optional ", h:mm[:ss] [am|pm]" (en-IN toLocaleString output)
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?\s*$/i;

/**
 * Format a Date as YYYY-MM-DD using local calendar fields.
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function toLocalISODate(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Today's date as YYYY-MM-DD in device local time.
 * @returns {string}
 */
export function todayLocalISO() {
    return toLocalISODate(new Date());
}

/**
 * Parse 'YYYY-MM-DD' as local midnight (not UTC midnight).
 * @param {string} str
 * @returns {Date|null}
 */
export function parseLocalDate(str) {
    if (typeof str !== 'string') return null;
    const m = ISO_DATE_ONLY.exec(str.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Reject overflow like 2024-02-31
    if (d.getMonth() !== Number(m[2]) - 1) return null;
    return d;
}

/**
 * Parse any date shape found on bills/expenses/sessions:
 * Firestore Timestamp, Date, epoch ms, 'YYYY-MM-DD' (local midnight),
 * ISO datetime, and en-IN 'DD/MM/YYYY[, h:mm:ss am]' strings.
 * Aligned with Helpers.parseDate, plus date-only and epoch support.
 * @param {*} value
 * @returns {Date|null}
 */
export function parseAnyBillDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'object') {
        if (typeof value.toDate === 'function') return value.toDate();
        if (typeof value.seconds === 'number') {
            return new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6));
        }
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? new Date(value) : null;
    }
    if (typeof value !== 'string') return null;

    const str = value.trim();
    if (/^\d{10,}$/.test(str)) return new Date(Number(str));

    const localDay = parseLocalDate(str);
    if (localDay) return localDay;

    const m = DMY.exec(str);
    if (m) {
        let hours = m[4] ? parseInt(m[4], 10) : 0;
        const period = m[7] ? m[7].toLowerCase() : null;
        if (period === 'pm' && hours !== 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;
        return new Date(
            parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10),
            hours, m[5] ? parseInt(m[5], 10) : 0, m[6] ? parseInt(m[6], 10) : 0
        );
    }

    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Local midnight at the start of the day containing `value`.
 * @param {*} [value=new Date()] Anything parseAnyBillDate accepts
 * @returns {Date|null}
 */
export function startOfLocalDay(value = new Date()) {
    const d = parseAnyBillDate(value);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Exclusive end of the local day containing `value` (next local midnight).
 * @param {*} [value=new Date()]
 * @returns {Date|null}
 */
export function endOfLocalDayExclusive(value = new Date()) {
    const start = startOfLocalDay(value);
    if (!start) return null;
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
}

/**
 * Local midnight `days` days after the day containing `value` (negative =
 * before). Calendar days, so a month end or 29 Feb is stepped over correctly.
 * @param {*} value Anything parseAnyBillDate accepts
 * @param {number} days
 * @returns {Date|null}
 */
export function addLocalDays(value, days) {
    const start = startOfLocalDay(value);
    if (!start) return null;
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
}

/**
 * Number of days in the local month containing `value` (28–31).
 * @param {*} value
 * @returns {number} NaN when there is no usable date
 */
export function daysInMonth(value) {
    const d = parseAnyBillDate(value);
    if (!d) return NaN;
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Local midnight on the 1st of the month `months` after the month of `value`
 * (0 = its own month, -1 = the month before). Steps whole months from the 1st,
 * so 31 Jan − 1 is 1 Dec and 31 Mar − 1 is 1 Feb.
 * @param {*} [value=new Date()]
 * @param {number} [months=0]
 * @returns {Date|null}
 */
export function monthStart(value = new Date(), months = 0) {
    const d = parseAnyBillDate(value);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth() + months, 1);
}

/**
 * The same local date and time `months` later (negative = earlier), clipped to
 * the last day of the target month: 31 Jan + 1 → 28 Feb (29 Feb in a leap
 * year), 29 Feb + 12 → 28 Feb, 31 Mar − 1 → 28/29 Feb.
 * @param {*} value
 * @param {number} months
 * @returns {Date|null}
 */
export function addMonths(value, months) {
    const d = parseAnyBillDate(value);
    if (!d) return null;
    const first = monthStart(d, months);
    const day = Math.min(d.getDate(), daysInMonth(first));
    return new Date(first.getFullYear(), first.getMonth(), day, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/**
 * [from, to) in ms of the local month `months` after the month of `value`.
 * @param {*} [value=new Date()]
 * @param {number} [months=0]
 * @returns {?{from: number, to: number}}
 */
export function monthRange(value = new Date(), months = 0) {
    const from = monthStart(value, months);
    if (!from) return null;
    return { from: from.getTime(), to: monthStart(from, 1).getTime() };
}

/**
 * The 1st of calendar month `monthIndex` (0 = Jan) on or before the month of
 * `now`: this year when that month has started, else last year (a tap on
 * "Dec" in January opens last December).
 * @param {number} monthIndex 0–11
 * @param {*} [now=new Date()]
 * @returns {Date|null}
 */
export function latestMonthStart(monthIndex, now = new Date()) {
    const d = parseAnyBillDate(now);
    if (!d) return null;
    return new Date(monthIndex > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear(), monthIndex, 1);
}

/**
 * First and last local day (YYYY-MM-DD) of the period [from, to) (ms; `to`
 * exclusive). A period shorter than a day has the same first and last day.
 * @param {number} from
 * @param {number} to
 * @returns {{first: string, last: string}}
 */
export function periodBounds(from, to) {
    return { first: toLocalISODate(new Date(from)), last: toLocalISODate(new Date(Math.max(from, to - 1))) };
}

/**
 * Local YYYY-MM-DD of every day the period [from, to) touches, oldest first
 * (each local midnight after `from` starts the next day).
 * @param {number} from ms
 * @param {number} to ms, exclusive
 * @returns {string[]}
 */
export function localDayKeys(from, to) {
    const keys = [];
    const end = new Date(to - 1);
    for (let x = new Date(from); x <= end; x = new Date(x.getFullYear(), x.getMonth(), x.getDate() + 1)) keys.push(toLocalISODate(x));
    return keys;
}

/**
 * Exclusive end of a period, never past `now` (now itself included).
 * @param {number} to ms, exclusive
 * @param {Date|number} [now=Date.now()]
 * @returns {number}
 */
export function endUpToNow(to, now = Date.now()) {
    return Math.min(to, Number(now) + 1);
}

/**
 * Local YYYY-MM-DD for `daysAgo` days before today.
 * @param {number} daysAgo
 * @returns {string}
 */
export function localISODaysAgo(daysAgo) {
    const now = new Date();
    return toLocalISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo));
}

const DMY_DASH = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

/**
 * Convert any stored timestamp shape to a valid Date, or null.
 * Handles Firestore Timestamp, {seconds}/{_seconds} objects, epoch ms,
 * ISO strings, DD/MM/YYYY and DD-MM-YYYY. `new Date(timestamp)` on a
 * Firestore Timestamp gives "Invalid Date".
 * @param {*} value
 * @returns {Date|null}
 */
export function toJsDate(value) {
    if (value && typeof value === 'object' && !(value instanceof Date) &&
        typeof value.toDate !== 'function' && typeof value.seconds !== 'number' &&
        typeof value._seconds === 'number') {
        value = { seconds: value._seconds, nanoseconds: value._nanoseconds || 0 };
    }
    if (typeof value === 'string') {
        const m = DMY_DASH.exec(value.trim());
        if (m) {
            const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
            return d.getMonth() === Number(m[2]) - 1 ? d : null;
        }
    }
    const d = parseAnyBillDate(value);
    return d && !isNaN(d.getTime()) ? d : null;
}

/**
 * Date/time text for any timestamp shape (the app's formatDayTime unless Intl
 * `options` are given), or `fallback` when unparseable.
 * @param {*} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @param {string} [fallback='Unknown']
 * @returns {string}
 */
export function formatDateTimeIN(value, options, fallback = t('ui.reports.unknown')) {
    const d = toJsDate(value);
    if (!d) return fallback;
    return options ? d.toLocaleString(displayLocale(), options) : formatDayTime(d, { lang: getLang() });
}

const MONTHS = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    hi: ['जन॰', 'फ़र॰', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुल॰', 'अग॰', 'सित॰', 'अक्तू॰', 'नव॰', 'दिस॰']
};
const DAY_HALF = { en: ['am', 'pm'], hi: ['पूर्वाह्न', 'अपराह्न'] };
const langOf = (lang) => (lang === 'hi' ? 'hi' : 'en');

/**
 * The app's one date format: "25 Oct 2026" (Hindi month names in Hindi).
 * @param {*} value anything toJsDate accepts
 * @param {{lang?: string, year?: boolean}} [opts] year: false drops the year ("25 Oct")
 * @returns {string} '' when there is no usable date
 */
export function formatDay(value, { lang = 'en', year = true } = {}) {
    const d = toJsDate(value);
    if (!d) return '';
    const day = `${d.getDate()} ${MONTHS[langOf(lang)][d.getMonth()]}`;
    return year ? `${day} ${d.getFullYear()}` : day;
}

/**
 * Month and year: "Oct 2026" (Hindi month names in Hindi).
 * @param {*} value anything toJsDate accepts
 * @param {{lang?: string, year?: boolean}} [opts]
 * @returns {string}
 */
export function formatMonth(value, { lang = 'en', year = true } = {}) {
    const d = toJsDate(value);
    if (!d) return '';
    const m = MONTHS[langOf(lang)][d.getMonth()];
    return year ? `${m} ${d.getFullYear()}` : m;
}

/**
 * Time of day: "8:59 pm" / "8:59 अपराह्न".
 * @param {*} value
 * @param {{lang?: string}} [opts]
 * @returns {string}
 */
export function formatTimeOfDay(value, { lang = 'en' } = {}) {
    const d = toJsDate(value);
    if (!d) return '';
    const h = d.getHours();
    return `${h % 12 || 12}:${pad2(d.getMinutes())} ${DAY_HALF[langOf(lang)][h >= 12 ? 1 : 0]}`;
}

/**
 * The app's one date-and-time format: "25 Oct, 8:59 pm" (the year is added
 * when it is not the current year: "25 Oct 2025, 8:59 pm").
 * @param {*} value
 * @param {{lang?: string, now?: Date}} [opts]
 * @returns {string}
 */
export function formatDayTime(value, { lang = 'en', now = new Date() } = {}) {
    const d = toJsDate(value);
    if (!d) return '';
    return `${formatDay(d, { lang, year: d.getFullYear() !== now.getFullYear() })}, ${formatTimeOfDay(d, { lang })}`;
}
