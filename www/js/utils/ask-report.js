// @ts-check
/**
 * @fileoverview Ask item reports (#415, docs/calculations.md ASK-5): which kinds of an item
 * were bought, how many kg, at what weighted average rate and for how much, bill by bill.
 * A question becomes a small report spec (validateSpec); the rows come from the bills the
 * same way Insights › Items (purchaseItems) and Statements' CSV (ST5) take them, so the
 * figures add up to History and Money (M16, M7). Also the Excel / CSV sheets of a report.
 * Pure: no DOM, no AppState, no Firestore.
 * @module utils/ask-report
 */

import { billsInRange } from './finance-calc.js';
import { billLabour, readLineItem, round2 } from './money.js';
import { createItemKeyResolver, eventTime } from './stock-replay.js';
import { periodRange } from './business-metrics.js';
import { partyNameKey } from './parties.js';
import { devanagariToLatin, suggestEnglishName, suggestHindiName } from './item-name-autofill.js';
import { csvCell } from './statements.js';
import { endOfLocalDayExclusive, toLocalISODate } from './dates.js';
import { t } from '../i18n/index.js';

/** Periods an item report can cover (business-metrics periodRange presets). */
export const REPORT_PRESETS = Object.freeze(['today', 'this-month', 'last-month', 'this-year', 'last-year', 'this-fy', 'last-fy', 'all',
    'since-last-month', 'since-last-year', 'since-last-fy']);
const BILL_TYPES = ['purchase'];
const MEASURES = ['kg', 'amount', 'avgRate', 'bills', 'labour', 'net'];

/**
 * @typedef {{v: 1, billType: 'purchase', item: {text: string, mode: 'family'}, range: {preset: string},
 *   groupBy: 'item', measures: string[]}} ReportSpec
 */

/**
 * The one gate for a report spec, from the rules or later any other source: known
 * keys and values only, everything else dropped; null when it can't be run.
 * @param {*} spec
 * @returns {?ReportSpec}
 */
export function validateSpec(spec) {
    if (!spec || typeof spec !== 'object' || spec.v !== 1) return null;
    if (!BILL_TYPES.includes(spec.billType)) return null;
    const text = typeof spec.item?.text === 'string' ? spec.item.text.normalize('NFC').trim().slice(0, 80) : '';
    if (!text) return null;
    const preset = REPORT_PRESETS.includes(spec.range?.preset) ? spec.range.preset : null;
    if (!preset) return null;
    const measures = Array.isArray(spec.measures) ? MEASURES.filter(m => spec.measures.includes(m)) : [];
    return { v: 1, billType: 'purchase', item: { text, mode: 'family' }, range: { preset }, groupBy: 'item', measures: measures.length ? measures : [...MEASURES] };
}

const DEVANAGARI = /[\u0900-\u097F]/;

/** One word in a loose Latin spelling: "लाह", "Laah" and "lah" are all "lah". */
function looseWord(/** @type {string} */ word) {
    const w = partyNameKey(word);
    const latin = DEVANAGARI.test(w) ? devanagariToLatin(w) : w;
    return latin.replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/w/g, 'v').replace(/[^a-z0-9]/g, '');
}

/** The loose spellings of a word, also through the item-name table (#134: chawal = चावल = Rice). */
function wordVariants(/** @type {string} */ word) {
    return new Set([word, suggestHindiName(word), suggestEnglishName(word)].map(w => looseWord(w || '')).filter(Boolean));
}

/** Loose spellings of every word of a name. */
function nameWords(/** @type {...*} */ ...names) {
    const out = new Set();
    names.forEach((/** @type {*} */ n) => partyNameKey(n).split(' ').filter(Boolean).forEach(w => wordVariants(w).forEach(v => out.add(v))));
    return out;
}

/**
 * The kinds a report can be about: every catalogue item (archived ones too: old bills
 * still count) and every bill-line name that matches none ("Unmatched").
 * @param {?Array<{id: string, name?: string, hindiName?: string}>|undefined} items
 * @param {?Array<Rec>|undefined} bills
 * @returns {Array<{key: string, name: string, hindiName: string}>}
 */
export function reportKinds(items, bills) {
    const getKey = createItemKeyResolver(items || []);
    const ids = new Set((items || []).map(i => i.id));
    /** @type {Map<string, {key: string, name: string, hindiName: string}>} */
    const out = new Map((items || []).filter(i => i && i.id).map(i => [i.id, { key: i.id, name: String(i.name || ''), hindiName: String(i.hindiName || '') }]));
    (bills || []).forEach(b => (Array.isArray(b?.items) ? b.items : []).forEach((/** @type {Rec} */ l) => {
        const key = getKey(l);
        if (!ids.has(key) && key !== '__unknown__' && !out.has(key)) out.set(key, { key, name: String(l.name || '').trim(), hindiName: '' });
    }));
    return [...out.values()].filter(k => k.name || k.hindiName);
}

/**
 * The kinds the typed words name. A kind matches a word when one of its name's words
 * is that word (any spelling, Latin or Devanagari); several matching words narrow it down
 * ("lah kusmi"). A name that only starts with the word ("Lahsun" for "lah") is never
 * included: it is listed in `near`. Words that name nothing are in `unknown` (a party's
 * name: the report would not be about it, so the answer gives no figure).
 * @param {Array<{key: string, name: string, hindiName: string}>} kinds reportKinds()
 * @param {string} text the typed subject
 * @returns {{kinds: Array<{key: string, name: string, hindiName: string}>, near: Array<{key: string, name: string, hindiName: string}>, unknown: string[]}}
 */
export function matchKinds(kinds, text) {
    const words = partyNameKey(text).split(' ').filter(Boolean).map(w => ({ w, v: wordVariants(w) }));
    const withWords = kinds.map(k => ({ k, words: nameWords(k.name, k.hindiName) }));
    const hitsOf = (/** @type {Set<string>} */ v) => withWords.filter(x => [...v].some(s => x.words.has(s))).map(x => x.k);
    const hits = words.map(x => hitsOf(x.v));
    const matched = hits.filter(h => h.length);
    let found = matched.length ? matched.reduce((a, h) => a.filter(k => h.includes(k))) : [];
    if (!found.length && matched.length) found = [...new Set(matched.flat())];
    const loose = words.map(x => looseWord(x.w)).filter(w => w.length >= 2);
    const near = withWords.filter(x => !found.includes(x.k) && loose.some(w => [...x.words].some(s => s.startsWith(w) && s !== w))).map(x => x.k);
    const unknown = words.filter((x, i) => !hits[i].length).map(x => x.w);
    const byName = (/** @type {{name: string, hindiName: string}} */ a, /** @type {{name: string, hindiName: string}} */ b) => (a.name || a.hindiName).localeCompare(b.name || b.hindiName);
    return { kinds: [...found].sort(byName), near: near.sort(byName), unknown };
}

const billNo = (/** @type {Rec} */ b) => String(b?.billNumber || b?.billNo || '');

/**
 * A bill's labour shared by line value in whole paise that add up to it exactly (largest
 * remainder), so a sheet's labour column adds up to its totals row.
 * @param {number} labour
 * @param {number[]} values line amounts
 * @returns {number[]}
 */
export function labourShares(labour, values) {
    const value = values.reduce((a, v) => a + v, 0);
    const paise = Math.round(labour * 100);
    if (!(value > 0) || !paise) return values.map(() => 0);
    const exact = values.map(v => paise * v / value);
    const out = exact.map(Math.floor);
    let left = paise - out.reduce((a, v) => a + v, 0);
    exact.map((e, i) => ({ i, r: e - out[i] })).sort((a, b) => b.r - a.r).forEach(({ i }) => {
        if (left > 0) { out[i]++; left--; }
    });
    return out.map(p => p / 100);
}

/**
 * ASK-5: the purchase lines of the chosen kinds in [from, to), bill by bill, with each
 * kind's totals. A line's amount is its saved line amount (readLineItem, as AVG-COST);
 * its labour is the bill's labour shared by line value in whole paise (labourShares; Insights ›
 * Items and ST5 share it the same way, unrounded), so amount − labour of every line of every
 * kind adds up to M16 with the bills' adjustments.
 * Average rate = total amount ÷ total kg (weighted by kg, not a mean of the rates).
 * @param {?Array<Rec>|undefined} purchases bills (voided bills and opening records are left out)
 * @param {?Array<{id: string, name?: string, hindiName?: string}>|undefined} items catalogue
 * @param {Array<{key: string, name: string, hindiName: string}>} kinds
 * @param {{from: number, to: number}} range
 */
export function itemPurchaseReport(purchases, items, kinds, { from, to }) {
    const getKey = createItemKeyResolver(items || []);
    const groups = kinds.map(k => ({ ...k, rows: /** @type {Array<Rec>} */ ([]), raw: { kg: 0, amount: 0, labour: 0 }, bills: new Set() }));
    const byKey = new Map(groups.map(g => [g.key, g]));
    billsInRange(purchases || [], from, to).forEach(b => {
        const lines = (Array.isArray(b.items) ? b.items : []).map((/** @type {BillLine} */ l) => ({ l, v: readLineItem(l) }));
        const shares = labourShares(billLabour(b), lines.map(x => x.v.total));
        const time = eventTime(/** @type {Rec} */ (b));
        lines.forEach(({ l, v }, i) => {
            const g = byKey.get(getKey(l));
            if (!g) return;
            const share = shares[i];
            g.raw.kg += v.qty;
            g.raw.amount += v.total;
            g.raw.labour += share;
            g.bills.add(b);
            g.rows.push({
                billNo: billNo(b), time, qty: v.qty,
                rate: v.rate > 0 ? v.rate : (v.qty > 0 ? round2(v.total / v.qty) : 0),
                amount: v.total, labour: share, net: round2(v.total - share)
            });
        });
    });
    const totals = (/** @type {{kg: number, amount: number, labour: number}} */ r, /** @type {number} */ bills) => ({
        kg: round2(r.kg), amount: round2(r.amount), labour: round2(r.labour), net: round2(r.amount - r.labour),
        avgRate: r.kg > 0 ? round2(r.amount / r.kg) : null, bills
    });
    const all = { kg: 0, amount: 0, labour: 0 };
    const allBills = new Set();
    const out = groups.map(g => {
        all.kg += g.raw.kg;
        all.amount += g.raw.amount;
        all.labour += g.raw.labour;
        g.bills.forEach(b => allBills.add(b));
        const rows = g.rows.sort((a, b) => a.time - b.time || a.billNo.localeCompare(b.billNo, 'en', { numeric: true }));
        return { key: g.key, name: g.name, hindiName: g.hindiName, rows, totals: totals(g.raw, g.bills.size) };
    });
    return { groups: out, totals: totals(all, allBills.size), rowCount: out.reduce((n, g) => n + g.rows.length, 0) };
}

/**
 * The first and last day of a report's period for its file stamp (YYYY-MM-DD; no first
 * day for all time; the last day is never after today).
 * @param {{from: number, to: number}} period
 * @param {Date} now
 * @returns {{from: ?string, to: string}}
 */
export function reportDays(period, now) {
    const end = Math.min(period.to, /** @type {Date} */ (endOfLocalDayExclusive(now)).getTime()) - 1;
    return { from: Number.isFinite(period.from) ? toLocalISODate(new Date(period.from)) : null, to: toLocalISODate(new Date(end)) };
}

/**
 * The days a report preset covers; `loadFrom` is where the bills must start (null = all).
 * @param {string} preset REPORT_PRESETS
 * @param {Date} now
 * @param {Rec} [cfg] insightsSettings()
 * @returns {{preset: string, from: number, to: number, loadFrom: ?number}}
 */
export function reportPeriod(preset, now, cfg) {
    const p = REPORT_PRESETS.includes(preset) ? preset : 'this-month';
    const since = p.startsWith('since-');
    const r = periodRange(since ? p.slice(6) : p, now, /** @type {*} */ (cfg));
    const to = since ? periodRange('today', now, /** @type {*} */ (cfg)).to : r.to;
    return { preset: p, from: r.from, to, loadFrom: Number.isFinite(r.from) ? r.from : null };
}

/**
 * The bills a report runs on: the ones on the phone (live, with this phone's own changes)
 * over the copies read for the report, without the bills voided on this phone.
 * @param {?Array<Rec>|undefined} loaded
 * @param {?Array<Rec>|undefined} fetched
 * @param {Iterable<string>} [voidedIds]
 * @returns {Array<Rec>}
 */
export function mergeReportBills(loaded, fetched, voidedIds = []) {
    const out = new Map();
    (fetched || []).forEach(b => { if (b?.id) out.set(String(b.id), b); });
    /** @type {Array<Rec>} */
    const extra = [];
    (loaded || []).forEach(b => {
        if (b?.id) out.set(String(b.id), b);
        else if (b) extra.push(b);
    });
    for (const id of voidedIds) out.delete(String(id));
    return [...out.values(), ...extra];
}

/**
 * About how many documents a report read costs: the bills of the loaded window, plus as
 * many per day for the days between the oldest bill (or `from`) and the window.
 * @param {{loaded: ?Array<Rec>|undefined, windowFrom: number, now: number, oldest: number, from: ?number}} a
 * @returns {?number} null when the oldest bill's time is not known
 */
export function estimateReportReads({ loaded, windowFrom, now, oldest, from }) {
    if (!Number.isFinite(oldest) && oldest !== Infinity) return null;
    const inWindow = (loaded || []).filter(b => eventTime(b) >= windowFrom).length;
    const start = Math.max(Number.isFinite(oldest) ? oldest : windowFrom, from ?? -Infinity);
    const span = Math.max(now - windowFrom, 1);
    const older = Math.max(0, windowFrom - start);
    return Math.max(1, inWindow + Math.ceil(inWindow * older / span));
}

/**
 * Sheet name Excel accepts: at most 31 characters, none of []:*?/\, unique in the book.
 * @param {string} name
 * @param {Set<string>} used lower-case names taken so far (added to)
 * @returns {string}
 */
export function sheetName(name, used) {
    const base = (String(name || '').replace(/[[\]:*?/\\]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, 31).trim();
    let out = base;
    for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base.slice(0, 31 - ` (${n})`.length).trim()} (${n})`;
    used.add(out.toLowerCase());
    return out;
}

const blank = (/** @type {?number} */ v) => (v === null || v === undefined ? '' : v);

/**
 * The report as sheets: a Summary (the stamp, one row per kind and the total), then one
 * sheet per kind with its bill lines sorted by date and a totals row.
 * @param {ReturnType<typeof itemPurchaseReport>} report
 * @param {{lang: 'en'|'hi', stamp: Array<[string, string]>, period: string}} opts stamp: stampPairs()
 * @returns {Array<{name: string, rows: Array<Array<*>>, widths: number[]}>}
 */
export function reportSheets(report, { lang, stamp, period }) {
    const tl = (/** @type {string} */ k) => t(k, null, lang);
    const kindName = (/** @type {{name: string, hindiName: string}} */ g) => (lang === 'hi' && g.hindiName ? g.hindiName : g.name || g.hindiName);
    const used = new Set();
    const groups = report.groups.filter(g => g.rows.length);
    const summaryHead = [tl('ui.ask.col_kind'), tl('ui.ask.col_bills'), tl('ui.ask.col_weight'), tl('ui.ask.col_avg_rate'), tl('ui.ask.col_amount'), tl('ui.ask.col_labour'), tl('ui.ask.col_net')];
    const sumRow = (/** @type {string} */ label, /** @type {Rec} */ x) => [label, x.bills, x.kg, blank(x.avgRate), x.amount, x.labour, x.net];
    const summary = {
        name: sheetName(tl('ui.ask.sheet_summary'), used),
        rows: [
            [tl('ui.ask.report_sheet_title')],
            ...stamp.map(([k, v]) => [k, v]),
            [tl('ui.ask.col_period'), period],
            [],
            summaryHead,
            ...groups.map(g => sumRow(kindName(g), g.totals)),
            sumRow(tl('ui.ask.col_total_all'), report.totals)
        ],
        widths: [24, 8, 12, 14, 14, 12, 14]
    };
    const head = [tl('ui.ask.col_bill_no'), tl('ui.ask.col_date'), tl('ui.ask.col_weight'), tl('ui.ask.col_rate'), tl('ui.ask.col_amount'), tl('ui.ask.col_labour'), tl('ui.ask.col_net')];
    const kinds = groups.map(g => ({
        name: sheetName(kindName(g), used),
        rows: [
            [kindName(g)],
            head,
            ...g.rows.map(r => [r.billNo, toLocalISODate(new Date(r.time)), r.qty, r.rate, r.amount, r.labour, r.net]),
            [tl('ui.ask.col_total'), '', g.totals.kg, blank(g.totals.avgRate), g.totals.amount, g.totals.labour, g.totals.net]
        ],
        widths: [12, 12, 12, 12, 14, 12, 14]
    }));
    return [summary, ...kinds];
}

/**
 * The same sheets as one CSV (when Excel can't be made): each sheet's name, its rows,
 * then a blank line. Formulas are neutralised (csvCell).
 * @param {Array<{name: string, rows: Array<Array<*>>}>} sheets
 * @returns {string}
 */
export function reportCsv(sheets) {
    const lines = sheets.flatMap(s => [[`# ${s.name}`], ...s.rows, []]);
    return `\uFEFF${lines.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
