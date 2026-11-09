/**
 * @fileoverview Repository of worker pay (#373 phase 1): `workers/{id}`, one document per worker
 * with its pay steps and its entries (payments and advances). Owner only (firestore.rules
 * "Worker pay"). Imported with the Workers page only, never at start.
 * @module firebase/repos/workers
 */

import { getDb, col, serverCreatedAt } from '../db.js';

const coll = () => getDb().collection(col('workers'));
const fv = () => firebase.firestore.FieldValue;

/** Every worker: one read per worker (one when there are none). */
export async function loadWorkers() {
    const snap = await coll().get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * @param {{name: string, startMonth: string, pay: number}} w
 * @returns {Promise<string>} the new id
 */
export async function addWorker({ name, startMonth, pay }) {
    const ref = coll().doc();
    await ref.set({ name, startMonth, active: true, pays: [{ from: startMonth, amount: pay }], entries: [], updatedAt: serverCreatedAt() });
    return ref.id;
}

/**
 * Name, start month, pay steps or active flag.
 * @param {string} id
 * @param {{name?: string, startMonth?: string, pays?: Array<{from: string, amount: number}>, active?: boolean}} patch
 */
export async function updateWorker(id, patch) {
    await coll().doc(id).update({ ...patch, updatedAt: serverCreatedAt() });
}

/** Adds one entry (arrayUnion: two phones never overwrite each other's entries). */
export async function addEntry(id, entry) {
    await coll().doc(id).update({ entries: fv().arrayUnion(entry), updatedAt: serverCreatedAt() });
}

/** Removes one entry, exactly as loaded. */
export async function removeEntry(id, entry) {
    await coll().doc(id).update({ entries: fv().arrayRemove(entry), updatedAt: serverCreatedAt() });
}
