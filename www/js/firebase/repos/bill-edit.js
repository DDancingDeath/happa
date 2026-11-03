/**
 * @fileoverview Changes to a saved bill: checked edits with their edit records (#121), void and
 * delete (#75). Moved out of repos/bills.js (#69).
 * @module firebase/repos/bill-edit
 */

import { CLIENT_VERSION, col, getDb, serverCreatedAt } from '../db.js';
import {
    billEditChanges, cleanReason, editCountOf, editRecord, hasEditChanges, nextEditNumber, voidBlocker
} from '../../utils/bill-edits.js';
import { AppState } from '../../utils/state.js';
import { docIdOf, HISTORY_SPEC, LOADED_PAYMENT, paymentSignature } from '../core/records.js';
import {
    findRecord, forgetRecord, noteLocalRecordWrite, noteMonthWrite, prepareStockRecord
} from '../core/history-window.js';
import { noteStockWrite } from '../core/stock-checkpoint.js';
import { isActiveBill } from '../../utils/money.js';
import { getWithRetry } from '../core/reads.js';
import { billEditsRef, keepEditCount, keepStoredCreatedAt } from './bill-fields.js';

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

/** FirebaseService methods that change a saved bill; spread into FirebaseService (`this` is FirebaseService). */
export const billEditMethods = {
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
    }
};
