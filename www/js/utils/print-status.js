// Per-bill print status (#132), kept on this phone only: Printed / Print failed /
// May have printed / Printed by hand. A print is a fact about the phone that has
// the printer, so it costs no Firestore reads or writes and needs no rules change.

const KEY = 'printStatus';
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

export const PRINT_STATES = Object.freeze(['printed', 'failed', 'uncertain', 'hand']);

let cache = null;

/** Same key as the printer's job key for a bill (bill number, else id). */
export function printKey(bill) {
    const id = bill?.billNumber || bill?.id;
    return id ? `bill:${id}` : null;
}

function load(store) {
    if (cache && cache.store === store) return cache.map;
    let map = {};
    try {
        const raw = JSON.parse(store.getItem(KEY));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) map = raw;
    } catch {
        map = {};
    }
    cache = { store, map };
    return map;
}

/** Drops entries older than 60 days and keeps the newest 1000. */
export function prunePrintStatuses(map, now = Date.now()) {
    return Object.fromEntries(Object.entries(map || {})
        .filter(([, e]) => e && PRINT_STATES.includes(e.s) && Number(e.at) > now - KEEP_MS)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, MAX_ENTRIES));
}

/**
 * @param {Object} bill
 * @returns {{s: 'printed'|'failed'|'uncertain'|'hand', at: number, n: number, err?: string}|null}
 */
export function printStatusOf(bill, { store = localStorage, now = Date.now() } = {}) {
    const key = printKey(bill);
    const e = key ? load(store)[key] : null;
    return e && PRINT_STATES.includes(e.s) && Number(e.at) > now - KEEP_MS ? e : null;
}

/**
 * Records a print outcome; `n` counts the tries sent to the printer.
 * @param {Object} bill
 * @param {'printed'|'failed'|'uncertain'|'hand'} state
 * @param {{error?: string, store?: Storage, now?: number}} [opts]
 * @returns {boolean} false when the phone's storage refused it
 */
export function recordPrint(bill, state, { error = '', store = localStorage, now = Date.now() } = {}) {
    const key = printKey(bill);
    if (!key || !PRINT_STATES.includes(state)) return false;
    const map = load(store);
    const prev = map[key];
    const tries = (prev?.n || 0) + (state === 'hand' ? 0 : 1);
    const entry = { s: state, at: now, n: tries };
    if (state === 'failed' && error) entry.err = String(error).slice(0, 120);
    const next = prunePrintStatuses({ ...map, [key]: entry }, now);
    try {
        store.setItem(KEY, JSON.stringify(next));
    } catch (e) {
        console.warn('Storing the print status failed:', e);
        return false;
    }
    cache = { store, map: next };
    return true;
}

/** Forgets the in-memory copy (tests, or another tab changed it). */
export function resetPrintStatusCache() {
    cache = null;
}
