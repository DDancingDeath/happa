/**
 * @fileoverview Repository of worker pay (#373 phase 1): `workers/{id}`, one document per worker
 * with its pay steps and its entries (payments and advances). Owner only (firestore.rules
 * "Worker pay"). Imported with the Workers page only, never at start.
 * @module firebase/repos/workers
 */

import { entryDocs } from './entry-docs.js';

const docs = () => entryDocs('workers');

/** Every worker: one read per worker (one when there are none). */
export const loadWorkers = () => docs().load();

/**
 * @param {{name: string, startMonth: string, pay: number}} w
 * @returns {Promise<string>} the new id
 */
export const addWorker = ({ name, startMonth, pay }) => docs().create({ name, startMonth, active: true, pays: [{ from: startMonth, amount: pay }] });

/**
 * Name, start month, pay steps or active flag.
 * @param {string} id
 * @param {{name?: string, startMonth?: string, pays?: Array<{from: string, amount: number}>, active?: boolean}} patch
 */
export const updateWorker = (id, patch) => docs().update(id, patch);

/** Adds one entry (arrayUnion: two phones never overwrite each other's entries). */
export const addEntry = (id, entry) => docs().addEntry(id, entry);

/** Removes one entry, exactly as loaded. */
export const removeEntry = (id, entry) => docs().removeEntry(id, entry);