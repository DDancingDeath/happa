/**
 * @fileoverview DUE-WRITE (#126): the one writer of a bill's stored due. `payment.due` is the
 * canonical field (BILL-PAY's due, docs/calculations.md); the top-level `dueAmount` is a legacy
 * mirror that only this module writes, always equal to `payment.due`. Every bill write of the
 * repositories (new bills, checked edits, due payments, write-offs, settle-all, party payments)
 * and tools/migrate pass their fields through `withCanonicalDue()` just before writing; the code
 * that builds those fields sets `payment.due` only. `dueBackfillFields()` is what the owner's one-time
 * backfill (DUE-BACKFILL) writes on an older bill. Pure: no Firestore, so tools/migrate imports it.
 *
 * The mirror goes on the same bills as before #126, so no stored shape changes:
 *  - a whole-bill write (new bill, edit) that sets the money: always;
 *  - a whole-bill write that keeps every money field as stored (a name or note edit): `dueAmount`
 *    stays as it is;
 *  - a partial update (payment, write-off): only when the stored bill has `dueAmount`.
 * @module firebase/repos/bill-due
 */

import { outstandingDue, readPayment } from '../../utils/money.js';

/** Money fields a bill edit sets together with its payment (bill-edits EDIT_FIELDS without dueAmount and the date). */
const MONEY_FIELDS = ['items', 'grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal', 'laborCharges',
    'payment', 'cashPayment', 'onlinePayment'];

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const canonical = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (isMap(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
};

const setsMoney = (record, stored) => !stored || MONEY_FIELDS.some(k => canonical(record[k]) !== canonical(stored[k]));

/**
 * Sets the `dueAmount` mirror of the `payment.due` this write stores (in place). A write
 * that stores no numeric `payment.due` (a void, a legacy bill kept as it was) is unchanged.
 * @param {Object} fields - the whole bill (`full`) or the fields of a partial update
 * @param {?Object} stored - the bill as stored now (null for a new bill)
 * @param {{full?: boolean}} [opts] - `full`: fields is the whole bill (set), else an update
 * @returns {Object} fields
 */
export function withCanonicalDue(fields, stored, { full = false } = {}) {
    const due = fields?.payment?.due;
    if (!isMap(fields?.payment) || typeof due !== 'number' || !Number.isFinite(due)) return fields;
    const mirror = full
        ? setsMoney(fields, stored)
        : isMap(stored) && Object.prototype.hasOwnProperty.call(stored, 'dueAmount');
    if (mirror) fields.dueAmount = due;
    return fields;
}

/** Why a stored bill needs the backfill (DUE-BACKFILL). */
export const DUE_BACKFILL_REASONS = Object.freeze(['missing', 'notNumber', 'mirror']);

/**
 * DUE-BACKFILL (#126): the fields the owner's one-time backfill writes on a stored bill so its due
 * is stored once, as a number in `payment.due`, with `dueAmount` (where the bill has it) equal to
 * it. The value is the due every screen shows now (BILL-PAY: `payment.due` when it is a number,
 * else `readPayment()`), so no figure moves. Null when nothing is needed: the due is already a
 * number in `payment.due` and `dueAmount` is absent or equal, or the bill is voided (it counts
 * nowhere and the rules refuse any change to it). `fields: null` with reason `changes`: a bill
 * whose figures the write would move, or whose `payment` is not a map; never written (none is known).
 * @param {Object} bill - the bill as stored
 * @returns {?{reason: 'missing'|'notNumber'|'mirror'|'changes', fields: ?Object}}
 */
export function dueBackfillFields(bill) {
    if (!isMap(bill) || bill.voided === true) return null;
    const p = isMap(bill.payment) ? bill.payment : null;
    const stored = p && Object.prototype.hasOwnProperty.call(p, 'due') ? p.due : undefined;
    const numeric = typeof stored === 'number' && Number.isFinite(stored);
    const due = numeric ? stored : readPayment(bill).due;
    const mirrorOff = Object.prototype.hasOwnProperty.call(bill, 'dueAmount') && bill.dueAmount !== due;
    if (numeric && !mirrorOff) return null;
    // Nothing owed and no other copy: storing `due: 0` changes nothing anyone reads
    if (!numeric && due === 0 && !Object.prototype.hasOwnProperty.call(bill, 'dueAmount')) return null;
    // A `payment` stored as something else than a map, or a NaN / Infinity where the write goes (no
    // edit record can match it: the rules see NaN != NaN), is left for a person to look at
    const nonFinite = (v) => typeof v === 'number' && !Number.isFinite(v);
    if ((bill.payment != null && !p) || nonFinite(bill.dueAmount) || (p && Object.values(p).some(nonFinite))) return { reason: 'changes', fields: null };
    const reason = numeric ? 'mirror' : stored === undefined ? 'missing' : 'notNumber';
    const fields = withCanonicalDue({ payment: { ...(p || {}), due } }, bill);
    const after = { ...bill, ...fields };
    const same = canonical(readPayment(after)) === canonical(readPayment(bill)) && outstandingDue(after) === outstandingDue(bill);
    return same ? { reason, fields } : { reason: 'changes', fields: null };
}
