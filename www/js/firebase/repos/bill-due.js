/**
 * @fileoverview DUE-WRITE (#126): the one writer of a bill's stored due. `payment.due` is the
 * canonical field (BILL-PAY's due, docs/calculations.md); the top-level `dueAmount` is a legacy
 * mirror that only this module writes, always equal to `payment.due`. Every bill write of the
 * repositories (new bills, checked edits, due payments, write-offs, settle-all, party payments)
 * and tools/migrate pass their fields through `withCanonicalDue()` just before writing; the code
 * that builds those fields sets `payment.due` only. Pure: no Firestore, so tools/migrate imports it.
 *
 * The mirror goes on the same bills as before #126, so no stored shape changes:
 *  - a whole-bill write (new bill, edit) that sets the money: always;
 *  - a whole-bill write that keeps every money field as stored (a name or note edit): `dueAmount`
 *    stays as it is;
 *  - a partial update (payment, write-off): only when the stored bill has `dueAmount`.
 * @module firebase/repos/bill-due
 */

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
