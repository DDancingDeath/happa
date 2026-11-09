/**
 * @fileoverview The data listeners of a signed-in session: items, the stock checkpoint, the history
 * window and dues of each history collection and the item order, started once after sign-in and
 * stopped by cleanup(); and what Diagnostics shows about them. Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/core/listeners
 */

import {
    applySnapshot, defaultMapDoc, FIRST_SNAPSHOT_CACHED_WAIT_MS, FIRST_SNAPSHOT_SERVER_WAIT_MS,
    listenerStartup, markDirty, pendingFirstSnapshots, pendingViews, resyncSnapshot, runView, unsubscribeFunctions
} from './realtime.js';
import { healPending, registerHealable, RELISTEN_TIMEOUT_MS, resetHeal, scheduleHeal } from './target-heal.js';
import { dataFreshness, expectServer, resetFreshness, sealFreshness, startFreshness, whenServerConfirmed } from '../../utils/data-freshness.js';
import { SyncStatus } from '../../ui/sync-status.js';
import { S } from './session.js';
import { AppState } from '../../utils/state.js';
import { forgetAppSettings } from '../repos/settings.js';
import {
    createCollState, findInSources, liveIdSet, pendingExtends, publishCollection, refetchAfterDueRemoval,
    warnDuplicateBillNumbers
} from './history-window.js';
import {
    adoptCheckpoint, invalidationTags, listenCheckpoint, noteObservedChange, parseCheckpoint, PINNED_CHUNK,
    PINNED_MAX
} from './stock-checkpoint.js';
import { getQuotaStatus } from '../firestore-meter.js';
import { col, getDb } from '../db.js';
import { canManageCheckpoint, HISTORY_COLLECTIONS, historySpecReadable, mapDoc } from './records.js';
import { getWithRetry } from './reads.js';
import { legacyScanRef, scheduleLegacyScan } from './legacy-scan.js';
import { defaultWindowStart } from '../../utils/history-range.js';
import { memberWindowStart } from '../../utils/rebuild-lease.js';
import { LEGACY_SCAN_DELAY_MS, shouldScheduleLegacyScan, whenIdle } from '../../utils/background-tasks.js';
import { localISODaysAgo } from '../../utils/dates.js';
import { emit, ITEM_FREQUENCY_CHANGED } from '../../utils/events.js';
import { FirebaseService } from '../firestore-service.js';

/** Short stable key of a pinned-ids chunk (the stored query it names). */
const idsKey = (ids) => {
    let h = 0;
    const s = ids.join(',');
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return `${ids.length}:${(h >>> 0).toString(36)}`;
};

/** FirebaseService listener methods; spread into FirebaseService (`this` is FirebaseService). */
export const listenerMethods = {
    /**
     * Cleans up all active real-time listeners.
     * Should be called when user logs out or app is destroyed.
     * @returns {void}
     */
    cleanup() {
        unsubscribeFunctions.forEach(unsubscribe => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        });
        unsubscribeFunctions.length = 0;
        resetHeal();
        resetFreshness();
        SyncStatus.clearListeners();
        pendingFirstSnapshots.forEach(settle => settle.resolve());
        pendingFirstSnapshots.length = 0;
        if (S.flushTimer) {
            clearTimeout(S.flushTimer);
            S.flushTimer = null;
        }
        pendingViews.clear();
        S.stockDirty = false;
        S.stockCache = {};
        AppState.dataVersion = ++S.dataVersion;
        S.sessionGen++;
        S.windowState = null;
        S.checkpointDoc = undefined;
        S.activeCheckpoint = null;
        S.checkpointItemsCheck = { items: null, checkpoint: null, ok: false };
        S.rebuildPromise = null;
        forgetAppSettings();
        S.rebuildRequestedAgain = false;
        S.rebuildAttempted = false;
        clearTimeout(S.leaseWaitTimer);
        S.leaseWaitTimer = null;
        S.leaseWaitStartedAt = 0;
        S.oldestTimestampPromise = null;
        S.extendQueue = Promise.resolve();
        pendingExtends.clear();
        invalidationTags.clear();
        S.legacyScanJob?.cancel();
        S.legacyScanJob = null;
        S.lastStockApprox = null;
        AppState.stockApprox = null;
        S.approxCheckpointCache = { doc: undefined, cp: null };
        S.ownStaleWrite = false;
        AppState.historyLoadedFrom = 0;
    },

    /**
     * Diagnostics: how each listener became ready at the last startup.
     * @returns {Object<string, {first: string, docs: number, readyBy?: string}>}
     */
    getStartupListenerInfo() {
        return JSON.parse(JSON.stringify(listenerStartup));
    },

    /**
     * 'cache' while some data listener of this session has not heard from the server yet, 'server' once all
     * did, null with no session (#59).
     */
    dataFreshness() {
        return dataFreshness();
    },

    /**
     * Resolves true once every data listener of this session heard from the server, false when the
     * session ends first. Writers of derived data wait for it, so they never work from cache-only data.
     * @returns {Promise<boolean>}
     */
    whenServerConfirmed() {
        return whenServerConfirmed();
    },

    /** Whether refreshing the listeners' stored queries (core/target-heal.js) is still to come or running. */
    listenerHealPending() {
        return healPending();
    },

    /**
     * Diagnostics (#194): estimated document reads since the app opened, the
     * top sources, and any "daily limit reached" errors seen this session.
     * @returns {{reads: number, since: number, top: Array<{source: string, reads: number}>, heavy: boolean, quota: Object}}
     */
    getReadStats() {
        return getQuotaStatus();
    },

    /**
     * Sets up real-time Firestore listeners for live data synchronization.
     *
     * Items are listened to in full. History collections (purchases, retail
     * and wholesale sales, expenses, stock adjustments, withdrawals) are
     * listened to only from the recent window start (see the section comment
     * above HISTORY_COLLECTIONS), plus bills with an outstanding due. The
     * stock checkpoint doc is read first because the window start depends on it.
     *
     * The first snapshot of each listener populates AppState, so startup does
     * not need a separate .get(). Later snapshots apply only docChanges() and
     * schedule a single debounced stock recalculation + re-render of the
     * visible tab.
     *
     * @returns {Promise<void>} Resolves once every data listener has delivered
     *   its first snapshot; rejects if a required listener fails before that.
     */
    setupRealtimeListeners() {
        // Clear any existing listeners first
        this.cleanup();
        startFreshness();
        const gen = S.sessionGen;
        const db = getDb();
        S.warmCache = false;
        Object.keys(listenerStartup).forEach(k => delete listenerStartup[k]);

        const listen = (query, label, live, onData, { optional = false, mapFn = mapDoc, target = null } = {}) => {
            let settle;
            const first = new Promise((resolve, reject) => { settle = { resolve, reject }; });
            // If listeners are torn down before the first snapshot (e.g. logout
            // during startup), don't leave startup waiting forever.
            pendingFirstSnapshots.push(settle);
            // Startup waits for server-confirmed data (like the former .get()),
            // falling back to the offline cache when offline or the server is slow.
            let ready = false;
            let readyTimer = null;
            const markReady = () => {
                if (ready) return;
                ready = true;
                clearTimeout(readyTimer);
                settle.resolve();
            };
            const syncId = `listen-${++S.listenSeq}`;
            const heardServer = expectServer(label);
            let serverAt = 0;
            // Set while a healed listener waits for the first snapshot of its new subscription.
            let resync = null;
            const onNext = snapshot => {
                if (gen !== S.sessionGen) return;
                SyncStatus.noteSnapshot(syncId, snapshot);
                const prev = live.lastSnapshot;
                live.lastSnapshot = snapshot;
                const { changed, changes } = resync ? resyncSnapshot(live, prev, snapshot, mapFn) : applySnapshot(live, snapshot, mapFn);
                if (resync) {
                    resync.done();
                    resync = null;
                }
                if (!snapshot.metadata.fromCache) {
                    live.server = true;
                    if (!serverAt) serverAt = Date.now();
                    SyncStatus.noteServerData();
                }
                live.delivered = true;
                // Before startup is ready only AppState is updated; startup
                // computes stock and renders the initial views itself.
                try {
                    if (changed) onData(changes, ready);
                } finally {
                    if (!snapshot.metadata.fromCache) heardServer();
                }
                if (!ready) {
                    const source = snapshot.metadata.fromCache ? 'cache' : 'server';
                    listenerStartup[label] = listenerStartup[label] || { first: source, docs: snapshot.size };
                    if (snapshot.metadata.fromCache && snapshot.size > 0) S.warmCache = true;
                    if (!snapshot.metadata.fromCache || navigator.onLine === false) {
                        listenerStartup[label].readyBy = source === 'server' ? 'server' : 'offline-cache';
                        markReady();
                    } else if (!readyTimer) {
                        // This device already has cached data: show it after a
                        // short wait instead of the full server grace; the live
                        // listener applies the server copy as soon as it arrives.
                        readyTimer = setTimeout(() => {
                            listenerStartup[label].readyBy = 'cache-timeout';
                            markReady();
                        }, S.warmCache ? FIRST_SNAPSHOT_CACHED_WAIT_MS : FIRST_SNAPSHOT_SERVER_WAIT_MS);
                    }
                }
            };
            const onError = error => {
                console.error(`${label} listener error:`, error);
                live.failed = true;
                heardServer();
                clearTimeout(readyTimer);
                if (resync) {
                    resync.done();
                    resync = null;
                }
                if (!ready) {
                    ready = true;
                    if (optional) {
                        live.docs = [];
                        live.initialized = true;
                        if (gen === S.sessionGen) onData(null, false);
                        settle.resolve();
                    } else {
                        settle.reject(error);
                    }
                } else if (optional) {
                    // Failed later (e.g. Roles & access switched off): drop what it had, so a
                    // phone without the rows never also counts them (#98).
                    live.docs = [];
                    if (gen === S.sessionGen) onData(null, true);
                }
            };
            // includeMetadataChanges so the cache -> server transition is seen
            // even when the cached data was already up to date.
            const subscribe = () => query.onSnapshot({ includeMetadataChanges: true }, onNext, onError);
            let unsubscribe = subscribe();
            unsubscribeFunctions.push(() => unsubscribe());
            if (target) {
                registerHealable({
                    ...target,
                    syncedAt: () => (live.failed ? 0 : serverAt),
                    relisten: () => {
                        if (gen !== S.sessionGen || !ready || live.failed || !serverAt || resync || !live.lastSnapshot) return null;
                        return new Promise(resolve => {
                            // A slow answer stops holding the next heal back; its snapshot is still diffed.
                            const timer = setTimeout(resolve, RELISTEN_TIMEOUT_MS);
                            resync = { done: () => { clearTimeout(timer); resolve(); } };
                            if (listenerStartup[label]) listenerStartup[label].healed = true;
                            unsubscribe();
                            unsubscribe = subscribe();
                        });
                    }
                });
            }
            return first;
        };

        const itemsLive = { docs: [], initialized: false, server: false };
        const firstSnapshots = [listen(db.collection(col('items')), 'Items', itemsLive, (changes, started) => {
            AppState.items = itemsLive.docs.slice();
            AppState.dataVersion = ++S.dataVersion;
            if (!started) return;
            // Index-based views (item dropdown values, item cards) must
            // never lag behind AppState.items, so refresh them right away.
            ['itemsList', 'billingDropdown', 'salesDropdown'].forEach(name => {
                pendingViews.delete(name);
                runView(name);
            });
            markDirty(['itemsTable'], true);
        }, { mapFn: defaultMapDoc })];

        // Read in parallel: only the background legacy scan and backfills need it (#13).
        S.legacyScanReadPromise = getWithRetry(legacyScanRef(), 'Legacy scan state', { attempts: 2 })
            .then(snap => { if (gen === S.sessionGen) S.legacyScanDoc = snap.exists ? snap.data() : {}; })
            .catch(e => { console.warn('Reading legacy scan state failed:', e?.code || e); if (gen === S.sessionGen) S.legacyScanDoc = null; });
        const historyReady = listenCheckpoint(gen).then(() => {
            if (gen !== S.sessionGen) return undefined;
            const W = defaultWindowStart(Date.now());
            const cp = parseCheckpoint(S.checkpointDoc);
            let liveFrom = cp ? Math.min(W, cp.asOf) : W;
            if (!cp && !canManageCheckpoint()) {
                // Cover a stale checkpoint so members get approximate stock without a full read (#129).
                liveFrom = memberWindowStart(W, parseCheckpoint(S.checkpointDoc, { allowStale: true })?.asOf ?? null);
            }
            S.windowState = { gen, liveFrom, rawFull: false, colls: {}, backfills: {} };
            S.onDemandAsOf = 0;
            S.fullHistoryFetchedAt = 0;
            AppState.historyLoadedFrom = liveFrom;
            if (cp) adoptCheckpoint(S.checkpointDoc);

            const waits = [];
            HISTORY_COLLECTIONS.forEach(spec => {
                const c = createCollState(spec);
                S.windowState.colls[spec.key] = c;
                if (!historySpecReadable(spec)) {
                    Object.assign(c.live, { docs: [], initialized: true, server: true });
                    publishCollection(c);
                    return;
                }
                const affectsStock = !!spec.stock;
                const collName = col(spec.key);
                const windowQuery = db.collection(collName)
                    .where('timestamp', '>=', liveFrom)
                    .orderBy('timestamp', 'desc');
                waits.push(listen(windowQuery, spec.label, c.live, (changes, started) => {
                    // null: an optional listener failed; its one-shot older records go too
                    if (changes === null) c.extended = new Map();
                    (changes || []).forEach(ch => {
                        const previous = ch.oldRec || findInSources(c, ch.docId, c.live);
                        if (ch.newRec) c.extended.delete(ch.docId);
                        if (spec.stock) noteObservedChange(c, previous, ch.newRec, ch.type);
                    });
                    publishCollection(c);
                    if (started && spec.dues && changes) warnDuplicateBillNumbers(c, changes);
                    if (started) markDirty(spec.views, affectsStock);
                }, { optional: !!spec.optional, target: { coll: collName, key: `${collName}|from|${liveFrom}` } }));

                if (!spec.dues) return;
                // Older bills with money due (in-window bills come from the window query), and older
                // bills paid or written off inside the window (#163): their payment counts in this
                // window's money in / out, day book and month snapshots after the due is gone.
                // Bills inside the window with a later payment come from both queries (published
                // once, read twice): two range filters would need a composite index.
                const dueQueries = [
                    ['openDue', db.collection(collName).where('openDue', '==', true).where('timestamp', '<', liveFrom), `openDue|${liveFrom}`],
                    ['paidAt', db.collection(collName).where('paidAt', '>=', liveFrom), `paidAt|${liveFrom}`]
                ];
                const pinnedIds = Array.isArray(S.checkpointDoc?.pinned?.[spec.key]) ? S.checkpointDoc.pinned[spec.key].slice(0, PINNED_MAX) : [];
                const docIdPath = typeof firebase !== 'undefined' && firebase.firestore?.FieldPath?.documentId
                    ? firebase.firestore.FieldPath.documentId() : null;
                for (let i = 0; docIdPath && i < pinnedIds.length; i += PINNED_CHUNK) {
                    const ids = pinnedIds.slice(i, i + PINNED_CHUNK);
                    dueQueries.push(['pinned', db.collection(collName).where(docIdPath, 'in', ids), `pinned|${idsKey(ids)}`]);
                }
                dueQueries.forEach(([field, duesQuery, key]) => {
                    const live = { docs: [], initialized: false, server: false };
                    c.dues.push(live);
                    waits.push(listen(duesQuery, `${spec.label} dues (${field})`, live, (changes, started) => {
                        (changes || []).forEach(ch => {
                            if (ch.newRec) {
                                const previous = ch.oldRec || c.extended.get(ch.docId) || null;
                                c.extended.delete(ch.docId);
                                if (spec.stock && previous) noteObservedChange(c, previous, ch.newRec, ch.type);
                            } else if (!liveIdSet(c).has(ch.docId)) {
                                // Paid off (keep a fresh copy) or deleted.
                                refetchAfterDueRemoval(c, ch.docId, ch.oldRec);
                            }
                        });
                        publishCollection(c);
                        if (started) markDirty(spec.views, affectsStock);
                    }, { optional: true, target: { coll: collName, key: `${collName}|${key}` } }));
                });
            });
            sealFreshness();
            const ws = S.windowState;
            // Without a usable checkpoint calculateStock() reads everything anyway (and backfills).
            return Promise.all(waits).then(() => {
                if (gen !== S.sessionGen) return;
                if (shouldScheduleLegacyScan({ canManage: canManageCheckpoint(), hasCheckpoint: !!cp, online: navigator.onLine })) {
                    scheduleLegacyScan(ws, gen);
                }
                // Owner/manager phones keep the last week's personal day totals in step with the rows (#98)
                // ...from the server's rows only: cached rows may miss other phones' changes (#59)
                if (canManageCheckpoint() && FirebaseService.personalRowsLoaded()) {
                    whenServerConfirmed().then(ok => ok && gen === S.sessionGen && whenIdle(() => (gen === S.sessionGen && navigator.onLine !== false
                        ? FirebaseService.rebuildPersonalExpenseDays([0, 1, 2, 3, 4, 5, 6].map(localISODaysAgo))
                            .catch(e => console.warn('Personal expense day totals not checked:', e?.code || e))
                        : undefined), { minDelayMs: LEGACY_SCAN_DELAY_MS }));
                }
            });
        });
        firstSnapshots.push(historyReady);

        // Note: the former `cashSessions` and `users` listeners were removed.
        // Their callbacks targeted a non-existent element id / app method and
        // never did anything, yet each re-read its whole collection on every
        // app open.
        
        // Global item frequency (dropdown order) for signed-in users
        if (AppState.currentUser?.uid) {
            // Listen to global item frequency changes to update dropdown order in real-time
            // The bill and wholesale pages reload their item dropdowns (utils/events.js).
            const unsubItemFrequency = getDb().collection(col('itemFrequency')).doc('global').onSnapshot(doc => {
                if (doc.exists) emit(ITEM_FREQUENCY_CHANGED, doc.data());
            }, error => {
                console.error('Item frequency listener error:', error);
            });
            unsubscribeFunctions.push(unsubItemFrequency);
        }
        // The notifications listener is owned by NotificationsManager (#12):
        // it starts once the profile is loaded and stops on logout.

        return Promise.all(firstSnapshots).then(() => {
            if (gen !== S.sessionGen) return;
            // The checkpoint is rolled forward from server-confirmed data only (#59)
            whenServerConfirmed().then(ok => {
                if (ok && gen === S.sessionGen) {
                    this.maintainStockCheckpoint().catch(e => console.error('Stock checkpoint maintenance failed:', e));
                }
            });
            scheduleHeal(gen);
        });
    }
};
