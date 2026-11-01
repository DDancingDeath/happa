/**
 * @fileoverview Whole-collection operations of Admin › Data and Storage: read a
 * collection for a backup, delete documents in batches, count documents. Moved verbatim
 * out of firestore-service.js (docs/architecture.md, phase 5).
 * @module firebase/repos/collection-admin
 */

import { getDb, col } from '../db.js';

/** FirebaseService methods for whole-collection reads and deletes; spread into FirebaseService (`this` is FirebaseService). */
export const collectionAdminMethods = {
    /**
     * Reads every document of a collection (env-prefixed) for a backup.
     * @async
     * @param {string} name unprefixed collection name
     * @returns {Promise<Array<{id: string, data: Object}>>}
     */
    async readCollectionForBackup(name) {
        const snapshot = await getDb().collection(col(name)).get();
        return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    },

    /**
     * Deletes the given documents of a collection with batched writes.
     * @async
     * @param {string} name unprefixed collection name
     * @param {Array<string>} ids
     * @returns {Promise<number>} number of documents deleted
     */
    async deleteDocsInBatches(name, ids) {
        const db = getDb();
        const ref = db.collection(col(name));
        for (let i = 0; i < ids.length; i += 450) {
            const batch = db.batch();
            ids.slice(i, i + 450).forEach(id => batch.delete(ref.doc(id)));
            await batch.commit();
        }
        return ids.length;
    },

    /** Number of documents in a collection (full read; Admin → Storage). */
    async countDocuments(name) {
        const snapshot = await getDb().collection(col(name)).get();
        return snapshot.size;
    }
};
