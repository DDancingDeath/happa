/**
 * @fileoverview Repository of the due-payment and write-off transactions on one bill
 * (docs/architecture.md phase 4): reads the bill (and today's cash session, when
 * given) from the server inside a transaction, lets the caller decide from that
 * fresh data, and writes what it returns. Bills are saved at doc(String(bill.id)),
 * but legacy documents may only carry an `id` field: when the transaction finds no
 * document it retries once with the one found by that field. Saving, editing and
 * voiding bills are in FirebaseService. A payment's audit entry can be written in the same
 * transaction (D-3), and a payment whose answer was lost is looked up on the server (D-1).
 * @module firebase/repos/bill-payments
 */
import { FirebaseService } from '../firestore-service.js';
import { sessionRefForTransaction } from './cash-sessions.js';
import { withCanonicalDue } from './bill-due.js';
import { serverCreatedAt } from '../db.js';

const colName = (name) => (window.getCollection ? window.getCollection(name) : name);

/** How long the server check after a lost answer may take before the outcome stays unknown. */
export const SERVER_CHECK_MS = 6000;

/**
 * The audit entry of a payment, written by the payment's own commit (all or nothing).
 * Its id comes from the payment entry id: a retry that finds the payment writes neither.
 * @param {*} tx
 * @param {?{id: string, data: Object}} audit
 */
function setAudit(tx, audit) {
    if (!audit) return;
    const ref = FirebaseService.db.collection(colName('auditLogs')).doc(String(audit.id));
    tx.set(ref, { ...audit.data, serverTime: serverCreatedAt() });
}

/**
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {string|number} billId - the bill's `id`
 * @param {?string} sessionId - today's cash session to read (and maybe update) too, or null
 * @param {function(Object, ?Object): {result: *, bill?: Object, session?: Object, audit?: {id: string, data: Object}}} change
 *   (fresh bill data, fresh session data or null) → `bill` / `session`: fields to update
 *   (bill first), `audit`: an audit log entry created in the same commit, `result`: what the
 *   transaction returns. May run more than once (retries) and may throw to abort.
 * @returns {Promise<*>} change's result
 * @throws {Error} 'Transaction not found' (code 'not-found') when neither document exists
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
        const data = snap.data() || {};
        const out = change(data, sessionSnap && sessionSnap.exists ? sessionSnap.data() : null);
        if (out.bill) tx.update(ref, withCanonicalDue(out.bill, data));
        if (out.session) tx.update(sessionRef, out.session);
        setAudit(tx, out.audit);
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
    throw Object.assign(new Error('Transaction not found'), { code: 'not-found' });
}

/**
 * Several bills of one collection read and updated in ONE transaction (all or
 * nothing): "Complete all due" (#150). Bills are read at their document ids; a bill
 * that is not there aborts the whole transaction.
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {Array<string|number>} billIds - document ids (FirebaseService.documentIdOf)
 * @param {function(Object[]): {result: *, bills: Array<?Object>, audit?: {id: string, data: Object}}} change
 *   fresh bill data (same order) → `bills`: fields to update per bill (null = no write),
 *   `audit`: an audit log entry created in the same commit, `result`: what the transaction returns. May run more than once and may throw to abort.
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
        const data = snaps.map(s => s.data() || {});
        const out = change(data);
        (out.bills || []).forEach((fields, i) => { if (fields) tx.update(refs[i], withCanonicalDue(fields, data[i])); });
        setAudit(tx, out.audit);
        return out.result;
    });
}

/**
 * A bill as the server has it now (not this phone's cache): what a payment whose answer
 * was lost really did (D-1). Legacy documents are found by their `id` field, as above.
 * @param {string} collKey - 'purchases' | 'retailSales' | 'wholesaleSales'
 * @param {string|number} billId - document id (or the legacy `id` field)
 * @param {number} [timeoutMs]
 * @returns {Promise<Object|false|null>} the bill's data; false: no such bill; null: the server
 *   did not answer in time (outcome still unknown)
 */
export async function readBillFromServer(collKey, billId, timeoutMs = SERVER_CHECK_MS) {
    let timer = null;
    const read = (async () => {
        const coll = FirebaseService.db.collection(colName(collKey));
        const snap = await coll.doc(String(billId)).get({ source: 'server' });
        if (snap.exists) return snap.data() || {};
        const found = await coll.where('id', '==', billId).limit(2).get({ source: 'server' });
        return found.size === 1 ? (found.docs[0].data() || {}) : false;
    })();
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
        return await Promise.race([read, late]);
    } catch (e) {
        console.warn('Server check of a payment failed:', e?.code || e);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
