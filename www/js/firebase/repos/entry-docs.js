/**
 * @fileoverview Owner-only documents that each keep an append-only list of entries (worker pay
 * #373, recurring bills #437): one query per page open, entries added with arrayUnion and removed
 * one at a time exactly as loaded, so two phones never overwrite each other's entries.
 * @module firebase/repos/entry-docs
 */

import { getDb, col, serverCreatedAt } from '../db.js';

/** @param {string} name collection name; col() resolves it for this environment */
export function entryDocs(name) {
    const coll = () => getDb().collection(col(name));
    const fv = () => firebase.firestore.FieldValue;
    const stamp = () => ({ updatedAt: serverCreatedAt() });
    return {
        /** Every document: one read each (one when there are none). */
        async load() {
            const snap = await coll().get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },
        /** A new document with no entries; returns its id. */
        async create(data) {
            const ref = coll().doc();
            await ref.set({ ...data, entries: [], ...stamp() });
            return ref.id;
        },
        async update(id, patch) {
            await coll().doc(id).update({ ...patch, ...stamp() });
        },
        async addEntry(id, entry) {
            await coll().doc(id).update({ entries: fv().arrayUnion(entry), ...stamp() });
        },
        async removeEntry(id, entry) {
            await coll().doc(id).update({ entries: fv().arrayRemove(entry), ...stamp() });
        }
    };
}
