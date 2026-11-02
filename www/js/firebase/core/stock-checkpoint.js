/**
 * @fileoverview The stock checkpoint (stockCheckpoints/current) and stock: stock = replay of the
 * checkpoint's running state plus the loaded window; the checkpoint is rebuilt from a full read
 * (one device at a time, under a lease), rolled forward from memory, and marked stale by any
 * stock-affecting change older than it. Moved verbatim out of firestore-service.js
 * (docs/architecture.md, phase 5, #69).
 * @module firebase/core/stock-checkpoint
 */

import { col, getDb, voidAwareStamp } from '../db.js';
import {
    buildCheckpointState, changeInvalidatesCheckpoint, deserializeState, eventTime, itemsSignature,
    resolutionsStillValid, serializeState, STOCK_REPLAY_FORMAT, stockFingerprint
} from '../../utils/stock-replay.js';
import { AppState } from '../../utils/state.js';
import { S } from './session.js';
import { canManageCheckpoint, docIdOf, HISTORY_COLLECTIONS, isPermissionDenied } from './records.js';
import {
    FIRST_SNAPSHOT_CACHED_WAIT_MS, FIRST_SNAPSHOT_SERVER_WAIT_MS, markDirty, pendingFirstSnapshots,
    unsubscribeFunctions
} from './realtime.js';
import { defaultWindowStart } from '../../utils/history-range.js';
import { LEASE_MAX_WAIT_MS, leaseOwnerUid } from '../../utils/rebuild-lease.js';
import { entryTime } from '../../utils/due-payments.js';
import { currentSources, hasDue, queueExtend } from './history-window.js';
import { dueVisibleToQueries } from './legacy-scan.js';
import { tip } from '../../tip/index.js';
import { checkpointProps } from '../../tip/scenarios/stock-checkpoint.js';
import { FirebaseService } from '../firestore-service.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

export const CHECKPOINT_COLLECTION = 'stockCheckpoints';

export const CHECKPOINT_DOC_ID = 'current';

/** Owner/manager devices fully rebuild a checkpoint older than this (bounds drift from deletes by outdated apps). */
export const FORCED_REBUILD_AGE_MS = 7 * DAY_MS;

/** Roll the checkpoint forward once it is this far behind the window start. */
export const ROLL_FORWARD_SLACK_MS = 7 * DAY_MS;

/** How long a device may hold the rebuild lease. */
export const REBUILD_LEASE_MS = 10 * 60 * 1000;

/** Re-check delay when another device has just built the checkpoint. */
export const FRESH_CHECKPOINT_WAIT_MS = 5000;

/** Edits older than the window start of (now + margin) invalidate (covers roll-forwards by devices near a month boundary). */
export const INVALIDATION_MARGIN_MS = 2 * DAY_MS;

export const ROLL_FORWARD_RETRY_MS = 30000;

/** Retry delay after the full-history read for stock failed. */
export const FULL_LOAD_RETRY_MS = 30000;

/** Max pinned (due-but-not-queryable) bills per collection; listened to in chunks of 30. */
export const PINNED_MAX = 300;

export const PINNED_CHUNK = 30;

/** Stock objects returned while another device rebuilds the checkpoint (not exact yet). */
export const pendingStocks = new WeakSet();

export const invalidationTags = new Set();

export const checkpointRef = () => getDb().collection(col(CHECKPOINT_COLLECTION)).doc(CHECKPOINT_DOC_ID);

/** Parses a checkpoint doc; null if missing, stale (unless allowStale) or incompatible. */
export function parseCheckpoint(data, { allowStale = false } = {}) {
    if (!data || data.formatVersion !== STOCK_REPLAY_FORMAT || (data.stale && !allowStale)) return null;
    if (typeof data.asOf !== 'number' || !Number.isFinite(data.asOf)) return null;
    const state = deserializeState(data.state);
    if (!state || !Array.isArray(data.resolutions)) return null;
    return {
        asOf: data.asOf,
        state,
        resolutions: data.resolutions.map(r => [r?.i ?? null, r?.n ?? '', r?.k]),
        itemsSignature: data.itemsSignature,
        staleCount: data.staleCount || 0,
        builtAt: data.builtAt || 0
    };
}

export const checkpointMatchesItems = (cp, items = AppState.items || []) => {
    if (S.checkpointItemsCheck.items === items && S.checkpointItemsCheck.checkpoint === cp) {
        return S.checkpointItemsCheck.ok;
    }
    const ok = cp.itemsSignature === itemsSignature(items) || resolutionsStillValid(cp.resolutions, items);
    S.checkpointItemsCheck = { items, checkpoint: cp, ok };
    return ok;
};

/** The active checkpoint if it can produce exact stock right now. */
export function usableCheckpoint() {
    const cp = S.activeCheckpoint;
    if (!cp || !S.windowState || S.windowState.liveFrom > cp.asOf) return null;
    return checkpointMatchesItems(cp) ? cp : null;
}

/**
 * Member devices only (#129): the last checkpoint even when it is marked
 * stale, if the loaded window covers it. Its state + the window give stock
 * that misses only the older edits that made it stale, so it is shown as
 * approximate instead of reading all history.
 */
export function approximateCheckpoint() {
    if (!S.windowState || canManageCheckpoint() || !S.checkpointDoc || S.ownStaleWrite) return null;
    if (S.approxCheckpointCache.doc !== S.checkpointDoc) {
        S.approxCheckpointCache = { doc: S.checkpointDoc, cp: parseCheckpoint(S.checkpointDoc, { allowStale: true }) };
    }
    const cp = S.approxCheckpointCache.cp;
    if (!cp || S.windowState.liveFrom > cp.asOf) return null;
    return checkpointMatchesItems(cp) ? cp : null;
}

export function adoptCheckpoint(data) {
    const cp = parseCheckpoint(data);
    if (!cp || !S.windowState || cp.asOf < S.windowState.liveFrom) return false;
    const cur = S.activeCheckpoint;
    if (cur && cur.asOf === cp.asOf && cur.builtAt === cp.builtAt && cur.staleCount === cp.staleCount) return true;
    S.activeCheckpoint = cp;
    AppState.dataVersion = ++S.dataVersion;
    return true;
}

export const knownCheckpointAsOf = () => Math.max(
    S.activeCheckpoint?.asOf || 0,
    S.checkpointDoc && typeof S.checkpointDoc.asOf === 'number' ? S.checkpointDoc.asOf : 0
);

export const invalidationTag = (collKey, oldRec, newRec) =>
    `${collKey}|${docIdOf(oldRec || newRec)}|${stockFingerprint(newRec)}`;

/**
 * Marks the stored checkpoint stale (merge write, fire-and-forget). When the
 * change also falls before the checkpoint this device uses, stock falls back
 * to a full replay until a rebuilt checkpoint is available.
 * @private
 */
export function invalidateCheckpoint(reason, affectsLocal) {
    let write = Promise.resolve();
    try {
        const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
        write = checkpointRef().set({
            stale: true,
            staleCount: fv?.increment ? fv.increment(1) : Date.now(),
            staleAt: Date.now(),
            staleReason: String(reason).slice(0, 200),
            staleBy: AppState.currentUser?.uid || 'unknown'
        }, { merge: true });
        write.catch(e => console.error('Stock checkpoint invalidation failed:', e));
    } catch (e) {
        console.error('Stock checkpoint invalidation failed:', e);
    }
    console.info(`Stock checkpoint invalidated (${reason})`);
    if (affectsLocal && S.activeCheckpoint) {
        S.activeCheckpoint = null;
        AppState.dataVersion = ++S.dataVersion;
        if (S.windowState) markDirty(['stockView'], true);
    }
    // Rebuild once the stale mark has reached the server (otherwise the
    // rebuild's own conflict check would discard it).
    if (canManageCheckpoint()) requestRebuild(write);
}

/** Safety net for changes seen by listeners (other devices, direct writes). */
export function noteObservedChange(c, oldRec, newRec, why) {
    const threshold = knownCheckpointAsOf();
    if (!threshold || !changeInvalidatesCheckpoint(oldRec, newRec, threshold)) return;
    const tag = invalidationTag(c.spec.key, oldRec, newRec);
    if (invalidationTags.has(tag)) return;
    invalidationTags.add(tag);
    const local = !!S.activeCheckpoint && changeInvalidatesCheckpoint(oldRec, newRec, S.activeCheckpoint.asOf);
    invalidateCheckpoint(`${c.spec.key} ${why}`, local);
}

/**
 * Called by FirebaseService write paths for stock-affecting records, after the
 * record write has been issued (writes reach the server in issue order).
 * @private
 */
export function noteStockWrite(collKey, oldRec, newRec, opts = {}) {
    try {
        const threshold = Math.max(knownCheckpointAsOf(), defaultWindowStart(Date.now() + INVALIDATION_MARGIN_MS));
        if (!changeInvalidatesCheckpoint(oldRec, newRec, threshold, opts)) return;
        invalidationTags.add(invalidationTag(collKey, oldRec, newRec));
        const local = !!S.activeCheckpoint && changeInvalidatesCheckpoint(oldRec, newRec, S.activeCheckpoint.asOf, opts);
        // The last checkpoint no longer reflects this device's own edit: no approximate stock from it (#129).
        S.ownStaleWrite = true;
        invalidateCheckpoint(`${collKey} write`, local);
        if (AppState.stockApprox && S.windowState) markDirty(['stockView'], true);
    } catch (e) {
        console.error('Stock checkpoint invalidation check failed:', e);
    }
}

/**
 * Another device is rebuilding the checkpoint: keep the last stock (marked
 * not ready) and re-check when its lease ends or the per-session wait cap
 * (LEASE_MAX_WAIT_MS, local clock, so a skewed or dead lease can't stretch
 * it) runs out, whichever is first; the checkpoint listener re-checks earlier
 * when the rebuilt checkpoint arrives. After the cap, stock falls back to a
 * full-history replay.
 * @private
 */
export function waitForCheckpoint(until) {
    const gen = S.sessionGen;
    if (!S.leaseWaitStartedAt) S.leaseWaitStartedAt = Date.now();
    clearTimeout(S.leaseWaitTimer);
    const remaining = Math.max(LEASE_MAX_WAIT_MS - leaseWaitedMs(), 0);
    const delay = Math.min(Math.max(Number(until) - Date.now(), 0), remaining) + 250;
    S.leaseWaitTimer = setTimeout(() => {
        S.leaseWaitTimer = null;
        if (gen !== S.sessionGen) return;
        AppState.dataVersion = ++S.dataVersion;
        markDirty(['stockView'], true);
    }, delay);
    console.info('Stock checkpoint is being rebuilt on another device; waiting for it instead of reading all history.');
    const stock = { ...(AppState.stock || {}) };
    pendingStocks.add(stock);
    return stock;
}

/** Total time this session has waited for another device's checkpoint rebuild. */
export const leaseWaitedMs = () => (S.leaseWaitStartedAt ? Date.now() - S.leaseWaitStartedAt : 0);

export function requestRebuild(after = Promise.resolve()) {
    if (!S.windowState || !canManageCheckpoint()) return;
    const gen = S.sessionGen;
    Promise.resolve(after).catch(() => {}).then(() => {
        if (gen !== S.sessionGen || !S.windowState) return null;
        return FirebaseService.rebuildStockCheckpoint();
    }).catch(e => console.error('Stock checkpoint rebuild failed:', e));
}

/**
 * An older bill (before `from`) with a payment or write-off at/after `from` that the
 * `paidAt >= from` query does not return (paid by an app version without `paidAt`, #163).
 */
export function paidUnseenSince(rec, from) {
    if (!Number.isFinite(from) || !Array.isArray(rec.payments) || !(eventTime(rec) < from)) return false;
    if (typeof rec.paidAt === 'number' && rec.paidAt >= from) return false;
    return rec.payments.some(p => entryTime(p) >= from);
}

/**
 * Ids of bills that are due but invisible to the dues queries (legacy derived
 * dues); stored in the checkpoint as `pinned`
 * and listened to by id.
 * @private
 */
/**
 * Bills the window and dues queries can't see but a phone needs, by document id:
 * a due only derivable from totals (no `openDue`), or — older bills paid or
 * written off at/after `asOf` by app versions that did not stamp `paidAt` (#163).
 * @param {number} asOf the checkpoint's start (the window starts no later)
 */
export function computePinned(asOf) {
    const ws = S.windowState;
    const pinned = {};
    HISTORY_COLLECTIONS.forEach(spec => {
        if (!spec.dues) return;
        pinned[spec.key] = [];
        const c = ws.colls[spec.key];
        const all = new Map();
        c.extended.forEach((rec, id) => all.set(id, rec));
        [c.live, ...c.dues].forEach(l => l.docs.forEach(rec => all.set(docIdOf(rec), rec)));
        const written = ws.backfillWritten?.[spec.key] || new Set();
        const paid = [];
        all.forEach((rec, docId) => {
            if (rec.date === undefined) return;
            if (hasDue(spec.key, rec) && !dueVisibleToQueries(rec) && !written.has(docId)) {
                pinned[spec.key].push(docId);
            } else if (!hasDue(spec.key, rec) && paidUnseenSince(rec, asOf)) {
                paid.push(docId);
            }
        });
        // Open dues first: over the cap, a settled bill's payment is dropped before a due.
        pinned[spec.key].push(...paid);
        if (pinned[spec.key].length > PINNED_MAX) {
            console.warn(`${pinned[spec.key].length} ${spec.key} bills need pinning (due only derivable from totals, or paid without paidAt); listening to the first ${PINNED_MAX}.`);
            pinned[spec.key] = pinned[spec.key].slice(0, PINNED_MAX);
        }
    });
    return pinned;
}

export const RESOLUTION_TAG = (r) => `${typeof r[0]}\u0000${r[0]}\u0000${r[1]}`;

export function checkpointPayload({ asOf, state, resolutions, items, staleCount, backfill, extra = {} }) {
    return {
        formatVersion: STOCK_REPLAY_FORMAT,
        asOf,
        state: serializeState(state),
        resolutions: resolutions.map(r => ({ i: r[0], n: r[1], k: r[2] })),
        itemsSignature: itemsSignature(items),
        stale: false,
        staleCount,
        builtAt: Date.now(),
        builtBy: AppState.currentUser?.uid || 'unknown',
        rebuildingUntil: 0,
        rebuildingBy: null,
        backfill: backfill || null,
        ...extra
    };
}

export const CHECKPOINT_MAX_BYTES = 900 * 1024;

/**
 * Listens to the checkpoint doc. Resolves after the first server snapshot (or
 * the cache when offline / the server is slow). Later snapshots adopt fresh
 * checkpoints built or rolled forward by other devices; a stale mark leaves
 * the checkpoint in use until a rebuilt one arrives.
 * @private
 */
export function listenCheckpoint(gen) {
    return new Promise(resolve => {
        let ready = false;
        let timer = null;
        const done = () => {
            if (ready) return;
            ready = true;
            clearTimeout(timer);
            resolve();
        };
        pendingFirstSnapshots.push({ resolve: done, reject: done });
        let unsubscribe = () => {};
        try {
            unsubscribe = checkpointRef().onSnapshot({ includeMetadataChanges: true }, snap => {
                if (gen !== S.sessionGen) return;
                S.checkpointDoc = snap.exists ? snap.data() : null;
                if (ready) {
                    if (S.checkpointDoc && !S.checkpointDoc.stale && adoptCheckpoint(S.checkpointDoc)) {
                        markDirty(['stockView'], true);
                    } else if (S.checkpointDoc?.stale && S.activeCheckpoint &&
                        (S.checkpointDoc.staleCount || 0) > S.activeCheckpoint.staleCount) {
                        // Another device changed history before the checkpoint: stop using it
                        // (full replay) until a rebuilt one arrives.
                        S.activeCheckpoint = null;
                        AppState.dataVersion = ++S.dataVersion;
                        markDirty(['stockView'], true);
                        requestRebuild();
                    } else if (S.leaseWaitTimer && !((S.checkpointDoc?.rebuildingUntil || 0) > Date.now())) {
                        // The device we were waiting for gave up its lease: decide again now.
                        clearTimeout(S.leaseWaitTimer);
                        S.leaseWaitTimer = null;
                        AppState.dataVersion = ++S.dataVersion;
                        markDirty(['stockView'], true);
                    }
                    return;
                }
                if (!snap.metadata.fromCache || navigator.onLine === false) {
                    done();
                } else if (!timer) {
                    // A cached checkpoint is safe to start from: later snapshots
                    // adopt a newer one or drop it when marked stale (above).
                    timer = setTimeout(done, snap.exists ? FIRST_SNAPSHOT_CACHED_WAIT_MS : FIRST_SNAPSHOT_SERVER_WAIT_MS);
                }
            }, error => {
                console.error('Stock checkpoint listener error:', error);
                if (S.checkpointDoc === undefined) S.checkpointDoc = null;
                done();
            });
        } catch (e) {
            console.error('Stock checkpoint listener error:', e);
            S.checkpointDoc = null;
            done();
        }
        unsubscribeFunctions.push(unsubscribe);
    });
}

/**
 * Moves the checkpoint to `newAsOf` using the in-memory window data
 * (events with asOf <= t < newAsOf); no extra reads. The transaction only
 * writes if nobody changed/invalidated the checkpoint meanwhile.
 * @private
 */
export async function rollForwardCheckpoint(cp, newAsOf) {
    const ws = S.windowState;
    const gen = S.sessionGen;
    if (!canManageCheckpoint()) return 'not-allowed';
    if (!ws || ws.liveFrom > cp.asOf) return 'uncovered';
    if (HISTORY_COLLECTIONS.some(s => s.stock && !ws.colls[s.key].live.server)) return 'waiting';
    const items = AppState.items || [];
    // Any stock change seen after this point (e.g. another device editing a record in
    // [asOf, newAsOf)) may be missing from the state below: then the payload is discarded.
    const changeGen = S.stockChangeGen;
    const { state, resolutions } = buildCheckpointState(currentSources(), newAsOf, items, { state: cp.state, from: cp.asOf });
    const allResolutions = new Map();
    [...cp.resolutions, ...resolutions].forEach(r => allResolutions.set(RESOLUTION_TAG(r), r));
    const ref = checkpointRef();
    let payload = null;
    let ok;
    try {
        ok = await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (S.stockChangeGen !== changeGen) return 'changed';
            if (!d || d.formatVersion !== STOCK_REPLAY_FORMAT || d.stale || d.asOf !== cp.asOf ||
                (d.staleCount || 0) !== cp.staleCount || (d.builtAt || 0) !== cp.builtAt ||
                (d.rebuildingUntil || 0) > Date.now()) {
                return 'conflict';
            }
            payload = checkpointPayload({
                asOf: newAsOf,
                state,
                resolutions: [...allResolutions.values()],
                items,
                staleCount: cp.staleCount,
                backfill: d.backfill || null,
                extra: { rolledForwardFrom: cp.asOf, pinned: d.pinned || null, fullBuiltAt: d.fullBuiltAt || d.builtAt || 0 }
            });
            if (JSON.stringify(payload).length > CHECKPOINT_MAX_BYTES) return 'too-large';
            tx.set(ref, { ...payload, ...voidAwareStamp() });
            return 'rolled';
        });
    } catch (e) {
        if (isPermissionDenied(e)) return 'not-allowed';
        throw e;
    }
    if (ok !== 'rolled') return ok;
    if (S.stockChangeGen !== changeGen) {
        // A change landed between the check and the commit: the stored state may miss it.
        invalidateCheckpoint('roll-forward raced with a stock change', true);
        return 'changed';
    }
    if (gen === S.sessionGen) adoptCheckpoint(payload);
    console.info(`Stock checkpoint rolled forward to ${new Date(newAsOf).toISOString()}`);
    return 'rolled';
}

/** Lease release after a rebuild that did not build: result → Promise<boolean> (TIP StockCheckpoint). */
export const leaseReleases = new WeakMap();

/** See FirebaseService.rebuildStockCheckpoint(). @private */
export async function rebuildCheckpointNow(gen) {
    if (!canManageCheckpoint()) return { status: 'not-allowed' };
    const db = getDb();
    const ref = checkpointRef();
    const token = `${AppState.currentUser?.uid || 'anon'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    let baseStaleCount = 0;
    let lease;
    try {
        lease = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            const parsed = parseCheckpoint(d);
            const aged = Date.now() - ((d && (d.fullBuiltAt || d.builtAt)) || 0) > FORCED_REBUILD_AGE_MS;
            if (parsed && checkpointMatchesItems(parsed) && !aged) return 'fresh';
            // A lease left by this same user (app reloaded/closed mid-rebuild) is taken over.
            const ownLease = !!AppState.currentUser?.uid && leaseOwnerUid(d?.rebuildingBy) === AppState.currentUser.uid;
            if (d && (d.rebuildingUntil || 0) > Date.now() && !ownLease) return 'leased';
            baseStaleCount = d?.staleCount || 0;
            tx.set(ref, { rebuildingUntil: Date.now() + REBUILD_LEASE_MS, rebuildingBy: token, ...voidAwareStamp() }, { merge: true });
            return 'acquired';
        });
    } catch (e) {
        if (isPermissionDenied(e)) {
            console.warn('Stock checkpoint: not allowed to rebuild (role); using full history.');
            return { status: 'not-allowed' };
        }
        throw e;
    }
    if (lease !== 'acquired') return { status: lease };
    let result = { status: 'failed' };
    try {
        // Always a fresh full server read: in-session copies may be stale.
        await queueExtend(0, true, true);
        const ws = S.windowState;
        if (gen !== S.sessionGen || !ws) return (result = { status: 'cancelled' });
        if (!ws.rawFull || HISTORY_COLLECTIONS.some(s => s.stock && !ws.colls[s.key].live.server)) {
            return (result = { status: 'offline' });
        }
        const asOf = Math.max(defaultWindowStart(Date.now()), ws.liveFrom);
        const backfills = await Promise.all(HISTORY_COLLECTIONS.map(spec => ws.backfills[spec.key] || { ok: true, complete: true, writes: 0 }));
        if (gen !== S.sessionGen) return (result = { status: 'cancelled' });
        if (HISTORY_COLLECTIONS.some((spec, i) => spec.stock && !backfills[i].ok)) return (result = { status: 'backfill-failed' });
        const backfill = {
            complete: backfills.every(b => b.complete),
            writes: backfills.reduce((n, b) => n + b.writes, 0),
            at: Date.now()
        };
        const items = AppState.items || [];
        const { state, resolutions } = buildCheckpointState(currentSources(), asOf, items);
        const now = Date.now();
        const payload = checkpointPayload({
            asOf,
            state,
            resolutions,
            items,
            staleCount: baseStaleCount,
            backfill,
            extra: { pinned: computePinned(asOf), fullBuiltAt: now }
        });
        if (JSON.stringify(payload).length > CHECKPOINT_MAX_BYTES) {
            console.error('Stock checkpoint too large to store; stock keeps using full history.');
            return (result = { status: 'too-large' });
        }
        const committed = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (!d || d.rebuildingBy !== token || (d.staleCount || 0) !== baseStaleCount) return false;
            tx.set(ref, { ...payload, ...voidAwareStamp() });
            return true;
        });
        if (!committed) return (result = { status: 'conflict' });
        if (gen === S.sessionGen && adoptCheckpoint(payload)) markDirty(['stockView'], true);
        console.info(`Stock checkpoint rebuilt as of ${new Date(asOf).toISOString()} (${backfill.writes} backfill writes)`);
        return (result = { status: 'built', asOf, backfill });
    } catch (e) {
        if (isPermissionDenied(e)) {
            console.warn('Stock checkpoint: not allowed to rebuild (role); using full history.');
            return (result = { status: 'not-allowed' });
        }
        throw e;
    } finally {
        if (result.status !== 'built') {
            leaseReleases.set(result, db.runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (snap.exists && snap.data().rebuildingBy === token) {
                    tx.update(ref, { rebuildingUntil: 0, rebuildingBy: null, ...voidAwareStamp() });
                }
            }).then(() => true, () => false));
        }
    }
}

/** FirebaseService methods of stock and its checkpoint; spread into FirebaseService (`this` is FirebaseService). */
export const stockCheckpointMethods = {
    /**
     * Diagnostics: the stock checkpoint in use, if any.
     * @returns {?{asOf: number, builtAt: number, liveFrom: number}}
     */
    getStockCheckpointInfo() {
        const cp = usableCheckpoint();
        return cp ? { asOf: cp.asOf, builtAt: cp.builtAt, liveFrom: S.windowState.liveFrom } : null;
    },

    /**
     * The usable stock checkpoint's running state (read-only; callers clone
     * before replaying), for costing sales without reading older history (#215).
     * @returns {?{asOf: number, state: Object}}
     */
    getStockCheckpointState() {
        const cp = usableCheckpoint();
        return cp ? { asOf: cp.asOf, state: cp.state } : null;
    },

    /**
     * Rebuilds the stock checkpoint from a full read of all history (one device
     * at a time via the `rebuildingUntil` lease). Also backfills `timestamp` /
     * due fields into legacy documents so window and dues queries see them.
     * @returns {Promise<{status: string}>} built | fresh | leased | offline | conflict | ...
     */
    rebuildStockCheckpoint() {
        if (!S.windowState) return Promise.resolve({ status: 'inactive' });
        if (!canManageCheckpoint()) return Promise.resolve({ status: 'not-allowed' });
        if (S.rebuildPromise) {
            S.rebuildRequestedAgain = true;
            return S.rebuildPromise;
        }
        S.rebuildAttempted = true;
        const gen = S.sessionGen;
        const run = tip.start('StockCheckpoint');
        const p = rebuildCheckpointNow(gen);
        S.rebuildPromise = p;
        p.then(res => Promise.resolve(leaseReleases.get(res) ?? null).then(released => run.complete(checkpointProps(res, released))),
            () => run.complete(checkpointProps(null)));
        const done = () => {
            if (gen !== S.sessionGen || S.rebuildPromise !== p) return;
            S.rebuildPromise = null;
            if (S.rebuildRequestedAgain) {
                S.rebuildRequestedAgain = false;
                requestRebuild();
            }
        };
        p.then(done, done);
        return p;
    },

    /**
     * Startup maintenance: request a rebuild when no checkpoint is usable, or
     * roll the checkpoint forward (from data already in memory, no extra reads)
     * when it lags the window start by more than a week.
     * @returns {Promise<string>}
     */
    async maintainStockCheckpoint(attempt = 0) {
        if (!S.windowState) return 'inactive';
        const cp = usableCheckpoint();
        // Without a usable checkpoint calculateStock() loads full history and then requests the rebuild.
        if (!cp) return 'rebuild';
        if (!canManageCheckpoint()) return 'not-allowed';
        const d = S.checkpointDoc || {};
        if (Date.now() - (d.fullBuiltAt || d.builtAt || 0) > FORCED_REBUILD_AGE_MS) {
            // Deletes by outdated apps can't be detected: bound the drift with a weekly full rebuild.
            requestRebuild();
            return 'rebuild-aged';
        }
        const W = defaultWindowStart(Date.now());
        if (cp.asOf >= W - ROLL_FORWARD_SLACK_MS) return 'current';
        const result = await rollForwardCheckpoint(cp, W);
        if ((result === 'waiting' || result === 'changed') && attempt < 5) {
            const gen = S.sessionGen;
            setTimeout(() => {
                if (gen === S.sessionGen) this.maintainStockCheckpoint(attempt + 1).catch(e => console.error('Stock checkpoint roll-forward failed:', e));
            }, ROLL_FORWARD_RETRY_MS);
        }
        return result;
    }
};
