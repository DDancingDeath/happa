/**
 * @fileoverview Repository of the item list (`items`) and its rate history
 * (`rateHistory`, #82): moved verbatim out of firestore-service.js (docs/architecture.md,
 * phase 5); still called as FirebaseService.loadItems() etc.
 * @module firebase/repos/items
 */

import { getDb, col } from '../db.js';
import { historyIdBound } from '../../utils/rate-history.js';
import { AppState } from '../../utils/state.js';
import { changedElsewhereError, isOffline, needsInternetError } from '../../utils/write-conflict.js';

/** Changed only by setItemArchived (#123): an item save never writes them. */
const ITEM_ARCHIVE_FIELDS = ['archived', 'archivedAt', 'archivedBy', 'archivedByUserId', 'unarchivedAt', 'unarchivedBy', 'unarchivedByUserId'];

/** FirebaseService methods for the item list and its rate history; spread into FirebaseService (`this` is FirebaseService). */
export const itemMethods = {
    /**
     * Loads all items from Firestore.
     * @async
     * @returns {Promise<Array<{id: string, name: string, hindiName?: string, rate?: number}>>} Array of item objects
     */
    async loadItems() {
        const snapshot = await getDb().collection(col('items')).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    /**
     * Saves an item to Firestore. Creates new if no ID, updates if ID exists.
     * @async
     * @param {Object} item - The item to save
     * @param {string} [item.id] - Item ID (if updating existing)
     * @param {string} item.name - Item name
     * @param {string} [item.hindiName] - Item name in Hindi
     * @param {number} [item.rate] - Default rate for the item
     * @param {{expectedRev?: number}} [opts] expectedRev: the item's `rev` when it was
     *   opened for editing; the save is a transaction that refuses it (code
     *   'changed-elsewhere') when another phone saved the item since (#113), and
     *   needs the internet. Without it: a plain merge (imports, older callers).
     * @returns {Promise<Object>} The saved item with ID (and its new `rev`)
     */
    async saveItem(item, { expectedRev } = {}) {
        if (item.id) {
            // merge, and never the archive fields: a stale phone's save can't drop or flip them (#123)
            const data = { ...item };
            ITEM_ARCHIVE_FIELDS.forEach(f => delete data[f]);
            delete data.rev;
            const ref = getDb().collection(col('items')).doc(item.id);
            if (expectedRev === undefined) {
                await ref.set(data, { merge: true });
                return item;
            }
            if (isOffline()) throw needsInternetError();
            let rev = 0;
            await getDb().runTransaction(async tx => {
                const snap = await tx.get(ref);
                const current = snap.exists ? (Number(snap.data().rev) || 0) : 0;
                if (!snap.exists || current !== (Number(expectedRev) || 0)) throw changedElsewhereError('Item');
                rev = current + 1;
                tx.set(ref, { ...data, rev }, { merge: true });
            });
            item.rev = rev;
        } else {
            const docRef = await getDb().collection(col('items')).add(item);
            item.id = docRef.id;
        }
        return item;
    },

    /**
     * Archives or unarchives an item (#123): one field-level update, so other
     * fields changed on another phone are kept. Items are never deleted.
     * @async
     * @param {string} itemId
     * @param {boolean} archived
     * @returns {Promise<Object>} the fields written
     */
    async setItemArchived(itemId, archived) {
        const by = AppState.userName || AppState.currentUser?.email || '';
        const byUserId = AppState.currentUser?.uid || '';
        const fields = archived
            ? { archived: true, archivedAt: Date.now(), archivedBy: by, archivedByUserId: byUserId }
            : { archived: false, unarchivedAt: Date.now(), unarchivedBy: by, unarchivedByUserId: byUserId };
        await getDb().collection(col('items')).doc(itemId).update(fields);
        return fields;
    },

    /**
     * Appends item rate/name history entries (#82) in one batch. Entries are
     * create-only (rules forbid update/delete); ids sort newest first per item.
     * @async
     * @param {Array<{id: string, data: Object}>} entries
     * @returns {Promise<void>}
     */
    async addRateHistoryEntries(entries) {
        if (!entries || entries.length === 0) return;
        const db = getDb();
        const ref = db.collection(col('rateHistory'));
        const batch = db.batch();
        entries.forEach(e => batch.set(ref.doc(e.id), e.data));
        await batch.commit();
    },

    /**
     * Reads the newest history entries of one item (document-id range, so no
     * composite index is needed). Owner/manager only (rules).
     * @async
     * @param {string} itemId
     * @param {number} [max=30]
     * @param {{since?: number}} [opts] only entries newer than this (ms)
     * @returns {Promise<Array<Object>>} newest first
     */
    async loadRateHistory(itemId, max = 30, { since = null } = {}) {
        let query = getDb().collection(col('rateHistory'))
            .orderBy(firebase.firestore.FieldPath.documentId())
            .startAt(`${itemId}_`);
        query = Number(since) > 0 ? query.endBefore(historyIdBound(itemId, Number(since))) : query.endAt(`${itemId}_\uf8ff`);
        const snapshot = await query.limit(max).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    /**
     * Applies an item import plan with batched writes (merge updates + new
     * docs). Never deletes. One batch for typical catalogues, so a failure
     * leaves the catalogue unchanged; very large imports are chunked.
     * @async
     * @param {Array<{id: string, fields: Object}>} updates
     * @param {Array<{fields: Object}>} adds
     * @returns {Promise<Array<Object>>} the added items with their new ids
     */
    async importItems(updates, adds) {
        const db = getDb();
        const ref = db.collection(col('items'));
        const ops = [
            // An import is a change too: an item dialog open elsewhere then can't save over it (#113)
            ...(updates || []).map(u => ({ doc: ref.doc(u.id), data: { ...u.fields, rev: firebase.firestore.FieldValue.increment(1) }, merge: true })),
            ...(adds || []).map(a => ({ doc: ref.doc(), data: a.fields, merge: false }))
        ];
        const added = [];
        for (let i = 0; i < ops.length; i += 450) {
            const batch = db.batch();
            ops.slice(i, i + 450).forEach(op => {
                if (op.merge) batch.set(op.doc, op.data, { merge: true });
                else {
                    batch.set(op.doc, op.data);
                    added.push({ ...op.data, id: op.doc.id });
                }
            });
            await batch.commit();
        }
        return added;
    }
};
