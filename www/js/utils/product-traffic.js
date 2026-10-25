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

export const TRAFFIC_KINDS = ['purchase', 'wholesale', 'retail'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const section = (doc, kind) => ({
    kg: round2(doc?.[kind]?.kg),
    bills: Number(doc?.[kind]?.bills) || 0,
    amount: round2(doc?.[kind]?.amount)
});

const movedKg = (doc) => round2(TRAFFIC_KINDS.reduce((s, k) => s + (Number(doc?.[k]?.kg) || 0), 0));

/** % change from `before` to `now`, or null when there is nothing to compare with. */
export function pctChange(now, before) {
    return before > 0 ? round2((now / before - 1) * 100) : null;
}

/**
 * One row per item that moved in the month, most kg first.
 * kg moved = purchase + wholesale + retail kg; amount = Σ line kg × rate.
 * @param {Array<Object>} docs month buckets of the month (monthBucketsFor())
 * @param {Array<Object>} [prevDocs] previous month
 * @param {Array<Object>} [lastYearDocs] same month last year
 * @returns {Array<Object>}
 */
export function trafficRows(docs, prevDocs = null, lastYearDocs = null) {
    const kgById = (list) => {
        const m = new Map();
        (list || []).forEach(d => { if (d?.itemId) m.set(d.itemId, movedKg(d)); });
        return m;
    };
    const prev = prevDocs ? kgById(prevDocs) : null;
    const lastYear = lastYearDocs ? kgById(lastYearDocs) : null;
    return (docs || [])
        .filter(d => d && d.itemId && movedKg(d) > 0)
        .map(d => {
            const row = { itemId: d.itemId, month: d.month, kg: movedKg(d), bills: Number(d.bills) || 0 };
            TRAFFIC_KINDS.forEach(k => { row[k] = section(d, k); });
            row.amount = round2(TRAFFIC_KINDS.reduce((s, k) => s + row[k].amount, 0));
            row.vsPrev = prev ? pctChange(row.kg, prev.get(d.itemId) || 0) : null;
            row.vsLastYear = lastYear ? pctChange(row.kg, lastYear.get(d.itemId) || 0) : null;
            return row;
        })
        .sort((a, b) => (b.kg - a.kg) || (a.itemId < b.itemId ? -1 : 1));
}

/** Months a month overview compares with. */
export function comparisonMonths(month) {
    return { prev: addMonths(month, -1), lastYear: addMonths(month, -12) };
}

/** Last `n` IST months, newest first. */
export function recentMonths(now, n = 24) {
    const current = istMonthKey(now);
    return Array.from({ length: n }, (_, i) => addMonths(current, -i));
}

/**
 * True when every bill of the month is in the loaded history window
 * (loadedFrom 0 = all history loaded).
 */
export function dailyDetailAvailable(month, loadedFrom) {
    if (!(Number(loadedFrom) > 0)) return true;
    return istMonthStartMs(month) >= Number(loadedFrom);
}

/** Month buckets of one month from year docs. */
export function monthBucketsFor(yearDocs, month) {
    return monthBuckets(yearDocs).filter(b => b.month === month);
}

/**
 * Year docs that can be kept on the device: no bucket of the year can still
 * change in a roll-forward (all its weeks and months are before the window).
 */
export function isSettledYear(year, now) {
    return String(year) < rollForwardWindow(0, now).fromYear;
}

/**
 * One item week by week (newest first) for the weeks from `fromWeek` to
 * `toWeek`; weeks without bills show 0.
 * @param {Array<Object>} buckets weekBuckets() of the item
 * @returns {Array<{week: string, kg: number, purchase: Object, wholesale: Object, retail: Object}>}
 */
export function weeklyItemRows(buckets, fromWeek, toWeek) {
    const byWeek = new Map((buckets || []).map(b => [b.week, b]));
    const rows = [];
    for (let w = fromWeek; w && w <= toWeek; w = addWeeks(w, 1)) {
        const b = byWeek.get(w);
        const row = { week: w };
        TRAFFIC_KINDS.forEach(k => { row[k] = { kg: round2(b?.[k]?.kg), bills: Number(b?.[k]?.bills) || 0 }; });
        row.kg = round2(TRAFFIC_KINDS.reduce((s, k) => s + row[k].kg, 0));
        rows.push(row);
    }
    return rows.reverse();
}

/** Monday of the first of the last `n` IST weeks (this week included). */
export function weeksBackStart(now, n) {
    return addWeeks(istWeekStart(now), -(Math.max(1, n) - 1));
}

const daysInMonth = (month) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const emptyDay = (day) => ({ day, purchase: { kg: 0, bills: 0 }, wholesale: { kg: 0, bills: 0 }, retail: { kg: 0, bills: 0 } });

const isDeleted = (bill) => bill?.deleted === true || bill?.isDeleted === true;

/**
 * Day-by-day kg and bills of one item in one IST month, with week totals
 * (days 1–7, 8–14, 15–21, 22–28, 29–end). Lines count like the monthly stats:
 * kg > 0 and a rate (or total) > 0; each bill once per day and type.
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources loaded bills
 * @param {Array} items catalogue
 * @param {string} itemId
 * @param {string} month 'YYYY-MM'
 * @returns {{days: Array<Object>, weeks: Array<Object>, total: Object}}
 */
export function dailyTraffic(sources, items, itemId, month) {
    const n = daysInMonth(month);
    const days = Array.from({ length: n }, (_, i) => emptyDay(`${month}-${String(i + 1).padStart(2, '0')}`));
    const resolve = createCatalogueResolver(items);
    RATE_KINDS.forEach(kind => (sources?.[kind] || []).forEach(bill => {
        if (!bill || isDeleted(bill) || !Array.isArray(bill.items)) return;
        const at = eventTime(bill);
        if (!Number.isFinite(at) || at === Number.MAX_SAFE_INTEGER || istMonthKey(at) !== month) return;
        let kg = 0;
        bill.items.forEach(line => {
            if (!line) return;
            const lkg = lineKg(line);
            if (!(lkg > 0) || !(lineRate(line, lkg) > 0) || resolve(line) !== itemId) return;
            kg += lkg;
        });
        if (!(kg > 0)) return;
        const d = days[Number(istDayKey(at).slice(8, 10)) - 1][kind];
        d.kg = round2(d.kg + kg);
        d.bills += 1;
    }));
    const sum = (list, label) => {
        const out = emptyDay(label);
        list.forEach(d => TRAFFIC_KINDS.forEach(k => {
            out[k].kg = round2(out[k].kg + d[k].kg);
            out[k].bills += d[k].bills;
        }));
        return out;
    };
    const weeks = [];
    for (let start = 0; start < n; start += 7) {
        const chunk = days.slice(start, Math.min(start + 7, n));
        weeks.push({ ...sum(chunk, null), week: weeks.length + 1, from: start + 1, to: start + chunk.length });
    }
    return { days, weeks, total: sum(days, null) };
}
