/**
 * @fileoverview TIP scenario StockCheckpoint (#161): a stock checkpoint
 * rebuild this phone starts completes, and when it does not (offline,
 * conflict, too large …) its lease is released so another phone can build.
 * Instrumented in FirebaseService.rebuildStockCheckpoint.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/stock-checkpoint
 */

/** Statuses where this phone did not (need to) build: not judged. */
const NOT_BUILDING = ['fresh', 'leased', 'not-allowed', 'inactive', 'cancelled'];

export const StockCheckpointTest = {
    id: 'StockCheckpoint',
    reasons: { rebuild_error: 1, lease_not_released: 2, too_large: 3, backfill_failed: 4, conflict: 5, not_built: 6 },
    timeoutMs: 10 * 60 * 1000,
    target: 90,
    onAbandon: 'discard',
    evaluate(props, flags, ctx) {
        // Expired before an answer (e.g. the app was in the background): still running, not judged.
        if (!props.status) return 'discard';
        if (props.status === 'built') return 'succeed';
        if (NOT_BUILDING.includes(props.status)) return 'ignore';
        if (props.status === 'offline') return 'discard';
        // A release can't run offline; the lease then just expires.
        if (props.released === false) return ctx.online ? { result: 'fail', reason: 'lease_not_released' } : 'discard';
        if (props.status === 'error') return ctx.online ? { result: 'fail', reason: 'rebuild_error' } : 'discard';
        if (props.status === 'too-large') return { result: 'fail', reason: 'too_large' };
        if (props.status === 'backfill-failed') return { result: 'fail', reason: 'backfill_failed' };
        if (props.status === 'conflict') return { result: 'warn', reason: 'conflict' };
        return { result: 'fail', reason: 'not_built' };
    }
};

/**
 * @param {?{status: string}} result rebuildStockCheckpoint() result (null when it threw)
 * @param {?boolean} released lease released after a failed build (null: no lease to release)
 * @returns {Object}
 */
export function checkpointProps(result, released = null) {
    return { status: result ? String(result.status || 'unknown').slice(0, 32) : 'error', released };
}
