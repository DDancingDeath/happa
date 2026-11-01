/**
 * @fileoverview TIP scenario MainThread (#83 watchdog): the app answers taps.
 * A 1-second timer notes when it last ran; when it runs again after
 * FREEZE_MS or more while the page was visible, the main thread was blocked
 * (a frozen screen). Each WINDOW_MS of visible time is one run: it fails
 * 'frozen' at the first freeze, else succeeds. Hidden pages and long gaps
 * (the phone asleep, the app suspended) are not judged. Reads and writes
 * nothing; the counts go out with the other TIP counters.
 * A stuck sync is the Sync scenario's `not_flushed` (#161).
 * Reason codes are stable: never renumber or reuse them.
 * @module tip/scenarios/main-thread
 */

export const TICK_MS = 1000;
export const FREEZE_MS = 5000;
export const WINDOW_MS = 5 * 60 * 1000;
/** A gap this long is the phone asleep or the app suspended, not a freeze. */
export const SLEEP_MS = 2 * 60 * 1000;

export const MainThreadTest = {
    id: 'MainThread',
    reasons: { frozen: 1 },
    timeoutMs: 3 * WINDOW_MS,
    target: 99,
    onAbandon: 'discard',
    evaluate(props, flags, ctx) {
        if (ctx?.expired || !props?.checked) return 'discard';
        return props.longestMs >= FREEZE_MS ? { result: 'fail', reason: 'frozen' } : 'succeed';
    }
};

/**
 * Turns timer ticks into MainThread runs.
 * @param {() => {complete: Function, discard: Function}} start tip.start('MainThread')
 * @param {{freezeMs?: number, windowMs?: number, sleepMs?: number}} [opts]
 * @returns {{tick: (now: number, visible: boolean) => void, stop: () => void}}
 */
export function createWatchdog(start, { freezeMs = FREEZE_MS, windowMs = WINDOW_MS, sleepMs = SLEEP_MS } = {}) {
    let run = null;
    let last = null;
    let windowStart = 0;
    let longest = 0;
    const open = (now) => {
        run = start();
        windowStart = now;
        longest = 0;
    };
    const drop = () => {
        if (run) run.discard();
        run = null;
    };
    return {
        tick(now, visible) {
            try {
                if (!visible) {
                    drop();
                    last = null;
                    return;
                }
                if (last === null) {
                    last = now;
                    open(now);
                    return;
                }
                const gap = now - last;
                last = now;
                if (gap >= sleepMs || gap < 0) {
                    drop();
                    open(now);
                    return;
                }
                if (gap > longest) longest = gap;
                if (longest >= freezeMs || now - windowStart >= windowMs) {
                    if (run) run.complete({ checked: true, longestMs: Math.round(longest) });
                    open(now);
                }
            } catch (_) { /* never break the app */ }
        },
        stop() {
            drop();
            last = null;
        }
    };
}
