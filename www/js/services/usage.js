/**
 * @fileoverview Local usage analytics (#136): track(event) counts feature use
 * per day in IndexedDB on this phone (localStorage when IndexedDB is missing).
 * Nothing goes to Firestore. Counts are batched in memory and written a few
 * seconds later or when the app is hidden. Never throws into the caller.
 * @module services/usage
 */

import { isUsageEvent, usageKey, mergeUsage, expiredUsage, USAGE_KEEP_DAYS } from '../utils/usage-stats.js';
import { toLocalISODate, localISODaysAgo } from '../utils/dates.js';

const DB_NAME = 'happa-usage';
const STORE = 'counters';
const LS_KEY = 'happa.usage';
const FLUSH_DELAY_MS = 3000;

const warn = (msg, e) => { try { console.warn(`[usage] ${msg}:`, e?.message || e); } catch (_) { /* never */ } };

/** IndexedDB store: rows {key, day, event, count}. */
export function idbStore(idb = globalThis.indexedDB) {
    let dbPromise = null;
    const open = () => {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = idb.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    };
    const run = async (mode, fn) => {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const store = tx.objectStore(STORE);
            let out;
            Promise.resolve(fn(store)).then(v => { out = v; }, reject);
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    };
    const request = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return {
        async all() {
            return run('readonly', store => request(store.getAll())).then(rows => rows || []);
        },
        /** Adds counts in one read-write transaction (another tab's adds queue behind it). */
        async add(pending) {
            await run('readwrite', store => new Promise((resolve, reject) => {
                const req = store.getAll();
                req.onsuccess = () => {
                    const byKey = new Map((req.result || []).map(r => [r.key, r]));
                    pending.forEach((n, key) => {
                        const [day, event] = key.split('|');
                        store.put({ key, day, event, count: (byKey.get(key)?.count || 0) + n });
                    });
                    resolve();
                };
                req.onerror = () => reject(req.error);
            }));
        },
        async dropKeys(keys) {
            if (!keys.length) return;
            await run('readwrite', store => { keys.forEach(k => store.delete(k)); });
        },
        async clear() {
            await run('readwrite', store => { store.clear(); });
        }
    };
}

/** localStorage fallback with the same shape. */
export function localStore(ls = globalThis.localStorage) {
    const read = () => {
        try {
            const rows = JSON.parse(ls.getItem(LS_KEY) || '[]');
            return Array.isArray(rows) ? rows : [];
        } catch (_) {
            return [];
        }
    };
    const write = (rows) => ls.setItem(LS_KEY, JSON.stringify(rows));
    return {
        async all() { return read(); },
        async add(pending) { write(mergeUsage(read(), pending)); },
        async dropKeys(keys) {
            const drop = new Set(keys);
            write(read().filter(r => !drop.has(usageKey(r.day, r.event))));
        },
        async clear() { ls.removeItem(LS_KEY); }
    };
}

/**
 * @param {{store?: Object, now?: Function, setTimer?: Function}} [deps]
 */
export function createUsage({ store = null, now = () => new Date(), setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    let backend = store;
    const pending = new Map();
    let timer = null;
    let writing = Promise.resolve();

    const getBackend = () => {
        if (backend) return backend;
        try {
            backend = typeof indexedDB !== 'undefined' && indexedDB ? idbStore(indexedDB) : localStore();
        } catch (_) {
            backend = localStore();
        }
        return backend;
    };

    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!pending.size) return writing;
        const batch = new Map(pending);
        pending.clear();
        writing = writing.then(() => getBackend().add(batch)).catch(e => {
            warn('not saved', e);
            batch.forEach((n, k) => pending.set(k, (pending.get(k) || 0) + n));
        });
        return writing;
    };

    return {
        /**
         * Counts one use of a feature (documented names only, see utils/usage-stats.js).
         * @param {string} event
         */
        track(event) {
            try {
                if (!isUsageEvent(event)) return;
                const key = usageKey(toLocalISODate(now()), event);
                pending.set(key, (pending.get(key) || 0) + 1);
                if (!timer) timer = setTimer(() => { timer = null; flush(); }, FLUSH_DELAY_MS);
            } catch (e) {
                warn('track failed', e);
            }
        },
        flush,
        /** Stored rows plus what is still in memory; drops days older than USAGE_KEEP_DAYS. */
        async rows() {
            await flush();
            const rows = await getBackend().all();
            const old = expiredUsage(rows, localISODaysAgo(USAGE_KEEP_DAYS));
            if (old.length) getBackend().dropKeys(old.map(r => usageKey(r.day, r.event))).catch(e => warn('prune failed', e));
            return rows.filter(r => !old.includes(r));
        },
        async clear() {
            pending.clear();
            await writing;
            await getBackend().clear();
        }
    };
}

export const Usage = createUsage();

/** Shorthand: Usage.track(event). */
export const track = (event) => Usage.track(event);

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
        window.addEventListener('aadhat:tabshown', (e) => track(`page.${e?.detail?.tabId || ''}`));
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') Usage.flush();
        });
        window.addEventListener('pagehide', () => Usage.flush());
    } catch (_) { /* never */ }
}
