/**
 * @fileoverview TIP scenario PaymentRecord (#217, #201 path): a due payment
 * updates the bill (cash + online + due still add up to the total) and, when
 * today's cash session is open, the drawer gets the same payment as a leg in
 * the same transaction. Instrumented in OutstandingManager._recordDuePayment.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/payment-record
 */

import { readPayment } from '../../utils/money.js';
import { SPLIT_TOLERANCE } from '../../utils/calc/billing.js';

export const PaymentRecordTest = {
    id: 'PaymentRecord',
    reasons: { cash_leg_missing: 1, totals_mismatch: 2, tx_error: 3, bill_missing: 4 },
    timeoutMs: 2 * 60 * 1000,
    target: 98,
    evaluate(props, flags, ctx) {
        if (props.retried) return 'ignore';
        if (props.billMissing) return { result: 'fail', reason: 'bill_missing' };
        if (props.totalsOk === false) return { result: 'fail', reason: 'totals_mismatch' };
        if (props.sessionOpen && !props.legWritten) return { result: 'fail', reason: 'cash_leg_missing' };
        if (ctx.expired) return ctx.online ? { result: 'fail', reason: 'tx_error' } : 'discard';
        return 'succeed';
    }
};

/**
 * Properties after the payment transaction.
 * @param {Object|null} freshBill - bill as read inside the transaction (null = missing)
 * @param {Object|null} written - fields written (null = nothing written)
 * @param {{sessionOpen: boolean, legWritten: boolean, retried: boolean}} info
 * @returns {Object}
 */
export function paymentRecordProps(freshBill, written, info = {}) {
    if (!freshBill || !written) return { billMissing: true };
    const after = readPayment({ ...freshBill, ...written });
    return {
        billMissing: false,
        retried: !!info.retried,
        sessionOpen: !!info.sessionOpen,
        legWritten: !!info.legWritten,
        dueCleared: after.due === 0,
        totalsOk: Math.abs(after.total - (after.paid + after.due)) <= SPLIT_TOLERANCE
    };
}

/**
 * How a failed payment attempt is reported: offline / amount-over-due are
 * user situations, not app failures.
 * @param {Object} error
 * @param {boolean} offline
 * @returns {'discard'|'ignore'|'fail'}
 */
export function paymentErrorOutcome(error, offline) {
    if (offline || error?.code === 'unavailable') return 'discard';
    if (error?.code === 'exceeds-due') return 'ignore';
    return 'fail';
}
