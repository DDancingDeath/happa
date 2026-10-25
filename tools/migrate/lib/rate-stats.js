/**
 * Buying and rate patterns for the new project: one `rateStats/{itemId}_{YYYY}`
 * document per item and year, with weekly buckets (IST weeks starting Monday,
 * key `w<YYYY-MM-DD of the Monday>`) and monthly buckets (key `m<YYYY-MM>`),
 * each { purchase, retail, wholesale: {kg, amount, min, max, avg, bills}, bills }.
 *
 * This is the layout of the Rate trends rework (branch feat/rate-trends-items-rate).
 * Until that branch exports its own aggregation from www/js/utils/rate-trends.js,
 * buildRateStatsDocs() below is the single place to switch over.
 * Line reading (kg, rate, catalogue matching, bill time) is the app's own.
 */
import {
    RATE_KINDS, createCatalogueResolver, emptySection, lineKg, lineRate, istDayKey, istMonthKey
} from '../../../www/js/utils/rate-trends.js';
import { eventTime } from '../../../www/js/utils/stock-replay.js';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** IST Monday 'YYYY-MM-DD' of the week containing ms. */
export function istWeekStartKey(ms) {
    const d = new Date(Number(ms) + IST_OFFSET_MS);
    const back = (d.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

/** Bucket keys of an instant: week (doc year = the Monday's year) and month. */
export function bucketKeys(ms) {
    const week = istWeekStartKey(ms);
    const month = istMonthKey(ms);
    return [
        { year: week.slice(0, 4), key: `w${week}` },
        { year: month.slice(0, 4), key: `m${month}` }
    ];
}

export const rateStatsDocId = (itemId, year) => `${itemId}_${year}`;

function finalize(s) {
    if (!s || !(s.kg > 0)) return emptySection();
    return { kg: round2(s.kg), amount: round2(s.amount), min: round2(s.min), max: round2(s.max), avg: round2(s.amount / s.kg), bills: s.bills || 0 };
}

/**
 * Yearly rateStats docs from every bill of the backup.
 * @param {{purchase?: Array, retail?: Array, wholesale?: Array}} sources bills by kind
 * @param {Array} items catalogue
 * @returns {{docs: Object.<string, Object>, bills: number, lines: number, skippedLines: number}}
 */
export function buildRateStatsDocs(sources, items) {
    const resolve = createCatalogueResolver(items);
    const acc = {};
    let bills = 0;
    let lines = 0;
    let skippedLines = 0;
    RATE_KINDS.forEach(kind => (sources?.[kind] || []).forEach(bill => {
        if (!bill || !Array.isArray(bill.items)) return;
        const t = eventTime(bill);
        if (!Number.isFinite(t) || t === Number.MAX_SAFE_INTEGER) return;
        const seen = new Set();
        let used = false;
        bill.items.forEach(line => {
            if (!line) return;
            const kg = lineKg(line);
            const rate = lineRate(line, kg);
            const itemId = kg > 0 && rate > 0 ? resolve(line) : null;
            if (!itemId) {
                skippedLines++;
                return;
            }
            lines++;
            used = true;
            bucketKeys(t).forEach(({ year, key }) => {
                const id = rateStatsDocId(itemId, year);
                const doc = acc[id] || (acc[id] = { itemId, year, bills: 0, buckets: {}, billSeen: new Set() });
                const b = doc.buckets[key] || (doc.buckets[key] = { bills: 0, kinds: {} });
                const s = b.kinds[kind] || (b.kinds[kind] = { kg: 0, amount: 0, min: null, max: null, bills: 0 });
                s.kg += kg;
                s.amount += kg * rate;
                s.min = s.min === null ? rate : Math.min(s.min, rate);
                s.max = s.max === null ? rate : Math.max(s.max, rate);
                const seenKey = `${id}|${key}`;
                if (!seen.has(seenKey)) {
                    seen.add(seenKey);
                    s.bills += 1;
                    b.bills += 1;
                }
                const billKey = `${kind}:${bill.id}`;
                if (!doc.billSeen.has(billKey)) {
                    doc.billSeen.add(billKey);
                    doc.bills += 1;
                }
            });
        });
        if (used) bills++;
    }));

    const docs = {};
    Object.keys(acc).sort().forEach(id => {
        const d = acc[id];
        const doc = { itemId: d.itemId, year: d.year, bills: d.bills };
        Object.keys(d.buckets).sort().forEach(key => {
            const b = d.buckets[key];
            const out = { bills: b.bills };
            RATE_KINDS.forEach(k => { out[k] = finalize(b.kinds[k]); });
            doc[key] = out;
        });
        docs[id] = doc;
    });
    return { docs, bills, lines, skippedLines };
}

/**
 * `rateStats/_meta` marking the history as built up to the cutoff, so the new
 * app does not offer the read-every-bill backfill.
 */
export function rateStatsMeta({ bills, docs, cutoff, now }) {
    const months = new Set();
    Object.values(docs).forEach(d => Object.keys(d).forEach(k => { if (/^m\d{4}-\d{2}$/.test(k)) months.add(k); }));
    return {
        backfillDone: true,
        backfillAt: now,
        bills,
        reads: 0,
        months: months.size,
        by: 'migration',
        byUserId: '',
        cutoff,
        cutoffDay: istDayKey(cutoff),
        source: 'migration'
    };
}
