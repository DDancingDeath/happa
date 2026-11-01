/**
 * @fileoverview Is the phone's clock wrong? (#184, #115)
 *
 * A payment or write-off entry carries the phone's time (`at`), and
 * firestore.rules (entryTimeOk) refuse it when it is 10 minutes or more from the
 * server's time. The phone then only sees "permission denied"; this tells the
 * user the real reason. The server's time comes from a fresh Firebase Auth ID
 * token (its `iat` is set by Google's server): one small request, made only
 * after a refusal, and no Firestore read.
 * @module utils/clock-skew
 */

import { toJsDate, toLocalISODate } from './dates.js';

/** firestore.rules entryTimeOk: a payment's `at` must be within this of the server's time. */
export const PAYMENT_CLOCK_LIMIT_MS = 10 * 60 * 1000;

/** Call the clock wrong a minute before the rules refuse it (request and transaction time). */
export const CLOCK_WRONG_MS = PAYMENT_CLOCK_LIMIT_MS - 60 * 1000;

const TOKEN_TIMEOUT_MS = 5000;

/**
 * Server time minus phone time, from a server time read between `sentAt` and
 * `receivedAt` (both phone clock).
 * @param {number} serverMs
 * @param {number} sentAt
 * @param {number} receivedAt
 * @returns {?number} ms (positive: the phone is behind), null when unknown
 */
export function clockSkewMs(serverMs, sentAt, receivedAt) {
    if (![serverMs, sentAt, receivedAt].every(Number.isFinite)) return null;
    return serverMs - (sentAt + receivedAt) / 2;
}

/**
 * Whether a measured skew is too large for the server to accept a payment.
 * @param {?number} skewMs
 * @returns {boolean}
 */
export function isClockWrong(skewMs) {
    return Number.isFinite(skewMs) && Math.abs(skewMs) >= CLOCK_WRONG_MS;
}

function currentUser() {
    try {
        return globalThis.firebase?.auth?.().currentUser || null;
    } catch (_) {
        return null;
    }
}

/**
 * Server time minus phone time, read from a freshly issued ID token.
 * @param {{user?: Object, now?: function(): number}} [opts] (tests)
 * @returns {Promise<?number>} ms, null when it can't be measured (offline, signed out)
 */
export async function measureClockSkew({ user = currentUser(), now = Date.now } = {}) {
    if (!user || typeof user.getIdTokenResult !== 'function') return null;
    let timer;
    try {
        const sentAt = now();
        const result = await Promise.race([
            user.getIdTokenResult(true),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS); })
        ]);
        const receivedAt = now();
        return clockSkewMs(Date.parse(result?.issuedAtTime), sentAt, receivedAt);
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Whether the server refused a write because of the phone's clock: a
 * permission error, and the phone's time is off by the rules' limit.
 * @param {*} error
 * @param {Object} [opts] passed to measureClockSkew (tests)
 * @returns {Promise<boolean>}
 */
export async function refusedForClock(error, opts) {
    if (error?.code !== 'permission-denied') return false;
    const wrong = isClockWrong(await measureClockSkew(opts));
    // A refusal caused by the phone's clock is not misuse (#124: services/security-monitor.js)
    if (wrong && error && typeof error === 'object') error.aadhatExpected = true;
    return wrong;
}

/** localStorage: the day's start-up clock check, {day, skewMs} (#115). */
export const CLOCK_CHECK_KEY = 'happa.clockCheck';

/**
 * The start-up check stored for a day, or null.
 * @param {?Storage} storage
 * @returns {?{day: string, skewMs: number}}
 */
export function readClockCheck(storage) {
    try {
        const saved = JSON.parse(storage?.getItem?.(CLOCK_CHECK_KEY) || 'null');
        return saved && typeof saved.day === 'string' && Number.isFinite(saved.skewMs) ? saved : null;
    } catch (_) {
        return null;
    }
}

/**
 * Start-up clock check (#115): measured at most once a day on this phone (one ID-token
 * refresh, no Firestore read) and kept for that day. Offline or signed out nothing is
 * kept, so the next start tries again; a wrong clock is measured again at the next start
 * (it may have been fixed). `force` measures now (the banner's Check again).
 * @param {{storage?: Storage, now?: function(): number, measure?: function(): Promise<?number>, force?: boolean}} [opts]
 * @returns {Promise<?number>} server time minus phone time (ms), null when unknown
 */
export async function dailyClockSkew({ storage = null, now = Date.now, measure = measureClockSkew, force = false } = {}) {
    const day = toLocalISODate(new Date(now()));
    if (!force) {
        const saved = readClockCheck(storage);
        if (saved && saved.day === day && !isClockWrong(saved.skewMs)) return saved.skewMs;
    }
    const skew = await measure();
    if (!Number.isFinite(skew)) return null;
    try {
        storage?.setItem?.(CLOCK_CHECK_KEY, JSON.stringify({ day, skewMs: Math.round(skew) }));
    } catch (_) { /* storage full: checked again next start */ }
    return skew;
}

/**
 * Whole minutes a clock is off, for the banner.
 * @param {number} skewMs
 * @returns {number}
 */
export function skewMinutes(skewMs) {
    return Math.max(1, Math.round(Math.abs(skewMs) / 60000));
}

/**
 * A bill's two times (#115): when it was entered on the phone (`enteredAt`, the phone's
 * clock) and when the server first saved it (`createdAt`). `far`: they are at least
 * CLOCK_WRONG_MS apart (a wrong phone clock, or a bill saved offline and sent later).
 * A bill not yet on the server (`waiting`, or `createdAt` still the phone's own number
 * stamp) has no server time.
 * @param {Object} bill
 * @param {{waiting?: boolean}} [opts]
 * @returns {{entered: ?Date, server: ?Date, far: boolean}}
 */
export function billTimes(bill, { waiting = false } = {}) {
    const entered = toJsDate(bill?.enteredAt);
    const server = waiting || typeof bill?.createdAt === 'number' ? null : toJsDate(bill?.createdAt);
    return { entered, server, far: !!(entered && server) && Math.abs(server.getTime() - entered.getTime()) >= CLOCK_WRONG_MS };
}
