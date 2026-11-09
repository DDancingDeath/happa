/**
 * @fileoverview Expenses, business (`expenses`) and personal (`personalExpenses`, with their day
 * totals in `personalExpenseDays`, #98): saves shown at once also offline, edits, void (#99) and
 * delete. Moved verbatim out of firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/repos/expenses
 */

import {
    dayDocTotals, expenseCollectionFor, PERSONAL_DAYS_COLLECTION, personalDayFixes, personalDayKey,
    personalDaysFromRows, personalOnlineFromRows
} from '../../utils/personal-expenses.js';
import { col, getDb, serverCreatedAt } from '../db.js';
import { isActiveExpense, isOnlineExpense } from '../../utils/money.js';
import { AppState } from '../../utils/state.js';
import {
    ensureTimestamp, findRecord, forgetRecord, locateExpense, noteLocalRecordWrite, noteMonthWrite,
    replaceLiveRecord, startCreate, voidedOf
} from '../core/history-window.js';
import { EXPENSE_STORE_WAIT_MS, whenStoredLocally } from '../core/write-settle.js';
import { getWithRetry } from '../core/reads.js';
import { cleanReason } from '../../utils/bill-edits.js';
import { byDateDesc, canManageCheckpoint, docIdOf, docIds } from '../core/records.js';
import { S } from '../core/session.js';

export const personalDayOf = (rec) => rec?.day || personalDayKey(rec?.date);

/**
 * One key of personalExpenseDays/{day}: the expense's amount, or removed (amount null), and
 * its online flag (EXP-MODE, #118: set when paid online, else removed).
 * `last` names the key for firestore.rules (validPersonalDay).
 */
export function personalDayWrite(day, id, amount, online = false) {
    const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
    const remove = typeof fv?.delete === 'function' ? fv.delete() : undefined;
    const value = amount === null ? remove : amount;
    const flag = amount !== null && online ? true : remove;
    return [getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), { amounts: { [id]: value }, online: { [id]: flag }, last: id }, { merge: true }];
}

/** Adds the day-doc key of a personal expense write to a batch: set to its amount, or removed (#98). */
export function addPersonalDayWrites(batch, id, before, after) {
    const from = before ? personalDayOf(before) : null;
    const to = after ? personalDayOf(after) : null;
    if (from && from !== to) batch.set(...personalDayWrite(from, String(id), null));
    if (to && !(from === to && Number(before.amount) === Number(after.amount) && isOnlineExpense(before) === isOnlineExpense(after))) {
        batch.set(...personalDayWrite(to, String(id), Number(after.amount) || 0, isOnlineExpense(after)));
    }
}

/** Personal expense day totals read on this device: { [YYYY-MM-DD]: {total, count, at} }. */
export const personalDayCache = new Map();

/** FirebaseService expense methods; spread into FirebaseService (`this` is FirebaseService). */
export const expenseMethods = {
    /**
     * Saves an expense to Firestore.
     * @async
     * @param {Object} expense - The expense to save
     * @param {string} expense.description - Expense description
     * @param {number} expense.amount - Expense amount
     * @param {string} expense.date - Expense date
     * @param {string} [expense.category] - Expense category
     * @returns {Promise<Object>} The saved expense with ID
     */
    async saveExpense(expense) {
        const { record, committed } = this.startSaveExpense(expense);
        await committed;
        return record;
    },

    /**
     * Starts saving a new expense and shows it in AppState.expensesHistory
     * straight away (#89), without waiting for the server (works offline).
     * The listener later replaces the local copy (same doc id, no duplicate);
     * if the write fails the local copy is removed again. `stored` resolves true
     * once the write is on this device, false when this device refused it (e.g.
     * storage full, #153), null if still unconfirmed after EXPENSE_STORE_WAIT_MS.
     * @param {Object} expense
     * @param {{id?: string}} [options] - id: save again over this not-yet-confirmed expense
     * @returns {{record: Object, committed: Promise<void>, stored: Promise<boolean|null>}}
     */
    startSaveExpense(expense, { id } = {}) {
        if (!expense.userId && AppState.currentUser) {
            expense.userId = AppState.currentUser.uid;
        }
        if (!expense.userName && AppState.userName) {
            expense.userName = AppState.userName;
        }

        ensureTimestamp(expense, true);
        // Personal expenses go to their own collection, with their key in the day doc (#98)
        const collKey = expenseCollectionFor(expense);
        if (collKey !== 'expenses' && !expense.day) expense.day = personalDayKey(expense.date);
        const { record, committed, sent } = startCreate(collKey, expense, id,
            collKey === 'expenses' ? null : (batch, docId) => addPersonalDayWrites(batch, docId, null, expense));
        noteMonthWrite(collKey, null, record);
        return { record, committed, stored: whenStoredLocally(sent, EXPENSE_STORE_WAIT_MS) };
    },

    /**
     * Deletes an expense from Firestore.
     * Handles both old numeric IDs and new Firebase document IDs.
     * Also updates local AppState.expensesHistory.
     * @async
     * @param {string|number} expenseId - The ID of the expense to delete
     * @returns {Promise<void>}
     */
    async deleteExpense(expenseId) {
        // The Expenses page takes the row off the screen before this runs, so look in the collection state
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        if (collKey === 'personalExpenses') {
            const batch = getDb().batch();
            batch.delete(getDb().collection(col(collKey)).doc(where.docId));
            addPersonalDayWrites(batch, where.docId, previous, null);
            await batch.commit();
        } else if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            // Handle both old numeric IDs and new Firebase document IDs
            // Old expense with numeric ID - query by id field
            const snapshot = await getDb().collection(col('expenses')).where('id', '==', Number(expenseId)).get();
            const deletePromises = snapshot.docs.map(doc => doc.ref.delete());
            await Promise.all(deletePromises);
        } else {
            // New expense with Firebase document ID
            await getDb().collection(col('expenses')).doc(expenseId).delete();
        }
        noteMonthWrite(collKey, previous, null);
        
        forgetRecord(collKey, collKey === 'personalExpenses' ? where.docId : expenseId);
        // Update local state
        const index = AppState.expensesHistory.findIndex(e => e.id == expenseId);
        if (index !== -1) {
            AppState.expensesHistory.splice(index, 1);
        }
    },

    /**
     * Updates fields of an existing expense in place (numeric ids are legacy
     * `id` fields, others document ids) and keeps the in-memory copy in step.
     * @param {string|number} expenseId
     * @param {Object} fields
     * @returns {Promise<void>}
     */
    async updateExpense(expenseId, fields) {
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        if (collKey === 'personalExpenses') {
            const ref = getDb().collection(col(collKey)).doc(where.docId);
            const prev = where.rec;
            const batch = getDb().batch();
            batch.update(ref, fields);
            if (prev) addPersonalDayWrites(batch, where.docId, prev, { ...prev, ...fields });
            await batch.commit();
            if (prev) noteLocalRecordWrite(collKey, ref.id, { ...prev, ...fields });
            noteMonthWrite(collKey, prev, prev ? { ...prev, ...fields } : fields);
            return;
        }
        const coll = getDb().collection(col('expenses'));
        let refs;
        if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            const snapshot = await getWithRetry(coll.where('id', '==', Number(expenseId)), 'Expense lookup');
            refs = snapshot.docs.map(doc => doc.ref);
        } else {
            refs = [coll.doc(String(expenseId))];
        }
        if (refs.length === 0) throw new Error('Expense not found');
        await Promise.all(refs.map(ref => ref.update(fields)));
        refs.forEach(ref => {
            const prev = findRecord('expenses', ref.id) || findRecord('expenses', expenseId);
            if (prev) noteLocalRecordWrite('expenses', ref.id, { ...prev, ...fields });
            noteMonthWrite('expenses', prev, prev ? { ...prev, ...fields } : fields);
        });
    },

    /**
     * Voids an expense (#99): never edited or deleted in place. One transaction
     * sets voided, voidedAt (server time), voidedBy, voidedByName and voidReason;
     * a personal expense also leaves its day total (personalExpenseDays) in the
     * same write. From then on it counts in no figure (money.isActiveExpense):
     * it leaves AppState.expensesHistory (voidedExpenses() lists it). Needs a
     * connection. Throws with `code` 'reason-required' | 'not-found' | 'already-voided'.
     * @param {string|number} expenseId
     * @param {string} reason
     * @returns {Promise<Object>} the voided expense
     */
    async voidExpense(expenseId, reason) {
        const why = cleanReason(reason);
        if (!why) throw Object.assign(new Error('A reason is needed to void an expense'), { code: 'reason-required' });
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        let docId = previous ? docIdOf(previous) : where.docId;
        if (!previous && collKey === 'expenses' && /^\d+$/.test(String(expenseId))) {
            // Old-app rows carry a numeric `id` field, not their document id
            const snap = await getWithRetry(getDb().collection(col('expenses')).where('id', '==', Number(expenseId)), 'Expense lookup');
            if (snap.empty) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            docId = snap.docs[0].id;
        }
        const ref = getDb().collection(col(collKey)).doc(String(docId));
        const fields = {
            voided: true,
            voidedAt: serverCreatedAt(),
            voidedBy: AppState.currentUser?.uid || null,
            voidedByName: String(AppState.userName || '').slice(0, 200),
            voidReason: why
        };
        let stored = null;
        await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            stored = snap.data();
            if (!isActiveExpense(stored)) throw Object.assign(new Error('This expense is already voided'), { code: 'already-voided' });
            tx.update(ref, fields);
            const day = collKey === 'personalExpenses' ? personalDayOf(stored) : null;
            if (day) tx.set(...personalDayWrite(day, String(docId), null));
        });
        const voided = { ...stored, ...fields, id: previous?.id ?? stored.id ?? docId, voidedAt: Date.now() };
        docIds.set(voided, String(docId));
        noteMonthWrite(collKey, previous || stored, null);
        if (collKey === 'personalExpenses') personalDayCache.delete(personalDayOf(stored));
        replaceLiveRecord(collKey, docId, voided);
        noteLocalRecordWrite(collKey, docId, voided);
        return voided;
    },

    /**
     * Voided expenses loaded (business and personal), newest first; kept out of
     * AppState.expensesHistory so no figure counts them (#99).
     * @returns {Array<Object>}
     */
    voidedExpenses() {
        return [...voidedOf('expenses'), ...voidedOf('personalExpenses')].sort(byDateDesc);
    },

    /**
     * A day's personal expense total and count (personalExpenseDays, #98), for
     * phones whose role can't read the expenses themselves. One read, reused for
     * `maxAgeMs`; personalExpenseDay() returns the last value read, for sync readers.
     * @param {string} day YYYY-MM-DD
     * @param {{maxAgeMs?: number}} [opts]
     * @returns {Promise<?{total: number, count: number}>} null when unknown (missing or unreadable)
     */
    async loadPersonalExpenseDay(day, { maxAgeMs = 60000 } = {}) {
        const cached = personalDayCache.get(day);
        if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
        let value = null;
        try {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2, timeoutMs: 8000 });
            value = dayDocTotals(snap.exists ? snap.data() : null);
        } catch (e) {
            console.warn('Personal expense day total not loaded:', e?.code || e);
            return cached ? cached.value : null;
        }
        personalDayCache.set(day, { value, at: Date.now() });
        return value;
    },

    /**
     * The last personal expense total read for a day (loadPersonalExpenseDay), or null.
     * @param {string} day YYYY-MM-DD
     * @returns {?{total: number, count: number}}
     */
    personalExpenseDay(day) {
        return personalDayCache.get(day)?.value ?? null;
    },

    /**
     * Whether this phone has the personal expense rows: their listener started
     * and delivered its first snapshot (not just what Roles & access says now).
     * When false, the cash count and Today use the day totals and the shared
     * month snapshots are not written (#98).
     * @returns {boolean}
     */
    personalRowsLoaded() {
        const live = S.windowState?.colls?.personalExpenses?.live;
        return !!(live && live.delivered && !live.failed);
    },

    /**
     * Owner/manager: makes personalExpenseDays of these days match the loaded
     * personal rows (one read per day, one write per wrong key; none when right).
     * @param {string[]} days YYYY-MM-DD, inside the loaded history
     * @returns {Promise<number>} keys written
     */
    async rebuildPersonalExpenseDays(days) {
        if (!canManageCheckpoint() || !this.personalRowsLoaded()) return 0;
        // Rows from the phone's cache only may miss other phones' changes: never "fix" the totals from them (#59)
        if (!S.windowState.colls.personalExpenses.live.server) return 0;
        const rows = (S.windowState.colls.personalExpenses.published || []).map(r => ({ ...r, id: docIdOf(r) }));
        const want = personalDaysFromRows(rows);
        const wantOnline = personalOnlineFromRows(rows);
        let written = 0;
        for (const day of days) {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2 });
            const fixes = personalDayFixes(want[day] || {}, snap.exists ? snap.data() : null, wantOnline[day] || {});
            for (const f of fixes) {
                const [ref, data, opts] = personalDayWrite(day, f.id, f.amount, f.online);
                await ref.set(data, opts);
                written++;
            }
            personalDayCache.delete(day);
        }
        return written;
    }
};
