/**
 * @fileoverview Realtime coordinator of the data layer: the listeners' unsubscribe and
 * first-snapshot lists, applying a snapshot's changes, and the debounced refresh that
 * recomputes stock and emits `refresh:<view>` for the open tab (utils/events.js).
 * Moved verbatim out of firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/core/realtime
 */

import { emit, REFRESH } from '../../utils/events.js';
import { S } from './session.js';
import { docIdOf } from './records.js';
import { FirebaseService } from '../firestore-service.js';

/** @type {Function[]} Array of unsubscribe functions for real-time listeners */
export const unsubscribeFunctions = [];

/** @type {Array<{resolve: Function}>} First-snapshot waiters of active listeners */
export const pendingFirstSnapshots = [];

export const defaultMapDoc = (doc) => ({ id: doc.id, ...doc.data() });

/**
 * Applies a query snapshot to a listener's private, ordered document list.
 * The first snapshot maps every document; later snapshots only deserialize
 * the changed documents (docChanges indices are defined relative to the
 * list with all prior changes applied, so sequential splicing reproduces
 * snapshot.docs order exactly).
 * @param {{docs: Object[], initialized: boolean}} live
 * @param {firebase.firestore.QuerySnapshot} snapshot
 * @param {Function} [mapFn]
 * @returns {{changed: boolean, changes: Array<{type: string, docId: string, oldRec: ?Object, newRec: ?Object}>|null}}
 *   changes is null for the initial snapshot (or after a resync)
 * @private
 */
export const applySnapshot = (live, snapshot, mapFn = defaultMapDoc) => {
    if (!live.initialized) {
        live.docs = snapshot.docs.map(mapFn);
        live.initialized = true;
        return { changed: true, changes: null };
    }
    const changes = snapshot.docChanges();
    if (changes.length === 0) return { changed: false, changes: [] };
    const diffs = [];
    changes.forEach(change => {
        let oldRec = null;
        let newRec = null;
        if (change.oldIndex !== -1) oldRec = live.docs.splice(change.oldIndex, 1)[0] || null;
        if (change.newIndex !== -1) {
            newRec = mapFn(change.doc);
            live.docs.splice(change.newIndex, 0, newRec);
        }
        diffs.push({ type: change.type, docId: change.doc.id, oldRec, newRec });
    });
    if (live.docs.length !== snapshot.size) {
        live.docs = snapshot.docs.map(mapFn);
        return { changed: true, changes: null };
    }
    return { changed: true, changes: diffs };
};

/**
 * The first snapshot of a re-subscribed listener (core/target-heal.js), as changes against
 * the listener's previous snapshot: unchanged documents keep their records, so a heal that
 * found nothing new reports no change.
 * @param {{docs: Object[], initialized: boolean}} live
 * @param {?firebase.firestore.QuerySnapshot} prev the last snapshot `live.docs` was built from
 * @param {firebase.firestore.QuerySnapshot} snapshot
 * @param {Function} [mapFn]
 * @returns {{changed: boolean, changes: Array<{type: string, docId: string, oldRec: ?Object, newRec: ?Object}>}}
 * @private
 */
export const resyncSnapshot = (live, prev, snapshot, mapFn = defaultMapDoc) => {
    const prevDocs = prev?.docs || [];
    if (prevDocs.length !== live.docs.length || prevDocs.some((doc, i) => docIdOf(live.docs[i]) !== doc.id)) {
        // Not expected; the same full refresh as applySnapshot's.
        live.docs = snapshot.docs.map(mapFn);
        live.initialized = true;
        return { changed: true, changes: null };
    }
    const before = new Map();
    prevDocs.forEach((doc, i) => before.set(doc.id, { doc, rec: live.docs[i] }));
    const docs = [];
    const changes = [];
    snapshot.docs.forEach(doc => {
        const old = before.get(doc.id);
        before.delete(doc.id);
        if (old && typeof old.doc.isEqual === 'function' && old.doc.isEqual(doc)) {
            docs.push(old.rec);
            return;
        }
        const newRec = mapFn(doc);
        docs.push(newRec);
        changes.push({ type: old ? 'modified' : 'added', docId: doc.id, oldRec: old ? old.rec : null, newRec });
    });
    before.forEach(({ rec }, docId) => changes.push({ type: 'removed', docId, oldRec: rec, newRec: null }));
    live.docs = docs;
    return { changed: changes.length > 0, changes };
};

const isTabActive = (tabId) => !!document.getElementById(tabId)?.classList.contains('active');

/**
 * Views refreshed after data changes. `tab` is the tab the view lives in
 * (null = always refresh). Views in hidden tabs stay pending until that
 * tab is shown. Refreshing a view emits its event (utils/events.js REFRESH);
 * the pages subscribe, this layer never calls them.
 * @private
 */
const VIEWS = {
    itemsList: { tab: null },
    itemsTable: { tab: 'items' },
    billingDropdown: { tab: 'billing' },
    salesDropdown: { tab: 'wholesale-sales' },
    wholesaleHistory: { tab: 'wholesale-sales' },
    wholesaleOutstanding: { tab: 'wholesale-sales' },
    history: { tab: 'history' },
    due: { tab: 'due' },
    stockAdjustmentHistory: { tab: 'stock' },
    stockView: { tab: 'stock' },
    expensesHistory: { tab: 'expenses' },
    money: { tab: 'money' },
    insights: { tab: 'insights' },
    statements: { tab: 'statements' },
    today: { tab: 'day' }
};

/** Debounce window that coalesces bursts of snapshot events (ms). */
const RENDER_DEBOUNCE_MS = 150;

/** Max wait for server data at startup once cached data is available (ms). */
export const FIRST_SNAPSHOT_SERVER_WAIT_MS = 10000;
/** ...when this device already has cached data for the app (#13). */
export const FIRST_SNAPSHOT_CACHED_WAIT_MS = 2500;
/** Per-listener startup facts for Diagnostics (first source, doc count, what made it ready). */
export const listenerStartup = {};
export const pendingViews = new Set();

export const runView = (name) => {
    emit(REFRESH[name]);
};

const runPendingViews = (shouldRun) => {
    for (const name of [...pendingViews]) {
        if (!shouldRun(VIEWS[name])) continue;
        pendingViews.delete(name);
        runView(name);
    }
};

const flushPendingWork = async () => {
    if (S.flushTimer) {
        clearTimeout(S.flushTimer);
        S.flushTimer = null;
    }
    if (S.stockDirty) {
        S.stockDirty = false;
        try {
            await FirebaseService.getStock();
        } catch (e) {
            console.error('Stock recalculation error:', e);
        }
    }
    runPendingViews(view => !view.tab || isTabActive(view.tab));
};

const scheduleFlush = () => {
    if (!S.flushTimer) {
        S.flushTimer = setTimeout(flushPendingWork, RENDER_DEBOUNCE_MS);
    }
};

export const markDirty = (views, affectsStock) => {
    views.forEach(v => pendingViews.add(v));
    if (affectsStock) S.stockDirty = true;
    scheduleFlush();
};

// Refresh views that went stale while their tab was hidden.
if (typeof window !== 'undefined') {
    window.addEventListener('aadhat:tabshown', (event) => {
        const tabId = event.detail?.tabId;
        if ([...pendingViews].some(name => VIEWS[name].tab === tabId)) {
            // Run now (not debounced) so the tab never shows stale data.
            flushPendingWork();
        }
    });
}
