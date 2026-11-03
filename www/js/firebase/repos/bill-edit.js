/**
 * @fileoverview Changes to a saved bill: checked edits with their edit records (#121), void and
 * delete (#75), and the server copy read before an edit (#127). Moved verbatim out of
 * repos/bills.js (#69).
 * @module firebase/repos/bill-edit
 */

import { CLIENT_VERSION, col, getDb, serverCreatedAt } from '../db.js';
import {
    billEditChanges, cleanReason, editCountOf, editRecord, hasEditChanges, nextEditNumber, voidBlocker
} from '../../utils/bill-edits.js';
import { AppState } from '../../utils/state.js';
import { docIdOf, LOADED_PAYMENT, paymentSignature, stableJson } from '../core/records.js';
import {
    findRecord, forgetRecord, liveIdSet, noteLocalRecordWrite, noteMonthWrite, prepareStockRecord,
    publishCollection
} from '../core/history-window.js';
import { noteObservedChange, noteStockWrite } from '../core/stock-checkpoint.js';
import { isActiveBill } from '../../utils/money.js';
import { getWithRetry } from '../core/reads.js';
import { S } from '../core/session.js';
import { markDirty } from '../core/realtime.js';
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
