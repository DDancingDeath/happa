/**
 * @fileoverview Bills (purchases, retail and wholesale sales): the first save with a client-made id
 * and its retry (#70, #153), checked edits with their edit records (#121), void and delete (#75),
 * and the server copy before an edit (#127). Moved verbatim out of firestore-service.js
 * (docs/architecture.md, phase 5, #69).
 * @module firebase/repos/bills
 */

import { CLIENT_VERSION, col, getDb, serverCreatedAt } from '../db.js';
import {
    billEditChanges, cleanReason, editCountOf, editRecord, hasEditChanges, nextEditNumber, voidBlocker
} from '../../utils/bill-edits.js';
import { AppState } from '../../utils/state.js';
import { t } from '../../i18n/index.js';
import {
    docIdOf, HISTORY_SPEC, isPermissionDenied, LOADED_PAYMENT, mapDoc, paymentSignature, stableJson
} from '../core/records.js';
import { LOCAL_STORE_WAIT_MS, settleWrite, whenStoredLocally } from '../core/write-settle.js';
import {
    findRecord, forgetRecord, liveIdSet, noteLocalRecordWrite, noteMonthWrite, prepareStockRecord,
    publishCollection, voidedOf
} from '../core/history-window.js';
import { SyncStatus } from '../../ui/sync-status.js';
import { noteObservedChange, noteStockWrite } from '../core/stock-checkpoint.js';
import { track } from '../../services/usage.js';
import { tip } from '../../tip/index.js';
import { billSaveProps } from '../../tip/scenarios/bill-save.js';
import { isActiveBill } from '../../utils/money.js';
import { getWithRetry } from '../core/reads.js';
import { S } from '../core/session.js';
import { markDirty } from '../core/realtime.js';

/** A bill's edit records (#121): a sub-collection, so the bill's own (dev_-prefixed) collection sets the environment. */
export const BILL_EDITS = 'edits';

export const billEditsRef = (billRef) => billRef.collection(BILL_EDITS);

/** Bill fields that Outstanding / other devices change after a bill is created. */
export const BILL_MONEY_FIELDS = ['payment', 'payments', 'dueAmount', 'cashPayment', 'onlinePayment', 'openDue', 'cleared'];

export const withServerCreatedAt = (record) => ({ ...record, createdAt: serverCreatedAt() });

/** Keeps the bill's stored `createdAt` on an overwrite (the rules refuse a change). */
export function keepStoredCreatedAt(record, stored) {
    if (stored && stored.createdAt !== undefined && stored.createdAt !== null) record.createdAt = stored.createdAt;
    else delete record.createdAt;
}

/** Keeps the bill's stored edit count on an overwrite (#121: it only moves with an edit record). */
export function keepEditCount(record, stored) {
    if (editCountOf(stored)) record.editCount = editCountOf(stored);
    else delete record.editCount;
}

/**
 * A retried new bill that changes what its unconfirmed first save stored is an edit (#121):
 * its record goes into the same transaction, with a fixed reason in the app language.
 * Sets `target.editCount`. @private
 */
export function logRetryEdit(tx, ref, server, after, target) {
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

/** A bill's content as compared between save attempts (createdAt is set by the server). */
export const billAttemptJson = (record) => {
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
 * timed-out attempt: see retryBillSave. With `createOnly` (online; a bill restored
 * from an auto-save or a draft, #93) it is created in a transaction only while its id
 * is free, else `already-saved` is thrown. @private
 */
export async function saveBill(collKey, record, label, { retry = false, createOnly = false } = {}) {
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
    if ((retry && !resend) || (createOnly && !offline)) {
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
 * the server's money fields. With `createOnly` (a copy restored from an auto-save or a
 * draft, #93) an existing bill is never written: throws `already-saved` with it. @private
 */
export async function retryBillSave(collKey, record, ref, previous, key, { createOnly = false } = {}) {
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
        // A restored copy (#93) never goes over the bill it was saved as
        if (createOnly) {
            throw Object.assign(new Error('This bill is already saved'),
                { code: 'already-saved', bill: { ...snap.data({ serverTimestamps: 'estimate' }), id: ref.id } });
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
        // A create-only save saw that no bill was there: checked like a first save
        noteStockWrite(collKey, previous, record, createOnly && created ? {} : { oldUnknown: true });
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
export async function updateBillChecked(collKey, record, { reason = null } = {}) {
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

export async function deleteBill(collKey, id) {
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
export async function voidBillDoc(collKey, bill, reason) {
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
export async function deleteVoidedBillDoc(collKey, bill) {
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
export const billStateKey = (b) => `${paymentSignature(b)}|${editCountOf(b) || 0}|${isActiveBill(b) ? 1 : 0}`;

/** The read before an edit (#127): a failed read falls back to the copy in memory, so it waits less. */
export const LATEST_BILL_TIMEOUT_MS = 5000;

/** The whole stored bill, to spot any change (createdAt: an estimate locally). */
export const billContentJson = (b) => {
    const rest = { ...b };
    delete rest.createdAt;
    return stableJson(rest);
};

/** Whether a listener that has heard from the server keeps this bill (its copy is current). */
export const keptLiveFromServer = (collKey, docId) => {
    const c = S.windowState?.colls?.[collKey];
    return !!c && [c.live, ...c.dues].some(l => l.server && l.docs.some(r => docIdOf(r) === docId));
};

/**
 * Puts a bill just read from the server in memory when no listener keeps it (an older,
 * on-demand bill), with the stock checkpoint check a listener change gets. @private
 */
export function adoptFreshBill(collKey, prev, fresh) {
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
export function dropGoneBill(collKey, prev, docId) {
    const c = S.windowState?.colls?.[collKey];
    if (!c || liveIdSet(c).has(docId)) return;
    if (c.spec.stock && prev) noteObservedChange(c, prev, null, 'deleted');
    forgetRecord(collKey, docId);
    markDirty(c.spec.views, !!c.spec.stock);
}

/** FirebaseService bill methods; spread into FirebaseService (`this` is FirebaseService). */
export const billMethods = {
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
     * With `idOnly` (#93: restoring an auto-save or a draft), `bill` is just `{ id }`: the copy
     * compared with is the one in memory, if any (`changed` is then against that copy).
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill - the copy in memory
     * @param {{idOnly?: boolean}} [options]
     * @returns {Promise<{bill: ?Object, changed: boolean}>} bill null when it no longer exists
     */
    async latestBill(collKey, bill, { idOnly = false } = {}) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        const docId = String(docIdOf(bill));
        const known = idOnly ? findRecord(collKey, docId) : bill;
        // A listener with server data already has the latest copy: no read
        if (known && keptLiveFromServer(collKey, docId)) return { bill: known, changed: false };
        const ref = getDb().collection(col(collKey)).doc(docId);
        const snap = await getWithRetry(() => ({ get: () => ref.get({ source: 'server' }) }), `${collKey} latest`, { attempts: 1, timeoutMs: LATEST_BILL_TIMEOUT_MS });
        const prev = findRecord(collKey, docId) || known;
        if (!snap.exists) {
            dropGoneBill(collKey, prev, docId);
            return { bill: null, changed: true };
        }
        const fresh = mapDoc(snap);
        if (known && billContentJson(fresh) === billContentJson(known)) return { bill: known, changed: false };
        adoptFreshBill(collKey, prev, fresh);
        // Notes and other unrecorded fields: edit the latest copy without asking
        return { bill: fresh, changed: !known || billStateKey(fresh) !== billStateKey(known) };
    },

    /**
     * The version of a bill an auto-save or a draft of its edit was taken from (#93): its
     * payments, edit count and void state (what a later change on any phone moves).
     * @param {?Object} bill
     * @returns {?string}
     */
    billVersion(bill) {
        return bill ? billStateKey(bill) : null;
    },

    /**
     * A bill as this phone's Firestore cache has it (#93: Restore with the server out of
     * reach): a bill this phone saved, synced or still waiting to sync, is there. No read
     * is billed. null when the cache doesn't have it.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {string} id
     * @returns {Promise<?Object>}
     */
    async billOnThisPhone(collKey, id) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        try {
            const snap = await getDb().collection(col(collKey)).doc(String(id)).get({ source: 'cache' });
            return snap.exists ? mapDoc(snap) : null;
        } catch {
            return null;
        }
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
    }
};
