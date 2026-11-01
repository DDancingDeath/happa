/**
 * @fileoverview TIP scenario MainThread (#83 watchdog): the app answers taps.
 * While the page is on screen a 1-second timer notes when it last ran
 * (performance.now(), so clock changes don't count); when it runs again
 * FREEZE_MS or more late, the main thread was blocked (a frozen screen).
 * Each WINDOW_MS on screen is one run: it fails 'frozen' at the first freeze,
 * else succeeds; a shorter stretch on screen (the page hidden, frozen by the
 * browser or closed) is judged when it lasted MIN_JUDGED_MS, else not.
 * main.js stops the timer whenever the page is hidden, so time away is never
 * a gap; a gap of SLEEP_MS or more (the phone asleep) is not judged.
 * Reads and writes nothing; the counts go out with the other TIP counters,
 * with at most MAX_SAMPLES failure samples a day. A stuck sync is the Sync
 * scenario's `not_flushed` (#161).
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/main-thread
 */

export const TICK_MS = 1000;
export const FREEZE_MS = 5000;
export const WINDOW_MS = 5 * 60 * 1000;
export const MIN_JUDGED_MS = 60 * 1000;
/** A gap this long is the phone asleep or the app suspended, not a freeze. */
export const SLEEP_MS = 2 * 60 * 1000;
export const MAX_SAMPLES = 2;

export const MainThreadTest = {
    id: 'MainThread',
    reasons: { frozen: 1 },
    timeoutMs: 3 * WINDOW_MS,
    target: 99,
    onAbandon: 'discard',
    maxSamplesPerDay: MAX_SAMPLES,
    evaluate(props, flags, ctx) {
        if (ctx?.expired || !props?.checked) return 'discard';
        return props.longestMs >= FREEZE_MS ? { result: 'fail', reason: 'frozen' } : 'succeed';
    }
};

/**
 * Turns timer ticks into MainThread runs. Times are performance.now() values.
 * @param {() => {complete: Function, discard: Function}} start tip.start('MainThread')
 * @param {{freezeMs?: number, windowMs?: number, sleepMs?: number, minJudgedMs?: number}} [opts]
 * @returns {{tick: (now: number) => void, hidden: (now: number) => void}}
 */
export function createWatchdog(start, { freezeMs = FREEZE_MS, windowMs = WINDOW_MS, sleepMs = SLEEP_MS, minJudgedMs = MIN_JUDGED_MS } = {}) {
    let run = null;
    let last = null;
    let windowStart = 0;
    let longest = 0;
    const open = (now) => {
        run = start();
        windowStart = now;
        longest = 0;
    };
    const close = (judged) => {
        if (run) {
            if (judged) run.complete({ checked: true, longestMs: Math.round(longest) });
            else run.discard();
        }
        run = null;
    };
    return {
        /** A timer tick while the page is on screen. */
        tick(now) {
            try {
                if (last === null) {
                    last = now;
                    open(now);
                    return;
                }
                const gap = now - last;
                last = now;
                if (gap >= sleepMs || gap < 0) {
                    close(false);
                    open(now);
                    return;
                }
                if (gap > longest) longest = gap;
                if (longest >= freezeMs || now - windowStart >= windowMs) {
                    close(true);
                    open(now);
                }
            } catch (_) { /* never break the app */ }
        },
        /** The page is hidden, frozen or closed: judge what was seen if it was long enough. */
        hidden(now) {
            try {
                // A screen frozen until the user left: the timer's late tick never runs, so count the gap here.
                const gap = last === null ? 0 : now - last;
                if (gap >= freezeMs && gap < sleepMs && gap > longest) longest = gap;
                close(run !== null && last !== null && (longest >= freezeMs || last - windowStart >= minJudgedMs) && gap < sleepMs);
                last = null;
            } catch (_) { /* never break the app */ }
        }
    };
}
