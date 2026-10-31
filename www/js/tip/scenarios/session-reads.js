/**
 * @fileoverview TIP scenario SessionReads (#159): Firestore reads stay well under
 * the shared free quota (50,000 a day for every phone together). Recorded at
 * once, without a timed run: at app open with the reads of the start-up
 * (`startupReads`), and once per session when the read meter sees a heavy session
 * (`heavy`) or a quota error (`quota`). Failures reach the daily `tip-auto` issues.
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/session-reads
 */

export const STARTUP_READS_WARN = 1000;
export const STARTUP_READS_FAIL = 2500;

export const SessionReadsTest = {
    id: 'SessionReads',
    reasons: { heavy_startup: 1, heavy_session: 2, quota_exhausted: 3 },
    timeoutMs: 60 * 1000,
    target: 95,
    onAbandon: 'discard',
    /** @param {{startupReads?: number, heavy?: boolean, quota?: boolean}} props */
    evaluate(props) {
        if (props.quota) return { result: 'fail', reason: 'quota_exhausted' };
        if (props.heavy) return { result: 'fail', reason: 'heavy_session' };
        const reads = Number(props.startupReads) || 0;
        if (reads > STARTUP_READS_FAIL) return { result: 'fail', reason: 'heavy_startup' };
        if (reads > STARTUP_READS_WARN) return { result: 'warn', reason: 'heavy_startup' };
        return 'succeed';
    }
};
