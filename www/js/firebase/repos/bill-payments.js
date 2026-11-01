/**
 * @fileoverview Repository of the due-payment and write-off transactions on one bill
 * (docs/architecture.md phase 4): reads the bill (and today's cash session, when
 * given) from the server inside a transaction, lets the caller decide from that
 * fresh data, and writes what it returns. Bills are saved at doc(String(bill.id)),
 * but legacy documents may only carry an `id` field: when the transaction finds no
 * document it retries once with the one found by that field. Saving, editing and
 * voiding bills are in FirebaseService.
 * @module firebase/repos/bill-payments
 */
import { FirebaseService } from '../firestore-service.js';
import { sessionRefForTransaction } from './cash-sessions.js';

const colName = (name) => (window.getCollection ? window.getCollection(name) : name);

/**
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {string|number} billId - the bill's `id`
 * @param {?string} sessionId - today's cash session to read (and maybe update) too, or null
 * @param {function(Object, ?Object): {result: *, bill?: Object, session?: Object}} change
 *   (fresh bill data, fresh session data or null) → `bill` / `session`: fields to update
 *   (bill first), `result`: what the transaction returns. May run more than once (retries)
 *   and may throw to abort.
 * @returns {Promise<*>} change's result
 * @throws {Error} 'Transaction not found' when neither document exists
 */
export async function updateBillInTransaction(collKey, billId, sessionId, change) {
    const sessionRef = sessionId ? sessionRefForTransaction(sessionId) : null;
    const db = FirebaseService.db;
    const coll = db.collection(colName(collKey));
    let ref = coll.doc(String(billId));
    const run = () => db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const sessionSnap = sessionRef ? await tx.get(sessionRef) : null;
        if (!snap.exists) return null;
        const out = change(snap.data() || {}, sessionSnap && sessionSnap.exists ? sessionSnap.data() : null);
        if (out.bill) tx.update(ref, out.bill);
        if (out.session) tx.update(sessionRef, out.session);
        return out.result;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        const written = await run();
        if (written) return written;
        if (attempt === 0) {
            const snap = await coll.where('id', '==', billId).limit(2).get();
            if (snap.size !== 1) break;
            ref = snap.docs[0].ref;
        }
    }
    throw new Error('Transaction not found');
}

/**
 * Several bills of one collection read and updated in ONE transaction (all or
 * nothing): "Complete all due" (#150). Bills are read at their document ids; a bill
 * that is not there aborts the whole transaction.
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {Array<string|number>} billIds - document ids (FirebaseService.documentIdOf)
 * @param {function(Object[]): {result: *, bills: Array<?Object>}} change
 *   fresh bill data (same order) → `bills`: fields to update per bill (null = no write),
 *   `result`: what the transaction returns. May run more than once and may throw to abort.
 * @returns {Promise<*>} change's result
 * @throws {Error} code 'not-found' when a bill document is missing
 */
export async function updateBillsInTransaction(collKey, billIds, change) {
    const db = FirebaseService.db;
    const coll = db.collection(colName(collKey));
    const refs = billIds.map(id => coll.doc(String(id)));
    return db.runTransaction(async (tx) => {
        const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
        const missing = billIds.filter((id, i) => !snaps[i].exists);
        if (missing.length) throw Object.assign(new Error('Bill not found'), { code: 'not-found', ids: missing });
        const out = change(snaps.map(s => s.data() || {}));
        (out.bills || []).forEach((fields, i) => { if (fields) tx.update(refs[i], fields); });
        return out.result;
    });
}
