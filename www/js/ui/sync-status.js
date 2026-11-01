/**
 * @fileoverview Offline / pending-sync pill in the header (#70). Uses only free
 * signals: the browser's online/offline events, the hasPendingWrites flag of
 * snapshots the app's listeners already receive, the writes this device sends,
 * and the SDK's "nothing left to send" (FirebaseService.pendingWritesWaiter, passed
 * in by main.js). It never reads from Firestore and never touches it directly.
 * @module ui/sync-status
 */

import { t, tn, getLang, LANG_CHANGE_EVENT } from '../i18n/index.js';
import { formatDayTime, formatTimeOfDay, toLocalISODate } from '../utils/dates.js';

/** An online write must stay unacknowledged this long before it is shown as waiting. */
export const PENDING_SHOW_DELAY_MS = 1500;
/** How long "Synced" stays on screen. */
export const SYNCED_SHOW_MS = 2500;
/** localStorage key: when this phone last got data from the server (ms). */
export const SERVER_DATA_AT_KEY = 'happa.serverDataAt';
/** Rows remembered as "Saved" this session (oldest dropped first). */
const SYNCED_IDS_MAX = 500;
const SERVER_DATA_SAVE_MS = 60 * 1000;

/**
 * "as of" time of cached data: the time of day, with the day when it is not today.
 * @param {number} at - ms
 * @param {number} [now]
 * @returns {string}
 */
export function asOfText(at, now = Date.now()) {
    if (!Number.isFinite(at) || at <= 0) return '';
    const lang = getLang();
    return toLocalISODate(new Date(at)) === toLocalISODate(new Date(now))
        ? formatTimeOfDay(at, { lang })
        : formatDayTime(at, { lang, now: new Date(now) });
}

/**
 * Text of the pill for a state, or '' when nothing is shown.
 * @param {{online: boolean, pending: number, synced?: boolean, asOf?: string}} state
 *   asOf: when the data on screen last came from the server (offline only)
 * @returns {string}
 */
export function syncStatusText({ online, pending, synced = false, asOf = '' }) {
    const waiting = pending > 0 ? tn('ui.sync.waiting', pending) : '';
    if (!online) {
        const offline = asOf ? t('ui.sync.offline_as_of', { time: asOf }) : t('ui.sync.offline');
        return waiting ? `${offline} · ${waiting}` : offline;
    }
    if (waiting) return waiting;
    return synced ? t('ui.sync.synced') : '';
}

const SYNC_CHIP_KEYS = Object.freeze({ pending: 'ui.sync.row_pending', synced: 'ui.sync.row_saved' });

/**
 * Per-row sync chip (#70): "Waiting to sync" for a document this phone has not got
 * onto the server yet, "Saved" once it did (this session). Kept up to date by fillSyncChips.
 * @param {string} id - Firestore document id
 * @param {?('pending'|'synced')} state
 * @returns {string} HTML (an empty, hidden span when there is nothing to say)
 */
export function syncChipHtml(id, state = null) {
    if (id === undefined || id === null || id === '') return '';
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    const key = SYNC_CHIP_KEYS[state];
    const text = key ? t(key).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`) : '';
    return `<span class="sync-chip" data-sync-id="${safeId}" data-state="${key ? state : ''}"${key ? '' : ' hidden'}>${text}</span>`;
}

/**
 * @param {Object} [deps]
 * @param {Window} [deps.win]
 * @param {Document} [deps.doc]
 * @param {Function} [deps.pendingWrites] - Returns a function that resolves once nothing is
 *   left to send, or null when that can't be asked (FirebaseService.pendingWritesWaiter)
 * @param {Storage} [deps.storage] - keeps the last server-data time across restarts
 */
export function createSyncStatus({ win = null, doc = null, pendingWrites: initialPendingWrites = () => null, storage = null } = {}) {
    let pendingWrites = initialPendingWrites;
    const writes = new Map();
    const listened = new Map();
    let online = win?.navigator?.onLine !== false;
    let shown = false;
    let synced = false;
    let pendingShowTimer = null;
    let syncedTimer = null;
    let started = false;
    let waitSeq = 0;
    let el = null;
    let lastSyncAt = null;
    const watchers = new Set();
    const syncedIds = new Set();
    let serverDataAt = Number(storage?.getItem?.(SERVER_DATA_AT_KEY)) || null;
    let serverDataSavedAt = 0;

    const idOf = (path) => String(path).split('/').pop();
    // Only an acknowledged write proves a row reached the server: a listener's pending
    // flag also clears when the server refuses a write (the SDK reverts the document).
    const markSynced = (path) => {
        const id = idOf(path);
        syncedIds.delete(id);
        syncedIds.add(id);
        if (syncedIds.size > SYNCED_IDS_MAX) syncedIds.delete(syncedIds.values().next().value);
    };
    const forgetSynced = (path) => syncedIds.delete(idOf(path));
    /** id → 'pending' | 'synced' for every row with something to say. */
    const rowStates = () => {
        const states = new Map();
        syncedIds.forEach(id => states.set(id, 'synced'));
        pendingKeys().forEach(p => states.set(idOf(p), 'pending'));
        return states;
    };

    const pendingKeys = () => {
        const all = new Set(writes.keys());
        listened.forEach(paths => paths.forEach(p => all.add(p)));
        return all;
    };
    const pendingCount = () => pendingKeys().size;
    const notifyStopped = () => watchers.forEach(fn => { try { fn({ online, pending: 0, stopped: true }); } catch (_) { /* never */ } });

    const element = () => {
        if (el && el.isConnected) return el;
        if (!doc) return null;
        el = doc.getElementById('syncStatus');
        if (!el && doc.body) {
            el = doc.createElement('div');
            el.id = 'syncStatus';
            el.className = 'sync-pill';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.hidden = true;
            doc.body.appendChild(el);
        }
        return el;
    };

    const paint = (text, kind) => {
        const node = element();
        if (!node) return;
        node.textContent = text;
        node.hidden = !text;
        node.dataset.state = text ? kind : '';
    };

    const flashSynced = () => {
        synced = true;
        lastSyncAt = Date.now();
        clearTimeout(syncedTimer);
        syncedTimer = setTimeout(() => { synced = false; shown = false; render(); }, SYNCED_SHOW_MS);
        render();
    };

    /** After the last pending change is gone, confirm with the SDK that nothing else is queued. */
    const confirmSynced = () => {
        const seq = ++waitSeq;
        let waiter = null;
        try { waiter = pendingWrites(); } catch (_) { waiter = null; }
        const wait = typeof waiter === 'function'
            ? Promise.resolve().then(() => waiter())
            : Promise.resolve();
        wait.then(() => {
            if (seq !== waitSeq || !online || pendingCount() > 0) return;
            flashSynced();
        }, () => {});
    };

    function render() {
        if (!started) return;
        const pending = pendingCount();
        watchers.forEach(fn => { try { fn({ online, pending }); } catch (_) { /* a watcher never breaks the pill */ } });
        if (!online) {
            clearTimeout(pendingShowTimer);
            clearTimeout(syncedTimer);
            pendingShowTimer = null;
            synced = false;
            shown = true;
            paint(syncStatusText({ online, pending, asOf: serverDataAt ? asOfText(serverDataAt) : '' }), 'offline');
            return;
        }
        if (pending > 0) {
            clearTimeout(syncedTimer);
            synced = false;
            if (shown) {
                paint(syncStatusText({ online, pending }), 'pending');
            } else if (!pendingShowTimer) {
                pendingShowTimer = setTimeout(() => {
                    pendingShowTimer = null;
                    if (online && pendingCount() > 0) {
                        shown = true;
                        render();
                    }
                }, PENDING_SHOW_DELAY_MS);
            }
            return;
        }
        clearTimeout(pendingShowTimer);
        pendingShowTimer = null;
        if (synced) {
            paint(syncStatusText({ online, pending: 0, synced: true }), 'synced');
            return;
        }
        if (shown && !synced) {
            paint('', '');
            confirmSynced();
            return;
        }
        paint('', '');
    }

    const onOnline = () => { online = true; render(); };
    const onOffline = () => { online = false; ++waitSeq; render(); };
    const onLang = () => render();

    return {
        /** @param {{pendingWrites?: Function}} [opts] - see createSyncStatus */
        start(opts = {}) {
            if (typeof opts.pendingWrites === 'function') pendingWrites = opts.pendingWrites;
            if (started || !win) return;
            started = true;
            online = win.navigator?.onLine !== false;
            win.addEventListener('online', onOnline);
            win.addEventListener('offline', onOffline);
            win.addEventListener(LANG_CHANGE_EVENT, onLang);
            render();
        },
        stop() {
            if (started && win) {
                win.removeEventListener('online', onOnline);
                win.removeEventListener('offline', onOffline);
                win.removeEventListener(LANG_CHANGE_EVENT, onLang);
            }
            started = false;
            notifyStopped();
            clearTimeout(pendingShowTimer);
            clearTimeout(syncedTimer);
            pendingShowTimer = null;
            writes.clear();
            listened.clear();
            syncedIds.clear();
            shown = false;
            synced = false;
            paint('', '');
        },
        /**
         * Counts a write until it settles (acknowledged by the server or refused).
         * @param {string} path - Document path, so a doc also seen by a listener counts once
         * @param {Promise} promise
         */
        trackWrite(path, promise) {
            const key = String(path);
            const token = {};
            writes.set(key, token);
            forgetSynced(key);
            render();
            const done = () => {
                if (writes.get(key) === token) writes.delete(key);
                render();
            };
            Promise.resolve(promise).then(() => { lastSyncAt = Date.now(); markSynced(key); done(); }, done);
        },
        /**
         * Notes the documents of a listener snapshot that are not yet on the server.
         * @param {string} listenerId
         * @param {Object} snapshot - Query snapshot (metadata.hasPendingWrites, docs)
         */
        noteSnapshot(listenerId, snapshot) {
            const had = listened.has(listenerId);
            if (!snapshot?.metadata?.hasPendingWrites) {
                if (!had) return;
                listened.delete(listenerId);
            } else {
                const paths = new Set();
                (snapshot.docs || []).forEach(d => {
                    if (d?.metadata?.hasPendingWrites) paths.add(d.ref?.path || d.id);
                });
                if (!paths.size && !had) return;
                if (paths.size) listened.set(listenerId, paths);
                else listened.delete(listenerId);
            }
            render();
        },
        /**
         * A listener got data from the server: the time the offline pill shows as "as of".
         * @param {number} [at]
         */
        noteServerData(at = Date.now()) {
            serverDataAt = at;
            if (!storage || at - serverDataSavedAt < SERVER_DATA_SAVE_MS) return;
            serverDataSavedAt = at;
            try { storage.setItem(SERVER_DATA_AT_KEY, String(at)); } catch (_) { /* storage full: the time is only shown */ }
        },
        /**
         * Sync state of one document on this phone.
         * @param {string} id
         * @returns {'pending'|'synced'|null}
         */
        syncStateOf(id) {
            if (id === undefined || id === null || id === '') return null;
            return rowStates().get(String(id)) || null;
        },
        /**
         * Fills the row chips (syncChipHtml) under root with their documents' state.
         * @param {ParentNode} [root]
         */
        fillSyncChips(root = doc) {
            const chips = root?.querySelectorAll?.('.sync-chip[data-sync-id]');
            if (!chips || !chips.length) return;
            const states = rowStates();
            chips.forEach(chip => {
                const state = states.get(chip.dataset.syncId) || '';
                const text = state ? t(SYNC_CHIP_KEYS[state]) : '';
                if (chip.dataset.state === state && chip.textContent === text) return;
                chip.hidden = !state;
                chip.dataset.state = state;
                chip.textContent = text;
            });
        },
        /**
         * Row chip with this document's state now (syncChipHtml).
         * @param {string} id
         * @returns {string} HTML
         */
        chipHtml(id) {
            return syncChipHtml(id, this.syncStateOf(id));
        },
        /** Forgets listener state (listeners torn down, e.g. sign-out). */
        clearListeners() {
            // Sign-out / listeners torn down: an open TIP Sync run is not judged.
            notifyStopped();
            if (!listened.size) return;
            listened.clear();
            render();
        },
        pendingCount,
        isOnline: () => online,
        /** When this phone last saw one of its changes reach the server (ms), null this session. */
        lastSyncAt: () => lastSyncAt,
        /**
         * Calls fn({online, pending}) on every state change (TIP Sync, #161).
         * @returns {Function} unsubscribe
         */
        watch(fn) {
            watchers.add(fn);
            return () => watchers.delete(fn);
        }
    };
}

export const SyncStatus = createSyncStatus({
    win: typeof window !== 'undefined' ? window : null,
    doc: typeof document !== 'undefined' ? document : null,
    storage: typeof localStorage !== 'undefined' ? localStorage : null
});

// Row chips follow the pill's state (one watcher for every list).
SyncStatus.watch(() => SyncStatus.fillSyncChips());
