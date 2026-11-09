/**
 * @fileoverview DUE-WRITE (#126): a bill's one stored due is `payment.due` (BILL-PAY's due,
 * docs/calculations.md). The legacy top-level `dueAmount` copy is neither written nor read: every
 * bill write of the repositories (new bills, checked edits, due payments, write-offs, settle-all,
 * party payments) passes its fields through `withCanonicalDue()` just before writing, which leaves
 * `dueAmount` out. tools/migrate stores each bill it copies with `canonicalDueBill()` (the due the
 * old app read, in `payment.due`); `dueBackfillFields()` is what the owner's one-time backfill
 * (DUE-BACKFILL) writes on an older bill. Pure: no Firestore, so tools/migrate imports it.
 * @module firebase/repos/bill-due
 */

import { legacyDue, readPayment } from '../../utils/money.js';
import { billEditChanges, withUnchangedFields } from '../../utils/bill-edits.js';

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const canonical = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (isMap(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
};

/**
 * Leaves the legacy `dueAmount` out of a bill write (in place): the due is `payment.due` only. A
 * whole-bill set() then drops a `dueAmount` an older bill still has; an update never touches it.
 * @param {Object} fields - the whole bill or the fields of a partial update
 * @returns {Object} fields
 */
export function withCanonicalDue(fields) {
    if (isMap(fields)) delete fields.dueAmount;
    return fields;
}

/**
 * The copy of a stored bill tools/migrate writes (#126): `payment.due` = the due the old app read
 * (legacyDue: `payment.due`, else `dueAmount`, else `due`, else total − paid), `dueAmount` left
 * out, every other field as stored, so every figure reads the same from `payment.due` alone.
 * @param {Object} bill - the bill as stored in the old project
 * @returns {Object} a new object
 */
export function canonicalDueBill(bill) {
    if (!isMap(bill)) return bill;
    const out = { ...bill, payment: { ...(isMap(bill.payment) ? bill.payment : {}), due: legacyDue(bill) } };
    delete out.dueAmount;
    return out;
}

/** Why a stored bill needs the backfill (DUE-BACKFILL). */
export const DUE_BACKFILL_REASONS = Object.freeze(['missing', 'notNumber']);

/**
 * DUE-BACKFILL (#126): the fields the owner's one-time backfill writes on a stored bill so its due
 * is stored as a number in `payment.due`: the due the bill showed before #126's cut-over (legacyDue),
 * so no figure moves from what the old app showed. Null when nothing is needed: the due is already
 * a number in `payment.due`, nothing is owed either way, or the bill is voided (it counts nowhere and
 * the rules refuse any change to it). `fields: null` with reason `changes`: a bill whose figures the
 * write would move, or whose `payment` is not a map; never written (none is known).
 * @param {Object} bill - the bill as stored
 * @returns {?{reason: 'missing'|'notNumber'|'changes', fields: ?Object}}
 */
export function dueBackfillFields(bill) {
    if (!isMap(bill) || bill.voided === true) return null;
    const p = isMap(bill.payment) ? bill.payment : null;
    const stored = p && Object.prototype.hasOwnProperty.call(p, 'due') ? p.due : undefined;
    if (typeof stored === 'number' && Number.isFinite(stored)) return null;
    const due = legacyDue(bill);
    if (due === 0 && readPayment(bill).due === 0) return null;
    // A `payment` stored as something else than a map, or a NaN / Infinity where the write goes (no
    // edit record can match it: the rules see NaN != NaN), is left for a person to look at
    const nonFinite = (v) => typeof v === 'number' && !Number.isFinite(v);
    if ((bill.payment != null && !p) || nonFinite(bill.dueAmount) || (p && Object.values(p).some(nonFinite))) return { reason: 'changes', fields: null };
    const reason = stored === undefined ? 'missing' : 'notNumber';
    const fields = { payment: { ...(p || {}), due } };
    const same = canonical(readPayment({ ...bill, ...fields })) === canonical({ ...readPayment(bill), due });
    return same ? { reason, fields } : { reason: 'changes', fields: null };
}

/**
 * DUE-BACKFILL's edit record fields (#121): what `fields` changes on `bill`, with `payment`
 * recorded even when unchanged (bill-edits isDueBackfillEdit).
 * @param {Object} bill - the bill as stored
 * @param {Object} fields - dueBackfillFields(bill).fields (and what goes with them)
 * @returns {{fields: Object}}
 */
export function dueBackfillChanges(bill, fields) {
    return withUnchangedFields(billEditChanges(bill, { ...bill, ...fields }), bill, ['payment']);
}
