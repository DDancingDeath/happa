/**
 * @fileoverview Offline / pending-sync pill in the header (#70). Uses only free
 * signals: the browser's online/offline events, the hasPendingWrites flag of
 * snapshots the app's listeners already receive, the writes this device sends,
 * and the SDK's "nothing left to send" (FirebaseService.pendingWritesWaiter, passed
 * in by main.js). It never reads from Firestore and never touches it directly.
 * @module ui/sync-status
 */

import { t, tn, LANG_CHANGE_EVENT } from '../i18n/index.js';

/** An online write must stay unacknowledged this long before it is shown as waiting. */
export const PENDING_SHOW_DELAY_MS = 1500;
/** How long "Synced" stays on screen. */
export const SYNCED_SHOW_MS = 2500;

/**
 * Text of the pill for a state, or '' when nothing is shown.
 * @param {{online: boolean, pending: number, synced?: boolean}} state
 * @returns {string}
 */
export function syncStatusText({ online, pending, synced = false }) {
    const waiting = pending > 0 ? tn('ui.sync.waiting', pending) : '';
    if (!online) return waiting ? `${t('ui.sync.offline')} · ${waiting}` : t('ui.sync.offline');
    if (waiting) return waiting;
    return synced ? t('ui.sync.synced') : '';
}

/**
 * @param {Object} [deps]
 * @param {Window} [deps.win]
 * @param {Document} [deps.doc]
 * @param {Function} [deps.pendingWrites] - Returns a function that resolves once nothing is
 *   left to send, or null when that can't be asked (FirebaseService.pendingWritesWaiter)
 */
export function createSyncStatus({ win = null, doc = null, pendingWrites: initialPendingWrites = () => null } = {}) {
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

    const pendingKeys = () => {
        const all = new Set(writes.keys());
        listened.forEach(paths => paths.forEach(p => all.add(p)));
        return all;
    };
    const pendingCount = () => pendingKeys().size;

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
        if (!online) {
            clearTimeout(pendingShowTimer);
            clearTimeout(syncedTimer);
            pendingShowTimer = null;
            synced = false;
            shown = true;
            paint(syncStatusText({ online, pending }), 'offline');
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
            clearTimeout(pendingShowTimer);
            clearTimeout(syncedTimer);
            pendingShowTimer = null;
            writes.clear();
            listened.clear();
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
            render();
            const done = () => {
                if (writes.get(key) === token) writes.delete(key);
                render();
            };
            Promise.resolve(promise).then(done, done);
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
        /** Forgets listener state (listeners torn down, e.g. sign-out). */
        clearListeners() {
            if (!listened.size) return;
            listened.clear();
            render();
        },
        pendingCount,
        isOnline: () => online
    };
}

export const SyncStatus = createSyncStatus({
    win: typeof window !== 'undefined' ? window : null,
    doc: typeof document !== 'undefined' ? document : null
});
