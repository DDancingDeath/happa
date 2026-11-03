/**
 * @fileoverview A new bill's first save with a client-made id and its retry (#70, #153), and the
 * create-only save of a new or restored bill (#93, #317), with the session's record of what this
 * phone sent. Moved out of repos/bills.js (#69).
 * @module firebase/repos/bill-save
 */

import { col, getDb } from '../db.js';
import { t } from '../../i18n/index.js';
import { AppState } from '../../utils/state.js';
import { isPermissionDenied, paymentSignature, stableJson } from '../core/records.js';
import { LOCAL_STORE_WAIT_MS, settleWrite, whenStoredLocally } from '../core/write-settle.js';
import {
    findRecord, forgetRecord, noteLocalRecordWrite, noteMonthWrite, prepareStockRecord
} from '../core/history-window.js';
import { SyncStatus } from '../../ui/sync-status.js';
import { noteStockWrite } from '../core/stock-checkpoint.js';
import { track } from '../../services/usage.js';
import { tip } from '../../tip/index.js';
import { billSaveProps } from '../../tip/scenarios/bill-save.js';
import { isActiveBill } from '../../utils/money.js';
import {
    BILL_MONEY_FIELDS, keepEditCount, keepStoredCreatedAt, logRetryEdit, withServerCreatedAt
} from './bill-fields.js';

/** Payment signature of the last new-bill write this device sent, by `${collKey}/${id}` (#70). */
export const sentBillPaymentSigs = new Map();

/** Bills whose retry kept the server's money fields (a payment was recorded meanwhile). */
export const keptServerPaymentBills = new WeakSet();

/** Bills that were stored on this phone while offline and are waiting to sync. */
export const savedOnPhoneBills = new WeakSet();

/** Bills whose write this phone had not confirmed storing when the save gave up waiting. */
export const unconfirmedBills = new WeakSet();

/** `${collKey}/${id}` of new bills whose first set() hasn't settled yet. */
export const pendingFirstSaves = new Set();

/** Of those, the ones a retry has saved meanwhile. */
export const retriedBillSaves = new Set();

/** First set() of new bills not yet confirmed on this phone, by key: { sent, json } (#153). */
export const unconfirmedFirstSaves = new Map();

/** A bill's content as compared between save attempts (createdAt is set by the server; undefined is never stored). */
export const billAttemptJson = (record) => {
    const rest = withoutUndefined({ ...record });
    delete rest.createdAt;
    return stableJson(rest);
};

function withoutUndefined(v) {
    if (Array.isArray(v)) return v.map(withoutUndefined);
    if (!v || typeof v !== 'object' || typeof v.toMillis === 'function') return v;
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, withoutUndefined(x)]));
}

/**
 * The contents of the bill saves this phone sent this session, by `${collKey}/${id}` (#93):
 * a create-only save that finds one of them on the server finds its own write (its
 * acknowledgement was lost), not another phone's bill.
 */
export const sentBillAttempts = new Map();

/** The same without what changes after a save (payments, edits): `${key}` → Set of shapes. */
const sentBillShapes = new Map();
const billShapeJson = (bill) => {
    const rest = { ...bill };
    [...BILL_MONEY_FIELDS, 'paidAt', 'editCount'].forEach(k => delete rest[k]);
    return billAttemptJson(rest);
};

function noteSentAttempt(key, record) {
    if (!sentBillAttempts.has(key)) sentBillAttempts.set(key, new Set());
    sentBillAttempts.get(key).add(billAttemptJson(record));
    if (!sentBillShapes.has(key)) sentBillShapes.set(key, new Set());
    sentBillShapes.get(key).add(billShapeJson(record));
}

/** Whether `bill` is one of this phone's attempts, a payment or an edit recorded since aside. */
const isOwnBillShape = (key, bill) => !!bill && !!sentBillShapes.get(key)?.has(billShapeJson(bill));

/** State of create-only transactions given up on, by key: 'pending' | 'own' | 'foreign' | 'none' (#93). */
const lateCreateStates = new Map();

/** How long a new bill's create-only save waits for the server before it is saved like an offline one. */
export const BILL_CREATE_WAIT_MS = 3000;
const NO_ANSWER_CODES = new Set(['unavailable', 'deadline-exceeded', 'resource-exhausted']);
/** After a create-only save got no answer, later first saves skip it until the server is heard again (at most this long). */
export const NO_ANSWER_SKIP_MS = 2 * 60 * 1000;
let createNoAnswerAt = 0;

/**
 * Whether a first save should try the create-only transaction: not while the server is known
 * to be out of reach. Heard again = one of this phone's writes reached the server since (a
 * listener's snapshot isn't: it can echo this phone's own pending write).
 */
function createOnlineReachable(now = Date.now()) {
    if (!createNoAnswerAt) return true;
    if ((SyncStatus.lastSyncAt?.() || 0) >= createNoAnswerAt || now - createNoAnswerAt > NO_ANSWER_SKIP_MS) {
        createNoAnswerAt = 0;
        return true;
    }
    return false;
}

/**
 * Create-only transactions given up on (no answer in time) that may still land, by key (#93):
 * resolves true when one did, its `already-saved` error when it found another phone's bill,
 * else false. A queued set() of the same bill refused afterwards (a non-owner can't change
 * createdAt) is then this phone's own bill, or that other phone's.
 */
export const abandonedCreates = new Map();

const LATE_CREATE_WAIT_MS = 15000;

/**
 * What a refused queued set() of `key` met (#93): true - this phone's own create-only
 * transaction landed late (or the server holds one of its attempts); an `already-saved`
 * error - another phone's bill; false - neither known.
 */
async function lateCreateOutcome(key, ref) {
    const late = abandonedCreates.get(key);
    if (!late) return false;
    const outcome = await Promise.race([late, new Promise(resolve => setTimeout(() => resolve(null), LATE_CREATE_WAIT_MS))]);
    if (outcome) return outcome;
    try {
        const snap = await ref.get({ source: 'server' });
        return snap.exists && !!sentBillAttempts.get(key)?.has(billAttemptJson(snap.data() || {}));
    } catch {
        return false;
    }
}

/**
 * An offline re-save of a bill whose first attempt was not confirmed (#153): a
 * transaction needs the server, so instead check that first write on this phone.
 * 'stored' - stored, same content: nothing to write; 'resend' - this phone
 * refused it: save it again as new; 'unconfirmed' - still unknown, or changed
 * since (no write: re-sending could clash with the queued first write).
 * @private
 */
export async function offlineRetryOutcome(key, record) {
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
 * timed-out attempt: see retryBillSave. With `createOnly` (#93), online, it is created in
 * a transaction only while its id is free (any bill already there was saved by another
 * phone, e.g. from the same user's auto-save), else `already-saved` is thrown with it.
 * A first save (not a retry) whose transaction gets no answer within BILL_CREATE_WAIT_MS
 * is saved like an offline one (a set() queued on the phone), unless `strict` (a copy
 * restored from an auto-save or a draft: its id may well be another phone's bill), which
 * throws instead. @private
 */
export async function saveBill(collKey, record, label, { retry = false, createOnly = false, strict = false } = {}) {
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
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    noteSentAttempt(key, record);
    if (retry && !resend) {
        try {
            const saved = await retryBillSave(collKey, record, docRef, previous, key, { createOnly });
            unconfirmedFirstSaves.delete(key);
            run.complete();
            return saved;
        } catch (error) {
            run.completeAndFail('save_error', { code: String(error?.code || 'unknown').slice(0, 40) });
            throw error;
        }
    }
    if (createOnly && !offline && !resend && (strict || createOnlineReachable())) {
        let saved;
        try {
            saved = await createBillOnline(collKey, record, docRef, previous, key, { strict });
        } catch (error) {
            run.completeAndFail('save_error', { code: String(error?.code || 'unknown').slice(0, 40) });
            throw error;
        }
        if (saved) {
            run.complete();
            return saved;
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
    const write = Promise.resolve(sent).then(settled, async (error) => {
        const late = isPermissionDenied(error) && !retriedBillSaves.has(key) ? await lateCreateOutcome(key, docRef) : false;
        if (late?.code === 'already-saved') {
            settled();
            throw late;
        }
        const superseded = isPermissionDenied(error) && (retriedBillSaves.has(key) || late === true);
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
    let settledWrite;
    try {
        settledWrite = await settleWrite(write, label);
    } catch (error) {
        // Refused before it counted as saved (by this phone or the server): nothing is stored, so
        // memory goes back too (a next first save must not take this copy for the stored bill)
        if (error && typeof error === 'object' && error.code !== 'already-saved') error.nothingQueued = true;
        if (previous) noteLocalRecordWrite(collKey, String(record.id), previous);
        else forgetRecord(collKey, String(record.id));
        throw error;
    }
    const { pending, stored } = settledWrite;
    if (!stored) {
        unconfirmedBills.add(record);
        return record;
    }
    unconfirmedFirstSaves.delete(key);
    if (pending && typeof navigator !== 'undefined' && navigator.onLine === false) savedOnPhoneBills.add(record);
    return record;
}

/**
 * A new bill's first save online (#93): retryBillSave's create-only transaction, on a copy
 * of `record` so a transaction still running after the wait can't change the bill being
 * saved offline-style. Resolves the saved record, or null when the server didn't answer
 * (if that transaction lands later, the queued set() is its retry: retriedBillSaves).
 * @private
 */
async function createBillOnline(collKey, record, ref, previous, key, { strict = false } = {}) {
    const attempt = { ...record };
    const control = { abandoned: false };
    const tx = retryBillSave(collKey, attempt, ref, previous, key, { createOnly: true, control });
    let timer;
    try {
        await Promise.race([tx, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('No answer from the server'), { code: 'deadline-exceeded' })), BILL_CREATE_WAIT_MS);
        })]);
    } catch (error) {
        const noAnswer = NO_ANSWER_CODES.has(error?.code);
        // The SDK may still run it again later: from now on it only creates the bill, never goes over it
        control.abandoned = true;
        if (noAnswer) watchLateCreate(key, tx);
        else tx.catch(() => {});
        if (strict || !noAnswer) {
            // Nothing queued: the next save is a first save again (a commit that did land is
            // recognised then as this phone's own, sentBillAttempts)
            if (error && typeof error === 'object' && error.code !== 'already-saved') error.nothingQueued = true;
            throw error;
        }
        createNoAnswerAt = Date.now();
        console.warn('New bill: no answer to the create-only save, saving it on the phone:', error.code);
        return null;
    } finally {
        clearTimeout(timer);
    }
    BILL_MONEY_FIELDS.forEach(k => { if (!(k in attempt)) delete record[k]; });
    Object.assign(record, attempt);
    if (keptServerPaymentBills.has(attempt)) keptServerPaymentBills.add(record);
    unconfirmedFirstSaves.delete(key);
    return record;
}

/** Keeps a create-only transaction given up on (no answer in time), to learn how it ends. */
function watchLateCreate(key, tx) {
    lateCreateStates.set(key, 'pending');
    abandonedCreates.set(key, tx.then(() => {
        lateCreateStates.set(key, 'own');
        return true;
    }, (late) => {
        if (late?.code !== 'already-saved') {
            lateCreateStates.set(key, 'none');
            return false;
        }
        // Read after this phone's own set() landed (a payment or edit since): still its bill
        if (isOwnBillShape(key, late.bill)) {
            lateCreateStates.set(key, 'own');
            return true;
        }
        lateCreateStates.set(key, 'foreign');
        noteSavedOnTwoPhones(late.bill);
        return late;
    }));
}

/**
 * A create-only transaction given up on found, late, another phone's bill under this id:
 * the queued set() may go over it (the owner) or be refused. Said, so it is checked.
 */
function noteSavedOnTwoPhones(bill) {
    console.warn('Bill saved on two phones under one id:', bill?.id);
    import('../../ui/ui-manager.js')
        .then(({ UIManager }) => UIManager.showToast(t('msg.sync.bill_saved_on_two_phones', { number: bill?.billNumber || '—' }), 8000))
        .catch(() => {});
}

/** TIP BillSave run (#217) for a new bill; never throws. @private */
export function startBillSaveRun(collKey, record, retry) {
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
 * the server's money fields. With `createOnly` (#93) an existing bill is written only
 * when it holds one of this phone's own attempts (sentBillAttempts: a lost acknowledgement);
 * otherwise `already-saved` is thrown with it. @private
 */
export async function retryBillSave(collKey, record, ref, previous, key, { createOnly = false, control = null } = {}) {
    const sentSig = sentBillPaymentSigs.get(key) ?? paymentSignature(record);
    let kept = false;
    let wrote = false;
    let created = false;
    let serverMoney = null;
    await getDb().runTransaction(async tx => {
        kept = false;
        wrote = true;
        created = false;
        serverMoney = null;
        const snap = await tx.get(ref);
        if (!snap.exists) {
            created = true;
            if (record.createdAt === undefined) record.createdAt = Date.now();
            tx.set(ref, withServerCreatedAt(record));
            return;
        }
        // Create-only (#93): a bill this phone didn't write is never gone over; given up on
        // (control.abandoned), not even this phone's own bill, which may be newer by now
        const there = snap.data() || {};
        const ownThere = sentBillAttempts.get(key)?.has(billAttemptJson(there));
        if (createOnly && control?.abandoned && (ownThere || isOwnBillShape(key, there))) {
            wrote = false;
            return;
        }
        if (createOnly && (control?.abandoned || !ownThere)) {
            throw Object.assign(new Error('This bill is already saved'),
                { code: 'already-saved', bill: { ...snap.data({ serverTimestamps: 'estimate' }), id: ref.id } });
        }
        const server = snap.data() || {};
        // Voided meanwhile on another phone (#75): never written over.
        if (!isActiveBill(server)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
        keepStoredCreatedAt(record, server);
        keepEditCount(record, server);
        const serverPayments = Array.isArray(server.payments) ? server.payments : [];
        // Found exactly one of this phone's own attempts (#93): its money is this phone's too
        if (!(createOnly && ownThere) && (serverPayments.length > 0 || paymentSignature(server) !== sentSig)) {
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
        // A create-only save saw that no bill was there: checked like a first save
        noteStockWrite(collKey, previous, record, createOnly && created ? {} : { oldUnknown: true });
        noteMonthWrite(collKey, previous, record);
    }
    if (wrote || !control?.abandoned) noteLocalRecordWrite(collKey, String(record.id), record);
    return record;
}

/** FirebaseService methods that save a new bill; spread into FirebaseService (`this` is FirebaseService). */
export const billSaveMethods = {
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
     * How a create-only save of this bill given up on (no answer in time) ended (#93):
     * 'pending' (still unknown), 'own' (it landed), 'foreign' (another phone's bill was
     * there), 'none' (it failed), or null when there was none.
     * @param {'purchases'|'retailSales'} collKey
     * @param {string} id
     * @returns {?string}
     */
    lateCreateState(collKey, id) {
        return lateCreateStates.get(`${collKey}/${id}`) || null;
    }
};
