/**
 * @fileoverview Keeps the offline-cache answers of the data listeners cheap (#59).
 *
 * The Firebase SDK answers a listener from this phone's cache through the documents it last
 * knew matched (fast) only when the query's stored target records a server-consistent
 * version, and then it also loads every document of the collection cached after that
 * version. On the web it stores that version only when a document of the query changes or
 * when the last listener of the query goes away (still so in SDK 12: "TODO(b/272564316)"
 * in local_store_impl.ts). So quiet queries (the `paidAt` and pinned dues), new queries (a
 * new month's window) and every query of a collection into which history reads have since
 * put older bills (stock rebuild, History "All time") load the whole collection on every
 * app open. Re-subscribing a server-synced listener ("healing" it) makes the SDK store that
 * version; its first snapshot is compared with what the app already has, so pages see only
 * real changes (realtime.js resyncSnapshot) and the read meter counts none.
 *
 * Per phone, localStorage keeps when each query was last healed and when a server read of
 * each collection last returned documents; a query is healed once after startup only when
 * it was never healed or its collection was read since.
 * @module firebase/core/target-heal
 */

import { S } from './session.js';
import { whenIdle } from '../../utils/background-tasks.js';
import { safeSetItem } from '../../utils/storage-full.js';
import { onServerQueryRead } from '../firestore-meter.js';

export const HEAL_STORE_KEY = 'happa.listenTargets';
/** Wait after the first screen before healing (the first interactions come first). */
export const HEAL_DELAY_MS = 3000;
/** Listeners not server-synced yet are tried again this much later, a few times. */
export const HEAL_RETRY_MS = 30000;
export const HEAL_MAX_RETRIES = 4;
/** A re-subscription that never answers stops holding the next one back after this long. */
export const RELISTEN_TIMEOUT_MS = 15000;
const MAX_KEYS = 150;

/** This session's healable listeners: {key, coll, relisten(): ?Promise<void>, syncedAt(): number}. */
const entries = [];
let job = null;
let running = false;
let retries = 0;

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/**
 * @param {?Storage} [store]
 * @returns {{reads: Object<string, number>, synced: Object<string, number>}}
 */
export function loadHealRecord(store = storage()) {
    try {
        const raw = JSON.parse(store?.getItem(HEAL_STORE_KEY) || 'null');
        if (raw && typeof raw === 'object') {
            return {
                reads: raw.reads && typeof raw.reads === 'object' ? raw.reads : {},
                synced: raw.synced && typeof raw.synced === 'object' ? raw.synced : {}
            };
        }
    } catch (_) { /* unreadable: start again */ }
    return { reads: {}, synced: {} };
}

/**
 * Keeps the record small: the keys of this session's listeners plus the most recent others.
 * @param {{reads: Object<string, number>, synced: Object<string, number>}} record
 * @param {?Storage} [store]
 * @param {Set<string>} [keep]
 */
export function saveHealRecord(record, store = storage(), keep = new Set()) {
    if (!store) return;
    const synced = Object.entries(record.synced)
        .sort(([a, x], [b, y]) => (keep.has(b) ? 1 : 0) - (keep.has(a) ? 1 : 0) || y - x)
        .slice(0, MAX_KEYS);
    safeSetItem(HEAL_STORE_KEY, JSON.stringify({ reads: record.reads, synced: Object.fromEntries(synced) }), store);
}

/**
 * Whether a listener's stored query must be healed: never healed (a new query), or its
 * collection got documents from a server read at or after the sync that was stored.
 * @param {{reads: Object<string, number>, synced: Object<string, number>}} record
 * @param {string} key
 * @param {string} coll
 * @returns {boolean}
 */
export function needsHeal(record, key, coll) {
    const synced = record.synced[key];
    if (!synced) return true;
    return (record.reads[coll] || 0) >= synced;
}

/** A server read of `coll` returned documents now: those are newer than its stored queries. */
export function noteCollectionRead(coll, at = Date.now(), store = storage()) {
    if (!coll || !store) return;
    const record = loadHealRecord(store);
    record.reads[coll] = at;
    saveHealRecord(record, store);
}

onServerQueryRead(coll => noteCollectionRead(coll));

/**
 * @param {{key: string, coll: string, relisten: function(): ?Promise<void>, syncedAt: function(): number}} entry
 */
export function registerHealable(entry) {
    entries.push(entry);
}

/** Sign-out / listeners torn down. */
export function resetHeal() {
    entries.length = 0;
    job?.();
    job = null;
    running = false;
    retries = 0;
}

/** True while a heal is scheduled or running (the benchmark waits for it). */
export function healPending() {
    return !!job || running;
}

const nextIdle = () => new Promise(resolve => { whenIdle(resolve, { timeoutMs: 2000 }); });

async function heal(gen) {
    running = true;
    let waiting = false;
    try {
        const keep = new Set(entries.map(e => e.key));
        for (const entry of [...entries]) {
            if (gen !== S.sessionGen) return;
            const record = loadHealRecord();
            if (!needsHeal(record, entry.key, entry.coll)) continue;
            const syncedAt = entry.syncedAt();
            const done = syncedAt ? entry.relisten() : null;
            if (!done) {
                waiting = true;
                continue;
            }
            await done;
            if (gen !== S.sessionGen) return;
            const after = loadHealRecord();
            after.synced[entry.key] = syncedAt;
            saveHealRecord(after, storage(), keep);
            await nextIdle();
        }
    } finally {
        if (gen === S.sessionGen) running = false;
    }
    if (waiting && gen === S.sessionGen && retries < HEAL_MAX_RETRIES && navigator.onLine !== false) {
        retries++;
        scheduleHeal(gen, HEAL_RETRY_MS);
    }
}

/**
 * Heals the listeners that need it once the device is idle.
 * @param {number} gen session the listeners belong to
 * @param {number} [delayMs]
 */
export function scheduleHeal(gen, delayMs = HEAL_DELAY_MS) {
    if (job || gen !== S.sessionGen) return;
    job = whenIdle(() => {
        job = null;
        if (gen !== S.sessionGen || running) return;
        heal(gen).catch(e => console.warn('Listener targets not refreshed:', e?.code || e));
    }, { minDelayMs: delayMs });
}
