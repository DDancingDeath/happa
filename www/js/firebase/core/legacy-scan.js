/**
 * @fileoverview Legacy timestamp scan and backfill: documents saved by old app versions without a
 * numeric `timestamp` (or `openDue`) are invisible to the window and dues queries; owner and
 * manager phones find them in the background after the first screen and write the missing
 * fields (stockCheckpoints/legacyScan records how far each collection got). Moved verbatim out
 * of firestore-service.js (docs/architecture.md, phase 5, #69). Also the owner's one-time due
 * backfill (DUE-BACKFILL, #126): a check, then the bills whose due is not stored once in payment.due.
 * @module firebase/core/legacy-scan
 */

import { CLIENT_VERSION, col, getDb, serverCreatedAt } from '../db.js';
import { S } from './session.js';
import { defaultWindowStart } from '../../utils/history-range.js';
import { eventTime } from '../../utils/stock-replay.js';
import { findRecord, hasDue, liveIdSet, noteLocalRecordWrite, publishCollection, RETRY_LIMIT_BASE } from './history-window.js';
import { HISTORY_COLLECTIONS, historySpecReadable, mapDoc } from './records.js';
import { getWithRetry } from './reads.js';
import { markDirty } from './realtime.js';
import { backgroundReadsAllowed } from '../firestore-meter.js';
import { markStartup } from '../../utils/startup-timings.js';
import { LEGACY_SCAN_DELAY_MS, whenIdle } from '../../utils/background-tasks.js';
import { FirebaseService } from '../firestore-service.js';
import { CHECKPOINT_COLLECTION } from './stock-checkpoint.js';
import { dueBackfillChanges, dueBackfillFields } from '../repos/bill-due.js';
import { billEditsRef } from '../repos/bill-fields.js';
import { editRecord, nextEditNumber } from '../../utils/bill-edits.js';
import { t } from '../../i18n/index.js';
import { AppState } from '../../utils/state.js';

export const LEGACY_SCAN_DOC_ID = 'legacyScan';

// Its own copy: a constant read at load can't come from stock-checkpoint.js, which imports this module.
const DAY_MS = 24 * 60 * 60 * 1000;
/** Keep scanning a collection for timestamp-less docs this long after old clients last wrote one. */
export const LEGACY_RESCAN_MS = 14 * DAY_MS;

/** ...but at most once per this interval across all devices. */
export const LEGACY_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Bump when the legacy backfill learns a new field (2: openDue). */
export const LEGACY_SCAN_VERSION = 2;

export const BACKFILL_MAX_WRITES = 5000;

export const BACKFILL_BATCH_SIZE = 400;

/** Whether the dues listener (openDue == true, numeric timestamp) returns this bill. */
export const dueVisibleToQueries = (rec) => rec.openDue === true && typeof rec.timestamp === 'number';

export const legacyScanRef = () => getDb().collection(col(CHECKPOINT_COLLECTION)).doc(LEGACY_SCAN_DOC_ID);

/** Whether a collection may still hold documents without a numeric timestamp (old clients). */
export const needsLegacyScan = (key) => {
    const e = S.legacyScanDoc?.[key];
    if (!e || e.v !== LEGACY_SCAN_VERSION || e.complete !== true) return true;
    // While outdated apps may still be writing, one device re-scans every few hours; its
    // backfill makes those documents visible to every device's window listener.
    return Date.now() - (e.foundAt || 0) < LEGACY_RESCAN_MS && Date.now() - (e.at || 0) > LEGACY_SCAN_INTERVAL_MS;
};

/**
 * Gives documents without a numeric `timestamp` (legacy data, old app versions)
 * the time the app already uses for them, so the window queries see them, and
 * records the outcome in stockCheckpoints/legacyScan. Records at/after the
 * loaded window start are always written (uncapped); older ones are capped per
 * pass and finished on later scans. Any approved user may do this.
 * @param {Object} spec collection spec
 * @param {Array} docs Firestore document snapshots from an unfiltered server read
 * @returns {Promise<{ok: boolean, complete: boolean, writes: number}>} ok = all recent ones written
 * @private
 */
export function backfillLegacyTimestamps(spec, docs) {
    // Never rejects (callers keep the promise around).
    return backfillLegacyTimestampsNow(spec, docs, S.sessionGen).catch(e => {
        console.warn(`${spec.label}: timestamp backfill failed:`, e?.code || e);
        return { ok: false, complete: false, writes: 0 };
    });
}

export async function backfillLegacyTimestampsNow(spec, docs, gen) {
    const db = getDb();
    const from = Math.min(S.windowState?.liveFrom ?? Infinity, defaultWindowStart(Date.now()));
    const critical = [];
    const optional = [];
    let lastLegacyEvent = 0;
    docs.forEach(doc => {
        const data = doc.data();
        if (data.date === undefined) return;
        const update = {};
        let isCritical = false;
        if (typeof data.timestamp !== 'number') {
            const t = eventTime(data);
            if (spec.stock || t !== Number.MAX_SAFE_INTEGER) {
                update.timestamp = t;
                isCritical = t >= from;
                if (t !== Number.MAX_SAFE_INTEGER && t <= Date.now()) lastLegacyEvent = Math.max(lastLegacyEvent, t);
            }
        }
        if (spec.dues) {
            const due = hasDue(spec.key, data);
            if (data.openDue !== due) {
                update.openDue = due;
                if (due) isCritical = true;
            }
        }
        if (!Object.keys(update).length) return;
        if (spec.stock) update.clientVersion = CLIENT_VERSION;
        (isCritical ? critical : optional).push({ id: doc.id, ref: db.collection(col(spec.key)).doc(doc.id), update });
    });
    const written = new Set();
    const commit = async (writes) => {
        for (let i = 0; i < writes.length; i += BACKFILL_BATCH_SIZE) {
            const chunk = writes.slice(i, i + BACKFILL_BATCH_SIZE);
            const batch = db.batch();
            chunk.forEach(w => batch.update(w.ref, w.update));
            try {
                await batch.commit();
                chunk.forEach(w => written.add(w.id));
            } catch (e) {
                // e.g. a security-rules access-call limit on large batches: retry one by one.
                console.warn('Backfill batch failed, retrying documents individually:', e?.code || e);
                for (const w of chunk) {
                    await w.ref.update(w.update).then(() => written.add(w.id), err => console.warn('Backfill write failed:', err?.code || err));
                }
            }
        }
    };
    let ok = true;
    let complete = true;
    try {
        await commit(critical);
    } catch (e) {
        console.error(`${spec.label}: timestamp backfill failed:`, e);
        ok = false;
        complete = false;
    }
    const allowed = optional.slice(0, BACKFILL_MAX_WRITES);
    if (allowed.length < optional.length) complete = false;
    try {
        await commit(allowed);
    } catch (e) {
        console.error(`${spec.label}: timestamp backfill (older records) failed:`, e);
        complete = false;
    }
    if (S.windowState) (S.windowState.backfillWritten ||= {})[spec.key] = written;
    if (critical.some(w => !written.has(w.id))) ok = false;
    if (gen !== S.sessionGen) return { ok, complete, writes: critical.length + allowed.length };
    // The legacyScan doc is read in parallel with startup; merge with what it holds.
    await S.legacyScanReadPromise;
    if (gen !== S.sessionGen) return { ok, complete, writes: critical.length + allowed.length };
    const prev = S.legacyScanDoc?.[spec.key] || {};
    // foundAt ~ when an outdated app last wrote such a document (its event time).
    const entry = { v: LEGACY_SCAN_VERSION, complete, foundAt: Math.max(prev.foundAt || 0, lastLegacyEvent), at: Date.now() };
    S.legacyScanDoc = { ...(S.legacyScanDoc || {}), [spec.key]: entry };
    legacyScanRef().set({ [spec.key]: entry }, { merge: true })
        .catch(e => console.warn('Saving legacy scan state failed:', e?.code || e));
    if (critical.length || allowed.length) console.info(`${spec.label}: backfilled timestamp on ${critical.length + allowed.length} documents`);
    return { ok, complete, writes: critical.length + allowed.length };
}

/**
 * Startup safety net while a collection may hold documents without a numeric
 * timestamp: one unfiltered read of it, merging the recent ones (they are
 * invisible to the window query) and backfilling them.
 * @private
 */
export async function scanLegacyCollections(ws, gen) {
    for (const spec of HISTORY_COLLECTIONS) {
        if (spec.timestamped || !needsLegacyScan(spec.key) || !historySpecReadable(spec)) continue;
        const db = getDb();
        let snap;
        try {
            snap = await getWithRetry(a => (a ? db.collection(col(spec.key)).limit(RETRY_LIMIT_BASE + a) : db.collection(col(spec.key))), `${spec.label} legacy scan`);
        } catch (e) {
            console.warn(`${spec.label}: legacy timestamp scan failed:`, e?.code || e);
            continue;
        }
        if (gen !== S.sessionGen || S.windowState !== ws) return;
        const c = ws.colls[spec.key];
        const live = liveIdSet(c);
        let added = 0;
        snap.docs.forEach(doc => {
            const data = doc.data();
            if (data.date !== undefined && !live.has(doc.id) &&
                ((typeof data.timestamp !== 'number' && eventTime(data) >= ws.liveFrom) ||
                 (spec.dues && hasDue(spec.key, data) && !dueVisibleToQueries(data)))) {
                c.extended.set(doc.id, mapDoc(doc));
                added++;
            }
        });
        publishCollection(c);
        // Runs after the first screen now (#13): refresh what it added.
        if (added) markDirty(spec.views, !!spec.stock);
        if (!snap.metadata?.fromCache) ws.backfills[spec.key] = backfillLegacyTimestamps(spec, snap.docs);
    }
}

/**
 * Schedules scanLegacyCollections() for when the device is idle after the
 * first screen, instead of holding startup on it (#13). Owner/manager devices
 * only, at most once per session.
 * @private
 */
export function scheduleLegacyScan(ws, gen) {
    S.legacyScanJob?.cancel();
    let started = null;
    const run = () => {
        if (!started) {
            cancel();
            started = S.legacyScanReadPromise
                // settings/app holds the kill switch; skipped under the read guards (#159), the next app open tries again
                .then(() => FirebaseService.loadAppSettings().catch(() => null))
                .then(() => (gen === S.sessionGen && S.windowState === ws && backgroundReadsAllowed() ? scanLegacyCollections(ws, gen) : undefined))
                .catch(e => console.warn('Legacy timestamp scan failed:', e?.code || e))
                .then(() => markStartup('legacy-scan'));
        }
        return started;
    };
    const cancel = whenIdle(run, { minDelayMs: LEGACY_SCAN_DELAY_MS });
    S.legacyScanJob = { run, cancel };
}

/** FirebaseService methods of the legacy scan; spread into FirebaseService (`this` is FirebaseService). */
export const legacyScanMethods = {
    /**
     * Runs the background legacy-timestamp scan now if one is scheduled
     * (tests / Diagnostics); resolves when it is done.
     * @returns {Promise<void>}
     */
    runLegacyScanNow() {
        return S.legacyScanJob ? S.legacyScanJob.run() : Promise.resolve();
    }
};

/** DUE-BACKFILL: its entry in stockCheckpoints/legacyScan ({v, at, checked, written, failed, complete, byUserId}). */
export const DUE_BACKFILL_KEY = 'dueFields';
export const DUE_BACKFILL_VERSION = 1;

const ownerOnly = () => {
    if (AppState.userRole !== 'owner') throw Object.assign(new Error('Only the owner can do this'), { code: 'owner-only' });
};

/**
 * One DUE-BACKFILL write, in its own transaction (a bill update with its edit record costs the
 * rules about 60 expressions and 5 document reads; several bills in one request would pass their
 * limits): re-reads the bill and, when it still needs it (dueBackfillFields, from this fresh copy),
 * writes payment.due with clientVersion and its edit record (#121: before/after of payment, the
 * owner, a fixed reason), so what was replaced stays on the bill.
 * @returns {Promise<?Object>} the bill as stored now when written; null when gone or not needed
 */
async function writeDueBill(collKey, id) {
    const db = getDb();
    const ref = db.collection(col(collKey)).doc(String(id));
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const fresh = snap.data() || {};
        const need = dueBackfillFields(fresh);
        if (!need?.fields) return null;
        const n = nextEditNumber(fresh);
        const fields = { ...need.fields, clientVersion: CLIENT_VERSION, editCount: n };
        tx.update(ref, fields);
        tx.set(billEditsRef(ref).doc(String(n)), editRecord({
            n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName,
            reason: t('ui.edits.due_backfill_reason'),
            changes: dueBackfillChanges(fresh, fields)
        }));
        return { id: String(id), ...fresh, ...fields };
    });
}
/** FirebaseService methods of the owner's due backfill (#126); spread into FirebaseService. */
export const dueBackfillMethods = {
    /**
     * DUE-BACKFILL check (a dry run): reads every bill from the server once (one read per bill)
     * and lists the ones whose due is not stored once as a number in payment.due
     * (dueBackfillFields). Writes nothing. Owner only; needs a connection.
     * @returns {Promise<{checked: number, todo: Array<{collKey: string, id: string, reason: string}>, byReason: Object<string, number>, changes: Array<{collKey: string, id: string}>}>}
     *   changes: bills the backfill would not write because a figure would move (expected: none)
     */
    async checkDueFields() {
        ownerOnly();
        const db = getDb();
        const out = { checked: 0, todo: [], byReason: { missing: 0, notNumber: 0 }, changes: [] };
        const docs = [];
        for (const spec of HISTORY_COLLECTIONS.filter(s => s.dues)) {
            const snap = await getWithRetry(a => (a ? db.collection(col(spec.key)).limit(RETRY_LIMIT_BASE + a) : db.collection(col(spec.key))), `${spec.label} due check`);
            if (snap.metadata?.fromCache) throw Object.assign(new Error('Offline: bills read from this phone only'), { code: 'unavailable' });
            snap.docs.forEach(doc => {
                docs.push(doc.id);
                const need = dueBackfillFields(doc.data());
                if (!need) return;
                if (!need.fields) out.changes.push({ collKey: spec.key, id: doc.id });
                else out.todo.push({ collKey: spec.key, id: doc.id, reason: need.reason });
            });
        }
        out.checked = docs.length;
        Object.keys(out.byReason).forEach(r => { out.byReason[r] = out.todo.filter(t => t.reason === r).length; });
        return out;
    },

    /**
     * DUE-BACKFILL: writes the bills a check listed, one transaction each (writeDueBill): re-read and
     * written only if it still needs it, from that fresh copy, so a payment recorded meanwhile is never
     * undone; a second run writes nothing; each write has its edit record. A bill that fails is counted
     * and the others go on. Records the outcome in stockCheckpoints/legacyScan. Owner only;
     * needs a connection.
     * @param {Array<{collKey: string, id: string}>} todo - checkDueFields().todo
     * @param {number} checked - checkDueFields().checked
     * @returns {Promise<{written: number, failed: number}>}
     */
    async backfillDueFields(todo, checked = 0) {
        ownerOnly();
        const written = [];
        const failed = [];
        for (const { collKey, id } of todo || []) {
            try {
                const record = await writeDueBill(collKey, id);
                if (!record) continue;
                written.push(id);
                if (findRecord(collKey, id)) noteLocalRecordWrite(collKey, id, record);
            } catch (e) {
                console.warn(`Due backfill: ${collKey}/${id} not written:`, e?.code || e);
                failed.push(id);
            }
        }
        const entry = { v: DUE_BACKFILL_VERSION, at: Date.now(), checked, written: written.length, failed: failed.length, complete: !failed.length, byUserId: AppState.currentUser?.uid || null };
        S.legacyScanDoc = { ...(S.legacyScanDoc || {}), [DUE_BACKFILL_KEY]: entry };
        // Not awaited: offline it is queued and would hold the run open until the phone is back online
        legacyScanRef().set({ [DUE_BACKFILL_KEY]: entry }, { merge: true })
            .catch(e => console.warn('Saving due backfill state failed:', e?.code || e));
        return { written: written.length, failed: failed.length };
    },

    /** The last DUE-BACKFILL run as recorded in stockCheckpoints/legacyScan (no read), or null. */
    dueBackfillState() {
        return S.legacyScanDoc?.[DUE_BACKFILL_KEY] || null;
    }
};
