/**
 * @fileoverview Bills (purchases, retail and wholesale sales), split by responsibility (#69):
 * bill-save.js (first save with a client-made id and its retry: #70, #153; create-only: #93),
 * bill-edit.js (checked edits with their edit records: #121; void and delete: #75),
 * bill-fields.js (shared fields), and here the reads: the server copy before an edit (#127),
 * voided bills and edit records. This module re-exports the others' functions
 * (docs/architecture.md, phase 5).
 * @module firebase/repos/bills
 */

import { col, getDb } from '../db.js';
import { editCountOf } from '../../utils/bill-edits.js';
import { docIdOf, HISTORY_SPEC, mapDoc, paymentSignature, stableJson } from '../core/records.js';
import {
    findRecord, forgetRecord, liveIdSet, publishCollection, voidedOf
} from '../core/history-window.js';
import { noteObservedChange } from '../core/stock-checkpoint.js';
import { isActiveBill } from '../../utils/money.js';
import { getWithRetry } from '../core/reads.js';
import { S } from '../core/session.js';
import { markDirty } from '../core/realtime.js';
import { billEditsRef } from './bill-fields.js';

export * from './bill-fields.js';
export {
    abandonedCreates, BILL_CREATE_WAIT_MS, billAttemptJson, keptServerPaymentBills, NO_ANSWER_SKIP_MS,
    offlineRetryOutcome, pendingFirstSaves, retriedBillSaves, retryBillSave, saveBill, savedOnPhoneBills,
    sentBillAttempts, sentBillPaymentSigs, startBillSaveRun, unconfirmedBills, unconfirmedFirstSaves
} from './bill-save.js';
export { deleteBill, deleteVoidedBillDoc, updateBillChecked, voidBillDoc } from './bill-edit.js';

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

/** FirebaseService bill reads; spread into FirebaseService (`this` is FirebaseService). */
export const billMethods = {
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
