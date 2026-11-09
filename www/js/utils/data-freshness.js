// @ts-check
/**
 * @fileoverview Whether this session's data has been confirmed by the server (#59). Every data
 * listener (items, the stock checkpoint, each history window and its dues queries) waits for its
 * first server answer; until all of them had one (a failed listener counts as answered), the
 * figures may come from the phone's offline cache only and can miss changes made on other phones.
 * The state only moves forward within a session (`cache` → `server`); it is null with no session
 * (signed out, or before the listeners start).
 * Writers of derived data wait for `server` (whenServerConfirmed); pages hear DATA_FRESHNESS_CHANGED.
 * The data layer (firebase/core/listeners.js, stock-checkpoint.js) reports to it; it holds no data.
 * @module utils/data-freshness
 */

import { emit, DATA_FRESHNESS_CHANGED } from './events.js';

/** @typedef {?('cache'|'server')} Freshness */

/** @type {Set<string>} listeners still waiting for their first server answer */
let open = new Set();
/** Every listener of the session is registered (the history listeners start after the checkpoint). */
let sealed = false;
/** @type {Freshness} */
let state = null;
/** @type {Array<function(boolean): void>} */
let waiters = [];
/** When this session's listeners started (ms). */
let startedAt = 0;

/**
 * Longest time unconfirmed data counts as "the server's answer is on its way" (awaitingServer):
 * after it, or offline, the phone works from its cache as it always did.
 */
export const AWAIT_SERVER_MAX_MS = 60 * 1000;
let gen = 0;
let seq = 0;

/** @param {Freshness} next */
function setState(next) {
    if (next === state) return;
    state = next;
    emit(DATA_FRESHNESS_CHANGED, next);
    if (next !== 'server') return;
    const done = waiters;
    waiters = [];
    done.forEach(resolve => resolve(true));
}

function settle() {
    if (sealed && open.size === 0) setState('server');
}

/** Ends the session (listeners torn down): its waiters get false. */
export function resetFreshness() {
    gen++;
    open = new Set();
    sealed = false;
    const dropped = waiters;
    waiters = [];
    setState(null);
    dropped.forEach(resolve => resolve(false));
}

/** A new session's listeners start: 'cache' until every one of them heard from the server. */
export function startFreshness() {
    resetFreshness();
    startedAt = Date.now();
    setState('cache');
}

/**
 * Registers a listener that must hear from the server.
 * @param {string} label
 * @returns {function(): void} call on its first server answer, or when it failed (idempotent)
 */
export function expectServer(label) {
    const key = `${label}#${++seq}`;
    const at = gen;
    open.add(key);
    return () => {
        if (at !== gen || !open.delete(key)) return;
        settle();
    };
}

/** Every listener of this session is registered. */
export function sealFreshness() {
    sealed = true;
    settle();
}

/** @returns {Freshness} */
export const dataFreshness = () => state;

/**
 * Online, the session's data not confirmed yet, and the server's answer still expected soon. Stock
 * from such data may miss other phones' bills for a moment: oversell only warns, and a stock count
 * or "set to" waits (#59). Offline, or after AWAIT_SERVER_MAX_MS, the cache is used as before.
 * @param {number} [now]
 * @param {boolean} [online]
 * @returns {boolean}
 */
export function awaitingServer(now = Date.now(), online = typeof navigator === 'undefined' || navigator.onLine !== false) {
    return state === 'cache' && online && now - startedAt < AWAIT_SERVER_MAX_MS;
}

/**
 * Resolves true once every listener of this session has heard from the server, or false when
 * the session ends first (sign-out, listeners set up again).
 * @returns {Promise<boolean>}
 */
export function whenServerConfirmed() {
    if (state === 'server') return Promise.resolve(true);
    return new Promise(resolve => waiters.push(resolve));
}
