/**
 * @fileoverview Firebase Firestore Service Module
 * Provides all database operations for the Aadhat Management App.
 * Handles CRUD operations for items, bills, sales, expenses, stock, and cash management.
 * @module firebase/firestore-service
 */

// -------------------- FIREBASE DATA OPERATIONS --------------------

import { AppState } from '../utils/state.js';
import { isActiveBill, isActiveExpense, isOnlineExpense } from '../utils/money.js';
import {
    billEditChanges, cleanReason, editCountOf, editRecord, hasEditChanges, nextEditNumber, voidBlocker
} from '../utils/bill-edits.js';
import { localISODaysAgo, parseAnyBillDate } from '../utils/dates.js';
import { defaultWindowStart } from '../utils/history-range.js';
import { memberWindowStart } from '../utils/rebuild-lease.js';
import { LEGACY_SCAN_DELAY_MS, shouldScheduleLegacyScan, whenIdle } from '../utils/background-tasks.js';
import {
    dayDocTotals, expenseCollectionFor, PERSONAL_DAYS_COLLECTION, personalDayFixes, personalDayKey,
    personalDaysFromRows, personalOnlineFromRows
} from '../utils/personal-expenses.js';
import { SyncStatus } from '../ui/sync-status.js';
import { CLIENT_VERSION, col, getDb, serverCreatedAt } from './db.js';
import { itemMethods } from './repos/items.js';
import { billStatsMethods } from './repos/bill-stats.js';
import { collectionAdminMethods } from './repos/collection-admin.js';
import { tipMethods } from './repos/tip-health.js';
import { anomalyMethods } from './repos/anomalies.js';
import { userProfileMethods } from './repos/user-profiles.js';
import { notificationMethods } from './repos/notifications.js';
import { cashDayMethods } from './repos/cash-days.js';
import { worthAccountMethods } from './repos/worth-accounts.js';
import { reminderMethods } from './repos/reminders.js';
import { forgetAppSettings, settingsMethods } from './repos/settings.js';
import { getWithRetry } from './core/reads.js';
import { S } from './core/session.js';
import {
    applySnapshot, defaultMapDoc, FIRST_SNAPSHOT_CACHED_WAIT_MS, FIRST_SNAPSHOT_SERVER_WAIT_MS,
    listenerStartup, markDirty, pendingFirstSnapshots, pendingViews, runView, unsubscribeFunctions
} from './core/realtime.js';
import {
    byDateDesc, canManageCheckpoint, docIdOf, docIds, HISTORY_COLLECTIONS, HISTORY_SPEC, historySpecReadable,
    isPermissionDenied, LOADED_PAYMENT, mapDoc, paymentSignature, stableJson
} from './core/records.js';
import { EXPENSE_STORE_WAIT_MS, LOCAL_STORE_WAIT_MS, settleWrite, whenStoredLocally } from './core/write-settle.js';
import { getQuotaStatus, installFirestoreMeter } from './firestore-meter.js';
import { emit, ITEM_FREQUENCY_CHANGED } from '../utils/events.js';
import { t } from '../i18n/index.js';
import { tip } from '../tip/index.js';
import { track } from '../services/usage.js';
import { billSaveProps } from '../tip/scenarios/bill-save.js';
import {
    createCollState, ensureTimestamp, findInSources, findRecord, forgetRecord, historyWindowMethods,
    liveIdSet, locateExpense, noteLocalRecordWrite, noteMonthWrite, pendingExtends, prepareStockRecord,
    publishCollection, refetchAfterDueRemoval, replaceLiveRecord, startCreate, voidedOf,
    warnDuplicateBillNumbers
} from './core/history-window.js';
import { legacyScanMethods, legacyScanRef, scheduleLegacyScan } from './core/legacy-scan.js';
import {
    adoptCheckpoint, invalidationTags, listenCheckpoint, noteObservedChange, noteStockWrite, parseCheckpoint,
    PINNED_CHUNK, PINNED_MAX, stockCheckpointMethods
} from './core/stock-checkpoint.js';
import { stockMethods } from './core/stock.js';

// Count reads and catch quota errors for every Firestore call in the app (#194).
if (typeof firebase !== 'undefined' && firebase.firestore) {
    try {
        installFirestoreMeter(firebase.firestore);
    } catch (e) {
        console.warn('Read counter not installed:', e);
    }
}

const personalDayOf = (rec) => rec?.day || personalDayKey(rec?.date);

/**
 * One key of personalExpenseDays/{day}: the expense's amount, or removed (amount null), and
 * its online flag (EXP-MODE, #118: set when paid online, else removed).
 * `last` names the key for firestore.rules (validPersonalDay).
 */
function personalDayWrite(day, id, amount, online = false) {
    const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
    const remove = typeof fv?.delete === 'function' ? fv.delete() : undefined;
    const value = amount === null ? remove : amount;
    const flag = amount !== null && online ? true : remove;
    return [getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), { amounts: { [id]: value }, online: { [id]: flag }, last: id }, { merge: true }];
}

/** Adds the day-doc key of a personal expense write to a batch: set to its amount, or removed (#98). */
function addPersonalDayWrites(batch, id, before, after) {
    const from = before ? personalDayOf(before) : null;
    const to = after ? personalDayOf(after) : null;
    if (from && from !== to) batch.set(...personalDayWrite(from, String(id), null));
    if (to && !(from === to && Number(before.amount) === Number(after.amount) && isOnlineExpense(before) === isOnlineExpense(after))) {
        batch.set(...personalDayWrite(to, String(id), Number(after.amount) || 0, isOnlineExpense(after)));
    }
}

/** Personal expense day totals read on this device: { [YYYY-MM-DD]: {total, count, at} }. */
const personalDayCache = new Map();

/** A bill's edit records (#121): a sub-collection, so the bill's own (dev_-prefixed) collection sets the environment. */
const BILL_EDITS = 'edits';
const billEditsRef = (billRef) => billRef.collection(BILL_EDITS);

/** Bill fields that Outstanding / other devices change after a bill is created. */
const BILL_MONEY_FIELDS = ['payment', 'payments', 'dueAmount', 'cashPayment', 'onlinePayment', 'openDue', 'cleared'];

const withServerCreatedAt = (record) => ({ ...record, createdAt: serverCreatedAt() });

/** Keeps the bill's stored `createdAt` on an overwrite (the rules refuse a change). */
function keepStoredCreatedAt(record, stored) {
    if (stored && stored.createdAt !== undefined && stored.createdAt !== null) record.createdAt = stored.createdAt;
    else delete record.createdAt;
}

/** Keeps the bill's stored edit count on an overwrite (#121: it only moves with an edit record). */
function keepEditCount(record, stored) {
    if (editCountOf(stored)) record.editCount = editCountOf(stored);
    else delete record.editCount;
}

/**
 * A retried new bill that changes what its unconfirmed first save stored is an edit (#121):
 * its record goes into the same transaction, with a fixed reason in the app language.
 * Sets `target.editCount`. @private
 */
function logRetryEdit(tx, ref, server, after, target) {
    const changes = billEditChanges(server, after);
    if (!hasEditChanges(changes)) return;
    const n = nextEditNumber(server);
    target.editCount = n;
    tx.set(billEditsRef(ref).doc(String(n)), editRecord({
        n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName,
        reason: t('ui.edits.retry_reason'), changes
    }));
}
/** Payment signature of the last new-bill write this device sent, by `${collKey}/${id}` (#70). */
const sentBillPaymentSigs = new Map();
/** Bills whose retry kept the server's money fields (a payment was recorded meanwhile). */
const keptServerPaymentBills = new WeakSet();
/** Bills that were stored on this phone while offline and are waiting to sync. */
const savedOnPhoneBills = new WeakSet();
/** Bills whose write this phone had not confirmed storing when the save gave up waiting. */
const unconfirmedBills = new WeakSet();
/** `${collKey}/${id}` of new bills whose first set() hasn't settled yet. */
const pendingFirstSaves = new Set();
/** Of those, the ones a retry has saved meanwhile. */
const retriedBillSaves = new Set();
/** First set() of new bills not yet confirmed on this phone, by key: { sent, json } (#153). */
const unconfirmedFirstSaves = new Map();

/** A bill's content as compared between save attempts (createdAt is set by the server). */
const billAttemptJson = (record) => {
    const rest = { ...record };
    delete rest.createdAt;
    return stableJson(rest);
};

/**
 * An offline re-save of a bill whose first attempt was not confirmed (#153): a
 * transaction needs the server, so instead check that first write on this phone.
 * 'stored' - stored, same content: nothing to write; 'resend' - this phone
 * refused it: save it again as new; 'unconfirmed' - still unknown, or changed
 * since (no write: re-sending could clash with the queued first write).
 * @private
 */
async function offlineRetryOutcome(key, record) {
    const first = unconfirmedFirstSaves.get(key);
    if (!first) return 'unconfirmed';
    const stored = await whenStoredLocally(first.sent, LOCAL_STORE_WAIT_MS);
    if (stored === false) return 'resend';
    if (stored === true && first.json === billAttemptJson(record)) return 'stored';
    return 'unconfirmed';
}

/**
 * Creates a bill (or overwrites by id) and keeps memory/checkpoint in step.
 * With `retry`, the same new bill (same id) is saved again after a failed or
 * timed-out attempt: see retryBillSave. @private
 */
async function saveBill(collKey, record, label, { retry = false } = {}) {
    if (!record.userId && AppState.currentUser) record.userId = AppState.currentUser.uid;
    if (!record.userName && AppState.userName) record.userName = AppState.userName;
    const previous = record.id ? findRecord(collKey, record.id) : null;
    prepareStockRecord(collKey, record, !previous);
    if (!record.id) record.id = getDb().collection(col(collKey)).doc().id;
    const docRef = getDb().collection(col(collKey)).doc(String(record.id));
    const key = `${collKey}/${record.id}`;
    const run = startBillSaveRun(collKey, record, retry);
    let resend = false;
    if (retry && typeof navigator !== 'undefined' && navigator.onLine === false) {
        const outcome = await offlineRetryOutcome(key, record);
        if (outcome !== 'resend') {
            if (outcome === 'stored') {
                unconfirmedFirstSaves.delete(key);
                savedOnPhoneBills.add(record);
            } else {
                unconfirmedBills.add(record);
            }
            run.complete();
            return record;
        }
        resend = true;
    }
    if (retry && !resend) {
        try {
            const saved = await retryBillSave(collKey, record, docRef, previous, key);
            unconfirmedFirstSaves.delete(key);
            run.complete();
            return saved;
        } catch (error) {
            run.completeAndFail('save_error', { code: String(error?.code || 'unknown').slice(0, 40) });
            throw error;
        }
    }
    sentBillPaymentSigs.set(key, paymentSignature(record));
    let payload = record;
    if (previous && !resend) {
        if (record.createdAt === undefined && previous.createdAt !== undefined) record.createdAt = previous.createdAt;
    } else {
        // Local estimate until the listener brings the server time
        record.createdAt = Date.now();
        payload = withServerCreatedAt(record);
    }
    pendingFirstSaves.add(key);
    const sent = docRef.set(payload);
    SyncStatus.trackWrite(docRef.path, sent);
    unconfirmedFirstSaves.set(key, { sent, json: billAttemptJson(record) });
    // A #70 retry may already have created this bill; this first attempt then arrives later as an
    // update that changes createdAt, which the rules refuse for non-owners (#87). Nothing is lost.
    const settled = () => {
        pendingFirstSaves.delete(key);
        retriedBillSaves.delete(key);
    };
    const write = Promise.resolve(sent).then(settled, (error) => {
        const superseded = retriedBillSaves.has(key) && isPermissionDenied(error);
        settled();
        if (superseded) {
            // Expected (a retry already saved this bill): not a misuse signal (#124)
            if (error && typeof error === 'object') error.aadhatExpected = true;
            return { supersededByRetry: true };
        }
        throw error;
    });
    // Server acknowledgement (may come after settleWrite released the UI)
    write.then((r) => run.complete(r ? { supersededByRetry: true } : undefined), (error) => run.completeAndFail('write_rejected', { code: String(error?.code || 'unknown').slice(0, 40) }));
    noteStockWrite(collKey, previous, record);
    noteMonthWrite(collKey, previous, record);
    noteLocalRecordWrite(collKey, String(record.id), record);
    const { pending, stored } = await settleWrite(write, label);
    if (!stored) {
        unconfirmedBills.add(record);
        return record;
    }
    unconfirmedFirstSaves.delete(key);
    if (pending && typeof navigator !== 'undefined' && navigator.onLine === false) savedOnPhoneBills.add(record);
    return record;
}

/** TIP BillSave run (#217) for a new bill; never throws. @private */
function startBillSaveRun(collKey, record, retry) {
    if (!retry) track(`bill.save.${collKey}`);
    try {
        return tip.start('BillSave', {
            flags: { retry: !!retry, offline: typeof navigator !== 'undefined' && navigator.onLine === false },
            props: billSaveProps(collKey, record, Date.now())
        });
    } catch (_) {
        return { complete() {}, completeAndFail() {} };
    }
}

/**
 * Retry of a new bill whose earlier attempt may already have reached the server
 * (#70). In a transaction: missing → create; identical → nothing to write; if a
 * payment was recorded on the server since (payments[] or a payment state other
 * than the one this device sent) → save the bill but keep the server's money
 * fields, so due / cash / payments[] stay consistent; otherwise overwrite.
 * Needs a connection (transaction). On "kept", `record` is updated in place with
 * the server's money fields. @private
 */
async function retryBillSave(collKey, record, ref, previous, key) {
    const sentSig = sentBillPaymentSigs.get(key) ?? paymentSignature(record);
    let kept = false;
    let wrote = false;
    let serverMoney = null;
    await getDb().runTransaction(async tx => {
        kept = false;
        wrote = true;
        serverMoney = null;
        const snap = await tx.get(ref);
        if (!snap.exists) {
            if (record.createdAt === undefined) record.createdAt = Date.now();
            tx.set(ref, withServerCreatedAt(record));
            return;
        }
        const server = snap.data() || {};
        // Voided meanwhile on another phone (#75): never written over.
        if (!isActiveBill(server)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
        keepStoredCreatedAt(record, server);
        keepEditCount(record, server);
        const serverPayments = Array.isArray(server.payments) ? server.payments : [];
        if (serverPayments.length > 0 || paymentSignature(server) !== sentSig) {
            const nonMoney = { ...record };
            BILL_MONEY_FIELDS.forEach(k => delete nonMoney[k]);
            logRetryEdit(tx, ref, server, { ...server, ...nonMoney }, nonMoney);
            if (nonMoney.editCount !== undefined) record.editCount = nonMoney.editCount;
            tx.set(ref, nonMoney, { merge: true });
            serverMoney = server;
            kept = true;
            return;
        }
        wrote = !Object.keys(record).every(k => stableJson(server[k]) === stableJson(record[k]));
        if (wrote) {
            logRetryEdit(tx, ref, server, record, record);
            tx.set(ref, record);
        }
    });
    if (pendingFirstSaves.has(key)) retriedBillSaves.add(key);
    if (kept) {
        BILL_MONEY_FIELDS.forEach(k => {
            if (k in serverMoney) record[k] = serverMoney[k];
            else delete record[k];
        });
        keptServerPaymentBills.add(record);
    }
    sentBillPaymentSigs.set(key, paymentSignature(record));
    // An identical retry wrote nothing: stock and the checkpoint are unchanged
    if (wrote) {
        noteStockWrite(collKey, previous, record, { oldUnknown: true });
        noteMonthWrite(collKey, previous, record);
    }
    noteLocalRecordWrite(collKey, String(record.id), record);
    return record;
}

/**
 * Overwrites an existing bill only if its payments did not change on the
 * server since this device loaded it (a full set() would otherwise erase a
 * payment recorded elsewhere). Runs in a transaction, so it needs a connection.
 * A change to a recorded field (bill-edits EDIT_FIELDS or the items) also
 * writes its edit record `edits/{n}` in the same transaction (#121): the
 * changed fields before/after, the editor and `reason` (required then).
 * A voided bill is never changed (#75).
 * @private
 */
async function updateBillChecked(collKey, record, { reason = null } = {}) {
    if (!record.id) throw new Error('Bill ID is required for update');
    const previous = findRecord(collKey, record.id);
    prepareStockRecord(collKey, record, false);
    const base = record[LOADED_PAYMENT] ?? previous?.[LOADED_PAYMENT] ?? null;
    const ref = getDb().collection(col(collKey)).doc(String(record.id));
    const why = cleanReason(reason);
    await getDb().runTransaction(async tx => {
        const snap = await tx.get(ref);
        const stored = snap.exists ? snap.data() : null;
        if (stored && !isActiveBill(stored)) {
            throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
        }
        if (base !== null && (!snap.exists || paymentSignature(stored) !== base)) {
            throw Object.assign(
                new Error('This bill was changed on another device — reopen it and try again'),
                { code: 'conflict' }
            );
        }
        if (stored) keepStoredCreatedAt(record, stored);
        const changes = stored ? billEditChanges(stored, record) : null;
        if (changes && hasEditChanges(changes)) {
            if (!why) throw Object.assign(new Error('A reason is needed to change this bill'), { code: 'reason-required' });
            const n = nextEditNumber(stored);
            record.editCount = n;
            tx.set(ref, record);
            tx.set(billEditsRef(ref).doc(String(n)), editRecord({
                n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName, reason: why, changes
            }));
            return;
        }
        if (stored) keepEditCount(record, stored);
        else delete record.editCount;
        tx.set(ref, record);
    });
    // The server now holds exactly this record: later edits must compare against it.
    record[LOADED_PAYMENT] = paymentSignature(record);
    noteStockWrite(collKey, previous, record, { oldUnknown: true });
    noteMonthWrite(collKey, previous, record);
    noteLocalRecordWrite(collKey, String(record.id), record);
    return record;
}

async function deleteBill(collKey, id) {
    const previous = findRecord(collKey, id);
    const write = getDb().collection(col(collKey)).doc(String(id)).delete();
    noteStockWrite(collKey, previous, null, { oldUnknown: true });
    noteMonthWrite(collKey, previous, null);
    await write;
    forgetRecord(collKey, id);
}

/**
 * Voids a bill (#75): one update in a transaction that sets voided, voidedAt
 * (server time), voidedBy, voidedByName, voidReason and openDue = false. The
 * bill stays stored; from then on it counts in no figure (money.isActiveBill),
 * so stock, month snapshots and the checkpoint are marked as for a delete.
 * Refused (code) when it is already voided ('already-voided') or has payments
 * recorded after it was saved ('has-payments', bill-edits.voidBlocker).
 * Needs a connection.
 * @private
 */
async function voidBillDoc(collKey, bill, reason) {
    const why = cleanReason(reason);
    if (!why) throw Object.assign(new Error('A reason is needed to void a bill'), { code: 'reason-required' });
    const docId = docIdOf(bill);
    const previous = findRecord(collKey, docId);
    const ref = getDb().collection(col(collKey)).doc(String(docId));
    const fields = {
        voided: true,
        voidedAt: serverCreatedAt(),
        voidedBy: AppState.currentUser?.uid || null,
        voidedByName: String(AppState.userName || '').slice(0, 200),
        voidReason: why,
        openDue: false,
        // Bills are stock records: the clientVersion gate checks every write (firestore.rules writesCurrentClient)
        clientVersion: CLIENT_VERSION
    };
    let stored = null;
    await getDb().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Bill not found'), { code: 'not-found' });
        stored = snap.data();
        const blocked = voidBlocker(stored);
        if (blocked) {
            throw Object.assign(new Error(`This bill can't be voided (${blocked})`),
                { code: blocked === 'voided' ? 'already-voided' : 'has-payments' });
        }
        tx.update(ref, fields);
    });
    const voided = { id: docId, ...stored, ...fields, voidedAt: Date.now() };
    noteStockWrite(collKey, previous, voided, { oldUnknown: true });
    noteMonthWrite(collKey, previous || stored, voided);
    noteLocalRecordWrite(collKey, docId, voided);
    return voided;
}

/**
 * Deletes a voided bill for good, with its edit records (owner only in the
 * rules; test data and mistakes). It counted in nothing, so no figure changes.
 * @private
 */
async function deleteVoidedBillDoc(collKey, bill) {
    if (isActiveBill(bill)) throw Object.assign(new Error('Only a voided bill can be deleted'), { code: 'not-voided' });
    const docId = docIdOf(bill);
    const ref = getDb().collection(col(collKey)).doc(String(docId));
    const batch = getDb().batch();
    if (editCountOf(bill)) {
        const edits = await getWithRetry(billEditsRef(ref), 'Bill edits');
        edits.docs.forEach(d => batch.delete(d.ref));
    }
    batch.delete(ref);
    await batch.commit();
    noteLocalRecordWrite(collKey, docId, null);
}

/** What a stale copy of a bill would differ in (#127): payments, edits, void. */
const billStateKey = (b) => `${paymentSignature(b)}|${editCountOf(b) || 0}|${isActiveBill(b) ? 1 : 0}`;
/** The read before an edit (#127): a failed read falls back to the copy in memory, so it waits less. */
const LATEST_BILL_TIMEOUT_MS = 5000;
/** The whole stored bill, to spot any change (createdAt: an estimate locally). */
const billContentJson = (b) => {
    const rest = { ...b };
    delete rest.createdAt;
    return stableJson(rest);
};
/** Whether a listener that has heard from the server keeps this bill (its copy is current). */
const keptLiveFromServer = (collKey, docId) => {
    const c = S.windowState?.colls?.[collKey];
    return !!c && [c.live, ...c.dues].some(l => l.server && l.docs.some(r => docIdOf(r) === docId));
};

/**
 * Puts a bill just read from the server in memory when no listener keeps it (an older,
 * on-demand bill), with the stock checkpoint check a listener change gets. @private
 */
function adoptFreshBill(collKey, prev, fresh) {
    const c = S.windowState?.colls?.[collKey];
    if (!c) return;
    const docId = docIdOf(fresh);
    if (liveIdSet(c).has(docId)) return;
    c.extended.set(docId, fresh);
    if (c.spec.stock && prev) noteObservedChange(c, prev, fresh, 'modified');
    publishCollection(c);
    markDirty(c.spec.views, !!c.spec.stock);
}

/** Drops a bill the server no longer has from memory when no listener keeps it. @private */
function dropGoneBill(collKey, prev, docId) {
    const c = S.windowState?.colls?.[collKey];
    if (!c || liveIdSet(c).has(docId)) return;
    if (c.spec.stock && prev) noteObservedChange(c, prev, null, 'deleted');
    forgetRecord(collKey, docId);
    markDirty(c.spec.views, !!c.spec.stock);
}

/**
 * Firebase Service object containing all database operations.
 * Provides methods for CRUD operations on all collections.
 * @namespace FirebaseService
 */
const FirebaseService = {
    /**
     * Gets the Firestore database reference.
     * @type {firebase.firestore.Firestore}
     */
    get db() {
        return getDb();
    },

    /**
     * For the sync pill (ui/sync-status.js): a function that resolves once the SDK
     * has sent every queued write, or null when Firestore or that call isn't there.
     * @returns {?function(): Promise<void>}
     */
    pendingWritesWaiter() {
        const db = getDb();
        return typeof db.waitForPendingWrites === 'function' ? () => db.waitForPendingWrites() : null;
    },

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

    ...itemMethods,

    ...billStatsMethods,

    // ---- Month snapshots (redesign §7.6): monthStats/{YYYY-MM}, owner/manager only (rules) ----

    ...historyWindowMethods,

    ...collectionAdminMethods,

    /**
     * See settleWrite(): resolves when a write is acknowledged, or stored on this
     * device (offline at once, online after a short timeout), so bill saves don't
     * block on the network; stored=false if that was not confirmed in time.
     * @param {Promise<void>} writePromise
     * @param {string} [label]
     * @returns {Promise<{pending: boolean, stored: boolean}>}
     */
    settleWrite(writePromise, label) {
        return settleWrite(writePromise, label);
    },

    /**
     * Saves a purchase to Firestore. Creates new if no ID, updates if ID exists.
     * Automatically adds userId and userName from AppState.
     * @async
     * @param {Object} purchase - The purchase to save
     * @param {string} [purchase.id] - Purchase ID (if updating existing)
     * @param {string} purchase.partyName - Party/customer name
     * @param {string} purchase.date - Purchase date
     * @param {Array} purchase.items - Array of purchase items
     * @param {number} purchase.total - Total purchase amount
     * @returns {Promise<Object>} The saved purchase with ID
     */
    async savePurchase(purchase, options) {
        return saveBill('purchases', purchase, 'savePurchase', options);
    },

    /**
     * Updates an existing purchase in Firestore.
     * @async
     * @param {Object} purchase - The purchase to update
     * @param {string} purchase.id - Purchase ID (required)
     * @returns {Promise<Object>} The updated purchase
     * @throws {Error} If purchase.id is not provided
     */
    async updatePurchase(purchase, options) {
        return updateBillChecked('purchases', purchase, options);
    },

    /**
     * Deletes a purchase from Firestore.
     * @async
     * @param {string} purchaseId - The ID of the purchase to delete
     * @returns {Promise<void>}
     */
    async deletePurchase(purchaseId) {
        await deleteBill('purchases', purchaseId);
    },

    /**
     * Saves a wholesale sale to Firestore. Creates new if no ID, updates if ID exists.
     * @async
     * @param {Object} sale - The sale to save
     * @param {string} [sale.id] - Sale ID (if updating existing)
     * @param {string} sale.partyName - Party/customer name
     * @param {string} sale.date - Sale date
     * @param {Array} sale.items - Array of sale items
     * @param {number} sale.total - Total sale amount
     * @returns {Promise<Object>} The saved sale with ID
     */
    async saveWholesaleSale(sale, options) {
        return saveBill('wholesaleSales', sale, 'saveWholesaleSale', options);
    },

    /**
     * Updates an existing wholesale sale in Firestore.
     * @async
     * @param {Object} sale - The sale to update
     * @param {string} sale.id - Sale ID (required)
     * @returns {Promise<Object>} The updated sale
     * @throws {Error} If sale.id is not provided
     */
    async updateWholesaleSale(sale, options) {
        return updateBillChecked('wholesaleSales', sale, options);
    },

    /**
     * Saves a retail sale to Firestore. Uses separate retailSales collection.
     * @async
     * @param {Object} sale - The retail sale to save
     * @param {string} [sale.id] - Sale ID (if updating existing)
     * @param {string} sale.customerName - Customer name
     * @param {string} sale.date - Sale date
     * @param {Array} sale.items - Array of sale items
     * @param {number} sale.total - Total sale amount
     * @returns {Promise<Object>} The saved sale with ID
     */
    async saveRetailSale(sale, options) {
        return saveBill('retailSales', sale, 'saveRetailSale', options);
    },

    /**
     * Updates an existing retail sale in Firestore.
     * @async
     * @param {Object} sale - The sale to update
     * @param {string} sale.id - Sale ID (required)
     * @returns {Promise<Object>} The updated sale
     * @throws {Error} If sale.id is not provided
     */
    async updateRetailSale(sale, options) {
        return updateBillChecked('retailSales', sale, options);
    },

    /**
     * Deletes a retail sale from Firestore.
     * @async
     * @param {string} saleId - The ID of the sale to delete
     * @returns {Promise<void>}
     */
    async deleteRetailSale(saleId) {
        await deleteBill('retailSales', saleId);
    },

    /**
     * Deletes a wholesale sale from Firestore.
     * @async
     * @param {string} saleId - The ID of the sale to delete
     * @returns {Promise<void>}
     */
    async deleteWholesaleSale(saleId) {
        await deleteBill('wholesaleSales', saleId);
    },

    /**
     * True when a retried new-bill save found a payment recorded on the server
     * since the first attempt and kept the server's money fields (#70).
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    keptServerPayment(record) {
        return !!record && keptServerPaymentBills.has(record);
    },

    /**
     * True when a new bill was stored on this phone while offline and has not
     * reached the server yet (#153: "Saved on this phone, will sync").
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    savedOnPhoneOnly(record) {
        return !!record && savedOnPhoneBills.has(record);
    },

    /**
     * True when a new bill's write was neither acknowledged nor confirmed stored on
     * this phone in time (#153): it may still be saved, so it must not be reported
     * as saved or cleared from the form.
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    saveUnconfirmed(record) {
        return !!record && unconfirmedBills.has(record);
    },

    /**
     * Payment-state signature of a bill as it was loaded. Bill editors capture it when they
     * open so a later save can detect payments recorded on another device in the meantime.
     * @param {Object} record
     * @returns {?string}
     */
    loadedPaymentSignature(record) {
        return record?.[LOADED_PAYMENT] ?? paymentSignature(record);
    },

    /**
     * Sets the payment-state baseline the next update of `record` is checked against.
     * @param {Object} record
     * @param {?string} signature - Value from loadedPaymentSignature()
     * @returns {Object} record
     */
    withLoadedPaymentSignature(record, signature) {
        if (record && signature !== undefined) record[LOADED_PAYMENT] = signature;
        return record;
    },

    /**
     * Deletes a purchase / retail sale / wholesale sale shown in History, using its real
     * Firestore document id (legacy docs may have an `id` field that differs from it).
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill - Record from the AppState history array
     */
    async deleteHistoryBill(collKey, bill) {
        const docId = docIdOf(bill);
        if (collKey === 'purchases') return this.deletePurchase(docId);
        if (collKey === 'retailSales') return this.deleteRetailSale(docId);
        if (collKey === 'wholesaleSales') return this.deleteWholesaleSale(docId);
        throw new Error(`Unknown history collection: ${collKey}`);
    },

    /**
     * Voids a bill shown in History (#75): kept, marked who / when / why, left out of
     * every figure. Throws with `code` 'reason-required' | 'not-found' | 'already-voided' |
     * 'has-payments' (payments recorded after it was saved), or the Firestore error.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @param {string} reason 3–300 characters
     * @returns {Promise<Object>} the voided bill
     */
    async voidBill(collKey, bill, reason) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        return voidBillDoc(collKey, bill, reason);
    },

    /**
     * Owner only: deletes a voided bill for good, with its edit records.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill a voided bill
     */
    async deleteVoidedBill(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        return deleteVoidedBillDoc(collKey, bill);
    },

    /**
     * The server's copy of a bill before it is edited (#127): one read, never the cache.
     * An older bill isn't listened to, so its copy here may be stale; a payment, edit or
     * void made on another phone shows as `changed`, and the server copy replaces the
     * one in memory. Rejects when the server can't be reached.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill - the copy in memory
     * @returns {Promise<{bill: ?Object, changed: boolean}>} bill null when it no longer exists
     */
    async latestBill(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        const docId = String(docIdOf(bill));
        // A listener with server data already has the latest copy: no read
        if (keptLiveFromServer(collKey, docId)) return { bill, changed: false };
        const ref = getDb().collection(col(collKey)).doc(docId);
        const snap = await getWithRetry(() => ({ get: () => ref.get({ source: 'server' }) }), `${collKey} latest`, { attempts: 1, timeoutMs: LATEST_BILL_TIMEOUT_MS });
        const prev = findRecord(collKey, docId) || bill;
        if (!snap.exists) {
            dropGoneBill(collKey, prev, docId);
            return { bill: null, changed: true };
        }
        const fresh = mapDoc(snap);
        if (billContentJson(fresh) === billContentJson(bill)) return { bill, changed: false };
        adoptFreshBill(collKey, prev, fresh);
        // Notes and other unrecorded fields: edit the latest copy without asking
        return { bill: fresh, changed: billStateKey(fresh) !== billStateKey(bill) };
    },

    /**
     * Voided bills loaded for a bill collection (History's "Show voided bills"),
     * newest first. They are never in AppState's bill lists.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @returns {Array<Object>}
     */
    voidedBills(collKey) {
        return voidedOf(collKey).slice();
    },

    /**
     * The edit records of one bill (#121), oldest first: read only when the user
     * opens them in the bill details (one read per edit).
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @returns {Promise<Array<Object>>}
     */
    async loadBillEdits(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        const ref = billEditsRef(getDb().collection(col(collKey)).doc(String(docIdOf(bill))));
        const snap = await getWithRetry(ref.orderBy('n'), 'Bill edits');
        return snap.docs.map(d => d.data({ serverTimestamps: 'estimate' }));
    },

    /**
     * Saves an expense to Firestore.
     * @async
     * @param {Object} expense - The expense to save
     * @param {string} expense.description - Expense description
     * @param {number} expense.amount - Expense amount
     * @param {string} expense.date - Expense date
     * @param {string} [expense.category] - Expense category
     * @returns {Promise<Object>} The saved expense with ID
     */
    async saveExpense(expense) {
        const { record, committed } = this.startSaveExpense(expense);
        await committed;
        return record;
    },

    /**
     * Starts saving a new expense and shows it in AppState.expensesHistory
     * straight away (#89), without waiting for the server (works offline).
     * The listener later replaces the local copy (same doc id, no duplicate);
     * if the write fails the local copy is removed again. `stored` resolves true
     * once the write is on this device, false when this device refused it (e.g.
     * storage full, #153), null if still unconfirmed after EXPENSE_STORE_WAIT_MS.
     * @param {Object} expense
     * @param {{id?: string}} [options] - id: save again over this not-yet-confirmed expense
     * @returns {{record: Object, committed: Promise<void>, stored: Promise<boolean|null>}}
     */
    startSaveExpense(expense, { id } = {}) {
        if (!expense.userId && AppState.currentUser) {
            expense.userId = AppState.currentUser.uid;
        }
        if (!expense.userName && AppState.userName) {
            expense.userName = AppState.userName;
        }

        ensureTimestamp(expense, true);
        // Personal expenses go to their own collection, with their key in the day doc (#98)
        const collKey = expenseCollectionFor(expense);
        if (collKey !== 'expenses' && !expense.day) expense.day = personalDayKey(expense.date);
        const { record, committed, sent } = startCreate(collKey, expense, id,
            collKey === 'expenses' ? null : (batch, docId) => addPersonalDayWrites(batch, docId, null, expense));
        noteMonthWrite(collKey, null, record);
        return { record, committed, stored: whenStoredLocally(sent, EXPENSE_STORE_WAIT_MS) };
    },

    /**
     * Deletes an expense from Firestore.
     * Handles both old numeric IDs and new Firebase document IDs.
     * Also updates local AppState.expensesHistory.
     * @async
     * @param {string|number} expenseId - The ID of the expense to delete
     * @returns {Promise<void>}
     */
    async deleteExpense(expenseId) {
        // The Expenses page takes the row off the screen before this runs, so look in the collection state
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        if (collKey === 'personalExpenses') {
            const batch = getDb().batch();
            batch.delete(getDb().collection(col(collKey)).doc(where.docId));
            addPersonalDayWrites(batch, where.docId, previous, null);
            await batch.commit();
        } else if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            // Handle both old numeric IDs and new Firebase document IDs
            // Old expense with numeric ID - query by id field
            const snapshot = await getDb().collection(col('expenses')).where('id', '==', Number(expenseId)).get();
            const deletePromises = snapshot.docs.map(doc => doc.ref.delete());
            await Promise.all(deletePromises);
        } else {
            // New expense with Firebase document ID
            await getDb().collection(col('expenses')).doc(expenseId).delete();
        }
        noteMonthWrite(collKey, previous, null);
        
        forgetRecord(collKey, collKey === 'personalExpenses' ? where.docId : expenseId);
        // Update local state
        const index = AppState.expensesHistory.findIndex(e => e.id == expenseId);
        if (index !== -1) {
            AppState.expensesHistory.splice(index, 1);
        }
    },

    /**
     * Updates fields of an existing expense in place (numeric ids are legacy
     * `id` fields, others document ids) and keeps the in-memory copy in step.
     * @param {string|number} expenseId
     * @param {Object} fields
     * @returns {Promise<void>}
     */
    async updateExpense(expenseId, fields) {
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        if (collKey === 'personalExpenses') {
            const ref = getDb().collection(col(collKey)).doc(where.docId);
            const prev = where.rec;
            const batch = getDb().batch();
            batch.update(ref, fields);
            if (prev) addPersonalDayWrites(batch, where.docId, prev, { ...prev, ...fields });
            await batch.commit();
            if (prev) noteLocalRecordWrite(collKey, ref.id, { ...prev, ...fields });
            noteMonthWrite(collKey, prev, prev ? { ...prev, ...fields } : fields);
            return;
        }
        const coll = getDb().collection(col('expenses'));
        let refs;
        if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            const snapshot = await getWithRetry(coll.where('id', '==', Number(expenseId)), 'Expense lookup');
            refs = snapshot.docs.map(doc => doc.ref);
        } else {
            refs = [coll.doc(String(expenseId))];
        }
        if (refs.length === 0) throw new Error('Expense not found');
        await Promise.all(refs.map(ref => ref.update(fields)));
        refs.forEach(ref => {
            const prev = findRecord('expenses', ref.id) || findRecord('expenses', expenseId);
            if (prev) noteLocalRecordWrite('expenses', ref.id, { ...prev, ...fields });
            noteMonthWrite('expenses', prev, prev ? { ...prev, ...fields } : fields);
        });
    },

    /**
     * Voids an expense (#99): never edited or deleted in place. One transaction
     * sets voided, voidedAt (server time), voidedBy, voidedByName and voidReason;
     * a personal expense also leaves its day total (personalExpenseDays) in the
     * same write. From then on it counts in no figure (money.isActiveExpense):
     * it leaves AppState.expensesHistory (voidedExpenses() lists it). Needs a
     * connection. Throws with `code` 'reason-required' | 'not-found' | 'already-voided'.
     * @param {string|number} expenseId
     * @param {string} reason
     * @returns {Promise<Object>} the voided expense
     */
    async voidExpense(expenseId, reason) {
        const why = cleanReason(reason);
        if (!why) throw Object.assign(new Error('A reason is needed to void an expense'), { code: 'reason-required' });
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        let docId = previous ? docIdOf(previous) : where.docId;
        if (!previous && collKey === 'expenses' && /^\d+$/.test(String(expenseId))) {
            // Old-app rows carry a numeric `id` field, not their document id
            const snap = await getWithRetry(getDb().collection(col('expenses')).where('id', '==', Number(expenseId)), 'Expense lookup');
            if (snap.empty) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            docId = snap.docs[0].id;
        }
        const ref = getDb().collection(col(collKey)).doc(String(docId));
        const fields = {
            voided: true,
            voidedAt: serverCreatedAt(),
            voidedBy: AppState.currentUser?.uid || null,
            voidedByName: String(AppState.userName || '').slice(0, 200),
            voidReason: why
        };
        let stored = null;
        await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            stored = snap.data();
            if (!isActiveExpense(stored)) throw Object.assign(new Error('This expense is already voided'), { code: 'already-voided' });
            tx.update(ref, fields);
            const day = collKey === 'personalExpenses' ? personalDayOf(stored) : null;
            if (day) tx.set(...personalDayWrite(day, String(docId), null));
        });
        const voided = { ...stored, ...fields, id: previous?.id ?? stored.id ?? docId, voidedAt: Date.now() };
        docIds.set(voided, String(docId));
        noteMonthWrite(collKey, previous || stored, null);
        if (collKey === 'personalExpenses') personalDayCache.delete(personalDayOf(stored));
        replaceLiveRecord(collKey, docId, voided);
        noteLocalRecordWrite(collKey, docId, voided);
        return voided;
    },

    /**
     * Voided expenses loaded (business and personal), newest first; kept out of
     * AppState.expensesHistory so no figure counts them (#99).
     * @returns {Array<Object>}
     */
    voidedExpenses() {
        return [...voidedOf('expenses'), ...voidedOf('personalExpenses')].sort(byDateDesc);
    },

    /**
     * A day's personal expense total and count (personalExpenseDays, #98), for
     * phones whose role can't read the expenses themselves. One read, reused for
     * `maxAgeMs`; personalExpenseDay() returns the last value read, for sync readers.
     * @param {string} day YYYY-MM-DD
     * @param {{maxAgeMs?: number}} [opts]
     * @returns {Promise<?{total: number, count: number}>} null when unknown (missing or unreadable)
     */
    async loadPersonalExpenseDay(day, { maxAgeMs = 60000 } = {}) {
        const cached = personalDayCache.get(day);
        if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
        let value = null;
        try {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2, timeoutMs: 8000 });
            value = dayDocTotals(snap.exists ? snap.data() : null);
        } catch (e) {
            console.warn('Personal expense day total not loaded:', e?.code || e);
            return cached ? cached.value : null;
        }
        personalDayCache.set(day, { value, at: Date.now() });
        return value;
    },

    /**
     * The last personal expense total read for a day (loadPersonalExpenseDay), or null.
     * @param {string} day YYYY-MM-DD
     * @returns {?{total: number, count: number}}
     */
    personalExpenseDay(day) {
        return personalDayCache.get(day)?.value ?? null;
    },

    /**
     * Whether this phone has the personal expense rows: their listener started
     * and delivered its first snapshot (not just what Roles & access says now).
     * When false, the cash count and Today use the day totals and the shared
     * month snapshots are not written (#98).
     * @returns {boolean}
     */
    personalRowsLoaded() {
        const live = S.windowState?.colls?.personalExpenses?.live;
        return !!(live && live.delivered && !live.failed);
    },

    /**
     * Owner/manager: makes personalExpenseDays of these days match the loaded
     * personal rows (one read per day, one write per wrong key; none when right).
     * @param {string[]} days YYYY-MM-DD, inside the loaded history
     * @returns {Promise<number>} keys written
     */
    async rebuildPersonalExpenseDays(days) {
        if (!canManageCheckpoint() || !this.personalRowsLoaded()) return 0;
        const rows = (S.windowState.colls.personalExpenses.published || []).map(r => ({ ...r, id: docIdOf(r) }));
        const want = personalDaysFromRows(rows);
        const wantOnline = personalOnlineFromRows(rows);
        let written = 0;
        for (const day of days) {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2 });
            const fixes = personalDayFixes(want[day] || {}, snap.exists ? snap.data() : null, wantOnline[day] || {});
            for (const f of fixes) {
                const [ref, data, opts] = personalDayWrite(day, f.id, f.amount, f.online);
                await ref.set(data, opts);
                written++;
            }
            personalDayCache.delete(day);
        }
        return written;
    },

    /** Version written as `clientVersion` on stock records (see firestore.rules). */
    CLIENT_VERSION,

    ...settingsMethods,

    ...tipMethods,

    ...stockMethods,

    ...stockCheckpointMethods,

    ...legacyScanMethods,

    /**
     * Saves a stock adjustment to Firestore.
     * @async
     * @param {Object} adjustment - The stock adjustment to save
     * @param {string} adjustment.itemId - ID of the item being adjusted
     * @param {string} adjustment.adjustType - Type of adjustment ('add', 'remove', 'set')
     * @param {number} adjustment.quantity - Adjustment quantity
     * @param {number} [adjustment.rate] - Rate for the adjustment
     * @param {string} adjustment.date - Adjustment date
     * @param {string} [adjustment.reason] - Reason for adjustment
     * @returns {Promise<Object>} The saved adjustment with ID
     */
    async saveStockAdjustment(adjustment) {
        const { record, committed } = this.startSaveStockAdjustment(adjustment);
        await committed;
        return record;
    },

    /**
     * Starts saving a new stock adjustment (id made on the phone) and shows it
     * at once, also offline (#95); a refused write removes it again.
     * @param {Object} adjustment
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveStockAdjustment(adjustment, { id } = {}) {
        if (!adjustment.userId && AppState.currentUser) {
            adjustment.userId = AppState.currentUser.uid;
        }
        if (!adjustment.userName && AppState.userName) {
            adjustment.userName = AppState.userName;
        }
        
        prepareStockRecord('stockAdjustments', adjustment, true);
        // `id`: a fixed id (a reversal, #146), so a second phone's copy lands on the same document
        const started = startCreate('stockAdjustments', adjustment, id || null);
        noteStockWrite('stockAdjustments', null, adjustment);
        noteMonthWrite('stockAdjustments', null, adjustment);
        return started;
    },

    /**
     * Starts saving a new withdrawal (id made on the phone) and shows it at
     * once, also offline (#95); a refused write removes it again.
     * @param {Object} withdrawal
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveWithdrawal(withdrawal) {
        if (!withdrawal.userId && AppState.currentUser) {
            withdrawal.userId = AppState.currentUser.uid;
        }
        if (!withdrawal.userName && AppState.userName) {
            withdrawal.userName = AppState.userName;
        }
        
        // The window queries filter on `timestamp`; `date` is a user-picked day, so use the
        // later of creation time and that day (a backdated withdrawal is then an extra older record).
        if (typeof withdrawal.timestamp !== 'number') {
            withdrawal.timestamp = Math.max(Date.now(), parseAnyBillDate(withdrawal.date)?.getTime() || 0);
        }
        const started = startCreate('withdrawals', withdrawal);
        noteMonthWrite('withdrawals', null, withdrawal);
        return started;
    },

    /**
     * Diagnostics: how each listener became ready at the last startup.
     * @returns {Object<string, {first: string, docs: number, readyBy?: string}>}
     */
    getStartupListenerInfo() {
        return JSON.parse(JSON.stringify(listenerStartup));
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
        const gen = S.sessionGen;
        const db = getDb();
        S.warmCache = false;
        Object.keys(listenerStartup).forEach(k => delete listenerStartup[k]);

        const listen = (query, label, live, onData, { optional = false, mapFn = mapDoc } = {}) => {
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
            // includeMetadataChanges so the cache -> server transition is seen
            // even when the cached data was already up to date.
            const unsubscribe = query.onSnapshot({ includeMetadataChanges: true }, snapshot => {
                if (gen !== S.sessionGen) return;
                SyncStatus.noteSnapshot(syncId, snapshot);
                const { changed, changes } = applySnapshot(live, snapshot, mapFn);
                if (!snapshot.metadata.fromCache) {
                    live.server = true;
                    SyncStatus.noteServerData();
                }
                live.delivered = true;
                // Before startup is ready only AppState is updated; startup
                // computes stock and renders the initial views itself.
                if (changed) onData(changes, ready);
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
            }, error => {
                console.error(`${label} listener error:`, error);
                live.failed = true;
                clearTimeout(readyTimer);
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
            });
            unsubscribeFunctions.push(unsubscribe);
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
                const windowQuery = db.collection(col(spec.key))
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
                }, { optional: !!spec.optional }));

                if (!spec.dues) return;
                // Older bills with money due (in-window bills come from the window query), and older
                // bills paid or written off inside the window (#163): their payment counts in this
                // window's money in / out, day book and month snapshots after the due is gone.
                // Bills inside the window with a later payment come from both queries (published
                // once, read twice): two range filters would need a composite index.
                const dueQueries = [
                    ['openDue', db.collection(col(spec.key)).where('openDue', '==', true).where('timestamp', '<', liveFrom)],
                    ['paidAt', db.collection(col(spec.key)).where('paidAt', '>=', liveFrom)]
                ];
                const pinnedIds = Array.isArray(S.checkpointDoc?.pinned?.[spec.key]) ? S.checkpointDoc.pinned[spec.key].slice(0, PINNED_MAX) : [];
                const docIdPath = typeof firebase !== 'undefined' && firebase.firestore?.FieldPath?.documentId
                    ? firebase.firestore.FieldPath.documentId() : null;
                for (let i = 0; docIdPath && i < pinnedIds.length; i += PINNED_CHUNK) {
                    dueQueries.push(['pinned', db.collection(col(spec.key)).where(docIdPath, 'in', pinnedIds.slice(i, i + PINNED_CHUNK))]);
                }
                dueQueries.forEach(([field, duesQuery]) => {
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
                    }, { optional: true }));
                });
            });
            const ws = S.windowState;
            // Without a usable checkpoint calculateStock() reads everything anyway (and backfills).
            return Promise.all(waits).then(() => {
                if (gen !== S.sessionGen) return;
                if (shouldScheduleLegacyScan({ canManage: canManageCheckpoint(), hasCheckpoint: !!cp, online: navigator.onLine })) {
                    scheduleLegacyScan(ws, gen);
                }
                // Owner/manager phones keep the last week's personal day totals in step with the rows (#98)
                if (canManageCheckpoint() && FirebaseService.personalRowsLoaded() && navigator.onLine !== false) {
                    whenIdle(() => (gen === S.sessionGen
                        ? FirebaseService.rebuildPersonalExpenseDays([0, 1, 2, 3, 4, 5, 6].map(localISODaysAgo))
                            .catch(e => console.warn('Personal expense day totals not checked:', e?.code || e))
                        : undefined), { minDelayMs: LEGACY_SCAN_DELAY_MS });
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
            setTimeout(() => {
                if (gen === S.sessionGen) {
                    this.maintainStockCheckpoint().catch(e => console.error('Stock checkpoint maintenance failed:', e));
                }
            }, 0);
        });
    },

    ...notificationMethods,

    ...cashDayMethods,

    ...anomalyMethods,
    ...worthAccountMethods,
    ...reminderMethods,

    ...userProfileMethods };

// Export FirebaseService and cleanup function
export { FirebaseService };
