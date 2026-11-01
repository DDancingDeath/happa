/**
 * @fileoverview Property expenses data (#157, RENT-17): rent_expenses/{id}
 * {propertyId, unitId, category, amount, date, month, mode, note, byName,
 * created*, updated*}. Anyone with a rentals role adds one; only the owner edits
 * or deletes (rules). Loaded with rent-expense.js (import() on first use). Never
 * the Aadhat cash drawer or Aadhat expenses.
 * @module rentals/rent-expense-store
 */

import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { rentCol, uid, clip } from './rent-store.js';

const coll = () => FirebaseService.db.collection(rentCol('rent_expenses'));

/** A property's newest expenses (one bounded query; index propertyId + date desc). */
export async function listExpenses(propertyId, max = 60) {
    const snap = await coll().where('propertyId', '==', propertyId).orderBy('date', 'desc').limit(max).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Adds an expense (a plain write: works offline). `e`: {propertyId, unitId, category, amount, date, mode, note}. */
export function addExpense(e) {
    const now = Date.now();
    return coll().doc().set({
        propertyId: e.propertyId, unitId: e.unitId || null, category: e.category, amount: e.amount,
        date: e.date, month: e.date.slice(0, 7), mode: e.mode, note: clip(e.note, 200), byName: clip(AppState.userName, 80),
        createdAt: now, createdBy: uid(), updatedAt: now, updatedBy: uid()
    });
}

/** Owner: corrects an expense (category, unit, amount, date, mode, note). */
export function updateExpense(id, e) {
    return coll().doc(id).update({
        unitId: e.unitId || null, category: e.category, amount: e.amount, date: e.date, month: e.date.slice(0, 7),
        mode: e.mode, note: clip(e.note, 200), updatedAt: Date.now(), updatedBy: uid()
    });
}

/** Owner: removes an expense. */
export const deleteExpense = (id) => coll().doc(id).delete();
