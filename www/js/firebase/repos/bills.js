/**
 * @fileoverview Bills (purchases, retail and wholesale sales): the FirebaseService bill methods.
 * The work is in bill-save.js (first save, retry, create-only: #70, #93, #153), bill-edit.js
 * (checked edits, void, delete, the server copy: #121, #75, #127) and bill-fields.js; their
 * exports are re-exported here (docs/architecture.md, phase 5, #69).
 * @module firebase/repos/bills
 */

import { col, getDb } from '../db.js';
import { docIdOf, HISTORY_SPEC, LOADED_PAYMENT, mapDoc, paymentSignature } from '../core/records.js';
import { findRecord, voidedOf } from '../core/history-window.js';
import { getWithRetry } from '../core/reads.js';
import { billEditsRef } from './bill-fields.js';
import {
    keptServerPaymentBills, lateCreateStates, saveBill, savedOnPhoneBills, unconfirmedBills
} from './bill-save.js';
import {
    adoptFreshBill, billContentJson, billStateKey, deleteBill, deleteVoidedBillDoc, dropGoneBill,
    keptLiveFromServer, LATEST_BILL_TIMEOUT_MS, updateBillChecked, voidBillDoc
} from './bill-edit.js';

export {
    BILL_EDITS, billEditsRef, BILL_MONEY_FIELDS, keepEditCount, keepStoredCreatedAt, logRetryEdit,
    withServerCreatedAt
} from './bill-fields.js';
export {
    abandonedCreates, BILL_CREATE_WAIT_MS, billAttemptJson, keptServerPaymentBills, NO_ANSWER_SKIP_MS,
    offlineRetryOutcome, pendingFirstSaves, retriedBillSaves, retryBillSave, saveBill, savedOnPhoneBills,
    sentBillAttempts, sentBillPaymentSigs, startBillSaveRun, unconfirmedBills, unconfirmedFirstSaves
} from './bill-save.js';
export {
    adoptFreshBill, billContentJson, billStateKey, deleteBill, deleteVoidedBillDoc, dropGoneBill,
    keptLiveFromServer, LATEST_BILL_TIMEOUT_MS, updateBillChecked, voidBillDoc
} from './bill-edit.js';

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
     * How a create-only save of this bill given up on (no answer in time) ended (#93):
     * 'pending' (still unknown), 'own' (it landed), 'foreign' (another phone's bill was
     * there), 'none' (it failed), or null when there was none.
     * @param {'purchases'|'retailSales'} collKey
     * @param {string} id
     * @returns {?string}
     */
    lateCreateState(collKey, id) {
        return lateCreateStates.get(`${collKey}/${id}`) || null;
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
