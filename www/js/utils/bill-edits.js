/**
 * @fileoverview Bill corrections (#121) and voids (#75). An edit keeps a
 * compact before/after of what changed (changed fields only, item lines
 * diffed) with the editor and a required reason, stored next to the bill
 * (`<bills>/{id}/edits/{n}`, firestore-service.js updateBillChecked). A void
 * keeps the bill with who, when and why (money.isActiveBill). Pure: no DOM,
 * AppState or Firestore.
 * @module utils/bill-edits
 */

import { formatRupees, isActiveBill, readLineItem } from './money.js';
import { formatDayTime } from './dates.js';
import { t } from '../i18n/index.js';

/** Reasons (edit and void): trimmed length limits, as firestore.rules check them. */
export const REASON_MIN = 3;
export const REASON_MAX = 300;

/**
 * Bill fields an edit records. Changing any but the notes needs an edit record
 * (firestore.rules editLoggedFields()).
 */
export const EDIT_FIELDS = Object.freeze([
    'customerName', 'grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal', 'laborCharges',
    'payment', 'cashPayment', 'onlinePayment', 'dueAmount', 'comments', 'printComments'
]);

/** Most item lines kept in one edit record (a bill has far fewer). */
export const MAX_EDIT_LINES = 200;

/** Fields written when a bill is voided (firestore.rules voidOk). */
export const VOID_FIELDS = Object.freeze(['voided', 'voidedAt', 'voidedBy', 'voidedByName', 'voidReason', 'openDue']);

const canonical = (v) => {
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        if (typeof v.toMillis === 'function') return String(v.toMillis());
        return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
};
const same = (a, b) => canonical(a) === canonical(b);
const stored = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * A reason as stored: trimmed, or null when too short / too long.
 * @param {*} text
 * @returns {?string}
 */
export function cleanReason(text) {
    const r = String(text ?? '').trim();
    return r.length >= REASON_MIN && r.length <= REASON_MAX ? r : null;
}

const lineKey = (line) => String(line?.itemId || readLineItem(line).name || '').trim().toLowerCase();
const lineView = (line) => {
    const v = readLineItem(line);
    return { qty: v.qty, rate: v.rate, total: v.total };
};

/**
 * Item lines that differ between two versions: lines of the same item are
 * paired in order; a line only in one version is added / removed.
 * @param {Array} before
 * @param {Array} after
 * @returns {Array<{name: string, before: ?{qty, rate, total}, after: ?{qty, rate, total}}>}
 */
export function diffLines(before, after) {
    const left = (Array.isArray(before) ? before : []).filter(Boolean);
    const right = (Array.isArray(after) ? after : []).filter(Boolean);
    const pool = new Map();
    left.forEach(l => {
        const k = lineKey(l);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(l);
    });
    const out = [];
    right.forEach(r => {
        const prev = pool.get(lineKey(r))?.shift();
        const a = lineView(r);
        if (!prev) {
            out.push({ name: readLineItem(r).name, before: null, after: a });
            return;
        }
        const b = lineView(prev);
        if (!same(a, b)) out.push({ name: readLineItem(r).name, before: b, after: a });
    });
    pool.forEach(rest => rest.forEach(l => out.push({ name: readLineItem(l).name, before: lineView(l), after: null })));
    return out;
}

/**
 * What an edit changes: the recorded fields whose stored value differs
 * ({field: {before, after}}), the item lines that differ, and whether the
 * items changed at all (also weights or packets alone).
 * @param {Object} before the bill as stored
 * @param {Object} after the bill to be written
 * @returns {{fields: Object<string, {before: *, after: *}>, lines: Array, itemsChanged: boolean}}
 */
export function billEditChanges(before, after) {
    const b = before || {};
    const a = after || {};
    const fields = {};
    EDIT_FIELDS.forEach(k => {
        if (!same(b[k], a[k])) fields[k] = { before: stored(b[k]), after: stored(a[k]) };
    });
    const itemsChanged = !same(b.items, a.items);
    const lines = itemsChanged ? diffLines(b.items, a.items).slice(0, MAX_EDIT_LINES) : [];
    return { fields, lines, itemsChanged };
}

/**
 * The edit changes something that is recorded (and needs a reason).
 * @param {ReturnType<typeof billEditChanges>} changes
 * @returns {boolean}
 */
export function hasEditChanges(changes) {
    return !!changes && (Object.keys(changes.fields || {}).length > 0 || !!changes.itemsChanged);
}

/**
 * The edit record stored at `<bills>/{id}/edits/{n}`; `at` is the server time
 * (passed in), `by` the editor's uid.
 * @param {{n: number, at: *, by: string, byName?: string, reason: string, changes: ReturnType<typeof billEditChanges>}} args
 * @returns {Object}
 */
export function editRecord({ n, at, by, byName = '', reason, changes }) {
    return {
        n, at, by,
        byName: String(byName || '').slice(0, 200),
        reason: String(reason || '').trim().slice(0, REASON_MAX),
        fields: changes.fields || {},
        lines: changes.lines || [],
        itemsChanged: !!changes.itemsChanged
    };
}

/** Number of edits recorded on a bill (0 for bills never edited or edited before #121). */
export function editCountOf(bill) {
    const n = Number(bill?.editCount);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Number (and document id) of the next edit record of a bill. */
export function nextEditNumber(bill) {
    return editCountOf(bill) + 1;
}

/**
 * Why a bill can't be voided right now, or null: already voided, or payments
 * recorded after it was saved (their cash-session legs would be left behind:
 * a void never moves money; see docs/role-permissions.md "Void").
 * @param {Object} bill
 * @returns {?('voided'|'payments')}
 */
export function voidBlocker(bill) {
    if (!isActiveBill(bill)) return 'voided';
    if (Array.isArray(bill.payments) ? bill.payments.length > 0 : !!bill.payments) return 'payments';
    return null;
}

const TOTAL_FIELDS = ['grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal'];
const FIELD_LABEL = {
    customerName: 'ui.edits.field_party', laborCharges: 'ui.edits.field_labour',
    comments: 'ui.edits.field_note', printComments: 'ui.edits.field_print_note'
};
const PAY_PARTS = [['cash', 'cashPayment', 'ui.edits.field_cash'], ['online', 'onlinePayment', 'ui.edits.field_online'], ['due', 'dueAmount', 'ui.edits.field_due']];

const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const valueText = (v, lang) => {
    if (v === null || v === undefined || v === '') return t('ui.edits.empty_value', null, lang);
    if (typeof v === 'boolean') return t(v ? 'ui.edits.yes' : 'ui.edits.no', null, lang);
    if (typeof v === 'number') return formatRupees(v);
    if (typeof v === 'object') return t('ui.edits.empty_value', null, lang);
    return String(v);
};
const lineText = (v, lang) => t('ui.edits.line_value', { qty: v.qty, rate: formatRupees(v.rate) }, lang);

/**
 * Plain-text lines for one stored edit (caller escapes): what changed, field
 * by field, then item by item. Totals stored in several fields show once.
 * @param {Object} edit stored edit record
 * @param {'en'|'hi'} [lang]
 * @returns {string[]}
 */
export function describeEdit(edit, lang) {
    const fields = edit?.fields || {};
    const out = [];
    const change = (labelKey, before, after) => {
        out.push(`${t(labelKey, null, lang)}: ${valueText(before, lang)} → ${valueText(after, lang)}`);
    };
    if (fields.customerName) change(FIELD_LABEL.customerName, fields.customerName.before, fields.customerName.after);
    const total = TOTAL_FIELDS.find(k => fields[k]);
    if (total) change('ui.edits.field_total', money(fields[total].before), money(fields[total].after));
    if (fields.laborCharges) change(FIELD_LABEL.laborCharges, money(fields.laborCharges.before), money(fields.laborCharges.after));
    PAY_PARTS.forEach(([part, top, label]) => {
        const p = fields.payment;
        const before = p ? money(p.before?.[part]) : null;
        const after = p ? money(p.after?.[part]) : null;
        if (p && before !== after) change(label, before, after);
        else if (!p && fields[top]) change(label, money(fields[top].before), money(fields[top].after));
    });
    ['comments', 'printComments'].forEach(k => {
        if (fields[k]) change(FIELD_LABEL[k], fields[k].before, fields[k].after);
    });
    (edit?.lines || []).forEach(l => {
        const name = l.name || t('ui.edits.empty_value', null, lang);
        if (!l.before) out.push(t('ui.edits.line_added', { name, after: lineText(l.after, lang) }, lang));
        else if (!l.after) out.push(t('ui.edits.line_removed', { name, before: lineText(l.before, lang) }, lang));
        else out.push(`${name}: ${lineText(l.before, lang)} → ${lineText(l.after, lang)}`);
    });
    if (edit?.itemsChanged && !(edit?.lines || []).length) out.push(t('ui.edits.items_other', null, lang));
    return out;
}

/**
 * Heading of one edit: "#2 · 31 Oct, 2:05 pm · Ravi".
 * @param {Object} edit
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function editHeading(edit, lang) {
    const when = formatDayTime(edit?.at, { lang }) || t('ui.edits.empty_value', null, lang);
    return `#${edit?.n ?? ''} · ${when} · ${edit?.byName || t('ui.edits.someone', null, lang)}`;
}
