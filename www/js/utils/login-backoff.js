/**
 * @fileoverview Sign-in backoff on this phone (#105): after a few wrong tries the
 * Login button waits before trying again, doubling each time. Firebase Auth has
 * its own server-side limit (auth/too-many-requests); this one stops password
 * guessing from the app sooner and tells the user how long to wait.
 * Pure: the caller keeps the state (localStorage) and passes the clock.
 * @module utils/login-backoff
 */

export const LOGIN_BACKOFF = Object.freeze({
    /** Wrong tries allowed before the first wait. */
    freeTries: 5,
    firstWaitMs: 30 * 1000,
    maxWaitMs: 15 * 60 * 1000,
    /** A quiet hour forgets earlier wrong tries. */
    forgetAfterMs: 60 * 60 * 1000
});

/** Failures that count: a wrong email or password, or Firebase's own limit. */
export const COUNTED_LOGIN_ERRORS = Object.freeze([
    'auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials',
    'auth/user-not-found', 'auth/too-many-requests'
]);

const clean = (state) => ({
    fails: Math.max(0, Math.floor(Number(state?.fails) || 0)),
    last: Number(state?.last) || 0,
    until: Number(state?.until) || 0
});

/**
 * Milliseconds left before the next try is allowed (0 = allowed now).
 * @param {{fails?: number, last?: number, until?: number}|null} state
 * @param {number} now
 * @returns {number}
 */
export function loginWaitMs(state, now) {
    const s = clean(state);
    return s.until > now ? s.until - now : 0;
}

/**
 * State after a failed sign-in.
 * @param {Object|null} state
 * @param {number} now
 * @param {string} code - Firebase error code; other failures (network, app errors) don't count
 * @returns {{fails: number, last: number, until: number}}
 */
export function afterLoginFailure(state, now, code) {
    const s = clean(state);
    if (!COUNTED_LOGIN_ERRORS.includes(code)) return s;
    const fails = (now - s.last > LOGIN_BACKOFF.forgetAfterMs ? 0 : s.fails) + 1;
    const over = fails - LOGIN_BACKOFF.freeTries;
    const wait = over < 0 ? 0 : Math.min(LOGIN_BACKOFF.firstWaitMs * 2 ** over, LOGIN_BACKOFF.maxWaitMs);
    return { fails, last: now, until: wait ? now + wait : 0 };
}

/**
 * A wait as whole seconds (under a minute) or whole minutes, rounded up.
 * @param {number} ms
 * @returns {{seconds: number}|{minutes: number}}
 */
export function waitParts(ms) {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return seconds < 60 ? { seconds } : { minutes: Math.ceil(seconds / 60) };
}
