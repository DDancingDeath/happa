/**
 * @fileoverview Sign-in backoff on this phone (#105): free tries, doubling waits, cap, forgetting.
 */
import { afterLoginFailure, loginWaitMs, waitParts, LOGIN_BACKOFF } from '../utils/login-backoff.js';

const fail = (state, now, code = 'auth/wrong-password') => afterLoginFailure(state, now, code);

test('5 free tries, then 30 s, doubling up to 15 min', () => {
    let s = null;
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
        s = fail(s, now);
        expect(loginWaitMs(s, now)).toBe(0);
    }
    const waits = [];
    for (let i = 0; i < 8; i++) {
        s = fail(s, now);
        waits.push(loginWaitMs(s, now) / 1000);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
    expect(loginWaitMs(s, now + LOGIN_BACKOFF.maxWaitMs)).toBe(0);
});

test('only wrong email/password (or Firebase\'s own limit) counts; a quiet hour forgets', () => {
    let s = null;
    for (let i = 0; i < 10; i++) s = afterLoginFailure(s, 1000, 'auth/network-request-failed');
    expect(s.fails).toBe(0);
    s = afterLoginFailure(s, 1000, undefined);
    expect(s.fails).toBe(0);
    for (let i = 0; i < 4; i++) s = fail(s, 1000, i % 2 ? 'auth/invalid-credential' : 'auth/user-not-found');
    expect(s.fails).toBe(4);
    s = fail(s, 1000 + LOGIN_BACKOFF.forgetAfterMs + 1);
    expect(s.fails).toBe(1);
    expect(loginWaitMs({ until: 'x' }, 5)).toBe(0);
    // a phone clock moved back never locks longer than the longest wait, and starts the count again
    expect(loginWaitMs({ fails: 9, last: 10 * 86400000, until: 10 * 86400000 + 900000 }, 1000)).toBe(LOGIN_BACKOFF.maxWaitMs);
    expect(fail({ fails: 9, last: 10 * 86400000, until: 0 }, 1000).fails).toBe(1);
});

test('wait text parts', () => {
    expect(waitParts(30000)).toEqual({ seconds: 30 });
    expect(waitParts(200)).toEqual({ seconds: 1 });
    expect(waitParts(59001)).toEqual({ minutes: 1 });
    expect(waitParts(61000)).toEqual({ minutes: 2 });
});
