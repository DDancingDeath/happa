/**
 * @fileoverview Repository of recurring bills (#437 phase 1): `recurringBills/{id}`, one document per
 * bill item (electricity, water …) with its cadence and its entries (bill amounts and payments).
 * Owner only (firestore.rules "Recurring bills"). Imported with the Recurring bills page only.
 * @module firebase/repos/recurring-bills
 */

import { entryDocs } from './entry-docs.js';

const docs = () => entryDocs('recurringBills');

/** Every bill item: one read per item (one when there are none). */
export const loadBillItems = () => docs().load();

/**
 * @param {{name: string, cadence: number, dueDay: number, startMonth: string, expected: number, note: string}} item
 * @returns {Promise<string>} the new id
 */
export const addBillItem = (item) => docs().create({ ...item, active: true, endMonth: '' });

/** Name, due day, expected amount, note, cadence / first month (no entries yet) or stopped. */
export const updateBillItem = (id, patch) => docs().update(id, patch);

/** Adds one bill amount or payment (arrayUnion). */
export const addEntry = (id, entry) => docs().addEntry(id, entry);

/** Removes one payment, exactly as loaded. */
export const removeEntry = (id, entry) => docs().removeEntry(id, entry);