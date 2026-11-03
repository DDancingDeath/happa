/**
 * @fileoverview The recent-history window of the data layer: what is in memory for each history
 * collection (window and dues listeners, one-shot older records) and how it reaches AppState,
 * records written on this phone, older history on demand and its refresh, and the month
 * snapshots a write makes stale. Moved verbatim out of firestore-service.js
 * (docs/architecture.md, phase 5, #69).
 * @module firebase/core/history-window
 */

import {
    ALL_HISTORY_VIEWS, byDateDesc, docIdOf, docIds, HISTORY_COLLECTIONS, HISTORY_SPEC, historySpecReadable,
    LOADED_PAYMENT, mapDoc, paymentSignature
} from './records.js';
import { AppState } from '../../utils/state.js';
import { isActiveBill, outstandingDue } from '../../utils/money.js';
import { S } from './session.js';
import { Helpers } from '../../utils/helpers.js';
import { t } from '../../i18n/index.js';
import { parseAnyBillDate } from '../../utils/dates.js';
import { eventTime, stockFingerprint } from '../../utils/stock-replay.js';
import { CLIENT_VERSION, col, getDb } from '../db.js';
import { SyncStatus } from '../../ui/sync-status.js';
import { getWithRetry } from './reads.js';
import { markDirty } from './realtime.js';
import { monthsBefore, normalizeFrom } from '../../utils/history-range.js';
import { noteObservedChange } from './stock-checkpoint.js';
import { backfillLegacyTimestamps } from './legacy-scan.js';

// -------------------- RECENT-HISTORY WINDOW + STOCK CHECKPOINT --------------------
//
// Reads per app open are kept to the recent window instead of all history:
//  * Each history collection is listened to with `timestamp >= liveFrom`, where
//    liveFrom = min(1st of previous month, checkpoint.asOf). Every current save
//    path writes a numeric `timestamp` (FirebaseService.save*/update* add one
//    when missing); legacy docs get one from the checkpoint rebuild backfill.
//  * Old bills that still have money due are kept in memory by realtime
//    listeners on `payment.due > 0` and `dueAmount > 0`.
//  * Stock = replay(checkpoint.state, events with t >= checkpoint.asOf). The
//    checkpoint (doc stockCheckpoints/current) is the running state after every
//    event before asOf, so the result is identical to a full replay. It is
//    rebuilt from a full read when missing/stale/incompatible (one device at a
//    time, guarded by a lease), rolled forward from in-memory data when it is
//    more than a week behind the window start, and marked stale whenever a
//    stock-affecting record older than it is created/edited/deleted.
//  * ensureHistoryFrom()/loadOlderHistory() one-shot fetch older ranges on
//    demand. Those records stay in memory for the session but are NOT live:
//    edits made to them on another device show up on the next app open.
//
// AppState history arrays keep their historical order (`date` desc, ties by
// document id desc, as orderBy('date','desc') returned) and, like that query,
// exclude documents without a `date` field.

export const RETRY_LIMIT_BASE = 1000000;

export const pendingExtends = new Map();

export const createCollState = (spec) => ({
    spec,
    live: { docs: [], initialized: false, server: false },
    dues: [],
    extended: new Map(),
    publishedExtended: new Set()
});

export const liveIdSet = (c, except = null) => {
    const ids = new Set();
    [c.live, ...c.dues].forEach(l => {
        if (l !== except) l.docs.forEach(r => ids.add(docIdOf(r)));
    });
    return ids;
};

export const findInSources = (c, docId, except = null) => {
    for (const l of [c.live, ...c.dues]) {
        if (l === except) continue;
        const rec = l.docs.find(r => docIdOf(r) === docId);
        if (rec) return rec;
    }
    return c.extended.get(docId) || null;
};

export const currentSources = () => ({
    purchases: AppState.purchaseHistory || [],
    wholesaleSales: AppState.salesHistory || [],
    retailSales: AppState.retailSalesHistory || [],
    stockAdjustments: AppState.stockAdjustments || []
});

/**
 * Rebuilds AppState[stateKey] from the window listener, the dues listeners and
 * the one-shot (extended) records, deduped by document id (live data wins).
 * @private
 */
export function publishCollection(c) {
    const current = AppState[c.spec.stateKey];
    if (c.publishedExtended.size && Array.isArray(current)) {
        // A one-shot record that was published but is gone from AppState was
        // removed by app code (e.g. a delete that splices the array); don't
        // resurrect it, and treat it as a deletion for the stock checkpoint.
        const present = new Set(current.map(r => String(r?.id)));
        const live = liveIdSet(c);
        c.publishedExtended.forEach(docId => {
            const rec = c.extended.get(docId);
            if (rec && !present.has(String(rec.id)) && !live.has(docId)) {
                c.extended.delete(docId);
                if (c.spec.stock) noteObservedChange(c, rec, null, 'removed locally');
            }
        });
    }
    const merged = new Map();
    c.extended.forEach((rec, id) => merged.set(id, rec));
    c.dues.forEach(l => l.docs.forEach(rec => merged.set(docIdOf(rec), rec)));
    c.live.docs.forEach(rec => merged.set(docIdOf(rec), rec));
    const list = [];
    const voided = [];
    merged.forEach(rec => {
        if (rec.date === undefined) return;
        // Voided bills (#75) and expenses (#99) never reach AppState's lists, so no figure counts them; History / Expenses ask for them.
        if ((c.spec.dues || c.spec.voidable) && !isActiveBill(rec)) voided.push(rec);
        else list.push(rec);
    });
    list.sort(byDateDesc);
    voided.sort(byDateDesc);
    c.voided = voided;
    c.publishedExtended = new Set();
    list.forEach(rec => {
        const id = docIdOf(rec);
        if (c.extended.get(id) === rec) c.publishedExtended.add(id);
    });
    c.published = list;
    AppState[c.spec.stateKey] = withSharedState(c, list);
    AppState.dataVersion = ++S.dataVersion;
    if (c.spec.stock) S.stockChangeGen++;
}

/** The published lists of every collection sharing c's AppState key (expenses + personal expenses), newest first. */
export function withSharedState(c, list) {
    const others = Object.values(S.windowState?.colls || {})
        .filter(o => o !== c && o.spec.stateKey === c.spec.stateKey && Array.isArray(o.published));
    if (!others.length) return list;
    return [...list, ...others.flatMap(o => o.published)].sort(byDateDesc);
}

/**
 * Where an expense lives (#98): personalExpenses when that collection's state holds it, by
 * document id or by its own `id` field (old-app rows carry a numeric one), else expenses.
 * @returns {{collKey: string, rec: ?Object, docId: string}}
 */
export function locateExpense(id) {
    const c = S.windowState?.colls?.personalExpenses;
    const sid = String(id);
    if (c) {
        const recs = [...c.extended.values(), ...c.live.docs, ...c.dues.flatMap(l => l.docs), ...(c.published || [])];
        const rec = recs.find(r => docIdOf(r) === sid) || recs.find(r => String(r?.id) === sid);
        if (rec) return { collKey: 'personalExpenses', rec, docId: docIdOf(rec) };
    }
    return { collKey: 'expenses', rec: null, docId: sid };
}

/**
 * Bill numbers already warned about this session (#41): pre-fix offline
 * numbering on two phones could issue the same number; tell the user once
 * when such a bill syncs so it can be told apart by customer/time.
 */
export const warnedDuplicateBillNumbers = new Set();

export function warnDuplicateBillNumbers(c, changes) {
    const dups = Helpers.findDuplicateBillNumbers(changes, AppState[c.spec.stateKey], docIdOf)
        .filter(n => !warnedDuplicateBillNumbers.has(n));
    if (!dups.length) return;
    dups.forEach(n => warnedDuplicateBillNumbers.add(n));
    console.warn(`[${c.spec.label}] duplicate bill number(s) after sync:`, dups);
    import('../../ui/ui-manager.js')
        .then(({ UIManager }) => UIManager.showToast(
            t('msg.sync.same_bill_number_used_twice', { dups: dups.join(', ') }), 6000))
        .catch(() => {});
}

/**
 * Keeps the in-memory copy of a record written by this device in step with the
 * write: one-shot (extended) records are not live, so without this the next
 * publish would resurrect the pre-edit version. Live records are left to their
 * listener. record = null for deletes.
 * @private
 */
export function noteLocalRecordWrite(collKey, docId, record) {
    const c = S.windowState?.colls[collKey];
    if (!c) return;
    const id = String(docId);
    if (record) {
        if (!liveIdSet(c).has(id)) {
            const rec = { ...record, id: record.id ?? id };
            rec[LOADED_PAYMENT] = paymentSignature(record);
            docIds.set(rec, id);
            c.extended.set(id, rec);
        }
    } else {
        c.extended.delete(id);
        c.extended.forEach((rec, key) => {
            if (String(rec.id) === id) c.extended.delete(key);
        });
    }
    publishCollection(c);
}

/** The time a record counts in a month: BILL-TIME for bills / adjustments, its date for expenses / withdrawals. */
export function monthTimeOf(collKey, rec) {
    if (!rec) return null;
    if (collKey === 'expenses' || collKey === 'personalExpenses' || collKey === 'withdrawals') return parseAnyBillDate(rec.date)?.getTime() ?? null;
    const t = eventTime(rec);
    return t === Number.MAX_SAFE_INTEGER ? null : t;
}

/**
 * Marks the month snapshots (monthStats) a write to a record dated before this month makes wrong
 * as stale: one merge write per month (staleMonthsFor), issued after the record write, never
 * blocking it. Owner/manager devices rebuild them (Money: rollSnapshots, Build month history).
 * @private
 * @returns {Promise<string[]>} the months marked
 */
export function noteMonthWrite(collKey, oldRec, newRec) {
    try {
        const now = Date.now();
        const d = new Date(now);
        const current = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
        const times = [monthTimeOf(collKey, oldRec), monthTimeOf(collKey, newRec)];
        if (!times.some(t => Number.isFinite(t) && t < current)) return (S.lastMonthMark = Promise.resolve([]));
        const cascade = !!HISTORY_SPEC[collKey]?.stock && stockFingerprint(oldRec) !== stockFingerprint(newRec);
        S.lastMonthMark = import('../../utils/month-snapshots.js').then(({ staleMonthsFor, staleMark }) => {
            const months = staleMonthsFor(times, { now, cascade });
            if (!months.length) return months;
            const db = getDb();
            const ref = db.collection(col('monthStats'));
            const batch = db.batch();
            months.forEach(k => batch.set(ref.doc(k), staleMark(k, now), { merge: true }));
            batch.commit().catch(e => console.error('Month snapshot stale mark failed:', e));
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('aadhat:monthstale', { detail: { months, at: now } }));
            }
            return months;
        }).catch(e => {
            console.error('Month snapshot stale mark failed:', e);
            return [];
        });
        return S.lastMonthMark;
    } catch (e) {
        console.error('Month snapshot stale mark failed:', e);
        return Promise.resolve([]);
    }
}

/**
 * Puts this device's version of a live record in its listener's list at once
 * (a void: published lists drop it before the listener's own update arrives).
 * @private
 */
export function replaceLiveRecord(collKey, docId, record) {
    const docs = S.windowState?.colls?.[collKey]?.live?.docs;
    const i = docs ? docs.findIndex(r => docIdOf(r) === String(docId)) : -1;
    if (i === -1) return;
    const rec = { ...record };
    docIds.set(rec, String(docId));
    docs[i] = rec;
}

/** Finds the in-memory version of a history record by document id or `id` field. */
export function findRecord(collKey, id) {
    if (id === undefined || id === null) return null;
    const arr = AppState[HISTORY_SPEC[collKey].stateKey] || [];
    const sid = String(id);
    return arr.find(r => docIdOf(r) === sid) || arr.find(r => String(r?.id) === sid) || null;
}

/** Voided bills (#75) loaded for a bill collection, newest first (kept out of AppState). */
export const voidedOf = (collKey) => S.windowState?.colls?.[collKey]?.voided || [];

/** Drops a deleted record from memory so it is not resurrected. */
export function forgetRecord(collKey, id) {
    noteLocalRecordWrite(collKey, id, null);
}

/**
 * New history record with an id made on the phone, shown in memory at once
 * (works offline; the listener later replaces it, same doc id). A refused
 * write removes it again and rejects `committed`. `id`: save again over this
 * not-yet-confirmed record; `sent` is the raw write (for whenStoredLocally).
 * `withBatch(batch, docId)` adds writes that must land with it (one batch).
 * @private
 * @returns {{record: Object, committed: Promise<void>, sent: Promise<void>}}
 */
export function startCreate(collKey, data, id = null, withBatch = null) {
    const coll = getDb().collection(col(collKey));
    const ref = id ? coll.doc(String(id)) : coll.doc();
    const record = { id: ref.id, ...data };
    const stateKey = HISTORY_SPEC[collKey].stateKey;
    noteLocalRecordWrite(collKey, ref.id, record);
    const list = AppState[stateKey] || (AppState[stateKey] = []);
    const at = list.findIndex(r => String(r.id) === ref.id);
    if (at === -1) list.unshift(record);
    else list[at] = record;
    let sent;
    if (withBatch) {
        const batch = getDb().batch();
        batch.set(ref, data);
        withBatch(batch, ref.id);
        sent = batch.commit();
    } else {
        sent = ref.set(data);
    }
    SyncStatus.trackWrite(ref.path, sent);
    const committed = sent.catch(err => {
        forgetRecord(collKey, ref.id);
        const i = (AppState[stateKey] || []).findIndex(r => String(r.id) === ref.id);
        if (i !== -1) AppState[stateKey].splice(i, 1);
        throw err;
    });
    return { record, committed, sent };
}

/**
 * Gives a record the numeric `timestamp` the window queries filter on. Uses
 * the time the stock replay already assigns it (so replay order is unchanged),
 * or now for a new record without a parseable date.
 * @private
 */
export function ensureTimestamp(record, isNew) {
    if (!record || typeof record.timestamp === 'number') return;
    const t = eventTime(record);
    record.timestamp = t === Number.MAX_SAFE_INTEGER && isNew ? Date.now() : t;
}

/**
 * Fields every FirebaseService bill/adjustment write carries: numeric timestamp,
 * clientVersion (required by firestore.rules) and, for bills, `openDue`
 * (the dues listener's filter).
 * @private
 */
export function prepareStockRecord(collKey, record, isNew) {
    ensureTimestamp(record, isNew);
    record.clientVersion = CLIENT_VERSION;
    if (HISTORY_SPEC[collKey].dues) record.openDue = hasDue(collKey, record);
}

/**
 * One-shot fetch of history older than the loaded window (target 0 = all
 * history, unfiltered so legacy docs without `timestamp` are included).
 * Collections are read one after another (see getWithRetry). `readFull(spec)` (the checkpoint
 * rebuild, #159) may read a collection of a full fetch instead (null: read it here).
 * @private
 */
export async function extendHistory(target, readFull = null) {
    const ws = S.windowState;
    if (!ws) return;
    const gen = S.sessionGen;
    const startedAt = Date.now();
    const upper = AppState.historyLoadedFrom;
    const full = target === 0;
    const db = getDb();
    const snaps = [];
    for (const spec of HISTORY_COLLECTIONS) {
        if (!historySpecReadable(spec)) {
            snaps.push(null);
            continue;
        }
        const makeQuery = (attempt) => {
            let q = db.collection(col(spec.key));
            if (!full) q = q.where('timestamp', '>=', target).where('timestamp', '<', upper);
            // A retry needs a distinct watch target; a huge limit keeps the results identical.
            return attempt ? q.limit(RETRY_LIMIT_BASE + attempt) : q;
        };
        const read = () => getWithRetry(makeQuery, `${spec.label} history`);
        snaps.push(await (full && readFull ? readFull(spec).then(s => s ?? read()) : read()).catch(err => {
            if (spec.optional) {
                console.error(`${spec.label} history fetch error:`, err);
                return null;
            }
            throw err;
        }));
        if (gen !== S.sessionGen || S.windowState !== ws) return;
    }
    let fromServer = true;
    snaps.forEach((snap, i) => {
        if (!snap) return;
        const c = ws.colls[HISTORY_COLLECTIONS[i].key];
        const fresh = !snap.metadata?.fromCache;
        if (!fresh) fromServer = false;
        const live = liveIdSet(c);
        // A fresh full read is authoritative: replace the one-shot set so
        // records deleted or edited elsewhere don't linger.
        if (full && fresh) c.extended = new Map();
        snap.docs.forEach(doc => {
            if (!live.has(doc.id)) c.extended.set(doc.id, mapDoc(doc));
        });
        if (full && fresh) ws.backfills[c.spec.key] = backfillLegacyTimestamps(c.spec, snap.docs);
        publishCollection(c);
    });
    // Pages read by an earlier, interrupted rebuild are as old as their first read
    const readAt = Math.min(...snaps.map(s => s?.readAt ?? Infinity));
    if (fromServer) {
        if (!S.onDemandAsOf) S.onDemandAsOf = Math.min(Date.now(), readAt);
        if (full) {
            AppState.historyLoadedFrom = 0;
            ws.rawFull = true;
            S.fullHistoryFetchedAt = Math.min(startedAt, readAt);
        } else if (AppState.historyLoadedFrom !== 0 && target < AppState.historyLoadedFrom) {
            AppState.historyLoadedFrom = target;
        }
    } else {
        console.warn('History fetch was served from the offline cache; loaded window not extended.');
    }
    markDirty(ALL_HISTORY_VIEWS, true);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aadhat:historyextended', { detail: { from: AppState.historyLoadedFrom } }));
    }
}

/**
 * Re-reads every on-demand (non-live) record in [historyLoadedFrom, liveFrom)
 * from the server and replaces the in-memory copies, so edits/deletes made on
 * another device since they were loaded show up (#132).
 * @private
 * @returns {Promise<boolean>} false if offline / served from cache
 */
export async function refreshOnDemand() {
    const ws = S.windowState;
    if (!ws) return false;
    const from = AppState.historyLoadedFrom;
    if (from >= ws.liveFrom) return true;
    const gen = S.sessionGen;
    const startedAt = Date.now();
    const full = from === 0;
    const db = getDb();
    const snaps = [];
    for (const spec of HISTORY_COLLECTIONS) {
        if (!historySpecReadable(spec)) {
            snaps.push(null);
            continue;
        }
        const makeQuery = (attempt) => {
            let q = db.collection(col(spec.key));
            if (!full) q = q.where('timestamp', '>=', from).where('timestamp', '<', ws.liveFrom);
            return attempt ? q.limit(RETRY_LIMIT_BASE + attempt) : q;
        };
        snaps.push(await getWithRetry(makeQuery, `${spec.label} refresh`).catch(err => {
            if (spec.optional) return null;
            throw err;
        }));
        if (gen !== S.sessionGen || S.windowState !== ws) return false;
    }
    if (snaps.some(s => s && s.metadata?.fromCache)) return false;
    const inRange = (rec) => full || (typeof rec?.timestamp === 'number' && rec.timestamp >= from && rec.timestamp < ws.liveFrom);
    snaps.forEach((snap, i) => {
        if (!snap) return;
        const c = ws.colls[HISTORY_COLLECTIONS[i].key];
        const live = liveIdSet(c);
        c.extended.forEach((rec, id) => {
            if (inRange(rec)) c.extended.delete(id);
        });
        snap.docs.forEach(doc => {
            if (!live.has(doc.id)) c.extended.set(doc.id, mapDoc(doc));
        });
        publishCollection(c);
    });
    S.onDemandAsOf = Date.now();
    if (full) S.fullHistoryFetchedAt = startedAt;
    markDirty(ALL_HISTORY_VIEWS, true);
    return true;
}

/** force: always do a fresh read (checkpoint rebuild must not reuse in-session data). */
export function queueExtend(target, raw = false, force = false, readFull = null) {
    const covered = () => !S.windowState || (!force && (raw
        ? S.windowState.rawFull
        : AppState.historyLoadedFrom === 0 || (target > 0 && target >= AppState.historyLoadedFrom)));
    if (covered()) return Promise.resolve();
    const key = force ? `force:${++S.forcedExtends}` : `${raw ? 'raw' : 'w'}:${target}`;
    if (pendingExtends.has(key)) return pendingExtends.get(key);
    const gen = S.sessionGen;
    const p = S.extendQueue.then(() => (gen === S.sessionGen && !covered() ? extendHistory(target, readFull) : undefined));
    S.extendQueue = p.catch(() => {});
    pendingExtends.set(key, p);
    const clear = () => {
        if (pendingExtends.get(key) === p) pendingExtends.delete(key);
    };
    p.then(clear, clear);
    return p;
}

/** Oldest numeric timestamp across history collections (cached per session). */
export function oldestTimestamp() {
    if (!S.oldestTimestampPromise) {
        const gen = S.sessionGen;
        const db = getDb();
        S.oldestTimestampPromise = Promise.all(HISTORY_COLLECTIONS.map(spec => (!historySpecReadable(spec) ? Infinity :
            getWithRetry(a => db.collection(col(spec.key)).orderBy('timestamp', 'asc').limit(1 + a), `${spec.label} oldest`)
                .then(s => (s.docs.length ? Number(s.docs[0].data().timestamp) : Infinity))
                .catch(err => {
                    if (spec.optional) return Infinity;
                    throw err;
                }))
        )).then(values => Math.min(...values)).catch(err => {
            if (gen === S.sessionGen) S.oldestTimestampPromise = null;
            throw err;
        });
    }
    return S.oldestTimestampPromise;
}

/** Re-reads an old bill that left a dues query (paid off, or deleted). */
export function refetchAfterDueRemoval(c, docId, prev) {
    const gen = S.sessionGen;
    getWithRetry(getDb().collection(col(c.spec.key)).doc(docId), `${c.spec.label} ${docId}`).then(snap => {
        if (gen !== S.sessionGen || !S.windowState || liveIdSet(c).has(docId)) return;
        if (snap.exists) {
            const rec = mapDoc(snap);
            // Paid off: keep it only if it is inside the loaded history range.
            if (AppState.historyLoadedFrom === 0 || eventTime(rec) >= AppState.historyLoadedFrom) c.extended.set(docId, rec);
            else c.extended.delete(docId);
            if (c.spec.stock && prev) noteObservedChange(c, prev, rec, 'modified');
        } else {
            c.extended.delete(docId);
            if (c.spec.stock && prev) noteObservedChange(c, prev, null, 'deleted');
        }
        publishCollection(c);
        markDirty(c.spec.views, !!c.spec.stock);
    }).catch(e => console.error(`${c.spec.label}: re-reading ${docId} failed:`, e));
}

/**
 * Due as the screens compute it: BILL-DUE (outstandingDue), the rule of
 * Outstanding, Money and Wholesale › Outstanding.
 */
export function hasDue(collKey, rec) {
    return outstandingDue(rec) > 0;
}

/** FirebaseService methods of the history window; spread into FirebaseService (`this` is FirebaseService). */
export const historyWindowMethods = {
    /**
     * Local time this device started its last fresh server read of all history (0 = none this
     * session); month snapshots marked stale before it can be rebuilt from the loaded bills.
     * @returns {number}
     */
    getFullHistoryFetchedAt() {
        return S.fullHistoryFetchedAt;
    },

    /** Resolves with the months of the last stale mark once it is issued (tests). */
    monthMarksIssued() {
        return S.lastMonthMark;
    },

    /**
     * Whether a bill has money due as the screens compute it (BILL-DUE,
     * outstandingDue). Stored as `openDue` on bills.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @returns {boolean}
     */
    billHasOpenDue(collKey, bill) {
        return hasDue(collKey, bill);
    },

    /**
     * Firestore document id of a loaded record (a legacy doc may carry an `id`
     * field that differs from its document id).
     * @param {Object} record
     * @returns {string}
     */
    documentIdOf(record) {
        return docIdOf(record);
    },

    /**
     * Start (ms epoch) of the history guaranteed to be in AppState; 0 = all.
     * @returns {number}
     */
    getHistoryWindowStart() {
        return AppState.historyLoadedFrom;
    },

    /**
     * @returns {boolean} true when every history record is loaded
     */
    isFullHistoryLoaded() {
        return AppState.historyLoadedFrom === 0;
    },

    /**
     * Makes sure every history record with event time >= `from` is in AppState.
     * Resolves immediately when already covered; otherwise one-shot fetches the
     * missing range [from, historyLoadedFrom) of all history collections (all
     * history, unfiltered, for null), merges it (deduped by id, date-desc order),
     * updates AppState.historyLoadedFrom, re-renders and dispatches
     * `aadhat:historyextended` ({detail: {from}}). Concurrent calls share work.
     * Fetched records are not live (edits by other devices appear on next open).
     * @param {number|Date|null} from ms epoch / Date; null = all history
     * @returns {Promise<void>}
     */
    ensureHistoryFrom(from) {
        return queueExtend(normalizeFrom(from)).then(() => undefined);
    },

    /**
     * Extends the loaded history back by `months` calendar months (to full
     * history once nothing older exists).
     * @param {number} [months=1]
     * @returns {Promise<{loadedFrom: number, reachedEnd: boolean}>}
     */
    async loadOlderHistory(months = 1) {
        if (!S.windowState || AppState.historyLoadedFrom === 0) {
            return { loadedFrom: AppState.historyLoadedFrom, reachedEnd: true };
        }
        const oldest = await oldestTimestamp();
        const target = monthsBefore(AppState.historyLoadedFrom, months);
        if (oldest < target) {
            await this.ensureHistoryFrom(target);
        } else if (S.checkpointDoc?.backfill?.complete === true) {
            // Every document carries a numeric timestamp: [1, loadedFrom) is the rest.
            const before = AppState.historyLoadedFrom;
            await this.ensureHistoryFrom(1);
            if (AppState.historyLoadedFrom === 1 && before !== 0) {
                AppState.historyLoadedFrom = 0;
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('aadhat:historyextended', { detail: { from: 0 } }));
                }
            }
        } else {
            // Legacy documents without a timestamp may exist: load everything.
            await this.ensureHistoryFrom(null);
        }
        return { loadedFrom: AppState.historyLoadedFrom, reachedEnd: AppState.historyLoadedFrom === 0 };
    },

    /**
     * On-demand history currently in memory (records older than the live
     * window; not live-updated), or null when only live data is loaded.
     * @returns {?{from: number, liveFrom: number, asOf: number}}
     */
    getOnDemandHistoryInfo() {
        if (!S.windowState || AppState.historyLoadedFrom >= S.windowState.liveFrom) return null;
        return { from: AppState.historyLoadedFrom, liveFrom: S.windowState.liveFrom, asOf: S.onDemandAsOf };
    },

    /**
     * Re-fetches the on-demand range from the server (queued behind any
     * running history load).
     * @returns {Promise<boolean>} false if it could not reach the server
     */
    refreshOnDemandHistory() {
        const p = S.extendQueue.then(() => refreshOnDemand());
        S.extendQueue = p.catch(() => {});
        return p;
    },

    /**
     * True once the live window listeners of all three bill collections
     * (purchases, retail, wholesale) have delivered a server snapshot this
     * session, i.e. the loaded bills are not just the offline cache.
     * @returns {boolean}
     */
    historyServerSynced() {
        const ws = S.windowState;
        if (!ws || ws.gen !== S.sessionGen) return false;
        return ['purchases', 'retailSales', 'wholesaleSales'].every(k => ws.colls[k]?.live?.server === true);
    }
};
