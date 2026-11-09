// @ts-check
/**
 * @fileoverview Ask item reports (#415, docs/calculations.md ASK-5, ASK-6): what was bought
 * or sold, by item kind, party or month: how many kg, at what weighted average rate and for
 * how much, bill by bill. A question becomes a small report spec (validateSpec); the rows come
 * from the bills the same way Insights › Items (purchaseItems, itemSummary) and Statements'
 * CSV (ST5) take them, so the figures add up to History and Money (M1, M16, M7). Also the
 * Excel / CSV sheets of a report. Pure: no DOM, no AppState, no Firestore.
 * @module utils/ask-report
 */

import { billsInRange } from './finance-calc.js';
import { billLabour, billTotal, readLineItem, round2 } from './money.js';
import { createItemKeyResolver, eventTime } from './stock-replay.js';
import { periodRange } from './business-metrics.js';
import { partyDisplayNames, partyNameKey, partyNameSpelling } from './parties.js';
import { devanagariToLatin, suggestEnglishName, suggestHindiName } from './item-name-autofill.js';
import { csvCell } from './statements.js';
import { endOfLocalDayExclusive, formatMonth, toLocalISODate } from './dates.js';
import { t } from '../i18n/index.js';

/** Periods an item report can cover (business-metrics periodRange presets). */
export const REPORT_PRESETS = Object.freeze(['today', 'this-month', 'last-month', 'this-year', 'last-year', 'this-fy', 'last-fy', 'all',
    'since-last-month', 'since-last-year', 'since-last-fy']);
/** Bills a report counts: purchases, all sales, or one kind of sale. */
export const REPORT_TYPES = Object.freeze(['purchase', 'sale', 'retail', 'wholesale']);
/** What a report's groups are: item kinds, parties or months. */
export const REPORT_GROUPS = Object.freeze(['item', 'party', 'month']);
/** Bill type → its Firestore collection key. */
export const REPORT_COLLECTIONS = Object.freeze({ purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' });
const MEASURES = ['kg', 'amount', 'avgRate', 'bills', 'labour', 'net'];
const MAX_KEYS = 1000;

/**
 * @typedef {{v: 1, billType: string, item: ?{text: string, mode: 'family'}, party: ?{text: string}, keys: ?string[],
 *   range: {preset: string}, groupBy: string, measures: string[]}} ReportSpec
 * item: the typed words (item kinds, and a party's name among them); keys: the kinds picked by hand
 */

const specText = (/** @type {*} */ v) => (typeof v === 'string' ? v.normalize('NFC').trim().slice(0, 80) : '');

/**
 * The one gate for a report spec, from the rules, the "Change" controls or later any other
 * source: known keys and values only, everything else dropped; null when it can't be run.
 * @param {*} spec
 * @returns {?ReportSpec}
 */
export function validateSpec(spec) {
    if (!spec || typeof spec !== 'object' || spec.v !== 1) return null;
    if (!REPORT_TYPES.includes(spec.billType)) return null;
    const preset = REPORT_PRESETS.includes(spec.range?.preset) ? spec.range.preset : null;
    if (!preset) return null;
    const item = specText(spec.item?.text);
    const party = specText(spec.party?.text);
    const keys = Array.isArray(spec.keys)
        ? [...new Set(spec.keys.filter((/** @type {*} */ k) => typeof k === 'string' && k).map((/** @type {string} */ k) => k.slice(0, 200)))].slice(0, MAX_KEYS)
        : null;
    const measures = Array.isArray(spec.measures) ? MEASURES.filter(m => spec.measures.includes(m)) : [];
    return {
        v: 1, billType: spec.billType, item: item ? { text: item, mode: 'family' } : null, party: party ? { text: party } : null, keys,
        range: { preset }, groupBy: REPORT_GROUPS.includes(spec.groupBy) ? spec.groupBy : 'item', measures: measures.length ? measures : [...MEASURES]
    };
}

/**
 * The bill types a report of `billType` counts: all sales are retail and wholesale, or retail
 * only for a role without Wholesale (as Outstanding); none for wholesale without it.
 * @param {string} billType REPORT_TYPES
 * @param {boolean} wholesale the role may see wholesale bills
 * @returns {Array<'purchase'|'retail'|'wholesale'>}
 */
export function reportBillTypes(billType, wholesale) {
    if (billType === 'purchase') return ['purchase'];
    if (billType === 'retail') return ['retail'];
    if (billType === 'wholesale') return wholesale ? ['wholesale'] : [];
    if (billType === 'sale') return wholesale ? ['retail', 'wholesale'] : ['retail'];
    return [];
}

const DEVANAGARI = /[\u0900-\u097F]/;

/** One word in a loose Latin spelling: "लाह", "Laah" and "lah" are all "lah". */
function looseWord(/** @type {string} */ word) {
    const w = partyNameKey(word);
    const latin = DEVANAGARI.test(w) ? devanagariToLatin(w) : w;
    return latin.replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/w/g, 'v').replace(/[^a-z0-9]/g, '');
}

/**
 * Words that name the same item in this trade, in any spelling: a word matches its whole
 * group, typed or in an item's name. Whole words only, so "Lahsun" never joins "lah".
 * Add a group here when the shop's bills use another name for an item.
 */
export const ITEM_WORD_SYNONYMS = Object.freeze([
    Object.freeze(['lah', 'lakh', 'लाह', 'लाख']),
    Object.freeze(['katki', 'kadki', 'कटकी', 'कदकी'])
]);
/** loose word → the loose words of its synonym group */
/** @type {Map<string, string[]>} */
const SYNONYMS = new Map();
ITEM_WORD_SYNONYMS.forEach(group => {
    const keys = [...new Set(group.map(looseWord))];
    keys.forEach(k => SYNONYMS.set(k, keys));
});

/** The loose spellings of a word, also through the item-name table (#134: chawal = चावल = Rice) and ITEM_WORD_SYNONYMS. */
function wordVariants(/** @type {string} */ word, synonyms = true) {
    const out = new Set([word, suggestHindiName(word), suggestEnglishName(word)].map(w => looseWord(w || '')).filter(Boolean));
    if (synonyms) [...out].forEach(v => (SYNONYMS.get(v) || []).forEach(s => out.add(s)));
    return out;
}

/** Loose spellings of every word of a name (without ITEM_WORD_SYNONYMS when `synonyms` is false). */
function nameWords(/** @type {string[]} */ names, synonyms = true) {
    const out = new Set();
    names.forEach((/** @type {*} */ n) => partyNameKey(n).split(' ').filter(Boolean).forEach(w => wordVariants(w, synonyms).forEach(v => out.add(v))));
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
    const withWords = kinds.map(k => ({ k, words: nameWords([k.name, k.hindiName]), own: nameWords([k.name, k.hindiName], false) }));
    const hitsOf = (/** @type {Set<string>} */ v) => withWords.filter(x => [...v].some(s => x.words.has(s))).map(x => x.k);
    const hits = words.map(x => hitsOf(x.v));
    const matched = hits.filter(h => h.length);
    let found = matched.length ? matched.reduce((a, h) => a.filter(k => h.includes(k))) : [];
    if (!found.length && matched.length) found = [...new Set(matched.flat())];
    const loose = words.map(x => looseWord(x.w)).filter(w => w.length >= 2);
    const near = withWords.filter(x => !found.includes(x.k) && loose.some(w => [...x.own].some(s => s.startsWith(w) && s !== w))).map(x => x.k);
    const unknown = words.filter((x, i) => !hits[i].length).map(x => x.w);
    const byName = (/** @type {{name: string, hindiName: string}} */ a, /** @type {{name: string, hindiName: string}} */ b) => (a.name || a.hindiName).localeCompare(b.name || b.hindiName);
    return { kinds: [...found].sort(byName), near: near.sort(byName), unknown };
}

/**
 * Whether a typed word starts a word of a kind's own name, in any spelling ("chaw" → Chawal, "lahs" → लहसुन).
 * @param {string} word
 * @param {{name: string, hindiName: string}} kind
 * @returns {boolean}
 */
export function startsKindName(word, kind) {
    const l = looseWord(word);
    return l.length >= 2 && [...nameWords([kind.name, kind.hindiName], false)].some(s => s.startsWith(l));
}

const billNo = (/** @type {Rec} */ b) => String(b?.billNumber || b?.billNo || '');
/** A bill's party as typed (PARTY: the same field Insights › Parties groups by). */
const billParty = (/** @type {Rec} */ b) => partyNameSpelling(b?.customerName ?? b?.supplierName);
const UNDATED = Number.MAX_SAFE_INTEGER;

/**
 * The parties on these bills, one per PARTY key, with the spelling used most (no unnamed bills).
 * @param {?Array<Rec>|undefined} bills
 * @returns {Array<{key: string, name: string}>}
 */
export function reportParties(bills) {
    return [...partyDisplayNames((bills || []).map(billParty))].map(([key, name]) => ({ key, name }));
}

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

/** Local "YYYY-MM" of a bill time, '' when undated. */
function monthKey(/** @type {number} */ time) {
    if (time === UNDATED || !Number.isFinite(time)) return '';
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @typedef {{kg: number, amount: number, labour: number, net: number, avgRate: ?number, bills: number,
 *   adjust: ?number, billsTotal: ?number}} ReportTotals
 * adjust / billsTotal: only when every line of the group's bills is counted (no kinds picked,
 * grouped by party or month): the bills' discounts and rounding, and the bills' own total
 */

/**
 * ASK-5 (purchases) / ASK-6 (sales): the bill lines of the chosen kinds (null = every item)
 * in [from, to), of one party when `partyKey` is set, grouped by item kind, party or month,
 * bill by bill, with each group's totals. A line's amount is its saved line amount
 * (readLineItem, as AVG-COST and Insights › Items); on a purchase its labour is the bill's labour
 * shared by line value in whole paise (labourShares; Insights › Items and ST5 share it the same
 * way, unrounded), so the lines after labour, with the bills' adjustments, add up to M16; sale
 * lines with theirs add up to M1. Average rate = total amount ÷ total kg (weighted by kg).
 * @param {Array<{type: 'purchase'|'retail'|'wholesale', bills: ?Array<Rec>|undefined}>} sources
 * @param {?Array<{id: string, name?: string, hindiName?: string}>|undefined} items catalogue
 * @param {{kinds: ?Array<{key: string, name: string, hindiName: string}>, partyKey?: ?string, groupBy?: string, billType?: string}} pick
 * @param {{from: number, to: number}} range
 */
export function itemReport(sources, items, { kinds, partyKey = null, groupBy = 'item', billType = 'purchase' }, { from, to }) {
    const getKey = createItemKeyResolver(items || []);
    const byId = new Map((items || []).map(i => [i.id, i]));
    const wanted = kinds ? new Set(kinds.map(k => k.key)) : null;
    const whole = !kinds;
    /** @type {Map<string, {key: string, name: string, hindiName: string, month: ?number, rows: Array<Rec>, raw: Rec, bills: Set<Rec>}>} */
    const groups = new Map();
    const group = (/** @type {string} */ key, /** @type {{name?: string, hindiName?: string, month?: ?number}} */ info) => {
        if (!groups.has(key)) groups.set(key, { key, name: info.name || '', hindiName: info.hindiName || '', month: info.month ?? null, rows: [], raw: { kg: 0, amount: 0, labour: 0, adjust: 0 }, bills: new Set() });
        return /** @type {*} */ (groups.get(key));
    };
    (kinds || []).forEach(k => { if (groupBy === 'item') group(k.key, k); });
    const ranged = sources.map(({ type, bills }) => ({ type, bills: billsInRange(bills || [], from, to) }));
    // one spelling per party across all the bill types (the one used most)
    const partyName = new Map(reportParties(ranged.flatMap(s => s.bills)).map(p => [p.key, p.name]));
    const all = { kg: 0, amount: 0, labour: 0, adjust: 0 };
    const allBills = new Set();
    ranged.forEach(({ type, bills: inRange }) => {
        const purchase = type === 'purchase';
        inRange.forEach(b => {
            const party = billParty(b);
            const pk = partyNameKey(party);
            if (partyKey !== null && pk !== partyKey) return;
            const lines = (Array.isArray(b.items) ? b.items : []).map((/** @type {BillLine} */ l) => ({ l, v: readLineItem(l) }));
            const shares = purchase ? labourShares(billLabour(b), lines.map(x => x.v.total)) : lines.map(() => 0);
            const time = eventTime(/** @type {Rec} */ (b));
            const month = groupBy === 'month' ? monthKey(time) : null;
            const billGroup = groupBy === 'party' ? group(pk, { name: pk }) : groupBy === 'month' ? group(/** @type {string} */ (month), { month: month ? new Date(time).setDate(1) : null }) : null;
            let net = 0;
            lines.forEach(({ l, v }, i) => {
                const key = getKey(l);
                if (wanted && !wanted.has(key)) return;
                const it = byId.get(key);
                const item = { name: it ? String(it.name || '') : (key === '__unknown__' ? '' : String(l.name || '').trim()), hindiName: it ? String(it.hindiName || '') : '' };
                const g = billGroup || group(key, item);
                const share = shares[i];
                for (const r of [g.raw, all]) {
                    r.kg += v.qty;
                    r.amount += v.total;
                    r.labour += share;
                }
                net += v.total - share;
                g.bills.add(b);
                allBills.add(b);
                g.rows.push({
                    billNo: billNo(b), time, type, party, itemKey: key, item, qty: v.qty,
                    rate: v.rate > 0 ? v.rate : (v.qty > 0 ? round2(v.total / v.qty) : 0),
                    amount: v.total, labour: share, net: round2(v.total - share)
                });
            });
            if (!whole) return;
            const rest = billTotal(b) - net;
            allBills.add(b);
            if (billGroup) billGroup.bills.add(b);
            if (Math.abs(rest) < 0.005) return;
            all.adjust += rest;
            if (billGroup) billGroup.raw.adjust += rest;
        });
    });
    const totals = (/** @type {Rec} */ r, /** @type {number} */ bills, /** @type {boolean} */ withAdjust) => {
        const net = round2(r.amount - r.labour);
        return {
            kg: round2(r.kg), amount: round2(r.amount), labour: round2(r.labour), net,
            avgRate: r.kg > 0 ? round2(r.amount / r.kg) : null, bills,
            adjust: withAdjust ? round2(r.adjust) : null, billsTotal: withAdjust ? round2(r.amount - r.labour + r.adjust) : null
        };
    };
    const byName = (/** @type {Rec} */ a, /** @type {Rec} */ b) => String(a.name || a.hindiName).localeCompare(String(b.name || b.hindiName));
    let list = [...groups.values()];
    if (groupBy === 'party') list.forEach(g => { g.name = partyName.get(g.key) || ''; });
    if (groupBy === 'month') list.sort((a, b) => (a.month ?? Infinity) - (b.month ?? Infinity));
    else if (!(groupBy === 'item' && kinds)) list.sort((a, b) => (!a.key ? 1 : 0) - (!b.key ? 1 : 0) || b.raw.kg - a.raw.kg || byName(a, b));
    const out = list.map(g => ({
        key: g.key, name: g.name, hindiName: g.hindiName, month: g.month,
        rows: g.rows.sort((a, b) => a.time - b.time || a.billNo.localeCompare(b.billNo, 'en', { numeric: true })),
        totals: totals(g.raw, g.bills.size, whole && groupBy !== 'item')
    }));
    return {
        billType, groupBy, kinds: kinds ? kinds.length : null, party: partyKey === null ? null : (partyName.get(partyKey) || partyKey),
        groups: out, totals: totals(all, allBills.size, whole), rowCount: out.reduce((n, g) => n + g.rows.length, 0)
    };
}

/**
 * ASK-5: the purchase lines of the chosen kinds, one group per kind (itemReport).
 * @param {?Array<Rec>|undefined} purchases bills (voided bills and opening records are left out)
 * @param {?Array<{id: string, name?: string, hindiName?: string}>|undefined} items catalogue
 * @param {Array<{key: string, name: string, hindiName: string}>} kinds
 * @param {{from: number, to: number}} range
 */
export function itemPurchaseReport(purchases, items, kinds, range) {
    return itemReport([{ type: 'purchase', bills: purchases }], items, { kinds }, range);
}

/**
 * What a role that sees weights only gets of a report: each group's kg and bill count, no
 * amounts, rates or bill rows.
 * @param {ReturnType<typeof itemReport>} report
 */
export function kgOnlyReport(report) {
    const keep = (/** @type {ReportTotals} */ x) => ({ kg: x.kg, bills: x.bills });
    return {
        billType: report.billType, groupBy: report.groupBy, kinds: report.kinds, party: report.party, kgOnly: true,
        groups: report.groups.map(g => ({ key: g.key, name: g.name, hindiName: g.hindiName, month: g.month, rows: [], totals: keep(g.totals) })),
        totals: keep(report.totals), rowCount: 0
    };
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
 * over the copies read for the report, without the bills voided on this phone. From
 * `windowFrom` on the phone has every bill with a numeric `timestamp` live, so such copies
 * read for the report count only before it (a bill deleted since on another phone stays out);
 * records without one (old app versions) are kept: the window queries never return them.
 * @param {?Array<Rec>|undefined} loaded
 * @param {?Array<Rec>|undefined} fetched
 * @param {Iterable<string>} [voidedIds]
 * @param {number} [windowFrom] start of the live window (ms)
 * @returns {Array<Rec>}
 */
export function mergeReportBills(loaded, fetched, voidedIds = [], windowFrom = Infinity) {
    const out = new Map();
    (fetched || []).forEach(b => { if (b?.id && !(typeof b.timestamp === 'number' && b.timestamp >= windowFrom)) out.set(String(b.id), b); });
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

const blank = (/** @type {?number|undefined} */ v) => (v === null || v === undefined ? '' : v);

/**
 * A report group's name in `lang`: the kind's name (Hindi name in Hindi), the party, or the month.
 * @param {{groupBy: string}} report
 * @param {{name: string, hindiName: string, month?: ?number}} g
 * @param {'en'|'hi'} lang
 * @returns {string}
 */
export function groupLabel(report, g, lang) {
    const tl = (/** @type {string} */ k) => t(k, null, lang);
    if (report.groupBy === 'month') return g.month ? formatMonth(g.month, { lang }) : tl('ui.ask.no_date');
    if (report.groupBy === 'party') return g.name || tl('ui.ask.no_party_name');
    return (lang === 'hi' && g.hindiName ? g.hindiName : g.name || g.hindiName) || tl('ui.ask.no_item_name');
}

/**
 * The label of a report's all-groups total: all kinds, all items, all parties or all months.
 * @param {{groupBy: string, kinds: ?number}} report
 * @returns {string} an i18n key
 */
export function totalLabelKey(report) {
    if (report.groupBy === 'party') return 'ui.ask.total_parties';
    if (report.groupBy === 'month') return 'ui.ask.total_months';
    return report.kinds === null ? 'ui.ask.total_items' : 'ui.ask.total_kinds';
}

/**
 * The report as sheets: a Summary (the stamp, one row per group and the total), then one
 * sheet per group with its bill lines sorted by date and a totals row. Purchases add the
 * labour columns; all sales the bill type; groups by party or month the item; by month the
 * party; a report of every item the bills' adjustments and own total in the Summary.
 * @param {ReturnType<typeof itemReport>} report
 * @param {{lang: 'en'|'hi', stamp: Array<[string, string]>}} opts stamp: stampPairs() (shop, period, time, who)
 * @returns {Array<{name: string, rows: Array<Array<*>>, widths: number[]}>}
 */
export function reportSheets(report, { lang, stamp }) {
    const tl = (/** @type {string} */ k) => t(k, null, lang);
    const purchase = report.billType === 'purchase';
    const both = report.billType === 'sale';
    const whole = report.totals.billsTotal !== null && report.totals.billsTotal !== undefined;
    const used = new Set();
    const groups = report.groups.filter(g => g.totals.bills);
    const kindName = (/** @type {{name: string, hindiName: string}} */ k) => (lang === 'hi' && k.hindiName ? k.hindiName : k.name || k.hindiName) || tl('ui.ask.no_item_name');
    const groupHead = { item: 'ui.ask.col_kind', party: 'ui.ask.col_party', month: 'ui.ask.col_month' }[report.groupBy] || 'ui.ask.col_kind';
    const summaryHead = [tl(groupHead), tl('ui.ask.col_bills'), tl('ui.ask.col_weight'), tl('ui.ask.col_avg_rate'), tl('ui.ask.col_amount'),
        ...(purchase ? [tl('ui.ask.col_labour'), tl('ui.ask.col_net')] : []), ...(whole ? [tl('ui.ask.col_adjust'), tl('ui.ask.col_bills_total')] : [])];
    const sumRow = (/** @type {string} */ label, /** @type {Rec} */ x) => [label, x.bills, x.kg, blank(x.avgRate), x.amount,
        ...(purchase ? [x.labour, x.net] : []), ...(whole ? [blank(x.adjust), blank(x.billsTotal)] : [])];
    const summary = {
        name: sheetName(tl('ui.ask.sheet_summary'), used),
        rows: [
            [tl(`ui.ask.sheet_title_${report.billType}`)],
            ...stamp.map(([k, v]) => [k, v]),
            ...(report.party ? [[tl('ui.ask.col_party'), report.party]] : []),
            [],
            summaryHead,
            ...groups.map(g => sumRow(groupLabel(report, g, lang), g.totals)),
            sumRow(tl(totalLabelKey(report)), report.totals)
        ],
        widths: [24, 8, 12, 14, 14, ...(purchase ? [12, 14] : []), ...(whole ? [14, 14] : [])]
    };
    const withItem = report.groupBy !== 'item';
    const withParty = report.groupBy === 'month';
    const typeName = (/** @type {string} */ type) => tl(`ui.ask.type_${type}_short`);
    const head = [tl('ui.ask.col_bill_no'), tl('ui.ask.col_date'), ...(both ? [tl('ui.ask.col_type')] : []), ...(withItem ? [tl('ui.ask.col_item')] : []),
        ...(withParty ? [tl('ui.ask.col_party')] : []), tl('ui.ask.col_weight'), tl('ui.ask.col_rate'), tl('ui.ask.col_amount'),
        ...(purchase ? [tl('ui.ask.col_labour'), tl('ui.ask.col_net')] : [])];
    const lead = (both ? 1 : 0) + (withItem ? 1 : 0) + (withParty ? 1 : 0);
    const sheets = groups.map(g => {
        const label = groupLabel(report, g, lang);
        return {
            name: sheetName(label, used),
            rows: [
                [label],
                head,
                ...g.rows.map(r => [r.billNo, r.time === UNDATED ? '' : toLocalISODate(new Date(r.time)), ...(both ? [typeName(r.type)] : []),
                    ...(withItem ? [kindName(r.item)] : []), ...(withParty ? [r.party] : []), r.qty, r.rate, r.amount, ...(purchase ? [r.labour, r.net] : [])]),
                [tl('ui.ask.col_total'), '', ...Array(lead).fill(''), g.totals.kg, blank(g.totals.avgRate), g.totals.amount, ...(purchase ? [g.totals.labour, g.totals.net] : [])]
            ],
            widths: [12, 12, ...(both ? [12] : []), ...(withItem ? [20] : []), ...(withParty ? [20] : []), 12, 12, 14, ...(purchase ? [12, 14] : [])]
        };
    });
    return [summary, ...sheets];
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
