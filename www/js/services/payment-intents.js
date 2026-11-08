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
 * Once the payment shows on the bill, the same amount again within PAYMENT_RETRY_WINDOW_MS of
 * the last try is that retry; later it may be a new payment, so the user is asked.
 * @module services/payment-intents
 */

import { round2 } from '../utils/money.js';
import { Helpers } from '../utils/helpers.js';
import { safeSetItem } from '../utils/storage-full.js';

const STORE_KEY = 'aadhat.paymentIntents';
/** A payment not confirmed within a day is a new payment when typed again. */
export const PAYMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
/** The same payment typed again this soon after its last try is a retry, not a new payment. */
export const PAYMENT_RETRY_WINDOW_MS = 10 * 60 * 1000;
const MAX_INTENTS = 50;

/** @typedef {{ids: string[], docs: string[], at: number}} Intent ids[i] is the entry id on bill docs[i]; at = last try */

/** @type {Record<string, Intent>} used when localStorage can't be */
let memory = {};
/** localStorage holds every intent (the one source, shared by tabs) until reading or writing it fails. */
let stored = true;

/**
 * Key of one payment intent: same kind of action, same bill(s) and the same amounts.
 * @param {{kind?: string, billType: string, billId: string|number, cash?: number, online?: number, parts?: string[]}} p
 *   `parts`: extra fixed parts (party payments: method)
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

/** @returns {Record<string, Intent>} */
function readAll() {
    const s = store();
    if (!s || !stored) return { ...memory };
    try {
        const parsed = JSON.parse(s.getItem(STORE_KEY) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) { /* unreadable: below */ }
    // Never write this tab's copy over the shared one: this tab keeps its own from now on
    stored = false;
    return { ...memory };
}

/** @param {Record<string, Intent>} all */
function writeAll(all) {
    memory = all;
    const s = store();
    if (s && stored) stored = safeSetItem(STORE_KEY, JSON.stringify(all), s).ok;
}

/**
 * @param {Record<string, Intent>} all
 * @param {number} now
 */
function fresh(all, now) {
    const kept = Object.entries(all)
        .filter(([, v]) => v && Array.isArray(v.ids) && v.ids.length && Array.isArray(v.docs) && v.docs.length === v.ids.length
            && Number.isFinite(v.at) && now - v.at < PAYMENT_INTENT_TTL_MS)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_INTENTS);
    return Object.fromEntries(kept);
}

/**
 * The open intent of `key`, if any (not expired).
 * @param {string} key
 * @param {number} [now]
 * @returns {?Intent}
 */
export function pendingPaymentIntent(key, now = Date.now()) {
    return fresh(readAll(), now)[key] || null;
}

/**
 * Whether the open intent's last try is recent enough for the same payment typed again to be
 * its retry (PAYMENT_RETRY_WINDOW_MS).
 * @param {?Intent} intent
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRetryOf(intent, now = Date.now()) {
    return !!intent && now - intent.at < PAYMENT_RETRY_WINDOW_MS;
}

/**
 * Entry ids of `key` for the bills `docs` (document ids): a bill this intent already tried keeps
 * its id, others get new ones; stored (with the time of this try) before they are used, so a
 * retry after anything finds them.
 * @param {string} key
 * @param {Array<string|number>} docs
 * @param {number} [now]
 * @returns {string[]}
 */
export function paymentIntentIds(key, docs, now = Date.now()) {
    const all = fresh(readAll(), now);
    const open = all[key];
    /** @type {Record<string, string>} */
    const byDoc = open ? Object.fromEntries(open.docs.map((d, i) => [d, open.ids[i]])) : {};
    const ids = docs.map(d => byDoc[String(d)] || (byDoc[String(d)] = Helpers.generateId()));
    const known = Object.keys(byDoc);
    all[key] = { ids: known.map(d => byDoc[d]), docs: known, at: now };
    writeAll(fresh(all, now));
    return ids;
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
    stored = true;
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
