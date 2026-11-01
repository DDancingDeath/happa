/**
 * @fileoverview Anomaly detection over saved data (#187, #40): the daily
 * anomaly report on Today and the Anomalies page.
 *
 * Pure functions only (no DOM, Firestore, AppState or clock): pass loaded
 * bills / cash sessions / stock adjustments / audit logs in, get anomaly
 * records out. Bill rules reuse the save-time engine (`utils/bill-checks.js`)
 * on the saved bill, plus the `flags` / `overrides` it already recorded.
 *
 * An anomaly:
 *   { id, type, severity: 'high'|'medium'|'low', en, hi, rule?,
 *     refKind: 'bill'|'expense'|'cash'|'stock'|'audit', refId, billType?, billNumber?,
 *     party, item, userId, user, amount, at (ms), dayKey (IST YYYY-MM-DD), hour (IST),
 *     detectedBy: 'scan' }
 * The id is deterministic (type + ref), so scanning the same data again never
 * creates a second record. Stored docs add status 'open'|'ok'|'fixed', note,
 * reviewedBy/reviewedByName/reviewedAt and detectedAt.
 * @module utils/anomalies
 */

import { evaluateBill, evaluateCashCount, evaluateStockAdjustment, isEntryIssue, normalizeThresholds } from './bill-checks.js';
import { activityBills, billTotal, isPersonalExpense, readLineItem, readPayment, round2, toMoney, formatKg, formatRate, formatRupees } from './money.js';
import { parseAnyBillDate, toJsDate } from './dates.js';
import { isNotCounted } from './cash-session.js';
import { cleanText } from './due-reminder.js';
import { firstStockTimes, stockKeyFor } from './stock-check.js';
import { labourCalcText } from './labour.js';
import { SECURITY_ACTIONS, OLD_BILL_TRIES_PER_DAY, deniedClusters } from './security-flags.js';
import { t, tn } from '../i18n/index.js';
import { pickLang } from '../i18n/localize.js';
import { peopleById } from './audit-changes.js';

/** Business day boundaries are Indian Standard Time (UTC+5:30), whatever the device clock zone. */
export const IST_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;

/** Extra thresholds for rules that only run on saved data. */
export const ANOMALY_DEFAULTS = Object.freeze({
    /** Entries at or after this IST hour … */
    nightStartHour: 22,
    /** … or before this IST hour are night-time entries. */
    nightEndHour: 5,
    /** An edit made more than this many days after the bill was entered is an "old bill" edit. */
    oldEditDays: 1,
    /** Round-number lines: line total at least this much … */
    roundLineMin: 1000,
    /** First scan on a device looks back this many days (only over already-loaded data). */
    scanDays: 7,
    /** Bills of the same kind this many days before a bill give its "usual" rate. */
    rateLookbackDays: 30
});

export const SEVERITIES = ['high', 'medium', 'low'];
export const SEVERITY_LABELS = {
    high: { en: 'High', hi: 'गंभीर' },
    medium: { en: 'Medium', hi: 'मध्यम' },
    low: { en: 'Low', hi: 'कम' }
};
export const STATUSES = ['open', 'ok', 'fixed'];
export const STATUS_LABELS = {
    open: { en: 'Open', hi: 'बाकी' },
    ok: { en: 'OK', hi: 'ठीक है' },
    fixed: { en: 'Fixed', hi: 'सुधारा' }
};

/** Rule catalogue: label + default severity per anomaly type. */
export const ANOMALY_TYPES = Object.freeze({
    'rate-high': { en: 'Rate far above usual', hi: 'रेट सामान्य से बहुत ज़्यादा', severity: 'medium' },
    'rate-low': { en: 'Rate far below usual', hi: 'रेट सामान्य से बहुत कम', severity: 'medium' },
    'rate-invalid': { en: 'Zero rate', hi: 'शून्य रेट', severity: 'high' },
    'rate-round': { en: 'Round-number line', hi: 'गोल रकम वाली लाइन', severity: 'low' },
    'qty-invalid': { en: 'Zero weight/quantity', hi: 'शून्य वज़न/मात्रा', severity: 'high' },
    'below-cost': { en: 'Sold below cost', hi: 'लागत से कम में बिक्री', severity: 'medium' },
    'cost-unknown': { en: 'Sold with cost not known', hi: 'लागत पता नहीं, फिर भी बिक्री', severity: 'medium' },
    'oversell': { en: 'Sold more than stock', hi: 'स्टॉक से ज़्यादा बिक्री', severity: 'medium' },
    'payment-split': { en: 'Payment does not match total', hi: 'भुगतान कुल से मेल नहीं खाता', severity: 'high' },
    'payment-none': { en: 'No payment recorded', hi: 'कोई भुगतान नहीं लिखा', severity: 'high' },
    'party-required': { en: 'Due without a name', hi: 'बिना नाम का उधार', severity: 'high' },
    'duplicate': { en: 'Possible duplicate bill', hi: 'शायद दोहरा बिल', severity: 'medium' },
    'date-future': { en: 'Bill dated in the future', hi: 'आगे की तारीख़ का बिल', severity: 'medium' },
    'date-backdated': { en: 'Backdated bill', hi: 'पीछे की तारीख़ का बिल', severity: 'medium' },
    'override': { en: 'Saved past a block', hi: 'रोक के बावजूद सेव', severity: 'high' },
    'cash-mismatch': { en: 'Cash count differs', hi: 'नकद गिनती में अंतर', severity: 'medium' },
    'cash-mismatch-high': { en: 'Big cash difference', hi: 'नकद में बड़ा अंतर', severity: 'high' },
    'cash-expected-negative': { en: 'Expected cash below ₹0', hi: 'अपेक्षित नकद ₹0 से कम', severity: 'medium' },
    'cash-not-counted': { en: 'Cash not counted at close', hi: 'बंद करते समय नकद नहीं गिना', severity: 'medium' },
    'due-written-off': { en: 'Due written off', hi: 'उधार माफ़ किया', severity: 'medium' },
    'stock-adjust-large': { en: 'Large stock adjustment', hi: 'बड़ा स्टॉक बदलाव', severity: 'medium' },
    'stock-adjust-no-reason': { en: 'Stock adjusted without reason', hi: 'बिना कारण स्टॉक बदला', severity: 'low' },
    'bill-old-edit': { en: 'Old bill edited', hi: 'पुराना बिल बदला', severity: 'medium' },
    'bill-edit-after-payment': { en: 'Bill edited after payment', hi: 'भुगतान के बाद बिल बदला', severity: 'medium' },
    'bill-deleted': { en: 'Bill deleted', hi: 'बिल मिटाया', severity: 'high' },
    'bill-voided': { en: 'Bill voided', hi: 'बिल रद्द किया', severity: 'medium' },
    'expense-deleted': { en: 'Expense deleted', hi: 'खर्च मिटाया', severity: 'medium' },
    'expense-voided': { en: 'Expense voided', hi: 'खर्च रद्द किया', severity: 'medium' },
    'night-entry': { en: 'Night-time entry', hi: 'रात में एंट्री', severity: 'low' },
    // #124: from the security entries phones write to the audit log
    'access-denied': { en: 'Changes refused again and again', hi: 'बार-बार बदलाव मना हुए', severity: 'high' },
    'new-device': { en: 'Sign-in from a new phone', hi: 'नए फ़ोन से लॉग इन', severity: 'low' },
    'old-bill-edit-try': { en: 'Tried to change several old bills', hi: 'कई पुराने बिल बदलने की कोशिश', severity: 'low' },
    // #160: the daily number checks (utils/number-check-flags.js)
    'numcheck-ac1': { en: 'Number check: stock value', hi: 'आँकड़ों की जाँच: स्टॉक की कीमत', severity: 'medium' },
    'numcheck-ac2': { en: 'Number check: bill split', hi: 'आँकड़ों की जाँच: बिल का बँटवारा', severity: 'high' },
    'numcheck-ac3': { en: 'Number check: payments', hi: 'आँकड़ों की जाँच: भुगतान', severity: 'high' },
    'numcheck-ac4': { en: 'Number check: bill dates', hi: 'आँकड़ों की जाँच: बिल की तारीख़', severity: 'medium' },
    'numcheck-ac5': { en: 'Number check: due in two places', hi: 'आँकड़ों की जाँच: दो जगह उधार', severity: 'high' },
    'numcheck-ac6': { en: 'Number check: cash drawer', hi: 'आँकड़ों की जाँच: गल्ला', severity: 'high' },
    'numcheck-ac8': { en: 'Number check: stock below zero', hi: 'आँकड़ों की जाँच: शून्य से कम स्टॉक', severity: 'medium' }
});

/** Label of a type (unknown stored flag rules fall back to their id). */
export function typeLabel(type) {
    const t = ANOMALY_TYPES[type];
    return t ? { en: t.en, hi: t.hi } : { en: String(type || ''), hi: String(type || '') };
}

const pad2 = (n) => String(n).padStart(2, '0');
const utcKey = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** IST calendar day (YYYY-MM-DD) of an instant (ms). */
export function istDayKey(ms) {
    return utcKey(new Date(Number(ms) + IST_OFFSET_MS));
}

/** IST hour (0–23) of an instant (ms). */
export function istHour(ms) {
    return new Date(Number(ms) + IST_OFFSET_MS).getUTCHours();
}

function keyParts(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null;
}

/** Day key `n` days after `key` (negative = before). */
export function addDaysToKey(key, n) {
    const p = keyParts(key);
    if (!p) return key;
    return utcKey(new Date(Date.UTC(p[0], p[1], p[2] + n)));
}

/** First instant (ms) of an IST day key. */
export function istDayStartMs(key) {
    const p = keyParts(key);
    return p ? Date.UTC(p[0], p[1], p[2]) - IST_OFFSET_MS : NaN;
}

/** DD/MM/YYYY for a day key. */
export function formatDayKey(key) {
    const p = keyParts(key);
    return p ? `${pad2(p[2])}/${pad2(p[1] + 1)}/${p[0]}` : String(key || '');
}

/**
 * Deterministic document id for an anomaly: rule + reference.
 * @param {string} type
 * @param {string} refKind
 * @param {string|number} refId
 * @returns {string}
 */
export function anomalyId(type, refKind, refId) {
    return `${type}~${refKind}~${String(refId)}`.replace(/\//g, '_');
}

const timeOf = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const d = parseAnyBillDate(v);
    return d ? d.getTime() : NaN;
};

/**
 * When a bill was entered (ms): `enteredAt` (#147: a back-dated bill's `timestamp` is its
 * day, not its entry), else the server `createdAt` when it is on a later IST day than the
 * timestamp and more than 12 hours after it (a bill without `enteredAt` dated back; a bill saved
 * offline that synced within 12 hours keeps its own time, so a sync just after midnight or at night
 * flags nothing), else its numeric timestamp, else its date.
 */
export function billTime(bill) {
    const entered = Number(bill?.enteredAt);
    if (Number.isFinite(entered) && entered > 0) return entered;
    const created = bill?.createdAt != null ? toJsDate(bill.createdAt)?.getTime() : NaN;
    const ts = Number(bill?.timestamp);
    const hasTs = Number.isFinite(ts) && ts > 0;
    if (Number.isFinite(created) && created > 0 && (!hasTs || (created - ts > DAY_MS / 2 && istDayKey(created) > istDayKey(ts)))) return created;
    return hasTs ? ts : timeOf(bill?.date);
}

/**
 * Voids, one record each (#75): a void flagged under its bill's id that an older scan stored under its
 * audit entry's id (same bill number, same person) is left out, and the other way round (an older app's
 * entry seen without its bill); a flag built from the audit entry (`auditTwin`) never rewrites the record
 * already stored under the bill's id, so scans that see the bill and scans that only see the entry don't
 * overwrite each other. An expense void's flag built from its audit entry (#99) likewise never rewrites
 * the record stored from the voided expense.
 * @param {Array} detected
 * @param {Array|null} stored
 * @returns {Array}
 */
export function withoutStoredVoidTwins(detected, stored) {
    const allVoids = (stored || []).filter(d => d && (d.type === 'bill-voided' || d.type === 'expense-voided'));
    if (!allVoids.length) return detected;
    const voids = allVoids.filter(d => d.type === 'bill-voided');
    const keyOf = (d) => `${d.billNumber}|${d.userId || ''}`;
    const storedAs = (kind) => new Set(voids.filter(d => d.refKind === kind && d.billNumber).map(keyOf));
    const byAudit = storedAs('audit');
    const byBill = storedAs('bill');
    const ids = new Set(allVoids.map(d => d.id));
    return detected.filter(a => !((a.type === 'expense-voided' && a.auditTwin && ids.has(a.id))
        || (a.type === 'bill-voided' && (a.refKind === 'bill'
            ? (a.auditTwin && ids.has(a.id)) || (!!a.billNumber && byAudit.has(keyOf(a)))
            : a.refKind === 'audit' && !!a.billNumber && byBill.has(keyOf(a))))));
}

const billParty = (bill) => String(bill?.customerName || bill?.supplierName || '').trim();
const billUserId = (bill) => String(bill?.userId || bill?.createdBy || '');

/**
 * A voided bill or expense (by kind, as detectAnomalies `voided`) voided within [from, to) by someone
 * other than `uid` (#75, #99): only then does a scan need to know who the owners are.
 */
export function voidedByOthers(voided, uid, from, to) {
    return Object.values(voided || {}).some(list => (list || []).some(b => {
        const at = toJsDate(b?.voidedAt)?.getTime();
        return !!b?.voidedBy && String(b.voidedBy) !== String(uid || '') && at >= from && at < to;
    }));
}
const lineNames = (items) => [...new Set((Array.isArray(items) ? items : [])
    .map(it => readLineItem(it).name).filter(Boolean))];

/**
 * uid → display name from everything loaded (bills, sessions, adjustments),
 * so purchase bills that only store a uid still show who entered them.
 * @param {Object} input - same shape as detectAnomalies input
 * @returns {Map<string, string>}
 */
export function buildUserNames({ bills = {}, sessions = [], adjustments = [] } = {}) {
    const names = new Map();
    const note = (uid, name) => {
        const n = String(name || '').trim();
        if (uid && n && n !== 'Unknown' && !names.has(String(uid))) names.set(String(uid), n);
    };
    Object.values(bills).forEach(list => (list || []).forEach(b => note(billUserId(b), b?.userName || b?.createdByName)));
    (sessions || []).forEach(s => note(s?.userId, s?.userName));
    (adjustments || []).forEach(a => note(a?.createdBy || a?.userId, a?.createdByName || a?.userName));
    return names;
}

function makeAnomaly(type, ref, fields) {
    const label = typeLabel(type);
    const at = Number(fields.at);
    return {
        id: anomalyId(type, ref.refKind, ref.refId),
        type,
        severity: fields.severity || ANOMALY_TYPES[type]?.severity || 'medium',
        en: fields.en || label.en,
        hi: fields.hi || label.hi,
        ...(fields.rule ? { rule: fields.rule } : {}),
        refKind: ref.refKind,
        refId: String(ref.refId),
        billType: ref.billType || null,
        billNumber: ref.billNumber || null,
        party: fields.party ?? ref.party ?? '',
        item: fields.item ?? ref.item ?? '',
        userId: fields.userId ?? ref.userId ?? '',
        user: fields.user ?? ref.user ?? '',
        amount: round2(fields.amount ?? ref.amount ?? 0),
        at,
        dayKey: fields.dayKey || istDayKey(at),
        hour: istHour(at),
        detectedBy: 'scan'
    };
}

/** Earlier bills of one kind within the rate look-back, for the "usual rate" and duplicates. */
function earlierBills(sorted, index, lookbackMs) {
    const ts = sorted[index].ts;
    const out = [];
    for (let i = index - 1; i >= 0 && sorted[i].ts >= ts - lookbackMs; i--) {
        if (sorted[i].ts < ts) out.push(sorted[i].bill);
    }
    return out;
}

/**
 * Re-run the save-time rules (#37) on a saved bill. Stock-based rules
 * (oversell, below cost) are skipped: today's stock says nothing about the
 * stock when the bill was saved — their save-time flags are used instead.
 */
function recheckBill(bill, kind, ts, earlier, base) {
    const pay = readPayment(bill);
    const writtenOff = toMoney(bill?.payment?.writtenOff) || 0;
    let issues;
    try {
        issues = evaluateBill({
            kind,
            isEdit: false,
            id: bill.id,
            items: Array.isArray(bill.items) ? bill.items : [],
            total: billTotal(bill),
            // A write-off moves due to payment.writtenOff; it is still part of the split
            payment: { cash: pay.cash, online: pay.online, due: round2(pay.due + writtenOff) },
            partyName: billParty(bill),
            date: bill.date,
            enteredAt: ts
        }, {
            now: ts,
            thresholds: base.thresholds,
            // Q20 for the owner's own bills; anyone else's back-dated bill is flagged from 1 day (owners unknown: Q20)
            ownerEntry: base.ownerIds ? base.ownerIds.has(billUserId(bill)) : undefined,
            catalogue: base.catalogue,
            stock: {},
            stockReady: false,
            credit: [],
            recentBills: earlier,
            oversellCanBlock: false,
            showCost: false
        });
    } catch (e) {
        return [];
    }
    const items = Array.isArray(bill.items) ? bill.items : [];
    const byRule = new Map();
    issues.filter(i => !isEntryIssue(i) && i.id !== 'oversell' && i.id !== 'below-cost' && i.id !== 'cost-unknown').forEach(i => {
        const lines = [i.line, ...(i.lines || [])].filter(n => Number.isInteger(n));
        const names = lines.map(n => readLineItem(items[n]).name).filter(Boolean);
        const prev = byRule.get(i.id);
        if (prev) prev.names.push(...names);
        else byRule.set(i.id, { issue: i, names });
    });
    return [...byRule.values()].map(({ issue, names }) => ({ type: issue.id, en: issue.en, hi: issue.hi, names }));
}

/** Lines whose total is a round figure but whose rate is an odd, back-worked number. */
function roundLines(items, t) {
    return (Array.isArray(items) ? items : []).map(readLineItem).filter(l =>
        l.total >= t.roundLineMin && Math.abs(l.total % 100) < 0.005 && l.rate > 0
        && Math.abs(l.rate * 4 - Math.round(l.rate * 4)) > 0.01);
}

const isNight = (hour, t) => (t.nightStartHour > t.nightEndHour
    ? hour >= t.nightStartHour || hour < t.nightEndHour
    : hour >= t.nightStartHour && hour < t.nightEndHour);

/**
 * Find anomalies in loaded data with event time in [from, to).
 * @param {Object} input
 * @param {{purchase?: Object[], retail?: Object[], wholesale?: Object[]}} input.bills
 * @param {Object[]} [input.sessions] - cash sessions (`cashManagement` docs)
 * @param {Object[]} [input.adjustments] - stock adjustments
 * @param {Object[]} [input.auditLogs] - audit log entries (owner devices only)
 * @param {{purchase?: Object[], retail?: Object[], wholesale?: Object[], expense?: Object[]}} [input.voided] - voided bills
 *   and expenses loaded (FirebaseService.voidedBills, voidedExpenses): a void by anyone but an owner is flagged (#75, #99), no read of its own
 * @param {Object[]} [input.people] - user profiles `{id, name, role}` (owner devices): names on audit-based flags
 * @param {Object[]} [input.catalogue] - items
 * @param {Object} [input.thresholds] - settings/app checkThresholds (+ ANOMALY_DEFAULTS keys)
 * @param {?string[]} [input.ownerIds] - uids of the owners: their back-dated bills follow Q20 (backdateDays), anyone else's are flagged from 1 day (#147); null (unknown, e.g. a manager's device) = Q20 for all, the save-time flag covers the rest
 * @param {Object} [input.stock] - AppState.stock: stock on hand counts as stock set (purchase older than the loaded history)
 * @param {number} input.from - inclusive (ms)
 * @param {number} input.to - exclusive (ms)
 * @returns {Array<Object>} anomalies, one per id, high severity and newest first
 */
export function detectAnomalies({ bills = {}, sessions = [], adjustments = [], auditLogs = [], people = [], catalogue = [], thresholds = {}, stock = {}, ownerIds = null, voided = {}, from, to }) {
    const peopleMap = peopleById(people);
    const t = { ...ANOMALY_DEFAULTS, ...normalizeThresholds(thresholds) };
    Object.keys(ANOMALY_DEFAULTS).forEach(k => {
        const n = Number(thresholds?.[k]);
        if (Number.isFinite(n) && n >= 0) t[k] = n;
    });
    const inRange = (ms) => Number.isFinite(ms) && ms >= from && ms < to;
    const names = buildUserNames({ bills, sessions, adjustments });
    const nameOf = (uid, fallback) => String(fallback || names.get(String(uid || '')) || '').trim();
    const out = new Map();
    const add = (a) => {
        if (!inRange(a.at)) return;
        const prev = out.get(a.id);
        if (!prev) { out.set(a.id, a); return; }
        const items = new Set([...String(prev.item).split(', '), ...String(a.item).split(', ')].filter(Boolean));
        prev.item = [...items].join(', ');
    };
    const base = { thresholds, catalogue: Array.isArray(catalogue) ? catalogue : [], ownerIds: Array.isArray(ownerIds) ? new Set(ownerIds.map(String)) : null };
    const lookbackMs = t.rateLookbackDays * DAY_MS;

    ['purchase', 'retail', 'wholesale'].forEach(kind => {
        const sorted = activityBills(bills[kind]).filter(b => b && b.id != null)
            .map(bill => ({ bill, ts: billTime(bill) }))
            .filter(x => Number.isFinite(x.ts))
            .sort((a, b) => a.ts - b.ts);
        sorted.forEach(({ bill, ts }, index) => {
            const userId = billUserId(bill);
            const ref = {
                refKind: 'bill', refId: bill.id, billType: kind, billNumber: bill.billNumber || null,
                party: billParty(bill), item: lineNames(bill.items).join(', '),
                userId, user: nameOf(userId, bill.userName || bill.createdByName), amount: billTotal(bill)
            };
            if (inRange(ts)) {
                (Array.isArray(bill.flags) ? bill.flags : []).forEach(f => {
                    if (!f || !f.rule) return;
                    add(makeAnomaly(f.rule, ref, { at: ts, en: f.en, hi: f.hi }));
                });
                const overrides = (Array.isArray(bill.overrides) ? bill.overrides : []).filter(o => o && o.rule);
                if (overrides.length) {
                    const rules = overrides.map(o => `${typeLabel(o.rule).en}${o.reason ? `: ${o.reason}` : ''}`).join('; ');
                    const rulesHi = overrides.map(o => `${typeLabel(o.rule).hi}${o.reason ? `: ${o.reason}` : ''}`).join('; ');
                    const by = overrides[0].by;
                    add(makeAnomaly('override', ref, {
                        at: ts, rule: overrides.map(o => o.rule).join(','),
                        en: `Saved past a block — ${rules}`, hi: `रोक के बावजूद सेव — ${rulesHi}`,
                        userId: by || userId, user: nameOf(by || userId, by ? '' : ref.user)
                    }));
                }
                recheckBill(bill, kind, ts, earlierBills(sorted, index, lookbackMs), base).forEach(r => {
                    add(makeAnomaly(r.type, ref, { at: ts, en: r.en, hi: r.hi, item: r.names.length ? [...new Set(r.names)].join(', ') : ref.item }));
                });
                const round = roundLines(bill.items, t);
                if (round.length) {
                    const l = round[0];
                    add(makeAnomaly('rate-round', ref, {
                        at: ts, item: [...new Set(round.map(x => x.name))].join(', '),
                        en: `${l.name}: round total ${inr(l.total)} with odd rate ${formatRate(l.rate)} — was the total typed in?`,
                        hi: `${l.name}: गोल रकम ${inr(l.total)}, रेट ${formatRate(l.rate)} — क्या कुल रकम सीधे लिखी गई?`
                    }));
                }
                if (Number.isFinite(Number(bill.timestamp)) && isNight(istHour(ts), t)) {
                    add(makeAnomaly('night-entry', ref, {
                        at: ts,
                        en: `Entered at ${pad2(istHour(ts))}:${pad2(new Date(ts + IST_OFFSET_MS).getUTCMinutes())} (outside shop hours)`,
                        hi: `${pad2(istHour(ts))}:${pad2(new Date(ts + IST_OFFSET_MS).getUTCMinutes())} बजे एंट्री (दुकान के समय के बाहर)`
                    }));
                }
            }

            const payments = Array.isArray(bill.payments) ? bill.payments : [];
            const editedAt = timeOf(bill.editedAt);
            if (Number.isFinite(editedAt)) {
                const editor = String(bill.editedBy || '');
                const editRef = { userId: editor, user: nameOf(editor, '') };
                const daysLate = Math.floor((editedAt - ts) / DAY_MS);
                if (editedAt - ts > t.oldEditDays * DAY_MS) {
                    add(makeAnomaly('bill-old-edit', ref, {
                        at: editedAt, ...editRef,
                        en: `Bill edited ${daysLate} day(s) after it was entered`,
                        hi: `बिल एंट्री के ${daysLate} दिन बाद बदला गया`
                    }));
                }
                const paidBefore = payments.some(p => Number.isFinite(timeOf(p?.at ?? p?.date)) && timeOf(p?.at ?? p?.date) < editedAt);
                if (paidBefore) {
                    add(makeAnomaly('bill-edit-after-payment', ref, {
                        at: editedAt, ...editRef,
                        en: 'Bill edited after a due payment was recorded on it',
                        hi: 'उधार का भुगतान लिखने के बाद बिल बदला गया'
                    }));
                }
            }
            const writeOffs = payments.filter(p => p && p.kind === 'writeOff' && inRange(timeOf(p.at ?? p.date)));
            if (writeOffs.length) {
                const amount = round2(writeOffs.reduce((s, p) => s + (Number(p.amount) || 0), 0));
                const last = writeOffs[writeOffs.length - 1];
                const reason = writeOffs.map(p => String(p.reason || '').trim()).filter(Boolean).join('; ');
                add(makeAnomaly('due-written-off', ref, {
                    at: timeOf(last.at ?? last.date), amount,
                    userId: String(last.recordedById || ''), user: nameOf(last.recordedById, last.recordedBy),
                    en: `${inr(amount)} due written off${reason ? ` — ${reason}` : ''}`,
                    hi: `${inr(amount)} उधार माफ़${reason ? ` — ${reason}` : ''}`
                }));
            }
        });
    });

    (sessions || []).forEach(s => {
        if (!s || s.id == null || !s.signedOut) return;
        const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')) ? s.date : null;
        const closed = timeOf(s.signOutTime);
        const at = Number.isFinite(closed) ? closed : (dayKey ? istDayStartMs(dayKey) + DAY_MS - 1 : NaN);
        const ref = { refKind: 'cash', refId: s.id, userId: String(s.userId || ''), user: nameOf(s.userId, s.userName) };
        const fields = { at, ...(dayKey ? { dayKey } : {}) };
        if (isNotCounted(s)) {
            add(makeAnomaly('cash-not-counted', ref, { ...fields, amount: 0 }));
            return;
        }
        const counted = toMoney(s.closingBalance);
        const expected = toMoney(s.expectedBalance);
        if (counted === null || expected === null) return;
        evaluateCashCount({ expected, counted }, thresholds).forEach(i => {
            add(makeAnomaly(i.id, ref, { ...fields, en: i.en, hi: i.hi, amount: i.id === 'cash-expected-negative' ? expected : round2(counted - expected) }));
        });
    });

    (adjustments || []).forEach(a => {
        if (!a || a.id == null) return;
        const at = billTime(a);
        const uid = String(a.createdBy || a.userId || '');
        const ref = {
            refKind: 'stock', refId: a.id, item: String(a.itemName || '').trim(),
            userId: uid, user: nameOf(uid, a.createdByName || a.userName)
        };
        const before = toMoney(a.previousStock);
        const after = toMoney(a.newStock);
        const change = before !== null && after !== null ? after - before
            : (a.adjustType === 'remove' ? -1 : 1) * (Number(a.quantity) || 0);
        evaluateStockAdjustment(change, thresholds).forEach(i => {
            add(makeAnomaly(i.id, ref, { at, en: i.en, hi: i.hi, amount: round2(Math.abs(change) * (Number(a.rate) || 0)) }));
        });
        if (!String(a.reason || '').trim()) {
            add(makeAnomaly('stock-adjust-no-reason', ref, {
                at, en: `Stock changed by ${formatKg(change)} kg with no reason`, hi: `बिना कारण स्टॉक ${formatKg(change)} kg बदला`
            }));
        }
    });

    const AUDIT_TYPES = { DELETE_BILL: 'bill-deleted', DELETE_SALE: 'bill-deleted', DELETE_EXPENSE: 'expense-deleted', VOID_BILL: 'bill-voided', VOID_EXPENSE: 'expense-voided' };
    const reasonText = (reason) => {
        const why = cleanText(reason).slice(0, 120);
        return why ? ` — ${why}` : '';
    };
    const AUDIT_TEXT = {
        'bill-deleted': (no, amount) => ({ en: `Bill${no} deleted (${inr(amount)})`, hi: `बिल${no} मिटाया (${inr(amount)})` }),
        'bill-voided': (no, amount, reason) => ({ en: `Bill${no} voided (${inr(amount)})${reasonText(reason)}`, hi: `बिल${no} रद्द किया (${inr(amount)})${reasonText(reason)}` }),
        'expense-deleted': (no, amount) => ({ en: `Expense deleted (${inr(amount)})`, hi: `खर्च मिटाया (${inr(amount)})` }),
        'expense-voided': (no, amount, reason) => ({ en: `Expense voided (${inr(amount)})${reasonText(reason)}`, hi: `खर्च रद्द किया (${inr(amount)})${reasonText(reason)}` })
    };
    // #75: a void needs no approval, but one by anyone except an owner is flagged. Owners come from the
    // profiles (owner's scan) or the owners' list (else an audit entry's stored role).
    const isOwnerUid = (uid, storedRole) => {
        const role = peopleMap.get(String(uid))?.role;
        if (role) return role === 'owner';
        if (base.ownerIds) return base.ownerIds.has(String(uid));
        return storedRole === 'owner';
    };
    // Until a phone knows the owners (read once a session when someone else voided a loaded bill), it flags no bill void
    const ownersKnown = peopleMap.size > 0 || !!base.ownerIds;
    const voidKey = (kind, billNumber, uid) => `${kind}|${String(billNumber || '')}|${String(uid || '')}`;
    const loadedVoids = new Map();
    // Voids of loaded bills: who and when come from the bill (rules: voidedBy = the writer, voidedAt = server time).
    // The name is the one stored on the bill on every phone, so scans never rewrite each other's record.
    ['purchase', 'retail', 'wholesale'].forEach(kind => (voided?.[kind] || []).forEach(bill => {
        if (!bill || bill.id == null || bill.voided !== true) return;
        const by = String(bill.voidedBy || '');
        if (bill.billNumber) loadedVoids.set(voidKey(kind, bill.billNumber, by), String(bill.id));
        if (!by || !ownersKnown || isOwnerUid(by)) return;
        const amount = round2(billTotal(bill));
        const no = bill.billNumber ? ` #${bill.billNumber}` : '';
        add(makeAnomaly('bill-voided', {
            refKind: 'bill', refId: bill.id, billType: kind, billNumber: bill.billNumber || null,
            party: billParty(bill), item: lineNames(bill.items).join(', '), userId: by, user: nameOf(by, bill.voidedByName), amount
        }, {
            at: toJsDate(bill.voidedAt)?.getTime(),
            ...AUDIT_TEXT['bill-voided'](no, amount, bill.voidReason)
        }));
    }));
    // #99: the same for voided expenses, from the expense itself; its audit entry names it (expenseId), so both
    // give one flag. A personal expense's flag carries no type or name (managers read flags, maybe not those rows).
    const expenseRef = (expense, id, userId, user, amount) => {
        const personal = isPersonalExpense(expense);
        return {
            refKind: 'expense', refId: id, party: personal ? '' : String(expense?.personName || '').trim(),
            item: personal ? '' : String(expense?.type || '').trim(), userId, user, amount
        };
    };
    (voided?.expense || []).forEach(expense => {
        if (!expense || expense.id == null || expense.voided !== true) return;
        const by = String(expense.voidedBy || '');
        if (!by || !ownersKnown || isOwnerUid(by)) return;
        const amount = round2(Number(expense.amount) || 0);
        add(makeAnomaly('expense-voided', expenseRef(expense, String(expense.id), by, nameOf(by, expense.voidedByName), amount), {
            at: toJsDate(expense.voidedAt)?.getTime(),
            ...AUDIT_TEXT['expense-voided']('', amount, expense.voidReason)
        }));
    });
    // An entry's userId is the writer's (rules); its stored userName is whatever the phone sent,
    // so the name comes from the profile when the owner's scan has the profiles (#85)
    const logUser = (log) => {
        const uid = String(log.userId || '');
        const profile = peopleMap.get(uid);
        return { userId: uid, user: String(profile?.name || '').trim() || nameOf(uid, log.userName === 'Unknown User' ? '' : log.userName) };
    };
    const KINDS = ['purchase', 'retail', 'wholesale'];
    (auditLogs || []).forEach(log => {
        const type = AUDIT_TYPES[log?.action];
        if (!type || log.id == null) return;
        const d = log.details && typeof log.details === 'object' ? log.details : {};
        // Deleting a bill that was already voided (flagged then) changes nothing.
        if (type === 'bill-deleted' && d.voided === true) return;
        if ((type === 'bill-voided' || type === 'expense-voided') && isOwnerUid(log.userId, log.userRole)) return;
        const amount = round2(Number(d.amount) || 0);
        if (type === 'expense-voided') {
            const expenseId = d.expenseId != null && String(d.expenseId) !== '' ? String(d.expenseId) : null;
            const { userId, user } = logUser(log);
            const ref = expenseId
                ? expenseRef({ type: d.type, category: d.category }, expenseId, userId, user, amount)
                : { ...expenseRef({ type: d.type, category: d.category }, log.id, userId, user, amount), refKind: 'audit' };
            const flag = makeAnomaly(type, ref, { at: Number(log.timestamp), ...AUDIT_TEXT[type]('', amount, d.reason) });
            if (expenseId) flag.auditTwin = true;
            add(flag);
            return;
        }
        const billNumber = d.billNumber && d.billNumber !== 'N/A' ? String(d.billNumber) : null;
        const no = billNumber ? ` #${billNumber}` : '';
        // A void shares its bill's flag id (named in the entry, or for older entries the loaded voided
        // bill of that kind and number voided by the same person), so the bill and its entry give one flag.
        // Such a twin only creates the record (auditTwin: withoutStoredVoidTwins); the bill's version wins.
        const kind = KINDS.includes(d.billType) ? d.billType : null;
        const billId = type !== 'bill-voided' || !kind ? null
            : d.billId != null && String(d.billId) !== '' ? String(d.billId)
                : (billNumber && loadedVoids.get(voidKey(kind, billNumber, log.userId))) || null;
        const flag = makeAnomaly(type, {
            ...(billId ? { refKind: 'bill', refId: billId, billType: kind } : { refKind: 'audit', refId: log.id }),
            billNumber, party: d.customer && d.customer !== 'N/A' ? String(d.customer) : '', ...logUser(log), amount
        }, {
            at: Number(log.timestamp),
            ...AUDIT_TEXT[type](no, amount, d.reason)
        });
        if (billId) flag.auditTwin = true;
        add(flag);
    });

    // #124: refused writes in a burst, new phones, tries on bills past their edit window
    deniedClusters(auditLogs, t).forEach(({ first, entries }) => {
        const kinds = [...new Set(entries.map(e => String(e.details?.source || '').trim()).filter(Boolean))].slice(0, 4).join(', ');
        const mins = Math.max(1, Math.round((Number(entries[entries.length - 1].timestamp) - Number(first.timestamp)) / 60000));
        add(makeAnomaly('access-denied', { refKind: 'audit', refId: first.id, ...logUser(first) }, {
            at: Number(first.timestamp),
            en: `${entries.length} changes refused within ${mins} min${kinds ? ` (${kinds})` : ''}`,
            hi: `${mins} मिनट में ${entries.length} बदलाव मना हुए`
        }));
    });
    (auditLogs || []).forEach(log => {
        if (!log || log.id == null) return;
        if (log.action === SECURITY_ACTIONS.NEW_DEVICE) {
            add(makeAnomaly('new-device', { refKind: 'audit', refId: log.id, ...logUser(log) }, {
                at: Number(log.timestamp),
                en: 'First sign-in on a phone this person had not used before',
                hi: 'इस व्यक्ति ने पहली बार इस फ़ोन से लॉग इन किया'
            }));
        }
    });
    // Tapping a locked Edit / Void is no flag by itself; trying 3 or more different old bills in a day is
    const triesByUserDay = new Map();
    (auditLogs || []).filter(l => l && l.id != null && l.action === SECURITY_ACTIONS.OLD_BILL_TRY && Number.isFinite(Number(l.timestamp)))
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
        .forEach(l => {
            const k = `${l.userId || ''}|${istDayKey(Number(l.timestamp))}`;
            if (!triesByUserDay.has(k)) triesByUserDay.set(k, []);
            triesByUserDay.get(k).push(l);
        });
    triesByUserDay.forEach(list => {
        const billIds = new Set(list.map(l => String(l.details?.billId || '')).filter(Boolean));
        if (billIds.size < OLD_BILL_TRIES_PER_DAY) return;
        const first = list[0];
        add(makeAnomaly('old-bill-edit-try', { refKind: 'audit', refId: first.id, ...logUser(first) }, {
            at: Number(first.timestamp),
            en: `Tried to change or void ${billIds.size} bills past their edit window in one day`,
            hi: `एक दिन में ${billIds.size} बिल बदलाव का समय बीतने के बाद बदलने या रद्द करने की कोशिश`
        }));
    });

    const stockFrom = firstStockTimes({ purchases: bills.purchase, stockAdjustments: adjustments }, catalogue);
    return sortAnomalies(withoutUnstockedOversell([...out.values()], { stockFrom, catalogue, stock }));
}

const sevRank = (s) => {
    const i = SEVERITIES.indexOf(s);
    return i === -1 ? SEVERITIES.length : i;
};

/** High severity first, then newest first, then id (stable). */
export function sortAnomalies(list) {
    return [...(list || [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
        || (Number(b.at) || 0) - (Number(a.at) || 0)
        || String(a.id).localeCompare(String(b.id)));
}

/** Fields a scan owns (written on every change); review fields belong to people. */
export const DETECTION_FIELDS = ['type', 'rule', 'severity', 'en', 'hi', 'refKind', 'refId', 'billType', 'billNumber',
    'party', 'item', 'userId', 'user', 'amount', 'at', 'dayKey', 'hour', 'detectedBy'];
const COMPARE_FIELDS = ['type', 'severity', 'en', 'hi', 'party', 'item', 'user', 'amount', 'at', 'dayKey'];

function detectionData(a) {
    const out = {};
    DETECTION_FIELDS.forEach(k => { if (a[k] !== undefined) out[k] = a[k]; });
    return out;
}

/**
 * Writes needed so stored anomaly docs match a scan, without touching review
 * fields: new ids get the full record with status 'open'; changed ones only
 * their detection fields (merge); unchanged ones nothing. Re-running a scan
 * over the same data therefore writes nothing.
 * @param {Array<Object>} detected
 * @param {Array<Object>} stored - docs already read for the same days ({id, ...})
 * @param {number} now - ms
 * @returns {Array<{id: string, data: Object, isNew: boolean}>}
 */
export function planAnomalyWrites(detected, stored, now) {
    const byId = new Map((stored || []).map(d => [d.id, d]));
    const seen = new Set();
    const writes = [];
    (detected || []).forEach(a => {
        if (!a || !a.id || seen.has(a.id)) return;
        seen.add(a.id);
        const ex = byId.get(a.id);
        if (!ex) {
            writes.push({
                id: a.id, isNew: true,
                data: { ...detectionData(a), detectedAt: now, status: 'open', note: '', reviewedBy: null, reviewedByName: null, reviewedAt: null }
            });
        } else if (COMPARE_FIELDS.some(k => (ex[k] ?? null) !== (a[k] ?? null))) {
            writes.push({ id: a.id, isNew: false, data: detectionData(a) });
        }
    });
    return writes;
}

/**
 * One list for display: stored docs (with their review status) plus fresh
 * detections not stored yet (status 'open'). Detection text comes from the
 * latest scan when both exist.
 * @param {Array<Object>} detected
 * @param {Array<Object>} stored
 * @returns {Array<Object>}
 */
export function mergeAnomalies(detected, stored) {
    const out = new Map();
    (stored || []).forEach(d => { if (d && d.id) out.set(d.id, { status: 'open', ...d }); });
    (detected || []).forEach(a => {
        if (!a || !a.id) return;
        const ex = out.get(a.id);
        out.set(a.id, ex ? { ...ex, ...detectionData(a) } : { status: 'open', ...a });
    });
    return sortAnomalies([...out.values()]);
}

const splitItems = (item) => String(item || '').split(', ').map(s => s.trim()).filter(Boolean);

/**
 * Drops "Sold more than stock" for items whose stock had never been set (no
 * purchase, no opening stock) by the time of the sale: before opening stock
 * is entered every sale is "more than stock" and the alert is noise (F15).
 * The flagged item is the one named at the start of the flag text, else any
 * item on the bill. Stock on hand (or a cost) counts as stock set when the
 * item's purchases are older than the loaded history.
 * @param {Array<Object>} list anomalies
 * @param {{stockFrom?: Map<string, number>, catalogue?: Array, stock?: Object}} ctx stockFrom from firstStockTimes()
 * @returns {Array<Object>}
 */
export function withoutUnstockedOversell(list, { stockFrom = new Map(), catalogue = [], stock = {} } = {}) {
    return (list || []).filter(a => {
        if (!a || a.type !== 'oversell') return true;
        const names = splitItems(a.item);
        if (!names.length) return true;
        const named = names.filter(n => String(a.en || '').startsWith(`${n}:`));
        const at = Number(a.at);
        return (named.length ? named : names).some(name => {
            const key = stockKeyFor({ name }, catalogue);
            if (stockFrom.has(key)) return !Number.isFinite(at) || stockFrom.get(key) <= at;
            const s = (stock || {})[key];
            return (Number(s?.quantity) || 0) > 0 || (Number(s?.rate) || 0) > 0;
        });
    });
}

function topCounts(list, keyFn, n) {
    const counts = new Map();
    list.forEach(a => keyFn(a).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)));
    return [...counts.entries()].map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
}

/**
 * Counts for a report: by severity, by type, top items/parties/users.
 * @param {Array<Object>} list
 * @returns {{total: number, open: number, bySeverity: Object, byType: Array, topItems: Array, topParties: Array, topUsers: Array}}
 */
export function summarizeAnomalies(list) {
    const items = list || [];
    const bySeverity = { high: 0, medium: 0, low: 0 };
    const types = new Map();
    items.forEach(a => {
        if (bySeverity[a.severity] !== undefined) bySeverity[a.severity]++;
        types.set(a.type, (types.get(a.type) || 0) + 1);
    });
    return {
        total: items.length,
        open: items.filter(a => (a.status || 'open') === 'open').length,
        bySeverity,
        byType: [...types.entries()].map(([type, count]) => ({ type, count, ...typeLabel(type) }))
            .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
        topItems: topCounts(items, a => splitItems(a.item), 3),
        topParties: topCounts(items, a => (a.party ? [String(a.party).trim()] : []), 3),
        topUsers: topCounts(items, a => (a.user ? [String(a.user).trim()] : []), 3)
    };
}

/** One line for the cash-close screen, in the app language. */
export function summaryLine(list) {
    const s = summarizeAnomalies(list);
    if (s.total === 0) return t('ui.anom.summary_none');
    return t('ui.anom.summary_count', { total: s.total, high: s.bySeverity.high });
}

const inr = (n) => formatRupees(n, { exact: true });

/**
 * WhatsApp text of the day report, in the app language (also the printed image lines).
 * @param {Object} args
 * @param {string} args.dayKey
 * @param {Array<Object>} args.today - today's anomalies
 * @param {Object} [args.totals] - day totals shown on Today
 * @param {string} [args.shopName]
 * @returns {string}
 */
export function buildDayReportText({ dayKey, today = [], totals = null, shopName = '' }) {
    const lines = [];
    lines.push(`*${t('ui.anom.day_report')}* — ${formatDayKey(dayKey)}`);
    const shop = cleanText(shopName);
    if (shop) lines.push(shop);
    if (totals) {
        lines.push('');
        lines.push(tn('ui.anom.report_sales', Number(totals.saleCount) || 0, { amount: inr(totals.sales) }));
        lines.push(tn('ui.anom.report_purchases', Number(totals.purchaseCount) || 0, { amount: inr(totals.purchases) }));
        lines.push(t('ui.anom.report_expenses', { amount: inr(totals.expenses) }));
        if (totals.labourToPay) {
            lines.push(tn('ui.anom.report_labour_deducted', Number(totals.labourDeductedBills) || 0, { amount: inr(totals.labourDeducted) }));
            lines.push(labourCalcText(totals.labourToPay, 'ui.anom.report_labour_to_pay', { amount: inr(totals.labourToPay.amount) }));
        }
        lines.push(t('ui.anom.report_money', { moneyIn: inr(totals.totalIn), moneyOut: inr(totals.totalOut) }));
        lines.push(t('ui.anom.report_due', { received: inr(totals.dueReceived), paid: inr(totals.duePaid) }));
    }
    const s = summarizeAnomalies(today);
    lines.push('');
    if (s.total === 0) {
        lines.push(t('ui.anom.report_none'));
    } else {
        lines.push(t('ui.anom.report_count', { total: s.total, high: s.bySeverity.high, medium: s.bySeverity.medium, low: s.bySeverity.low }));
        s.byType.forEach(x => lines.push(`• ${pickLang(x)}: ${x.count}`));
        if (s.topItems.length) lines.push(`${t('ui.anom.top_items')}: ${s.topItems.map(x => `${cleanText(x.name)} (${x.count})`).join(', ')}`);
        if (s.topParties.length) lines.push(`${t('ui.anom.top_parties')}: ${s.topParties.map(x => `${cleanText(x.name)} (${x.count})`).join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * Day-key range for a date preset.
 * @param {'today'|'yesterday'|'7d'|'30d'|'90d'} preset
 * @param {string} todayKey
 * @returns {{from: string, to: string}}
 */
export function presetRange(preset, todayKey) {
    switch (preset) {
        case 'yesterday': { const y = addDaysToKey(todayKey, -1); return { from: y, to: y }; }
        case '30d': return { from: addDaysToKey(todayKey, -29), to: todayKey };
        case '90d': return { from: addDaysToKey(todayKey, -89), to: todayKey };
        case 'today': return { from: todayKey, to: todayKey };
        default: return { from: addDaysToKey(todayKey, -6), to: todayKey };
    }
}

/**
 * Filter anomalies for the Anomalies page.
 * @param {Array<Object>} list
 * @param {{from?: string, to?: string, type?: string, severity?: string, item?: string, user?: string, status?: string}} f
 *   empty / 'all' means no filter on that field
 * @returns {Array<Object>}
 */
export function filterAnomalies(list, f = {}) {
    const any = (v) => v === undefined || v === null || v === '' || v === 'all';
    const itemQ = String(f.item || '').trim().toLowerCase();
    return (list || []).filter(a => (any(f.from) || String(a.dayKey) >= f.from)
        && (any(f.to) || String(a.dayKey) <= f.to)
        && (any(f.type) || a.type === f.type)
        && (any(f.severity) || a.severity === f.severity)
        && (any(f.status) || (a.status || 'open') === f.status)
        && (any(f.user) || String(a.user || a.userId || '') === f.user)
        && (!itemQ || String(a.item || '').toLowerCase().includes(itemQ)));
}

/**
 * Pattern views over a list: per-day counts by type, item × type heatmap,
 * by user, by hour of day and repeat offenders (seen on 2+ different days).
 * @param {Array<Object>} list
 * @param {{maxItems?: number}} [opts]
 */
export function anomalyPatterns(list, { maxItems = 10 } = {}) {
    const items = list || [];
    const typesSeen = [...new Set(items.map(a => a.type))].sort();

    const dayMap = new Map();
    items.forEach(a => {
        const d = dayMap.get(a.dayKey) || { dayKey: a.dayKey, total: 0, byType: {} };
        d.total++;
        d.byType[a.type] = (d.byType[a.type] || 0) + 1;
        dayMap.set(a.dayKey, d);
    });
    const days = [...dayMap.values()].sort((a, b) => String(a.dayKey).localeCompare(String(b.dayKey)));

    const itemTotals = topCounts(items, a => splitItems(a.item), maxItems);
    const cells = {};
    itemTotals.forEach(({ name }) => { cells[name] = {}; });
    items.forEach(a => splitItems(a.item).forEach(name => {
        if (cells[name]) cells[name][a.type] = (cells[name][a.type] || 0) + 1;
    }));
    const heatTypes = typesSeen.filter(t => itemTotals.some(({ name }) => cells[name][t]));

    const users = new Map();
    items.forEach(a => {
        const key = String(a.user || a.userId || '').trim();
        if (!key) return;
        const u = users.get(key) || { name: key, count: 0, high: 0, byType: {} };
        u.count++;
        if (a.severity === 'high') u.high++;
        u.byType[a.type] = (u.byType[a.type] || 0) + 1;
        users.set(key, u);
    });

    const byHour = new Array(24).fill(0);
    items.forEach(a => {
        const h = Number.isInteger(a.hour) ? a.hour : (Number.isFinite(Number(a.at)) ? istHour(Number(a.at)) : null);
        if (h !== null && h >= 0 && h < 24) byHour[h]++;
    });

    const repeat = (keyFn) => {
        const m = new Map();
        items.forEach(a => keyFn(a).forEach(k => {
            const r = m.get(k) || { name: k, count: 0, days: new Set(), types: new Set() };
            r.count++;
            r.days.add(a.dayKey);
            r.types.add(a.type);
            m.set(k, r);
        }));
        return [...m.values()].filter(r => r.days.size >= 2)
            .map(r => ({ name: r.name, count: r.count, days: r.days.size, types: [...r.types] }))
            .sort((a, b) => b.count - a.count || b.days - a.days || a.name.localeCompare(b.name))
            .slice(0, 10);
    };

    return {
        types: typesSeen,
        days,
        heat: { items: itemTotals.map(x => x.name), types: heatTypes, cells },
        byUser: [...users.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        byHour,
        repeat: {
            items: repeat(a => splitItems(a.item)),
            users: repeat(a => (a.user ? [String(a.user).trim()] : [])),
            parties: repeat(a => (a.party ? [String(a.party).trim()] : []))
        }
    };
}
