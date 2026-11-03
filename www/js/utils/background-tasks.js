// @ts-check
/**
 * @fileoverview Scheduling of startup work that must not hold the first
 * screen (#13): stock after the first paint, the legacy-timestamp scan when
 * the device is idle.
 * @module utils/background-tasks
 */

/** The legacy scan starts no earlier than this after the first screen. */
export const LEGACY_SCAN_DELAY_MS = 3000;
/** ...and no later than this once the delay has passed, even if never idle. */
export const LEGACY_SCAN_IDLE_TIMEOUT_MS = 10000;

/**
 * Runs `fn` once the browser is idle (requestIdleCallback, falling back to
 * setTimeout), but not before `minDelayMs`.
 * @param {Function} fn
 * @param {{minDelayMs?: number, timeoutMs?: number, win?: Rec}} [opts]
 * @returns {Function} cancel
 */
export function whenIdle(fn, { minDelayMs = 0, timeoutMs = LEGACY_SCAN_IDLE_TIMEOUT_MS, win = globalThis } = {}) {
    let cancelled = false;
    /** @type {*} */
    let idleHandle = null;
    const fire = () => {
        if (!cancelled) fn();
    };
    const delayTimer = setTimeout(() => {
        if (cancelled) return;
        if (typeof win.requestIdleCallback === 'function') {
            idleHandle = win.requestIdleCallback(fire, { timeout: timeoutMs });
        } else {
            idleHandle = setTimeout(fire, 0);
        }
    }, minDelayMs);
    return () => {
        cancelled = true;
        clearTimeout(delayTimer);
        if (idleHandle !== null) {
            if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(idleHandle);
            clearTimeout(idleHandle);
        }
    };
}

/**
 * Runs `fn` right after the next frame is painted (rAF + task), or after
 * `maxWaitMs` when frames don't run (background tab, old WebView).
 * @param {Function} fn
 * @param {{maxWaitMs?: number, win?: Rec}} [opts]
 */
export function afterFirstPaint(fn, { maxWaitMs = 100, win = globalThis } = {}) {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        fn();
    };
    const fallback = setTimeout(run, maxWaitMs);
    if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => setTimeout(() => {
            clearTimeout(fallback);
            run();
        }, 0));
    }
}

/**
 * Whether this device runs the legacy-timestamp scan (an unfiltered read of
 * each collection) in the background. Only owner/manager devices, only with a
 * usable checkpoint (without one the full-history read backfills anyway), and
 * not while offline (it would only read the cache).
 * @param {{canManage: boolean, hasCheckpoint: boolean, online?: boolean}} p
 * @returns {boolean}
 */
export function shouldScheduleLegacyScan({ canManage, hasCheckpoint, online = true }) {
    return !!canManage && !!hasCheckpoint && online !== false;
}
