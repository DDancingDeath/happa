// @ts-check
/**
 * @fileoverview One id per due payment the user means to record (#70, D-1), owned here and
 * not by the amount box: the Due list redraws its rows (new, empty inputs) as soon as the
 * bill changes, so an id kept on the input was lost exactly when a payment had reached the
 * server but its answer had not reached the phone, and the retry was recorded a second time.
 *
 * The same bill, amounts and action ("key") get the same entry id(s) until the outcome is
 * known: recorded (the transaction finds its own id and writes nothing again) or expired.
 * Kept in localStorage, so a reload or a second tab keeps it too. No Firestore here.
 * @module services/payment-intents
 */

import { round2 } from '../utils/money.js';
import { Helpers } from '../utils/helpers.js';
import { safeSetItem } from '../utils/storage-full.js';

const STORE_KEY = 'aadhat.paymentIntents';
/** A payment not confirmed within a day is a new payment when typed again. */
export const PAYMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INTENTS = 50;

/** @type {Record<string, {ids: string[], at: number}>} used when localStorage can't be */
let memory = {};

/**
 * Key of one payment intent: same kind of action, same bill(s) and the same amounts.
 * @param {{kind?: string, billType: string, billId: string|number, cash?: number, online?: number, parts?: string[]}} p
 *   `parts`: extra fixed parts (party payments: party, method and each bill's share)
 * @returns {string}
 */
export function paymentIntentKey({ kind = 'pay', billType, billId, cash = 0, online = 0, parts = [] }) {
    return [kind, billType, String(billId ?? ''), round2(Number(cash) || 0), round2(Number(online) || 0), ...parts].join('|');
}

/** @returns {?Storage} */
function store() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (_) {
        return null;
    }
}

/** @returns {Record<string, {ids: string[], at: number}>} */
function readAll() {
    const s = store();
    if (!s) return memory;
    try {
        const parsed = JSON.parse(s.getItem(STORE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? { ...memory, ...parsed } : memory;
    } catch (_) {
        return memory;
    }
}

/** @param {Record<string, {ids: string[], at: number}>} all */
function writeAll(all) {
    memory = all;
    const s = store();
    if (s) safeSetItem(STORE_KEY, JSON.stringify(all), s);
}

/**
 * @param {Record<string, {ids: string[], at: number}>} all
 * @param {number} now
 */
function fresh(all, now) {
    const kept = Object.entries(all)
        .filter(([, v]) => v && Array.isArray(v.ids) && v.ids.length && Number.isFinite(v.at) && now - v.at < PAYMENT_INTENT_TTL_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_INTENTS);
    return Object.fromEntries(kept);
}

/**
 * The open intent of `key`, if any (not expired).
 * @param {string} key
 * @param {number} [now]
 * @returns {?{ids: string[], at: number}}
 */
export function pendingPaymentIntent(key, now = Date.now()) {
    return fresh(readAll(), now)[key] || null;
}

/**
 * Entry ids of `key`: the open intent's when there is one with as many ids, else new ones
 * (stored before they are used, so a retry after anything finds them).
 * @param {string} key
 * @param {number} [count]
 * @param {number} [now]
 * @returns {string[]}
 */
export function paymentIntentIds(key, count = 1, now = Date.now()) {
    const all = fresh(readAll(), now);
    const open = all[key];
    if (open && open.ids.length === count) return open.ids.slice();
    const ids = Array.from({ length: count }, () => Helpers.generateId());
    all[key] = { ids, at: now };
    writeAll(fresh(all, now));
    return ids.slice();
}

/**
 * The outcome of `key` is known (recorded): a payment typed again is a new one.
 * @param {string} key
 */
export function settlePaymentIntent(key) {
    const all = readAll();
    if (!(key in all)) return;
    delete all[key];
    writeAll(all);
}

/** Tests: forget every intent. */
export function forgetPaymentIntents() {
    memory = {};
    const s = store();
    try {
        s?.removeItem(STORE_KEY);
    } catch (_) { /* nothing stored */ }
}

/**
 * Codes after which the payment is certainly not on the server: the change refused it
 * before writing, or the server refused the write. Anything else (no answer, timeout,
 * "unavailable") may have been committed and is checked on the server.
 */
const REFUSED_CODES = new Set(['exceeds-due', 'voided', 'not-found', 'due-changed', 'permission-denied', 'invalid-argument']);

/**
 * Whether a failed payment's outcome is unknown (it may have been recorded).
 * @param {*} error
 * @returns {boolean}
 */
export function paymentOutcomeUnknown(error) {
    return !REFUSED_CODES.has(String(error?.code || ''));
}

/**
 * The bill's payments[] entry with this id, if any.
 * @param {?{payments?: *}} bill
 * @param {?string} id
 * @returns {?Object}
 */
export function paymentEntryOf(bill, id) {
    if (!bill || !id) return null;
    /** @type {Array<?{id?: string}>} */
    const entries = Array.isArray(bill.payments) ? bill.payments : [];
    return entries.find(p => p && p.id === id) || null;
}
