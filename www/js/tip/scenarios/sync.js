/**
 * @fileoverview TIP scenario Sync (#161): changes this phone makes while
 * online reach the server within the limit. A run starts when the header
 * pill's pending count goes above 0 (ui/sync-status.js) and completes when it
 * is back to 0. A run that saw the phone offline is not judged (it can't
 * sync); one still pending after the limit while online fails.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/sync
 */

export const SYNC_LIMIT_MS = 5 * 60 * 1000;

export const SyncTest = {
    id: 'Sync',
    reasons: { not_flushed: 1 },
    timeoutMs: SYNC_LIMIT_MS,
    target: 95,
    // Closed with changes waiting: Firestore keeps them and sends them on the next start.
    onAbandon: 'discard',
    evaluate(props, flags, ctx) {
        if (flags.offline) return 'discard';
        if (ctx.expired) return ctx.online ? { result: 'fail', reason: 'not_flushed' } : 'discard';
        return 'succeed';
    }
};

/**
 * Turns pending-count changes into Sync runs.
 * @param {(opts: Object) => {setFlag: Function, complete: Function, discard: Function}} start tip.start('Sync', opts)
 * @returns {{update: (s: {online: boolean, pending: number, stopped?: boolean}) => void}}
 */
export function createSyncWatcher(start) {
    let run = null;
    return {
        update({ online, pending, stopped = false }) {
            try {
                if (stopped) {
                    // Signed out / listeners torn down: nothing is judged.
                    if (run) run.discard();
                    run = null;
                    return;
                }
                if (pending > 0) {
                    if (!run) run = start({ flags: { offline: !online } });
                    else if (!online) run.setFlag('offline', true);
                    return;
                }
                if (run) {
                    const r = run;
                    run = null;
                    r.complete({ online: !!online });
                }
            } catch (_) { /* never break the pill */ }
        }
    };
}
