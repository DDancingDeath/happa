/**
 * @fileoverview Resumable full-history read for the stock checkpoint rebuild (#159). The rebuild
 * reads every history collection in pages (document id order, the same order as one unfiltered
 * read) and keeps on this phone which documents each page returned. A rebuild cut short (the app
 * closed, a reload) carries on from there: a page already read is taken from the phone's Firestore
 * cache when every one of its documents is still there, else read again; the rest comes from the
 * server. Progress is only reused for the same user and data set, the same window month and the
 * same checkpoint `staleCount` (any older stock change since bumps it), and for at most a day.
 * Without document-id ordering (no FieldPath) a collection is read in one go, as before.
 * @module firebase/core/rebuild-progress
 */

import { col, getDb } from '../db.js';
import { getWithRetry } from './reads.js';
import { STOCK_REPLAY_FORMAT } from '../../utils/stock-replay.js';

/** Documents per page of the rebuild's read (an object so tests can use small pages). */
export const REBUILD_PAGING = { pageSize: 500 };

export const PROGRESS_VERSION = 1;

/** Progress older than this is read again: data on this phone that no listener keeps may be out of date. */
export const PROGRESS_MAX_AGE_MS = 86400000;

const STORAGE_PREFIX = 'happa.rebuildProgress';

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/**
 * Whether stored progress may be resumed by this rebuild.
 * @param {*} p stored progress
 * @param {{uid: string, env: string, windowStart: number, staleCount: number, now: number}} ctx
 */
export function usableProgress(p, ctx) {
    if (!p || typeof p !== 'object' || p.v !== PROGRESS_VERSION || p.format !== STOCK_REPLAY_FORMAT) return false;
    if (p.uid !== ctx.uid || p.env !== ctx.env || p.windowStart !== ctx.windowStart || p.staleCount !== ctx.staleCount) return false;
    const age = ctx.now - p.startedAt;
    return Number.isFinite(age) && age >= 0 && age <= PROGRESS_MAX_AGE_MS && !!p.colls && typeof p.colls === 'object';
}

const validPage = (page) => !!page && Array.isArray(page.ids) && page.ids.every(id => typeof id === 'string')
    && (page.after === null || typeof page.after === 'string') && Number.isFinite(page.readAt);

/**
 * Opens the progress of one rebuild: the stored one when usable, else a new one (the stored
 * one is dropped).
 * @param {{uid: string, staleCount: number, windowStart: number, now?: number, storage?: Storage, alive?: Function}} opts
 * @returns {{resumed: boolean, readCollection: Function, clear: Function}}
 */
export function openRebuildProgress({ uid, staleCount, windowStart, now = Date.now(), storage = defaultStorage(), alive = () => true }) {
    const env = col('stockCheckpoints');
    const key = `${STORAGE_PREFIX}:${env}:${uid}`;
    const ctx = { uid, env, windowStart, staleCount, now };
    let stored = null;
    try {
        stored = storage ? JSON.parse(storage.getItem(key) || 'null') : null;
    } catch {
        stored = null;
    }
    const resumed = usableProgress(stored, ctx);
    const data = resumed ? stored : { v: PROGRESS_VERSION, format: STOCK_REPLAY_FORMAT, uid, env, windowStart, staleCount, startedAt: now, colls: {} };
    let persist = !!storage;
    const keepProgress = () => {
        if (!persist) return;
        try {
            storage.setItem(key, JSON.stringify(data));
        } catch (e) {
            // Storage full: this rebuild just can't be resumed
            persist = false;
            console.warn('Stock checkpoint rebuild progress not saved:', e?.name || e);
            try { storage.removeItem(key); } catch { /* nothing to drop */ }
        }
    };
    if (!resumed && stored !== null) {
        try { storage.removeItem(key); } catch { /* nothing to drop */ }
    }
    return {
        resumed,
        /** Same result as one unfiltered `get()` of the collection (see readCollectionResumable). */
        readCollection: (spec) => readCollectionResumable(spec, data, keepProgress, alive),
        clear() {
            persist = false;
            try { storage?.removeItem(key); } catch { /* nothing to drop */ }
        }
    };
}

/** A stored page from this phone's cache, in its order; null unless every document is there. */
async function cachedPage(ref, docIdPath, page) {
    if (!page.ids.length) return [];
    let q = ref.orderBy(docIdPath);
    if (page.after !== null) q = q.startAfter(page.after);
    const snap = await q.endAt(page.ids[page.ids.length - 1]).get({ source: 'cache' }).catch(() => null);
    if (!snap) return null;
    const byId = new Map(snap.docs.map(d => [d.id, d]));
    const docs = page.ids.map(id => byId.get(id));
    return docs.every(Boolean) ? docs : null;
}

/**
 * Every document of a history collection, like one unfiltered server `get()`: stored pages from
 * the cache, the rest from the server a page at a time (each page saved once read). `readAt` is
 * when the oldest page was read. A page served from the cache by the SDK (offline) or a session
 * that ended stops the read: the result is then marked `fromCache` (not a full server read).
 * @private
 */
export async function readCollectionResumable(spec, data, keepProgress, alive = () => true) {
    const ref = getDb().collection(col(spec.key));
    const docIdPath = typeof firebase !== 'undefined' && firebase.firestore?.FieldPath?.documentId
        ? firebase.firestore.FieldPath.documentId() : null;
    // No document-id ordering available: the caller reads it in one go
    if (!docIdPath) return null;
    const entry = data.colls[spec.key] && Array.isArray(data.colls[spec.key].pages)
        ? data.colls[spec.key] : (data.colls[spec.key] = { pages: [], done: false });
    const { pageSize } = REBUILD_PAGING;
    const docs = [];
    let after = null;
    let readAt = Infinity;
    let kept = 0;
    for (const page of entry.pages) {
        if (!validPage(page) || page.after !== after) break;
        const got = await cachedPage(ref, docIdPath, page);
        if (!got) break;
        docs.push(...got);
        if (page.ids.length) after = page.ids[page.ids.length - 1];
        readAt = Math.min(readAt, page.readAt);
        kept++;
    }
    if (kept < entry.pages.length) {
        entry.pages.length = kept;
        entry.done = false;
        keepProgress();
    }
    const partial = () => ({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: true }, readAt });
    while (!entry.done) {
        if (!alive()) return partial();
        const from = after;
        const snap = await getWithRetry(a => {
            let q = ref.orderBy(docIdPath);
            if (from !== null) q = q.startAfter(from);
            return q.limit(pageSize + a);
        }, `${spec.label} history`);
        if (snap.metadata?.fromCache) {
            docs.push(...snap.docs);
            return partial();
        }
        const ids = snap.docs.map(d => d.id);
        const at = Date.now();
        entry.pages.push({ after: from, ids, readAt: at });
        entry.done = ids.length < pageSize;
        keepProgress();
        docs.push(...snap.docs);
        if (ids.length) after = ids[ids.length - 1];
        readAt = Math.min(readAt, at);
    }
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false }, readAt };
}
