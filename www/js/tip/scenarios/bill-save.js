/**
 * @fileoverview TIP scenario BillSave (#217): a new purchase / retail /
 * wholesale bill is saved with consistent totals (total = cash + online + due
 * within ₹1) and the server acknowledges the write. Instrumented in
 * firestore-service.js saveBill(), the one path every new bill takes.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/bill-save
 */

import { readPayment } from '../../utils/money.js';
import { SPLIT_TOLERANCE } from '../../utils/calc/billing.js';

/** An override recorded this recently was made for the bill being saved. */
const RECENT_OVERRIDE_MS = 15 * 60 * 1000;
/** Override reason written when an auto rollback let an owner/manager save without the prompt. */
export const AUTO_ROLLBACK_REASON = 'auto-rollback';

export const BillSaveTest = {
    id: 'BillSave',
    reasons: { totals_mismatch: 1, write_rejected: 2, save_error: 3, blocked_valid_bill: 4, not_acknowledged: 5 },
    timeoutMs: 5 * 60 * 1000,
    target: 98,
    // App closed while the save was queued offline: Firestore still syncs it later.
    onAbandon: (flags) => (flags.offline ? 'discard' : 'fail'),
    evaluate(props, flags, ctx) {
        if (props.totalsOk === false) return { result: 'fail', reason: 'totals_mismatch' };
        // Offline saves are queued and sync later: not a failure of this run.
        if (ctx.expired) return flags.offline || !ctx.online ? 'discard' : { result: 'fail', reason: 'not_acknowledged' };
        // A block the owner/manager had to override: the check stopped a bill they say is valid.
        if (props.overridden) return { result: 'warn', reason: 'blocked_valid_bill' };
        return 'succeed';
    }
};

/**
 * PII-free properties of a bill about to be written: kind, line count,
 * rounded total and whether its payment split adds up.
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {Object} record
 * @param {number} now
 * @returns {Object}
 */
export function billSaveProps(collKey, record, now) {
    const p = readPayment(record);
    const overrides = Array.isArray(record?.overrides) ? record.overrides : [];
    return {
        kind: collKey,
        lines: Array.isArray(record?.items) ? record.items.length : 0,
        total100: Math.round(p.total / 100) * 100,
        totalsOk: Math.abs(p.total - (p.paid + p.due)) <= SPLIT_TOLERANCE,
        // Auto-rollback overrides are not a person saying "this block was wrong".
        overridden: overrides.some(o => Number(o?.at) > now - RECENT_OVERRIDE_MS && o?.reason !== AUTO_ROLLBACK_REASON)
    };
}
