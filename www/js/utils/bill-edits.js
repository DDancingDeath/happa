// @ts-check
/**
 * @fileoverview Bill corrections (#121) and voids (#75). An edit keeps the
 * before/after of every recorded field it changed (the item list too, as it
 * was and as it became; the screen diffs the lines) with the editor and a
 * required reason, stored next to the bill (`<bills>/{id}/edits/{n}`,
 * firestore-service.js updateBillChecked; firestore.rules check every value
 * against the bill before and after the write). A void
 * keeps the bill with who, when and why (money.isActiveBill). Pure: no DOM,
 * AppState or Firestore.
 * @module utils/bill-edits
 */

import { formatRupees, isActiveBill, readLineItem, round2, toMoney } from './money.js';
import { formatDayTime } from './dates.js';
import { t } from '../i18n/index.js';

/** Reasons (edit and void): trimmed length limits, as firestore.rules check them. */
export const REASON_MIN = 3;
export const REASON_MAX = 300;

/**
 * Bill fields an edit records, the same list as firestore.rules editLoggedFields(): changing
 * any of them needs an edit record, and the record must hold exactly their values before and
 * after. The notes (comments, print toggle) are not recorded and need no reason.
 */
export const EDIT_FIELDS = Object.freeze([
    'items', 'customerName', 'grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal', 'laborCharges',
    'payment', 'cashPayment', 'onlinePayment', 'dueAmount', 'date', 'timestamp'
]);

/** Fields written when a bill is voided (firestore.rules voidOk). */
export const VOID_FIELDS = Object.freeze(['voided', 'voidedAt', 'voidedBy', 'voidedByName', 'voidReason', 'openDue']);

/**
 * @param {*} v
 * @returns {string}
 */
const canonical = (v) => {
    if (v === undefined) return 'undefined';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        if (typeof v.toMillis === 'function') return `ts:${v.toMillis()}`;
        return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
};
const same = (/** @type {*} */ a, /** @type {*} */ b) => canonical(a) === canonical(b);
// A value as Firestore keeps it (the rules compare the record with the bill): undefined
// keys dropped, Timestamps left as Timestamps.
/**
 * @param {*} v
 * @returns {*}
 */
const stored = (v) => {
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return v.filter(x => x !== undefined).map(stored);
    if (typeof v === 'object') {
        if (typeof v.toMillis === 'function') return v;
        /** @type {Rec} */
        const out = {};
        Object.keys(v).forEach(k => { if (v[k] !== undefined) out[k] = stored(v[k]); });
        return out;
    }
    return v;
};

/**
 * A reason as stored: trimmed, or null when too short / too long.
 * @param {*} text
 * @returns {?string}
 */
export function cleanReason(text) {
    const r = String(text ?? '').trim();
    return r.length >= REASON_MIN && r.length <= REASON_MAX ? r : null;
}

const lineKey = (/** @type {Rec} */ line) => String(line?.itemId || readLineItem(line).name || '').trim().toLowerCase();
const lineView = (/** @type {Rec} */ line) => {
    const v = readLineItem(line);
    return { qty: v.qty, rate: v.rate, total: v.total };
};

/**
 * Item lines that differ between two versions: lines of the same item are
 * paired in order; a line only in one version is added / removed.
 * @param {*} before
 * @param {*} after
 * @returns {Array<{name: string, before: ?{qty: number, rate: number, total: number}, after: ?{qty: number, rate: number, total: number}}>}
 */
export function diffLines(before, after) {
    const left = (Array.isArray(before) ? before : []).filter(Boolean);
    const right = (Array.isArray(after) ? after : []).filter(Boolean);
    /** @type {Map<string, Array<Rec>>} */
    const pool = new Map();
    left.forEach(l => {
        const k = lineKey(l);
        if (!pool.has(k)) pool.set(k, []);
        /** @type {Array<Rec>} */ (pool.get(k)).push(l);
    });
    /** @type {ReturnType<typeof diffLines>} */
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
 * What an edit changes: each recorded field whose stored value differs, with its value
 * before and after ({field: {before, after}}; the whole item list for `items`).
 * @param {Rec} before the bill as stored
 * @param {Rec} after the bill to be written
 * @returns {{fields: Object<string, {before: *, after: *}>}}
 */
export function billEditChanges(before, after) {
    const b = before || {};
    const a = after || {};
    /** @type {Object<string, {before: *, after: *}>} */
    const fields = {};
    EDIT_FIELDS.forEach(k => {
        if (!same(b[k], a[k])) fields[k] = { before: stored(b[k]), after: stored(a[k]) };
    });
    return { fields };
}

/**
 * The edit changes something that is recorded (and needs a reason).
 * @param {ReturnType<typeof billEditChanges>} changes
 * @returns {boolean}
 */
export function hasEditChanges(changes) {
    return !!changes && Object.keys(changes.fields || {}).length > 0;
}

/**
 * The item lines an edit changed, worked out from its stored item lists (diffLines).
 * @param {Rec} edit stored edit record
 * @returns {ReturnType<typeof diffLines>}
 */
export function editLines(edit) {
    const items = edit?.fields?.items;
    return items ? diffLines(items.before, items.after) : [];
}

/**
 * The edit record stored at `<bills>/{id}/edits/{n}`; `at` is the server time
 * (passed in), `by` the editor's uid.
 * @param {{n: number, at: *, by: string, byName?: string, reason: string, changes: ReturnType<typeof billEditChanges>}} args
 * @returns {Rec}
 */
export function editRecord({ n, at, by, byName = '', reason, changes }) {
    return {
        n, at, by,
        byName: String(byName || '').slice(0, 200),
        reason: String(reason || '').trim().slice(0, REASON_MAX),
        fields: changes.fields || {}
    };
}

/**
 * Number of edits recorded on a bill (0 for bills never edited or edited before #121).
 * @param {?Rec|undefined} bill
 * @returns {number}
 */
export function editCountOf(bill) {
    const n = Number(bill?.editCount);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Number (and document id) of the next edit record of a bill.
 * @param {?Rec|undefined} bill
 * @returns {number}
 */
export function nextEditNumber(bill) {
    return editCountOf(bill) + 1;
}

/**
 * Why a bill can't be voided right now, or null: already voided, or payments
 * recorded after it was saved (their cash-session legs would be left behind:
 * a void never moves money; see docs/role-permissions.md "Void").
 * @param {Rec} bill
 * @returns {?('voided'|'payments')}
 */
export function voidBlocker(bill) {
    if (!isActiveBill(bill)) return 'voided';
    if (Array.isArray(bill.payments) ? bill.payments.length > 0 : !!bill.payments) return 'payments';
    return null;
}

const TOTAL_FIELDS = ['grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal'];
const FIELD_LABEL = { customerName: 'ui.edits.field_party', laborCharges: 'ui.edits.field_labour' };
const PAY_PARTS = [['cash', 'cashPayment', 'ui.edits.field_cash'], ['online', 'onlinePayment', 'ui.edits.field_online'], ['due', 'dueAmount', 'ui.edits.field_due']];

const money = (/** @type {*} */ v) => (v === null || v === undefined || v === '' ? null : Number(v));
const valueText = (/** @type {*} */ v, /** @type {'en'|'hi'|undefined} */ lang) => {
    if (v === null || v === undefined || v === '') return t('ui.edits.empty_value', null, lang);
    if (typeof v === 'number') return formatRupees(v);
    if (typeof v === 'object') return t('ui.edits.empty_value', null, lang);
    return String(v);
};
const dayText = (/** @type {*} */ v, /** @type {'en'|'hi'|undefined} */ lang) => formatDayTime(v, { lang }) || t('ui.edits.empty_value', null, lang);
const lineText = (/** @type {Rec} */ v, /** @type {'en'|'hi'|undefined} */ lang) => t('ui.edits.line_value', { qty: v.qty, rate: formatRupees(v.rate) }, lang);

/** A finite number. */
const isNum = (/** @type {*} */ v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The fields of `keys` an edit record holds although the edit leaves them as they are ({before,
 * after} equal; the rules allow any recorded field with its true values): what the due backfill
 * adds so its record proves which due the bill showed before (isDueBackfillEdit).
 * @param {ReturnType<typeof billEditChanges>} changes
 * @param {Rec} bill the bill as stored
 * @param {string[]} keys recorded fields (EDIT_FIELDS)
 * @returns {ReturnType<typeof billEditChanges>}
 */
export function withUnchangedFields(changes, bill, keys) {
    const fields = { ...(changes?.fields || {}) };
    keys.filter(k => EDIT_FIELDS.includes(k) && !fields[k] && bill && Object.prototype.hasOwnProperty.call(bill, k))
        .forEach(k => { fields[k] = { before: stored(bill[k]), after: stored(bill[k]) }; });
    return { fields };
}

/**
 * Whether a stored edit is the owner's due backfill (#126, DUE-BACKFILL) and provably moved no
 * figure, so it can read as one line: its reason in either language; nothing but `payment` /
 * `dueAmount` recorded; `payment` recorded and changed in `due` only; the due the bill showed
 * before (BILL-PAY: `payment.due`, else `dueAmount`, as recorded) equal to the new `payment.due`;
 * a recorded `dueAmount` ending equal to it. Anything else, also with that reason (any editor can
 * type it), is described in full.
 * @param {Rec} edit stored edit record
 * @returns {boolean}
 */
export function isDueBackfillEdit(edit) {
    const reason = String(edit?.reason || '').trim();
    if (!['en', 'hi'].some(l => t('ui.edits.due_backfill_reason', null, /** @type {'en'|'hi'} */ (l)) === reason)) return false;
    const fields = edit?.fields || {};
    if (!fields.payment || Object.keys(fields).some(k => k !== 'payment' && k !== 'dueAmount')) return false;
    const before = fields.payment.before && typeof fields.payment.before === 'object' ? fields.payment.before : {};
    const after = fields.payment.after && typeof fields.payment.after === 'object' ? fields.payment.after : {};
    const rest = (/** @type {Rec} */ m) => Object.keys(m).filter(k => k !== 'due').sort().map(k => `${k}:${JSON.stringify(m[k])}`).join('|');
    if (rest(before) !== rest(after) || !isNum(after.due)) return false;
    const shown = toMoney(before.due) ?? (fields.dueAmount ? toMoney(fields.dueAmount.before) : null);
    if (shown === null || round2(shown) !== after.due) return false;
    return !fields.dueAmount || fields.dueAmount.after === after.due;
}
/**
 * Plain-text lines for one stored edit (caller escapes): what changed, field
 * by field, then item by item. Totals stored in several fields show once.
 * @param {Rec} edit stored edit record
 * @param {'en'|'hi'} [lang]
 * @returns {string[]}
 */
export function describeEdit(edit, lang) {
    if (isDueBackfillEdit(edit)) return [t('ui.edits.due_backfill_line', null, lang)];
    const fields = edit?.fields || {};
    const out = [];
    const change = (/** @type {string} */ labelKey, /** @type {*} */ before, /** @type {*} */ after) => {
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
    const day = fields.date ? 'date' : fields.timestamp ? 'timestamp' : null;
    if (day) out.push(`${t('ui.edits.field_date', null, lang)}: ${dayText(fields[day].before, lang)} → ${dayText(fields[day].after, lang)}`);
    const lines = editLines(edit);
    lines.forEach(l => {
        const name = l.name || t('ui.edits.empty_value', null, lang);
        if (!l.before) out.push(t('ui.edits.line_added', { name, after: lineText(/** @type {Rec} */ (l.after), lang) }, lang));
        else if (!l.after) out.push(t('ui.edits.line_removed', { name, before: lineText(l.before, lang) }, lang));
        else out.push(`${name}: ${lineText(l.before, lang)} → ${lineText(l.after, lang)}`);
    });
    if (fields.items && !lines.length) out.push(t('ui.edits.items_other', null, lang));
    return out;
}

/**
 * Heading of one edit: "#2 · 31 Oct, 2:05 pm · Ravi".
 * @param {Rec} edit
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function editHeading(edit, lang) {
    const when = formatDayTime(edit?.at, { lang }) || t('ui.edits.empty_value', null, lang);
    return `#${edit?.n ?? ''} · ${when} · ${edit?.byName || t('ui.edits.someone', null, lang)}`;
}
