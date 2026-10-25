/**
 * @fileoverview Rate trends (#65): weekly and monthly per-item rate statistics
 * built from bill lines, the resumable backfill over all bills, the
 * roll-forward plan for recent weeks/months, and the seasonal "usually goes
 * up / down" estimate. Pure functions; Firestore access is injected by the caller.
 *
 * Stats doc `rateStats/{itemId}_{YYYY}` (one per item per year):
 *   { itemId, year: 'YYYY', weeks: { 'wYYYY-MM-DD': Bucket }, months: { 'mYYYY-MM': Bucket }, updatedAt }
 *   weeks are IST weeks starting Monday, keyed by the Monday; a week that
 *   spans two years belongs to the year of its Monday.
 *   Bucket  = { purchase: Section, retail: Section, wholesale: Section, bills }
 *   Section = { kg, amount, min, max, avg, bills }  — avg = amount / kg (kg-weighted rate)
 *   bills   = bills of any kind with this item in the bucket
 * @module utils/rate-trends
 */

import { createItemKeyResolver, eventTime } from './stock-replay.js';
import { t, getLang } from '../i18n/index.js';

export const RATE_KINDS = ['purchase', 'retail', 'wholesale'];

/** Bill collections read by the backfill, in order, with the section they fill. */
export const BACKFILL_SOURCES = [
    { coll: 'purchases', kind: 'purchase' },
    { coll: 'retailSales', kind: 'retail' },
    { coll: 'wholesaleSales', kind: 'wholesale' }
];

export const BACKFILL_PAGE_SIZE = 300;
export const DEFAULT_DAILY_READ_BUDGET = 10000;
export const READ_BUDGET_OPTIONS = [5000, 10000, 20000];
export const CURSOR_VERSION = 2;

/** Month-over-month changes within ±this % count as "about the same". */
export const FLAT_PCT = 2;
export const MIN_SEASONS = 2;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 86400000;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** IST calendar month 'YYYY-MM' of an instant (ms). */
export function istMonthKey(ms) {
    const d = new Date(Number(ms) + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** IST calendar day 'YYYY-MM-DD' of an instant (ms). */
export function istDayKey(ms) {
    const d = new Date(Number(ms) + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Start (ms) of the IST day 'YYYY-MM-DD'. */
export function istDayStartMs(day) {
    const m = DAY_RE.exec(day || '');
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
}

/** Monday 'YYYY-MM-DD' of the IST week (Monday–Sunday) containing an instant (ms). */
export function istWeekStart(ms) {
    const d = new Date(Number(ms) + IST_OFFSET_MS);
    const back = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY_MS;
    return istDayKey(monday - IST_OFFSET_MS);
}

/** Week start 'YYYY-MM-DD' shifted by n weeks. */
export function addWeeks(week, n) {
    const start = istDayStartMs(week);
    return Number.isFinite(start) ? istDayKey(start + n * 7 * DAY_MS) : null;
}

export const weekKey = (week) => `w${week}`;
export const monthKey = (month) => `m${month}`;

/** Start (ms) of an IST month 'YYYY-MM'. */
export function istMonthStartMs(month) {
    const m = MONTH_RE.exec(month || '');
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - IST_OFFSET_MS;
}

/** 'YYYY-MM' shifted by n months. */
export function addMonths(month, n) {
    const m = MONTH_RE.exec(month || '');
    if (!m) return null;
    const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
    return `${Math.floor(total / 12)}-${pad2((total % 12 + 12) % 12 + 1)}`;
}

/** IST month of a bill (numeric timestamp, Firestore Timestamp, ISO or en-IN date string), or null. */
export function billMonth(bill) {
    const t = eventTime(bill);
    if (!Number.isFinite(t) || t === Number.MAX_SAFE_INTEGER) return null;
    return istMonthKey(t);
}

/** kg on a bill line: purchase/retail store `qty`, wholesale stores `quantity`. */
export function lineKg(line) {
    if (!line) return 0;
    const raw = line.qty !== undefined && line.qty !== null && line.qty !== '' ? line.qty : line.quantity;
    const kg = parseFloat(raw);
    return Number.isFinite(kg) && kg > 0 ? kg : 0;
}

/** ₹/kg on a bill line; falls back to total / kg for legacy lines without `rate`. */
export function lineRate(line, kg = lineKg(line)) {
    const rate = parseFloat(line?.rate);
    if (Number.isFinite(rate) && rate > 0) return rate;
    const total = parseFloat(line?.total);
    return kg > 0 && Number.isFinite(total) && total > 0 ? total / kg : 0;
}

export function emptySection() {
    return { kg: 0, amount: 0, min: null, max: null, avg: 0, bills: 0 };
}

/** Stats doc id: one doc per item per year. */
export const statsDocId = (itemId, year) => `${itemId}_${year}`;

/**
 * Item-key resolver limited to catalogue ids: lines are grouped by `itemId`,
 * legacy lines without one (or with a deleted id) by English/Hindi name.
 * Lines that match no catalogue item are skipped (returns null).
 */
export function createCatalogueResolver(items) {
    const ids = new Set((items || []).map(i => i.id));
    const resolve = createItemKeyResolver(items);
    return (line) => {
        const key = resolve({ itemId: line.itemId, name: line.name || line.itemName });
        return ids.has(key) ? key : null;
    };
}

const isDeletedBill = (bill) => bill?.deleted === true || bill?.isDeleted === true;

/**
 * Adds one bill to a plain-object accumulator (serialisable and compact, so
 * the backfill can keep it in its cursor). The bill goes into the bucket of
 * its IST week (doc of the Monday's year) and of its IST month (doc of that
 * year); each bill counts once per item, bucket and kind.
 * Accumulator: { [docId]: { itemId, year, b: { [bucketKey]: { n, purchase?: [kg, amount, min, max, bills], … } } } }
 * @param {Object} acc
 * @param {Object} bill
 * @param {'purchase'|'retail'|'wholesale'} kind
 * @param {Function} resolve createCatalogueResolver(items)
 * @param {{fromMs?: number}} [opts] skip bills before this instant
 * @returns {boolean} whether the bill was used
 */
export function addBillToAcc(acc, bill, kind, resolve, { fromMs = null } = {}) {
    if (!bill || isDeletedBill(bill) || !Array.isArray(bill.items)) return false;
    const at = eventTime(bill);
    if (!Number.isFinite(at) || at === Number.MAX_SAFE_INTEGER || (fromMs !== null && at < fromMs)) return false;
    const month = istMonthKey(at);
    const week = istWeekStart(at);
    const targets = [[month.slice(0, 4), monthKey(month)], [week.slice(0, 4), weekKey(week)]];
    const seen = new Set();
    let used = false;
    bill.items.forEach(line => {
        if (!line) return;
        const kg = lineKg(line);
        const rate = lineRate(line, kg);
        if (!(kg > 0) || !(rate > 0)) return;
        const itemId = resolve(line);
        if (!itemId) return;
        targets.forEach(([year, key]) => {
            const id = statsDocId(itemId, year);
            const doc = acc[id] || (acc[id] = { itemId, year, b: {} });
            const bucket = doc.b[key] || (doc.b[key] = { n: 0 });
            const s = bucket[kind] || (bucket[kind] = [0, 0, null, null, 0]);
            s[0] += kg;
            s[1] += kg * rate;
            s[2] = s[2] === null ? rate : Math.min(s[2], rate);
            s[3] = s[3] === null ? rate : Math.max(s[3], rate);
            const once = `${id}|${key}`;
            if (!seen.has(once)) {
                seen.add(once);
                s[4] += 1;
                bucket.n += 1;
            }
        });
        used = true;
    });
    return used;
}

/**
 * Accumulates loaded bills of every kind.
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources
 * @param {Array} items catalogue
 * @param {{fromMs?: number}} [opts]
 */
export function aggregateBills(sources, items, opts = {}) {
    const acc = {};
    const resolve = createCatalogueResolver(items);
    RATE_KINDS.forEach(kind => (sources?.[kind] || []).forEach(bill => addBillToAcc(acc, bill, kind, resolve, opts)));
    return acc;
}

function finalizeSection(s) {
    if (!s || !(s[0] > 0)) return emptySection();
    return { kg: round2(s[0]), amount: round2(s[1]), min: round2(s[2]), max: round2(s[3]), avg: round2(s[1] / s[0]), bills: s[4] || 0 };
}

function finalizeBucket(b) {
    const out = { bills: b.n || 0 };
    RATE_KINDS.forEach(k => { out[k] = finalizeSection(b[k]); });
    return out;
}

/**
 * Per-item-year stats documents from an accumulator: every kind present in
 * each bucket (empty sections for kinds with no lines), rounded, avg = amount / kg.
 * @returns {Object.<string, Object>} docId -> { itemId, year, weeks, months } (without updatedAt)
 */
export function finalizeStats(acc) {
    const out = {};
    Object.keys(acc || {}).forEach(id => {
        const d = acc[id];
        const doc = { itemId: d.itemId, year: d.year, weeks: {}, months: {} };
        Object.keys(d.b || {}).sort().forEach(key => {
            (key[0] === 'w' ? doc.weeks : doc.months)[key] = finalizeBucket(d.b[key]);
        });
        out[id] = doc;
    });
    return out;
}

/**
 * Bills → per-item-year stats docs (the pure aggregation the backfill, the
 * roll-forward and data migrations share).
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources
 * @param {Array} items catalogue
 * @returns {Object.<string, Object>} docId -> doc
 */
export function billsToYearDocs(sources, items) {
    return finalizeStats(aggregateBills(sources, items));
}

const sameSection = (a, b) => {
    const x = a || emptySection();
    const y = b || emptySection();
    return ['kg', 'amount', 'min', 'max', 'avg', 'bills'].every(f => (x[f] ?? null) === (y[f] ?? null));
};

const sameBucket = (a, b) => (a?.bills || 0) === (b?.bills || 0) && RATE_KINDS.every(k => sameSection(a?.[k], b?.[k]));

const sameBuckets = (a, b) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return [...keys].every(k => a?.[k] && b?.[k] && sameBucket(a[k], b[k]));
};

/** True when two stats docs carry the same numbers (updatedAt ignored). */
export function sameStats(a, b) {
    if (!a || !b) return false;
    return a.itemId === b.itemId && String(a.year) === String(b.year)
        && sameBuckets(a.weeks, b.weeks) && sameBuckets(a.months, b.months);
}

/**
 * First IST month fully covered by the loaded history (ms; 0 = all loaded),
 * capped to `maxMonths` back from `now` so a roll-forward (and its server
 * read of those months) stays small.
 */
export function rollForwardFromMonth(loadedFrom, now, maxMonths = 2) {
    const current = istMonthKey(now);
    const floor = addMonths(current, -(maxMonths - 1));
    if (!(loadedFrom > 0)) return floor;
    const m = istMonthKey(loadedFrom);
    const covered = istMonthStartMs(m) === loadedFrom ? m : addMonths(m, 1);
    return covered > floor ? covered : floor;
}

/**
 * Buckets a roll-forward recomputes: months from rollForwardFromMonth(), and
 * weeks whose Monday is in the loaded history from the week of that month's
 * start (a week that started before the loaded window is left as stored).
 * @returns {{fromMonth: string, fromWeek: string, fromYear: string}}
 */
export function rollForwardWindow(loadedFrom, now, maxMonths = 2) {
    const fromMonth = rollForwardFromMonth(loadedFrom, now, maxMonths);
    const monthStart = istMonthStartMs(fromMonth);
    let fromWeek = istWeekStart(monthStart);
    if (Number(loadedFrom) > 0 && istDayStartMs(fromWeek) < loadedFrom) fromWeek = addWeeks(fromWeek, 1);
    const fromYear = [fromMonth.slice(0, 4), fromWeek.slice(0, 4)].sort()[0];
    return { fromMonth, fromWeek, fromYear };
}

const pickBuckets = (map, inRange, keep) => {
    const out = {};
    Object.keys(map || {}).forEach(k => { if (inRange(k) === keep) out[k] = map[k]; });
    return out;
};

/**
 * Writes that bring the stored year docs in line with the loaded bills for
 * the roll-forward window: buckets from fromMonth / fromWeek on are replaced
 * by the computed ones (dropped when their bills were all deleted or edited
 * away); older buckets stay as stored. Only changed docs are written.
 * @param {Object.<string, Object>} computed finalizeStats() of the loaded bills
 * @param {Array<Object>} stored stored year docs ({id, ...data}) with year >= window.fromYear
 * @param {{fromMonth: string, fromWeek: string, fromYear: string}} window
 * @returns {Array<{id: string, data: Object}>}
 */
export function planRollForward(computed, stored, { fromMonth, fromWeek, fromYear }) {
    const storedById = new Map((stored || []).filter(d => d && d.itemId && d.year && String(d.year) >= fromYear).map(d => [d.id, d]));
    const ids = new Set([...storedById.keys(), ...Object.keys(computed || {}).filter(id => String(computed[id].year) >= fromYear)]);
    const monthIn = (k) => k >= monthKey(fromMonth);
    const weekIn = (k) => k >= weekKey(fromWeek);
    const writes = [];
    ids.forEach(id => {
        const old = storedById.get(id);
        const fresh = computed?.[id];
        const base = old || { itemId: fresh.itemId, year: fresh.year, weeks: {}, months: {} };
        const merged = {
            itemId: base.itemId,
            year: String(base.year),
            weeks: { ...pickBuckets(base.weeks, weekIn, false), ...pickBuckets(fresh?.weeks, weekIn, true) },
            months: { ...pickBuckets(base.months, monthIn, false), ...pickBuckets(fresh?.months, monthIn, true) }
        };
        if (!old && !Object.keys(merged.weeks).length && !Object.keys(merged.months).length) return;
        if (!sameStats(merged, old)) writes.push({ id, data: merged });
    });
    return writes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// History carried from the old project (#15)
// ---------------------------------------------------------------------------

/** `_meta.by` of a history carried from the old project (tools/migrate, #15); its `backfillAt` is the backup time. */
export const MIGRATION_META_BY = 'migration';

/**
 * A carried history holds the old app's bills up to the backup and this
 * project only has the bills after it, so a roll-forward must leave every
 * bucket that started before the backup as stored (otherwise it would be
 * rebuilt from the new bills alone).
 * @param {{fromMonth: string, fromWeek: string, fromYear: string}} win rollForwardWindow()
 * @param {?Object} meta rateStats/_meta
 * @returns {{fromMonth: string, fromWeek: string, fromYear: string}}
 */
export function clampWindowToMigration(win, meta) {
    const at = Number(meta?.backfillAt);
    if (meta?.by !== MIGRATION_META_BY || !(at > 0)) return win;
    let month = istMonthKey(at);
    if (istMonthStartMs(month) < at) month = addMonths(month, 1);
    let week = istWeekStart(at);
    if (istDayStartMs(week) < at) week = addWeeks(week, 1);
    const fromMonth = win.fromMonth > month ? win.fromMonth : month;
    const fromWeek = win.fromWeek > week ? win.fromWeek : week;
    return { fromMonth, fromWeek, fromYear: [fromMonth.slice(0, 4), fromWeek.slice(0, 4)].sort()[0] };
}

// ---------------------------------------------------------------------------
// Backfill (owner-triggered, resumable)
// ---------------------------------------------------------------------------

/** A fresh backfill cursor. */
export function newCursor(now) {
    return { v: CURSOR_VERSION, startedAt: now, phase: 'read', source: 0, after: null, acc: {}, bills: 0, reads: 0, day: istDayKey(now), readsToday: 0 };
}

/** Parses a stored cursor; null when missing, corrupt or from another format. */
export function parseCursor(text) {
    if (!text) return null;
    try {
        const c = JSON.parse(text);
        if (!c || c.v !== CURSOR_VERSION || !['read', 'write'].includes(c.phase) || typeof c.acc !== 'object') return null;
        return c;
    } catch (_) {
        return null;
    }
}

/**
 * Reads bill pages until every bill collection is done, today's read budget
 * is used up, or an error stops it. The cursor is saved after every page, so
 * a closed app, quota error or budget stop continues from the next page.
 * @param {Object} args
 * @param {Object} args.cursor mutated
 * @param {(coll: string, after: ?string, limit: number) => Promise<{docs: Array<{id: string}>, reads: number}>} args.fetchPage
 * @param {Array} args.items catalogue
 * @param {(cursor: Object) => void} args.saveCursor
 * @param {(err: *) => boolean} args.isQuotaError
 * @param {number} [args.budget] reads per IST day
 * @param {number} [args.pageSize]
 * @param {() => number} [args.now]
 * @param {(cursor: Object) => void} [args.onProgress]
 * @returns {Promise<{status: 'read-done'|'budget'|'quota'|'error', error?: *}>}
 */
export async function runBackfillReads({
    cursor, fetchPage, items, saveCursor, isQuotaError,
    budget = DEFAULT_DAILY_READ_BUDGET, pageSize = BACKFILL_PAGE_SIZE, now = () => Date.now(), onProgress = null
}) {
    const resolve = createCatalogueResolver(items);
    while (cursor.source < BACKFILL_SOURCES.length) {
        const today = istDayKey(now());
        if (cursor.day !== today) {
            cursor.day = today;
            cursor.readsToday = 0;
        }
        if (cursor.readsToday >= budget) {
            saveCursor(cursor);
            return { status: 'budget' };
        }
        const { coll, kind } = BACKFILL_SOURCES[cursor.source];
        const limit = Math.min(pageSize, Math.max(1, budget - cursor.readsToday));
        let page;
        try {
            page = await fetchPage(coll, cursor.after, limit);
        } catch (error) {
            saveCursor(cursor);
            return { status: isQuotaError(error) ? 'quota' : 'error', error };
        }
        const docs = page?.docs || [];
        const reads = Number.isFinite(page?.reads) ? page.reads : Math.max(1, docs.length);
        cursor.reads += reads;
        cursor.readsToday += reads;
        docs.forEach(bill => { if (addBillToAcc(cursor.acc, bill, kind, resolve)) cursor.bills += 1; });
        if (docs.length < limit) {
            cursor.source += 1;
            cursor.after = null;
        } else {
            cursor.after = docs[docs.length - 1].id;
        }
        saveCursor(cursor);
        if (onProgress) onProgress(cursor);
    }
    cursor.phase = 'write';
    saveCursor(cursor);
    return { status: 'read-done' };
}

/**
 * Rough read cost of a full backfill: bills loaded per day in the current
 * window, extrapolated back to the oldest bill (exact when all history is
 * loaded), plus one page end per bill collection and, after writing, about
 * one read per item for the first roll-forward check of this year's docs.
 * @param {{loadedBills: number, loadedFrom: number, oldest: number, now: number, items?: number}} args
 * @returns {number}
 */
export function estimateBackfillReads({ loadedBills, loadedFrom, oldest, now, items = 0 }) {
    const n = Math.max(0, Number(loadedBills) || 0);
    const pages = BACKFILL_SOURCES.length + Math.max(0, Number(items) || 0);
    if (!(loadedFrom > 0)) return n + pages;
    const span = now - loadedFrom;
    if (!(span > DAY_MS) || !Number.isFinite(oldest) || oldest >= loadedFrom) return n + pages;
    return Math.ceil(n * ((now - oldest) / span)) + pages;
}

/** Days the backfill will take at `budget` reads per day. */
export function backfillDays(estimate, budget = DEFAULT_DAILY_READ_BUDGET) {
    return Math.max(1, Math.ceil((Number(estimate) || 0) / Math.max(1, budget)));
}

// ---------------------------------------------------------------------------
// Series, table rows and the seasonal estimate
// ---------------------------------------------------------------------------

/** kg-weighted average of one kind, or of 'sale' (retail + wholesale together). */
export function sectionAvg(doc, kind) {
    if (!doc) return null;
    const kinds = kind === 'sale' ? ['retail', 'wholesale'] : [kind];
    let kg = 0;
    let amount = 0;
    kinds.forEach(k => {
        kg += Number(doc[k]?.kg) || 0;
        amount += Number(doc[k]?.amount) || 0;
    });
    return kg > 0 ? round2(amount / kg) : null;
}

const isYearDoc = (d) => d && d.itemId && /^\d{4}$/.test(String(d.year || ''));

/**
 * Month buckets of year docs as a flat list, oldest first:
 * [{ itemId, month: 'YYYY-MM', purchase, retail, wholesale, bills }].
 */
export function monthBuckets(yearDocs) {
    const out = [];
    (yearDocs || []).filter(isYearDoc).forEach(d => Object.keys(d.months || {}).forEach(k => {
        if (MONTH_RE.test(k.slice(1))) out.push({ itemId: d.itemId, month: k.slice(1), ...d.months[k] });
    }));
    return out.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.itemId < b.itemId ? -1 : 1)));
}

/** Week buckets of year docs, oldest first: [{ itemId, week: 'YYYY-MM-DD' (Monday), … }]. */
export function weekBuckets(yearDocs) {
    const out = [];
    (yearDocs || []).filter(isYearDoc).forEach(d => Object.keys(d.weeks || {}).forEach(k => {
        if (DAY_RE.test(k.slice(1))) out.push({ itemId: d.itemId, week: k.slice(1), ...d.weeks[k] });
    }));
    return out.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : (a.itemId < b.itemId ? -1 : 1)));
}

/** { 'YYYY-MM': avg } for one kind ('purchase' | 'retail' | 'wholesale' | 'sale') from month buckets. */
export function monthSeries(buckets, kind) {
    return periodSeries(buckets, kind, 'month');
}

/** { period: avg } for one kind from month ('month') or week ('week') buckets. */
export function periodSeries(buckets, kind, key = 'month') {
    const out = {};
    (buckets || []).forEach(d => {
        const v = sectionAvg(d, kind);
        if (v !== null && d[key]) out[d[key]] = v;
    });
    return out;
}

/**
 * Table rows per period (oldest first) with sale average and margin per kg.
 * @param {Array<Object>} buckets monthBuckets() or weekBuckets() of one item
 * @param {'month'|'week'} [key]
 */
export function trendRows(buckets, key = 'month') {
    const valid = key === 'week' ? DAY_RE : MONTH_RE;
    return (buckets || [])
        .filter(d => d && valid.test(d[key] || ''))
        .slice()
        .sort((a, b) => (a[key] < b[key] ? -1 : 1))
        .map(d => {
            const purchase = sectionAvg(d, 'purchase');
            const sale = sectionAvg(d, 'sale');
            return {
                period: d[key],
                purchase,
                retail: sectionAvg(d, 'retail'),
                wholesale: sectionAvg(d, 'wholesale'),
                sale,
                margin: purchase !== null && sale !== null ? round2(sale - purchase) : null,
                kgBought: round2(d.purchase?.kg),
                kgSold: round2((Number(d.retail?.kg) || 0) + (Number(d.wholesale?.kg) || 0)),
                bills: Number(d.bills) || 0
            };
        })
        .filter(r => r.purchase !== null || r.sale !== null);
}

/** Same calendar months per year: { year: [12 values or null] } (Jan..Dec). */
export function yearOverlay(series, years) {
    const out = {};
    (years || []).forEach(y => {
        out[y] = Array.from({ length: 12 }, (_, i) => {
            const v = series[`${y}-${pad2(i + 1)}`];
            return v === undefined ? null : v;
        });
    });
    return out;
}

const directionOf = (pct, flat = FLAT_PCT) => (pct > flat ? 'up' : pct < -flat ? 'down' : 'flat');

/**
 * Seasonal estimate for the next `weeks` weeks: in every past year with data
 * for both months, the change from this calendar month to the month the
 * horizon ends in. Average change → direction; agreement across years and
 * the number of years → confidence.
 * @param {Object.<string, number>} series monthSeries()
 * @param {{now: number, weeks?: number, flatPct?: number, maxYears?: number}} opts
 * @returns {{status: 'ok'|'not-enough', fromMonth: string, toMonth: string, seasons: number,
 *   perYear: Array<{year: number, from: number, to: number, pct: number}>, pct?: number,
 *   direction?: 'up'|'down'|'flat', agree?: number, confidence?: 'high'|'medium'|'low'}}
 */
export function seasonalOutlook(series, opts = {}) {
    return outlookFrom((f, t) => {
        const a = series?.[f];
        const b = series?.[t];
        return a > 0 && b > 0 ? { from: a, to: b, ratio: b / a } : null;
    }, opts);
}

/**
 * Change from month f to month t on the combined rate line: bills up to the
 * cutoff month, the Items-page rate from the cutoff month on. A change that
 * crosses the cutoff is chained through the cutoff month (bills f → cutoff,
 * then Items page cutoff → t), so the level difference between the two
 * sources is not counted as a seasonal change.
 * @param {{bills: Object.<string, number>, items: Object.<string, number>, cutoffMonth: ?string}} combined
 * @returns {?{from: number, to: number, ratio: number}}
 */
export function combinedChange(combined, f, t) {
    const bills = combined?.bills || {};
    const items = combined?.items || {};
    const cut = combined?.cutoffMonth || null;
    const pair = (s, a, b) => (s[a] > 0 && s[b] > 0 ? s[b] / s[a] : null);
    let ratio = null;
    if (!cut || t <= cut) ratio = pair(bills, f, t);
    else if (f >= cut) ratio = pair(items, f, t);
    else {
        const before = pair(bills, f, cut);
        const after = pair(items, cut, t);
        ratio = before !== null && after !== null ? before * after : null;
    }
    if (ratio === null) return null;
    const from = !cut || f <= cut ? bills[f] : items[f];
    const to = !cut || t <= cut ? bills[t] : items[t];
    return { from, to, ratio };
}

/** seasonalOutlook() over the combined bills + Items-page line (see combinedChange). */
export function seasonalOutlookCombined(combined, opts = {}) {
    return outlookFrom((f, t) => combinedChange(combined, f, t), opts);
}

function outlookFrom(change, { now, weeks = 6, flatPct = FLAT_PCT, maxYears = 10 } = {}) {
    const fromMonth = istMonthKey(now);
    let toMonth = istMonthKey(now + weeks * 7 * DAY_MS);
    if (toMonth <= fromMonth) toMonth = addMonths(fromMonth, 1);
    const perYear = [];
    for (let k = 1; k <= maxYears; k++) {
        const f = addMonths(fromMonth, -12 * k);
        const c = change(f, addMonths(toMonth, -12 * k));
        if (c) perYear.push({ year: Number(f.slice(0, 4)), from: c.from, to: c.to, pct: round2((c.ratio - 1) * 100) });
    }
    const base = { fromMonth, toMonth, seasons: perYear.length, perYear };
    if (perYear.length < MIN_SEASONS) return { ...base, status: 'not-enough' };
    const pct = round2(perYear.reduce((s, y) => s + y.pct, 0) / perYear.length);
    const direction = directionOf(pct, flatPct);
    const agree = perYear.filter(y => directionOf(y.pct, flatPct) === direction).length;
    let confidence = 'low';
    if (perYear.length >= 3 && agree === perYear.length) confidence = 'high';
    else if (agree * 3 >= perYear.length * 2) confidence = 'medium';
    return { ...base, status: 'ok', pct, direction, agree, confidence };
}

const MONTH_NAMES = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
};

/** 'Oct 2026' / 'अक्टूबर 2026'; `withYear` false gives just the month. */
export function monthLabel(month, lang = 'en', withYear = true) {
    const m = MONTH_RE.exec(month || '');
    if (!m) return String(month || '');
    const name = MONTH_NAMES[lang === 'hi' ? 'hi' : 'en'][Number(m[2]) - 1];
    return withYear ? `${name} ${m[1]}` : name;
}

const signed = (n) => `${n > 0 ? '+' : ''}${n}%`;

/** i18n keys for an outlook's direction and confidence. */
export const DIRECTION_KEYS = { up: 'ui.trends.dir_up', down: 'ui.trends.dir_down', flat: 'ui.trends.dir_flat' };
export const CONFIDENCE_KEYS = { high: 'ui.trends.conf_high', medium: 'ui.trends.conf_medium', low: 'ui.trends.conf_low' };

/**
 * Plain explanation of an outlook in the app language.
 * @param {Object} o seasonalOutlook() result
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function explainOutlook(o, lang = getLang()) {
    const from = monthLabel(o.fromMonth, lang, false);
    const to = monthLabel(o.toMonth, lang, false);
    if (o.status !== 'ok') {
        return t('ui.trends.not_enough_explain', { from, to, min: MIN_SEASONS, have: o.seasons }, lang);
    }
    const list = o.perYear.map(y => `${y.year}: ${signed(y.pct)}`).join(', ');
    const about = Math.abs(Math.round(o.pct));
    const dir = t(o.direction === 'up' ? 'ui.trends.went_up' : o.direction === 'down' ? 'ui.trends.went_down' : 'ui.trends.went_flat', { pct: about }, lang);
    return t('ui.trends.explain', { from, to, list, dir, agree: o.agree, seasons: o.seasons }, lang);
}

/**
 * Catalogue items ordered by how many loaded bill lines use them (most used
 * first), then by name.
 */
export function itemsByUsage(items, sources) {
    const resolve = createCatalogueResolver(items);
    const uses = {};
    RATE_KINDS.forEach(kind => (sources?.[kind] || []).forEach(bill => {
        (bill?.items || []).forEach(line => {
            if (!line) return;
            const id = resolve(line);
            if (id) uses[id] = (uses[id] || 0) + 1;
        });
    }));
    return (items || [])
        .map(i => ({ item: i, uses: uses[i.id] || 0 }))
        .sort((a, b) => (b.uses - a.uses) || String(a.item.name || '').localeCompare(String(b.item.name || '')));
}
