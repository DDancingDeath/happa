/**
 * @fileoverview TIP scenario Print (#161): a print job (Bluetooth connect +
 * send) ends printed. Instrumented in PrinterService.runJob, the one path
 * every bill, expense, statement and image print takes. A printer that is
 * off / not paired / Bluetooth off is the phone's set-up, reported as a
 * warning; a connect or send that fails on a ready printer is a failure.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/print
 */

/** Error kinds that mean the printer or Bluetooth isn't ready (not an app failure). */
const NOT_READY = ['bluetooth_off', 'no_printer', 'stopped', 'unavailable'];
const CONNECT = ['connect', 'timeout_connect', 'timeout_list', 'timeout_check'];

export const PrintTest = {
    id: 'Print',
    reasons: { connect_failed: 1, send_failed: 2, may_have_printed: 3, printer_not_ready: 4 },
    timeoutMs: 3 * 60 * 1000,
    target: 90,
    onAbandon: 'discard',
    evaluate(props, flags, ctx) {
        if (props.outcome === 'printed') return 'succeed';
        if (props.outcome === 'cancelled') return 'ignore';
        if (props.outcome === 'uncertain') return { result: 'warn', reason: 'may_have_printed' };
        if (props.outcome === 'failed') {
            if (NOT_READY.includes(props.errorKind)) return { result: 'warn', reason: 'printer_not_ready' };
            if (CONNECT.includes(props.errorKind)) return { result: 'fail', reason: 'connect_failed' };
            return { result: 'fail', reason: 'send_failed' };
        }
        return ctx.expired ? 'discard' : 'ignore';
    }
};

/**
 * @param {'printed'|'failed'|'uncertain'|'cancelled'} outcome
 * @param {?Error} error PrinterLinkError (kind) or other
 * @param {'quick'|'full'} [mode]
 * @returns {Object} PII-free props
 */
export function printProps(outcome, error = null, mode = 'quick') {
    return { outcome, errorKind: error ? String(error.kind || 'other').slice(0, 32) : null, mode };
}
