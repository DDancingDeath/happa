/**
 * @fileoverview Month snapshots (`monthStats/{YYYY-MM}`) for comparisons with
 * last year and the 13-month profit chart without loading old bills
 * (docs/insights-redesign.md §7.6). Pure: build a snapshot from a detailed
 * moneySummary, read it back in the same shape the pages compare with.
 * @module utils/month-snapshots
 */

import { itemSummary, partySummary, profitPerDay } from './business-metrics.js';

export const SNAPSHOT_VERSION = 1;
/** Current / previous month snapshots older than this are rebuilt from the loaded bills. */
export const SNAPSHOT_ROLL_MS = 6 * 60 * 60 * 1000;
export const TOP_PARTIES = 50;

const pad = (x) => String(x).padStart(2, '0');

/** 'YYYY-MM' of a local time. */
export const monthKeyOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

/** [from, to) of a 'YYYY-MM' key. */
export function monthBounds(key) {
    const [y, m] = String(key).split('-').map(Number);
    return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() };
}

/** 'YYYY-MM' keys of every month that overlaps [from, to), oldest first. */
export function monthKeysBetween(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const out = [];
    const d0 = new Date(from);
    for (let d = new Date(d0.getFullYear(), d0.getMonth(), 1); d.getTime() < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        out.push(monthKeyOf(d.getTime()));
    }
    return out;
}

/** The last `n` month keys ending with the month of `now`, oldest first. */
export function lastMonthKeys(now, n) {
    const d = new Date(now);
    return Array.from({ length: n }, (_, i) => monthKeyOf(new Date(d.getFullYear(), d.getMonth() - (n - 1 - i), 1).getTime()));
}

/**
 * A snapshot document from a detailed moneySummary of one whole month.
 * @param {string} month 'YYYY-MM'
 * @param {Object} m moneySummary(input, monthBounds(month), {detail: true})
 * @param {Object} src bill sources (for parties)
 * @param {number} now
 */
export function buildSnapshot(month, m, src, now = Date.now()) {
    const range = monthBounds(month);
    const items = {};
    itemSummary(m).forEach(r => {
        items[r.itemKey || '_'] = { s: r.sales, c: r.cogs, q: r.qty, r: r.retail, w: r.wholesale };
    });
    const allCustomers = partySummary(src, 'sales', range);
    const parties = (kind) => (kind === 'sales' ? allCustomers : partySummary(src, kind, range)).slice(0, TOP_PARTIES)
        .map(p => ({ k: p.key, n: p.name, t: p.total, c: p.count }));
    const categories = {};
    (m.M4.byCategory || []).forEach(c => { categories[c.category] = c.total; });
    // Per day of month (sales, profit), so a part month compares with the same days last year.
    const days = {};
    (m.detail?.sales || []).forEach(r => {
        if (!Number.isFinite(r.t)) return;
        const k = new Date(r.t).getDate();
        days[k] = days[k] || { s: 0, p: 0 };
        days[k].s = Math.round((days[k].s + (Number(r.amount) || 0)) * 100) / 100;
    });
    if (m.M6.total !== null && m.detail) {
        Object.entries(profitPerDay(m)).forEach(([k, v]) => {
            const d = Number(String(k).slice(8, 10));
            days[d] = days[d] || { s: 0, p: 0 };
            days[d].p = v;
        });
    }
    return {
        month,
        v: SNAPSHOT_VERSION,
        m: {
            M1: m.M1.total, M1c: m.M1.count, M1r: m.M1.retail.total, M1w: m.M1.wholesale.total,
            M2: m.M2, M3: m.M3.total, M4: m.M4.total, M5: m.M5, M6: m.M6.total, M7: m.M7,
            M8: m.M8.total, M9: m.M9, M10: m.M10, M12: m.M12.total, M13: m.M13.total, M14: m.M14,
            M16: m.M16.total, M16c: m.M16.count, close: m.M17 ? m.M17.closing : null, Cc: allCustomers.length
        },
        items,
        customers: parties('sales'),
        suppliers: parties('purchases'),
        categories,
        days,
        builtAt: now
    };
}

/**
 * Every customer of a snapshot's month, or null when the stored list was cut to the top
 * TOP_PARTIES (m.Cc = how many there were; older snapshots without it count as cut when full).
 * @param {?Object} doc
 * @returns {?Array<{key: string, name: string}>}
 */
export function snapshotCustomers(doc) {
    if (!doc || !Array.isArray(doc.customers)) return null;
    const all = Number(doc.m?.Cc);
    const cut = Number.isFinite(all) ? all > doc.customers.length : doc.customers.length >= TOP_PARTIES;
    return cut ? null : doc.customers.map(p => ({ key: p.k, name: p.n }));
}

/**
 * The figures a page compares with, from a snapshot (same names as moneySummary).
 * @param {?Object} doc
 * @returns {?Object}
 */
export function figuresFromSnapshot(doc) {
    if (!doc || !doc.m) return null;
    const m = doc.m;
    return {
        month: doc.month,
        M1: m.M1, M1count: m.M1c, M2: m.M2, M3: m.M3, M4: m.M4, M5: m.M5, M6: m.M6, M7: m.M7,
        M8: m.M8, M9: m.M9, M10: m.M10, M12: m.M12, M13: m.M13, M14: m.M14, M16: m.M16, closing: m.close,
        items: Object.entries(doc.items || {}).map(([k, v]) => ({ key: k === '_' ? '' : k, sales: v.s, cogs: v.c, profit: v.c === null ? null : v.s - v.c })),
        customers: (doc.customers || []).map(p => ({ key: p.k, name: p.n, total: p.t, count: p.c })),
        suppliers: (doc.suppliers || []).map(p => ({ key: p.k, name: p.n, total: p.t, count: p.c })),
        categories: Object.entries(doc.categories || {}).map(([key, total]) => ({ key, total }))
    };
}

/**
 * Sales and profit of days `fromDay`…`uptoDay` of a snapshot's month (CMP for a part month).
 * @param {?Object} doc
 * @param {number} uptoDay 1–31
 * @param {number} [fromDay=1]
 * @returns {?{M1: number, M6: ?number}}
 */
export function partialFigures(doc, uptoDay, fromDay = 1) {
    if (!doc || !doc.days) return null;
    let s = 0;
    let p = 0;
    Object.entries(doc.days).forEach(([d, v]) => {
        if (Number(d) >= fromDay && Number(d) <= uptoDay) { s += v.s || 0; p += v.p || 0; }
    });
    return { M1: Math.round(s * 100) / 100, M6: doc.m && doc.m.M6 === null ? null : Math.round(p * 100) / 100 };
}

/**
 * Figures for any [from, to) from month snapshots. Whole months add all
 * figures; a part first or last month adds only its days (sales and profit),
 * so a range starting mid-month is never padded with the whole month.
 * @param {Object<string, Object>} docs month → snapshot doc
 * @param {number} from
 * @param {number} to
 * @returns {?Object} null when a month is missing
 */
export function rangeFigures(docs, from, to) {
    const keys = monthKeysBetween(from, to);
    if (!keys.length) return null;
    // Nearest local midnight, so a DST hour does not move the day.
    const dayOf = (ms) => { const d = new Date(ms + 12 * 3600000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
    const parts = keys.map(k => {
        const b = monthBounds(k);
        const startsInside = from > b.from + 12 * 3600000;
        const endsInside = to < b.to - 12 * 3600000;
        if (!startsInside && !endsInside) return { whole: figuresFromSnapshot(docs[k]) };
        const fromDay = startsInside ? dayOf(from).getDate() : 1;
        const uptoDay = endsInside ? new Date(dayOf(to).getTime() - 1).getDate() : 31;
        return { part: partialFigures(docs[k], uptoDay, fromDay) };
    });
    if (parts.some(p => !(p.whole || p.part))) return null;
    if (parts.every(p => p.whole)) return sumFigures(parts.map(p => p.whole));
    const add = (k) => parts.some(p => (p.whole || p.part)[k] === null || (p.whole || p.part)[k] === undefined)
        ? null : Math.round(parts.reduce((a, p) => a + (p.whole || p.part)[k], 0) * 100) / 100;
    return { M1: add('M1'), M6: add('M6') };
}

/**
 * Sum of whole-month figures (for a period made of whole months, e.g. a year).
 * @param {Array<?Object>} list figuresFromSnapshot results
 * @returns {?Object} null when any month is missing
 */
export function sumFigures(list) {
    if (!list.length || list.some(x => !x)) return null;
    const keys = ['M1', 'M1count', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M12', 'M13', 'M14', 'M16'];
    const out = {};
    keys.forEach(k => {
        out[k] = list.some(x => x[k] === null || x[k] === undefined) ? null : list.reduce((a, x) => a + x[k], 0);
    });
    return out;
}

/**
 * Which months to rebuild from the loaded bills: the current and previous
 * month when their snapshot is missing, stale, older than the roll interval,
 * or from another version; only months fully inside the loaded window.
 * @param {Object<string, Object>} docs month → snapshot doc
 * @param {{now: number, loadedFrom: number}} ctx loadedFrom 0 = full history
 * @returns {string[]}
 */
export function monthsToRoll(docs, { now, loadedFrom }) {
    const d = new Date(now);
    const keys = [monthKeyOf(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime()), monthKeyOf(now)];
    return keys.filter(k => {
        if (monthBounds(k).from < (loadedFrom || 0)) return false;
        const doc = docs[k];
        return !doc || doc.stale || doc.v !== SNAPSHOT_VERSION || now - (doc.builtAt || 0) > SNAPSHOT_ROLL_MS;
    });
}
