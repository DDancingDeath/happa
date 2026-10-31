/**
 * @fileoverview Save-time / live bill checks (#37, #188) as one pure rule engine.
 *
 * `evaluateBill(draft, ctx)` returns a list of issues
 *   { id, field, severity: 'block' | 'warn', en, hi, overridable, line?, lines? }
 * - `id` is the rule id (stored as `rule` in a bill's `flags` / `overrides`).
 * - `field` says where the problem is: 'party', 'payment', 'date', 'bill',
 *   'items' (with `lines`), `items.<i>` (one line) or `entry.rate` / `entry.qty`
 *   (the line being typed, not yet in the bill — shown live, never gates Save).
 *
 * No DOM, no AppState, no clock: everything comes in through `draft` and `ctx`
 * (build `ctx` with `buildCheckContext(state, …)`), so the same rules can be
 * re-run later over saved bills (anomaly list, #187).
 * @module utils/bill-checks
 */

import {
    billTotal, dueNeedsName, NAME_REQUIRED_FOR_DUE_KEY, paymentSplitMessage, readLineItem, round2, toMoney
} from './money.js';
import { validatePaymentSplit } from './calc/billing.js';
import { parseAnyBillDate, startOfLocalDay } from './dates.js';
import { t } from '../i18n/index.js';
import { computeShortfallsFrom, stockKeyFor, approxStockNote, stockedItemKeys } from './stock-check.js';

/**
 * Defaults from the owner questionnaire (#106; blank answer = default).
 * Shop-wide overrides live in settings/app `checkThresholds` (owner only).
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
    /** Q18: oversell up to this many kg only warns; beyond it blocks. */
    oversellBlockKg: 5,
    /** Q15: rate more than this × (or less than 1/this ×) the usual rate warns. */
    rateMultiple: 2,
    /** Q21: same party + items + total within this many seconds = possible duplicate. */
    duplicateWindowSec: 120,
    /** Q14: bill dated more than this many minutes ahead of entry time. */
    maxFutureMin: 60,
    /** Q20: bill dated more than this many days before entry day. */
    backdateDays: 1,
    /** Q19: cash count difference up to this is fine … */
    cashOkRs: 50,
    /** … and above this it is a high mismatch. */
    cashHighRs: 200,
    /** Q17: stock adjustment above this many kg gets a flag. */
    stockAdjustFlagKg: 20,
    /** #124: this many refused changes by one person … */
    deniedCount: 3,
    /** … within this many minutes raise a review flag. */
    deniedWindowMin: 10
});

/** Rate list on an item for each bill kind (see utils/rate-history.js RATE_FIELDS). */
const ITEM_RATE_FIELD = { purchase: 'rates', retail: 'saleRates', wholesale: 'wholesaleRates' };

/** Rule ids an owner/manager may never override: saving them would corrupt money/stock. */
const HARD_RULES = new Set(['payment-none', 'party-required', 'payment-split', 'qty-invalid', 'rate-invalid']);

const normalize = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const fmtRs = (n) => `₹${round2(n).toLocaleString('en-IN')}`;
const fmtKg = (n) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * Thresholds with blank / invalid / non-positive values replaced by the defaults.
 * @param {Object} [raw]
 * @returns {typeof DEFAULT_THRESHOLDS}
 */
export function normalizeThresholds(raw = {}) {
    const out = { ...DEFAULT_THRESHOLDS };
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
        const n = toMoney(raw?.[key]);
        if (n !== null && n > 0) out[key] = n;
    }
    return out;
}

function issue(id, field, severity, en, hi, extra = {}) {
    return { id, field, severity, en, hi, overridable: severity === 'block' && !HARD_RULES.has(id), ...extra };
}

/** Bill-line key used to compare lines and look up rates (itemId, else name). */
function lineKey(item) {
    return item?.itemId || normalize(readLineItem(item).name);
}

/**
 * Most recent rate per item from saved bills of the same kind (newest wins).
 * @param {Array<Object>} bills
 * @param {string|null} skipId - bill being edited (its own old rate is not "usual")
 * @returns {Map<string, number>}
 */
function lastRates(bills, skipId) {
    const best = new Map();
    for (const bill of Array.isArray(bills) ? bills : []) {
        if (!bill || (skipId && bill.id === skipId) || !Array.isArray(bill.items)) continue;
        const ts = Number(bill.timestamp) || parseAnyBillDate(bill.date)?.getTime() || 0;
        for (const item of bill.items) {
            const key = lineKey(item);
            const { rate } = readLineItem(item);
            if (!key || !(rate > 0)) continue;
            const prev = best.get(key);
            if (!prev || ts > prev.ts) best.set(key, { ts, rate });
        }
    }
    return new Map([...best].map(([k, v]) => [k, v.rate]));
}

function findItem(line, catalogue) {
    if (line?.itemId) {
        const byId = catalogue.find(i => i.id === line.itemId);
        if (byId) return byId;
    }
    const name = normalize(readLineItem(line).name);
    return name ? catalogue.find(i => normalize(i.name) === name || normalize(i.hindiName) === name) || null : null;
}

/** Usual rate for a line: last billed rate of this kind, else the item's saved rate. */
function usualRate(line, ctx, rates) {
    const last = rates.get(lineKey(line));
    if (last > 0) return last;
    const item = findItem(line, ctx.catalogue);
    const field = ITEM_RATE_FIELD[ctx.kind];
    const saved = (Array.isArray(item?.[field]) ? item[field] : []).map(Number).find(r => Number.isFinite(r) && r > 0);
    return saved || null;
}

/** Average stock cost for a line (stock rate), or null when unknown. */
function avgCost(line, ctx) {
    const item = findItem(line, ctx.catalogue);
    const keys = [item?.id, line?.itemId, readLineItem(line).name, item?.name].filter(Boolean);
    for (const key of keys) {
        const rate = toMoney(ctx.stock?.[key]?.rate);
        if (rate && rate > 0) return rate;
    }
    return null;
}

/** Rate checks shared by bill lines and the line being typed. */
function rateIssues(line, field, ctx, rates, extra) {
    const out = [];
    // Legacy lines without a stored rate (total only) are not judged.
    if (toMoney(line?.rate) === null) return out;
    const { rate, name } = readLineItem(line);
    if (!(rate > 0)) {
        out.push(issue('rate-invalid', field, 'block',
            `${name ? name + ': ' : ''}rate must be more than ₹0`,
            `${name ? name + ': ' : ''}रेट ₹0 से ज़्यादा होना चाहिए`, extra));
        return out;
    }
    const usual = usualRate(line, ctx, rates);
    const m = ctx.thresholds.rateMultiple;
    if (usual) {
        const ratio = rate / usual;
        if (ratio > m + 1e-9) {
            out.push(issue('rate-high', field, 'warn',
                `Rate ${fmtRs(rate)} is ${ratio.toFixed(1)}× the usual ${fmtRs(usual)}`,
                `रेट ${fmtRs(rate)} सामान्य ${fmtRs(usual)} का ${ratio.toFixed(1)} गुना है`, extra));
        } else if (ratio < 1 / m - 1e-9) {
            out.push(issue('rate-low', field, 'warn',
                `Rate ${fmtRs(rate)} is less than 1/${m} of the usual ${fmtRs(usual)}`,
                `रेट ${fmtRs(rate)} सामान्य ${fmtRs(usual)} के 1/${m} से कम है`, extra));
        }
    }
    if (ctx.kind !== 'purchase') {
        const cost = avgCost(line, ctx);
        if (cost && rate < cost - 1e-9) {
            // Cost figures are shown to owner/manager only (#84 is still open).
            out.push(issue('below-cost', field, 'warn',
                ctx.showCost ? `Selling below average cost ${fmtRs(cost)}` : 'Selling below cost — check the rate',
                ctx.showCost ? `औसत लागत ${fmtRs(cost)} से कम में बिक्री` : 'लागत से कम में बिक्री — रेट जाँचें', extra));
        }
    }
    return out;
}

function qtyIssue(line, field, extra) {
    if (toMoney(line?.qty) === null && toMoney(line?.quantity) === null) return null;
    const { qty, name } = readLineItem(line);
    if (qty > 0) return null;
    return issue('qty-invalid', field, 'block',
        `${name ? name + ': ' : ''}weight/quantity must be more than 0`,
        `${name ? name + ': ' : ''}वज़न/मात्रा 0 से ज़्यादा होनी चाहिए`, extra);
}

function oversellIssues(items, ctx, extraLine) {
    if (ctx.kind === 'purchase') return [];
    const lines = extraLine ? [...items, extraLine] : items;
    const shortfalls = computeShortfallsFrom(lines,
        { items: ctx.catalogue, stock: ctx.stock, stockReady: ctx.stockReady }, ctx.credit);
    // Approximate stock (#129) may be off by older edits: warn, never block.
    const approx = ctx.stockApproximate ? approxStockNote(ctx.stockApprox || {}) : null;
    // An item whose stock was never set (no purchase, no opening stock) can't be "more than stock" yet.
    return shortfalls.filter(s => !ctx.stocked || ctx.stocked.has(s.key)).map(s => {
        const block = ctx.oversellCanBlock && !approx && s.shortfall > ctx.thresholds.oversellBlockKg + 1e-6;
        const avail = s.available <= 0 ? '0' : fmtKg(s.available);
        const indices = items.map((it, i) => (stockKeyFor(it, ctx.catalogue) === s.key ? i : -1)).filter(i => i !== -1);
        const onEntry = !!extraLine && stockKeyFor(extraLine, ctx.catalogue) === s.key;
        const field = onEntry ? 'entry.qty' : 'items';
        return issue('oversell', field, block ? 'block' : 'warn',
            `${s.name}: selling ${fmtKg(s.requested)} kg, only ${avail} kg in stock (short ${fmtKg(s.shortfall)} kg)${approx ? ` — ${approx.en}` : ''}`,
            `${s.name}: ${fmtKg(s.requested)} kg बिक्री, स्टॉक में सिर्फ़ ${avail} kg (${fmtKg(s.shortfall)} kg कम)${approx ? ` — ${approx.hi}` : ''}`,
            { lines: indices });
    });
}

/** Multiset signature of bill lines for duplicate detection. */
function itemsSignature(items) {
    return (Array.isArray(items) ? items : [])
        .map(it => { const l = readLineItem(it); return `${lineKey(it)}|${round2(l.qty)}|${round2(l.rate)}`; })
        .sort()
        .join(';');
}

function duplicateIssue(draft, ctx) {
    if (draft.isEdit) return null;
    const windowMs = ctx.thresholds.duplicateWindowSec * 1000;
    const party = normalize(draft.partyName);
    const sig = itemsSignature(draft.items);
    const total = round2(draft.total);
    const ref = Number(draft.enteredAt) || ctx.now;
    const dup = (ctx.recentBills || []).find(b => {
        if (!b || (draft.id && b.id === draft.id)) return false;
        const ts = Number(b.timestamp) || parseAnyBillDate(b.date)?.getTime();
        if (!ts || Math.abs(ref - ts) > windowMs) return false;
        const bTotal = billTotal(b);
        return normalize(b.customerName) === party && bTotal === total && itemsSignature(b.items) === sig;
    });
    if (!dup) return null;
    const secs = Math.max(1, Math.round(Math.abs(ref - (Number(dup.timestamp) || ref)) / 1000));
    const no = dup.billNumber ? ` (${dup.billNumber})` : '';
    return issue('duplicate', 'bill', 'warn',
        `Same bill was saved ${secs} s ago${no} — is this a duplicate?`,
        `यही बिल ${secs} सेकंड पहले सेव हुआ था${no} — क्या यह दोबारा तो नहीं?`);
}

function dateIssues(draft, ctx) {
    const d = parseAnyBillDate(draft.date);
    if (!d) return [];
    const ref = Number(draft.enteredAt) || ctx.now;
    const out = [];
    if (d.getTime() - ref > ctx.thresholds.maxFutureMin * 60000) {
        out.push(issue('date-future', 'date', 'warn',
            'Bill date is in the future — check the phone date/time',
            'बिल की तारीख़ आगे की है — फ़ोन की तारीख़/समय जाँचें'));
    }
    const days = Math.round((startOfLocalDay(ref).getTime() - startOfLocalDay(d).getTime()) / 86400000);
    if (days > ctx.thresholds.backdateDays) {
        out.push(issue('date-backdated', 'date', 'warn',
            `Bill is dated ${days} days back`,
            `बिल की तारीख़ ${days} दिन पीछे की है`));
    }
    return out;
}

function paymentIssues(draft) {
    const cash = round2(draft.payment?.cash);
    const online = round2(draft.payment?.online);
    const due = round2(draft.payment?.due);
    const out = [];
    // Order matches the save path before #37: no payment → name for Due → split.
    if (!draft.isEdit && cash === 0 && online === 0 && due === 0) {
        out.push(issue('payment-none', 'payment', 'block',
            'Please enter at least one payment method (Cash, Online, or Due)',
            'कम से कम एक भुगतान (नकद, ऑनलाइन या उधार) लिखें'));
    }
    if (dueNeedsName(due, draft.partyName)) {
        const en = t(NAME_REQUIRED_FOR_DUE_KEY, null, 'en');
        const hi = t(NAME_REQUIRED_FOR_DUE_KEY, null, 'hi');
        out.push(issue('party-required', 'party', 'block', en, hi));
    }
    if (!out.some(i => i.id === 'payment-none')) {
        const split = validatePaymentSplit(draft.total, { cash, online, due });
        if (!split.ok) {
            const en = paymentSplitMessage(split, 'en');
            const hi = paymentSplitMessage(split, 'hi');
            out.push(issue('payment-split', 'payment', 'block', en, hi));
        }
    }
    return out;
}

/**
 * Run every rule over a bill being entered or edited.
 * @param {Object} draft
 * @param {'purchase'|'retail'|'wholesale'} draft.kind
 * @param {boolean} [draft.isEdit]
 * @param {string|null} [draft.id] - bill id (pending id for a new bill)
 * @param {Array<Object>} draft.items - bill lines (any stored shape)
 * @param {number} draft.total - bill total (purchase: after labour)
 * @param {{cash?: number, online?: number, due?: number}} draft.payment
 * @param {string} [draft.partyName]
 * @param {*} [draft.date] - bill date (any stored shape)
 * @param {number} [draft.enteredAt] - when the bill was entered (ms); defaults to ctx.now
 * @param {{itemId?: string, name?: string, rate?: (number|null), qty?: (number|null)}|null} [draft.entry]
 * @param {ReturnType<typeof buildCheckContext>} ctx
 * @returns {Array<Object>} issues, blocks first
 */
export function evaluateBill(draft, ctx) {
    const c = { ...ctx, kind: draft.kind, thresholds: normalizeThresholds(ctx?.thresholds), catalogue: ctx?.catalogue || [] };
    const items = Array.isArray(draft.items) ? draft.items.filter(Boolean) : [];
    const rates = lastRates(c.recentBills, draft.isEdit ? draft.id : null);
    const out = [];

    const entry = draft.entry;
    if (entry && (entry.itemId || entry.name)) {
        if (entry.rate !== null && entry.rate !== undefined && entry.rate !== '') {
            out.push(...rateIssues(entry, 'entry.rate', c, rates));
        }
        if (entry.qty !== null && entry.qty !== undefined && entry.qty !== '') {
            const q = qtyIssue(entry, 'entry.qty');
            if (q) out.push(q);
        }
    }

    if (items.length > 0) {
        items.forEach((line, i) => {
            const q = qtyIssue(line, `items.${i}`, { line: i });
            if (q) out.push(q);
            out.push(...rateIssues(line, `items.${i}`, c, rates, { line: i }));
        });
        out.push(...oversellIssues(items, c));
        const dup = duplicateIssue({ ...draft, items }, c);
        if (dup) out.push(dup);
        out.push(...dateIssues(draft, c));
    }
    // An edit is checked even with no lines (the save path always checked payments)
    if (items.length > 0 || draft.isEdit) out.push(...paymentIssues(draft));

    const entryQty = toMoney(entry?.qty);
    if (entry && entryQty > 0 && c.kind === 'wholesale') {
        out.push(...oversellIssues(items, c, entry).filter(i => i.field === 'entry.qty'));
    }

    const rank = { block: 0, warn: 1 };
    return out.map((it, order) => ({ it, order }))
        .sort((a, b) => rank[a.it.severity] - rank[b.it.severity] || a.order - b.order)
        .map(({ it }) => it);
}

/** True for issues about the line being typed (shown live, never gate Save). */
export const isEntryIssue = (i) => String(i.field).startsWith('entry.');

/**
 * Split issues for the save decision.
 * @param {Array<Object>} issues
 * @returns {{blocks: Array<Object>, hardBlocks: Array<Object>, warns: Array<Object>}}
 */
export function saveGate(issues) {
    const bill = (issues || []).filter(i => !isEntryIssue(i));
    const blocks = bill.filter(i => i.severity === 'block');
    return { blocks, hardBlocks: blocks.filter(i => !i.overridable), warns: bill.filter(i => i.severity === 'warn') };
}

/**
 * Banner text for a number of problems.
 * @param {number} count
 * @returns {{en: string, hi: string}}
 */
export function bannerText(count) {
    return count === 1
        ? { en: '1 problem — check before saving', hi: '1 समस्या — सेव करने से पहले देखें' }
        : { en: `${count} problems — check before saving`, hi: `${count} समस्याएँ — सेव करने से पहले देखें` };
}

/** Owner / manager may "Save anyway" past an overridable block. */
export function canOverride(role) {
    return role === 'owner' || role === 'manager';
}

/**
 * Accepted warnings to store on the bill as `flags`.
 * @param {Array<Object>} warns
 * @param {string} by - uid
 * @param {number} at - ms
 * @returns {Array<{rule: string, en: string, hi: string, by: string, at: number}>}
 */
export function toFlags(warns, by, at) {
    return (warns || []).map(w => ({ rule: w.id, en: w.en, hi: w.hi, by, at }));
}

/**
 * Owner/manager overrides of blocks to store on the bill as `overrides` (one per rule).
 * @param {Array<Object>} blocks
 * @param {string} reason
 * @param {string} by - uid
 * @param {number} at - ms
 * @returns {Array<{rule: string, reason: string, by: string, at: number}>}
 */
export function toOverrides(blocks, reason, by, at) {
    const seen = new Set();
    return (blocks || []).filter(b => !seen.has(b.id) && seen.add(b.id))
        .map(b => ({ rule: b.id, reason: String(reason || '').trim(), by, at }));
}

const historyFor = (s, kind) => (kind === 'purchase' ? s.purchaseHistory : kind === 'retail' ? s.retailSalesHistory : s.salesHistory);

/**
 * Bill lines that current stock already reflects for the bill being saved:
 * the saved copy of a bill being edited, or a new bill whose earlier save
 * attempt already reached local history (and stock) before failing (#70 retry).
 * Counting them back avoids blocking a bill against its own quantities.
 * @param {Object} state - AppState-like
 * @param {'purchase'|'retail'|'wholesale'} kind
 * @param {{editingBill?: Object|null, draftId?: string|null}} [opts]
 * @returns {Array<Object>}
 */
export function stockCreditFor(state, kind, { editingBill = null, draftId = null } = {}) {
    const history = historyFor(state || {}, kind);
    const own = editingBill
        || (draftId && Array.isArray(history) ? history.find(b => b && b.id === draftId) : null);
    return own && Array.isArray(own.items) ? own.items : [];
}

/**
 * Build the rule context from app state (pure: pass AppState in).
 * @param {Object} state - AppState-like ({ items, stock, stockReady, purchaseHistory, retailSalesHistory, salesHistory, stockAdjustments, userRole, settings })
 * @param {'purchase'|'retail'|'wholesale'} kind
 * @param {{now?: number, editingBill?: Object|null, draftId?: string|null}} [opts]
 * @returns {Object}
 */
export function buildCheckContext(state, kind, { now = Date.now(), editingBill = null, draftId = null } = {}) {
    const s = state || {};
    const history = historyFor(s, kind);
    return {
        kind,
        now,
        thresholds: normalizeThresholds(s.settings?.checkThresholds),
        catalogue: Array.isArray(s.items) ? s.items : [],
        stock: s.stock || {},
        stockReady: s.stockReady !== false,
        stockApproximate: !!s.stockApprox,
        stockApprox: s.stockApprox || null,
        credit: stockCreditFor(s, kind, { editingBill, draftId }),
        stocked: kind === 'purchase' ? null : stockedItemKeys({ purchases: s.purchaseHistory, stockAdjustments: s.stockAdjustments }, s.items, s.stock),
        recentBills: Array.isArray(history) ? history : [],
        // #33 (should retail reduce stock?) is open: retail oversell only warns, as before.
        oversellCanBlock: kind === 'wholesale',
        showCost: canOverride(s.userRole)
    };
}

/**
 * Cash count against the expected drawer (Q19 bands). Never blocks: the
 * count is what it is; a big gap or a negative expected drawer is flagged.
 * @param {{expected: number, counted: number}} input
 * @param {Object} [thresholds]
 * @returns {Array<Object>}
 */
export function evaluateCashCount({ expected, counted }, thresholds) {
    const t = normalizeThresholds(thresholds);
    const out = [];
    const exp = round2(expected);
    if (exp < 0) {
        out.push(issue('cash-expected-negative', 'expected', 'warn',
            `Expected cash is ${fmtRs(exp)} — the drawer cannot be below ₹0; check today's entries`,
            `अपेक्षित नकद ${fmtRs(exp)} है — गल्ला ₹0 से कम नहीं हो सकता; आज की एंट्री जाँचें`));
    }
    const diff = round2(round2(counted) - exp);
    const gap = Math.abs(diff);
    if (gap > t.cashOkRs) {
        const high = gap > t.cashHighRs;
        const word = diff < 0 ? 'short' : 'extra';
        const wordHi = diff < 0 ? 'कम' : 'ज़्यादा';
        out.push(issue(high ? 'cash-mismatch-high' : 'cash-mismatch', 'counted', 'warn',
            `Cash is ${fmtRs(gap)} ${word}${high ? ' — big difference, count again' : ''}`,
            `नकद ${fmtRs(gap)} ${wordHi} है${high ? ' — बड़ा अंतर, दोबारा गिनें' : ''}`));
    }
    return out;
}

/**
 * Stock adjustment size check (Q17): above the limit it gets a flag.
 * @param {number} qtyKg - signed adjustment
 * @param {Object} [thresholds]
 * @returns {Array<Object>}
 */
export function evaluateStockAdjustment(qtyKg, thresholds) {
    const t = normalizeThresholds(thresholds);
    const q = Math.abs(Number(qtyKg) || 0);
    if (q <= t.stockAdjustFlagKg) return [];
    return [issue('stock-adjust-large', 'qty', 'warn',
        `Large stock adjustment: ${fmtKg(q)} kg (more than ${t.stockAdjustFlagKg} kg)`,
        `बड़ा स्टॉक बदलाव: ${fmtKg(q)} kg (${t.stockAdjustFlagKg} kg से ज़्यादा)`)];
}
