/**
 * @fileoverview Items-page rate series (#65): after the one-time bill history
 * (cutoff = rateStats/_meta.backfillAt), the rate line of an item comes from
 * the rate set on the Items page, rebuilt per day from `rateHistory` entries
 * and the item's current rate lists. Pure functions.
 * @module utils/item-rate-series
 */

import { RATE_FIELDS } from './rate-history.js';
import { istDayKey, istDayStartMs, istMonthKey, istWeekStart } from './rate-trends.js';

/**
 * Which rate in an item's list is "the" Items-page rate (0 = the first one).
 * Customer rates are given from it based on quality.
 */
export const BASE_RATE_INDEX = 0;

export const ITEM_RATE_KINDS = ['purchase', 'wholesale', 'retail'];

const DAY_MS = 86400000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const cleanList = (list) => (Array.isArray(list) ? list : [])
    .map(Number)
    .filter(r => Number.isFinite(r) && r > 0);

const rateOrNull = (v) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

/** The Items-page (base) rate of a rate list, or null when the list has none. */
export function baseRate(list) {
    const clean = cleanList(list);
    return clean.length > BASE_RATE_INDEX ? clean[BASE_RATE_INDEX] : (clean.length ? clean[0] : null);
}

const seqOf = (e) => {
    const m = /_(\d+)$/.exec(String(e?.id || ''));
    return m ? Number(m[1]) : 0;
};

/** Reverses one history entry on a rate list (positions are not stored, so a removed rate goes back at the end). */
function undoEntry(list, entry) {
    const oldRate = rateOrNull(entry.old);
    const newRate = rateOrNull(entry.new);
    const out = list.slice();
    const idx = newRate === null ? -1 : out.indexOf(newRate);
    if (idx >= 0) {
        if (oldRate !== null) out[idx] = oldRate;
        else out.splice(idx, 1);
    } else if (oldRate !== null) {
        out.push(oldRate);
    }
    return out;
}

/**
 * Step series of the base rate of one rate type: rebuilt backwards from the
 * item's current list through its history entries (newest first).
 * @param {Array<number>} currentList the item's rate list today
 * @param {Array<{field: string, old: *, new: *, at: number, id?: string}>} entries rateHistory entries (any fields)
 * @param {'purchase'|'wholesale'|'retail'} kind
 * @returns {Array<{at: number, rate: ?number}>} ascending; the first step has at = -Infinity
 */
export function rateSteps(currentList, entries, kind) {
    const own = (entries || [])
        .filter(e => e && e.field === kind && Number.isFinite(Number(e.at)))
        .slice()
        .sort((a, b) => (Number(b.at) - Number(a.at)) || (seqOf(b) - seqOf(a)));
    let list = cleanList(currentList);
    const back = [];
    own.forEach(e => {
        const at = Number(e.at);
        if (!back.length || back[back.length - 1].at !== at) back.push({ at, rate: baseRate(list) });
        list = undoEntry(list, e);
    });
    const steps = [{ at: -Infinity, rate: baseRate(list) }];
    back.reverse().forEach(s => {
        if (s.rate !== steps[steps.length - 1].rate) steps.push(s);
    });
    return steps;
}

/** Rate in effect just before `ms`. */
export function rateAt(steps, ms) {
    let rate = null;
    for (const s of steps || []) {
        if (s.at < ms) rate = s.rate;
        else break;
    }
    return rate;
}

/**
 * One value per IST day from the day of `fromMs` to the day of `toMs`: the
 * rate in effect at the end of that day (the last change of the day wins).
 * @returns {Array<{day: string, rate: ?number}>}
 */
export function dailyRates(steps, fromMs, toMs) {
    if (!(toMs >= fromMs)) return [];
    const out = [];
    for (let start = istDayStartMs(istDayKey(fromMs)); start <= toMs; start += DAY_MS) {
        out.push({ day: istDayKey(start), rate: rateAt(steps, start + DAY_MS) });
    }
    return out;
}

/** Average of the daily rates per group (days without a rate are left out). */
function averageBy(steps, fromMs, toMs, groupOf) {
    const sums = {};
    dailyRates(steps, fromMs, toMs).forEach(d => {
        if (d.rate === null) return;
        const g = groupOf(d.day);
        const s = sums[g] || (sums[g] = { total: 0, days: 0 });
        s.total += d.rate;
        s.days += 1;
    });
    const out = {};
    Object.keys(sums).forEach(g => { out[g] = round2(sums[g].total / sums[g].days); });
    return out;
}

/**
 * Monthly Items-page rate: average of the daily rates of the month's days in
 * [fromMs, toMs] (days without a rate are left out).
 * @returns {Object.<string, number>} 'YYYY-MM' -> ₹/kg
 */
export function monthlyStepAverage(steps, fromMs, toMs) {
    return averageBy(steps, fromMs, toMs, (day) => day.slice(0, 7));
}

/**
 * Weekly Items-page rate: average of the daily rates of the IST week's
 * (Monday–Sunday) days in [fromMs, toMs].
 * @returns {Object.<string, number>} Monday 'YYYY-MM-DD' -> ₹/kg
 */
export function weeklyStepAverage(steps, fromMs, toMs) {
    return averageBy(steps, fromMs, toMs, (day) => istWeekStart(istDayStartMs(day)));
}

/**
 * Items-page series of one item for every rate type, from the cutoff to now.
 * @param {Object} item catalogue item (rates, wholesaleRates, saleRates)
 * @param {Array<Object>} entries rateHistory entries newer than the cutoff ([] when unreadable)
 * @param {{cutoffMs: number, now: number}} opts
 * @returns {Object.<string, {steps: Array, monthly: Object.<string, number>, weekly: Object.<string, number>, current: ?number}>}
 */
export function itemRateSeries(item, entries, { cutoffMs, now }) {
    const out = {};
    ITEM_RATE_KINDS.forEach(kind => {
        const list = item?.[RATE_FIELDS[kind]];
        const steps = rateSteps(list, (entries || []).filter(e => Number(e.at) > cutoffMs), kind);
        out[kind] = {
            steps,
            monthly: monthlyStepAverage(steps, cutoffMs, now),
            weekly: weeklyStepAverage(steps, cutoffMs, now),
            current: baseRate(list)
        };
    });
    return out;
}

/**
 * Base-rate changes after the cutoff, newest first, for the table view.
 * @returns {Array<{at: number, kind: string, from: ?number, to: ?number}>}
 */
export function rateChangeRows(series) {
    const rows = [];
    ITEM_RATE_KINDS.forEach(kind => {
        const steps = series?.[kind]?.steps || [];
        for (let i = 1; i < steps.length; i++) rows.push({ at: steps[i].at, kind, from: steps[i - 1].rate, to: steps[i].rate });
    });
    return rows.sort((a, b) => b.at - a.at);
}

/** IST month of the cutoff, or null before the history is built. */
export function cutoffMonth(cutoffMs) {
    return Number(cutoffMs) > 0 ? istMonthKey(Number(cutoffMs)) : null;
}

/** IST week (Monday) of the cutoff, or null before the history is built. */
export function cutoffWeek(cutoffMs) {
    return Number(cutoffMs) > 0 ? istWeekStart(Number(cutoffMs)) : null;
}

/**
 * Merges cached and newly read history entries (by id), newest first.
 * @returns {Array<Object>}
 */
export function mergeHistoryEntries(cached, fresh) {
    const byId = new Map();
    [...(cached || []), ...(fresh || [])].forEach(e => { if (e && e.id) byId.set(e.id, e); });
    return [...byId.values()].sort((a, b) => (Number(b.at) - Number(a.at)) || (a.id < b.id ? -1 : 1));
}
