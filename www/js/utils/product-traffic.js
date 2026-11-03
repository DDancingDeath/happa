// @ts-check
/**
 * @fileoverview Product traffic (#65): how much of each item moved in a month
 * (month buckets of the per-item-year rateStats docs), one item week by week
 * (week buckets) and, for one item, day by day within a month (from bills
 * already loaded on the device — no extra reads). Pure.
 * @module utils/product-traffic
 */

import {
    RATE_KINDS, addMonths, addWeeks, createCatalogueResolver, istDayKey, istMonthKey, istMonthStartMs, istWeekStart,
    lineKg, lineRate, monthBuckets, rollForwardWindow
} from './rate-trends.js';
import { eventTime } from './stock-replay.js';
import { isActiveBill } from './money.js';

export const TRAFFIC_KINDS = ['purchase', 'wholesale', 'retail'];

/** @typedef {{kg: number, bills: number}} KgBills */

const round2 = (/** @type {*} */ n) => Math.round((Number(n) || 0) * 100) / 100;

const section = (/** @type {?Rec|undefined} */ doc, /** @type {string} */ kind) => ({
    kg: round2(doc?.[kind]?.kg),
    bills: Number(doc?.[kind]?.bills) || 0,
    amount: round2(doc?.[kind]?.amount)
});

const movedKg = (/** @type {?Rec|undefined} */ doc) => round2(TRAFFIC_KINDS.reduce((s, k) => s + (Number(doc?.[k]?.kg) || 0), 0));

/**
 * % change from `before` to `now`, or null when there is nothing to compare with.
 * @param {number} now
 * @param {number} before
 * @returns {?number}
 */
export function pctChange(now, before) {
    return before > 0 ? round2((now / before - 1) * 100) : null;
}

/**
 * One row per item that moved in the month, most kg first.
 * kg moved = purchase + wholesale + retail kg; amount = Σ line kg × rate.
 * @param {Array<Rec>} docs month buckets of the month (monthBucketsFor())
 * @param {?Array<Rec>} [prevDocs] previous month
 * @param {?Array<Rec>} [lastYearDocs] same month last year
 * @returns {Array<Rec>}
 */
export function trafficRows(docs, prevDocs = null, lastYearDocs = null) {
    const kgById = (/** @type {Array<Rec>} */ list) => {
        /** @type {Map<string, number>} */
        const m = new Map();
        (list || []).forEach(d => { if (d?.itemId) m.set(d.itemId, movedKg(d)); });
        return m;
    };
    const prev = prevDocs ? kgById(prevDocs) : null;
    const lastYear = lastYearDocs ? kgById(lastYearDocs) : null;
    return (docs || [])
        .filter(d => d && d.itemId && movedKg(d) > 0)
        .map(d => {
            /** @type {Rec} */
            const row = { itemId: d.itemId, month: d.month, kg: movedKg(d), bills: Number(d.bills) || 0 };
            TRAFFIC_KINDS.forEach(k => { row[k] = section(d, k); });
            row.amount = round2(TRAFFIC_KINDS.reduce((s, k) => s + row[k].amount, 0));
            row.vsPrev = prev ? pctChange(row.kg, prev.get(d.itemId) || 0) : null;
            row.vsLastYear = lastYear ? pctChange(row.kg, lastYear.get(d.itemId) || 0) : null;
            return row;
        })
        .sort((a, b) => (b.kg - a.kg) || (a.itemId < b.itemId ? -1 : 1));
}

/**
 * Months a month overview compares with.
 * @param {string} month 'YYYY-MM'
 * @returns {{prev: ?string, lastYear: ?string}} null for an unreadable month
 */
export function comparisonMonths(month) {
    return { prev: addMonths(month, -1), lastYear: addMonths(month, -12) };
}

/**
 * Last `n` IST months, newest first.
 * @param {*} now
 * @param {number} [n]
 * @returns {Array<?string>}
 */
export function recentMonths(now, n = 24) {
    const current = istMonthKey(now);
    return Array.from({ length: n }, (_, i) => addMonths(current, -i));
}

/**
 * True when every bill of the month is in the loaded history window
 * (loadedFrom 0 = all history loaded).
 * @param {string} month 'YYYY-MM'
 * @param {*} loadedFrom
 * @returns {boolean}
 */
export function dailyDetailAvailable(month, loadedFrom) {
    if (!(Number(loadedFrom) > 0)) return true;
    return istMonthStartMs(month) >= Number(loadedFrom);
}

/**
 * Month buckets of one month from year docs.
 * @param {?Array<Rec>|undefined} yearDocs
 * @param {string} month 'YYYY-MM'
 * @returns {Array<Rec>}
 */
export function monthBucketsFor(yearDocs, month) {
    return monthBuckets(yearDocs).filter(b => b.month === month);
}

/**
 * Year docs that can be kept on the device: no bucket of the year can still
 * change in a roll-forward (all its weeks and months are before the window).
 * @param {*} year
 * @param {*} now
 * @returns {boolean}
 */
export function isSettledYear(year, now) {
    return String(year) < rollForwardWindow(0, now).fromYear;
}

/**
 * One item week by week (newest first) for the weeks from `fromWeek` to
 * `toWeek`; weeks without bills show 0.
 * @param {?Array<Rec>|undefined} buckets weekBuckets() of the item
 * @param {?string} fromWeek Monday 'YYYY-MM-DD'
 * @param {string} toWeek
 * @returns {Array<{week: string, kg: number, purchase: KgBills, wholesale: KgBills, retail: KgBills}>}
 */
export function weeklyItemRows(buckets, fromWeek, toWeek) {
    const byWeek = new Map((buckets || []).map(b => [b.week, b]));
    /** @type {Array<Rec>} */
    const rows = [];
    for (let w = fromWeek; w && w <= toWeek; w = addWeeks(w, 1)) {
        const b = byWeek.get(w);
        /** @type {Rec} */
        const row = { week: w };
        TRAFFIC_KINDS.forEach(k => { row[k] = { kg: round2(b?.[k]?.kg), bills: Number(b?.[k]?.bills) || 0 }; });
        row.kg = round2(TRAFFIC_KINDS.reduce((s, k) => s + row[k].kg, 0));
        rows.push(row);
    }
    return /** @type {ReturnType<typeof weeklyItemRows>} */ (rows.reverse());
}

/**
 * Monday of the first of the last `n` IST weeks (this week included).
 * @param {*} now
 * @param {number} n
 * @returns {?string}
 */
export function weeksBackStart(now, n) {
    return addWeeks(istWeekStart(now), -(Math.max(1, n) - 1));
}

const daysInMonth = (/** @type {string} */ month) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** @type {(day: ?string) => {day: ?string, purchase: KgBills, wholesale: KgBills, retail: KgBills}} */
const emptyDay = (day) => ({ day, purchase: { kg: 0, bills: 0 }, wholesale: { kg: 0, bills: 0 }, retail: { kg: 0, bills: 0 } });

const isDeleted = (/** @type {?Rec|undefined} */ bill) => bill?.deleted === true || bill?.isDeleted === true || !isActiveBill(bill);

/**
 * Day-by-day kg and bills of one item in one IST month, with week totals
 * (days 1–7, 8–14, 15–21, 22–28, 29–end). Lines count like the monthly stats:
 * kg > 0 and a rate (or total) > 0; each bill once per day and type.
 * @param {?Object<string, Array<Rec>|undefined>|undefined} sources loaded bills: purchase, retail, wholesale
 * @param {?Array<{id: string, name?: string, hindiName?: string}>|undefined} items catalogue
 * @param {string} itemId
 * @param {string} month 'YYYY-MM'
 * @returns {{days: Array<Rec>, weeks: Array<Rec>, total: Object}}
 */
export function dailyTraffic(sources, items, itemId, month) {
    const n = daysInMonth(month);
    const days = Array.from({ length: n }, (_, i) => emptyDay(`${month}-${String(i + 1).padStart(2, '0')}`));
    const resolve = createCatalogueResolver(items);
    RATE_KINDS.forEach((/** @type {string} */ kind) => (sources?.[kind] || []).forEach(bill => {
        if (!bill || isDeleted(bill) || !Array.isArray(bill.items)) return;
        const at = eventTime(bill);
        if (!Number.isFinite(at) || at === Number.MAX_SAFE_INTEGER || istMonthKey(at) !== month) return;
        let kg = 0;
        bill.items.forEach((/** @type {Rec} */ line) => {
            if (!line) return;
            const lkg = lineKg(line);
            if (!(lkg > 0) || !(lineRate(line, lkg) > 0) || resolve(line) !== itemId) return;
            kg += lkg;
        });
        if (!(kg > 0)) return;
        const d = /** @type {Rec} */ (days[Number(istDayKey(at).slice(8, 10)) - 1])[kind];
        d.kg = round2(d.kg + kg);
        d.bills += 1;
    }));
    const sum = (/** @type {Array<Rec>} */ list, /** @type {?string} */ label) => {
        const out = /** @type {Rec} */ (emptyDay(label));
        list.forEach(d => TRAFFIC_KINDS.forEach(k => {
            out[k].kg = round2(out[k].kg + d[k].kg);
            out[k].bills += d[k].bills;
        }));
        return out;
    };
    /** @type {Array<Rec>} */
    const weeks = [];
    for (let start = 0; start < n; start += 7) {
        const chunk = days.slice(start, Math.min(start + 7, n));
        weeks.push({ ...sum(chunk, null), week: weeks.length + 1, from: start + 1, to: start + chunk.length });
    }
    return { days, weeks, total: sum(days, null) };
}
