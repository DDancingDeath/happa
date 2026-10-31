/**
 * @fileoverview Repository of cash-drawer sessions (`cashManagement/{id}`) for the
 * Cash page's writes (docs/architecture.md phase 4): checked updates in a
 * transaction (auto-close, late count), field updates (close) and entries added
 * with arrayUnion (deposits, "No bill" legs), so another device's additions are
 * never overwritten. Reads and opening a day are in FirebaseService
 * (loadCashSessions, openCashSession…).
 * @module firebase/repos/cash-sessions
 */
import { FirebaseService } from '../firestore-service.js';

const sessionRef = (sessionId) => {
    const name = window.getCollection ? window.getCollection('cashManagement') : 'cashManagement';
    return FirebaseService.db.collection(name).doc(String(sessionId));
};

/** FirebaseService's col(): the env prefix from window.COLLECTION_PREFIX. */
const prefixed = (name) => (window.COLLECTION_PREFIX || '') + name;

/**
 * A session's document reference for another repository's transaction (bill-payments:
 * the drawer leg of a due payment). Named with FirebaseService's prefix
 * (`window.COLLECTION_PREFIX`, the same as getCollection in the app). Never given to pages.
 * @param {string} sessionId
 */
export const sessionRefForTransaction = (sessionId) => FirebaseService.db
    .collection(prefixed('cashManagement')).doc(String(sessionId));

/**
 * Re-reads a session in a transaction and writes `fieldsFor(fresh)`, so a session
 * changed on another device (e.g. closed) since it was loaded is never clobbered.
 * Needs the server (fails offline).
 * @param {string} sessionId
 * @param {function(Object): ?Object} fieldsFor - fresh session (`{ id, ...data }`) → fields to
 *   update, or null to write nothing
 * @returns {Promise<?Object>} the session with the fields written, or null (missing / nothing written)
 */
export function updateSessionChecked(sessionId, fieldsFor) {
    const ref = sessionRef(sessionId);
    return FirebaseService.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const fresh = { id: snap.id, ...snap.data() };
        const fields = fieldsFor(fresh);
        if (!fields) return null;
        tx.update(ref, fields);
        return { ...fresh, ...fields };
    });
}

/**
 * Field-level update (never the whole document). Not async: queued on the phone at once.
 * @param {string} sessionId
 * @param {Object} fields
 * @returns {Promise<void>} the server acknowledgement
 */
export function updateSession(sessionId, fields) {
    return sessionRef(sessionId).update(fields);
}

/**
 * Adds one entry to a list field with arrayUnion (queued offline; entries added on
 * other devices are kept). Not async: queued on the phone at once.
 * @param {string} sessionId
 * @param {'cashDeposits'|'duePayments'} field
 * @param {Object} entry
 * @returns {Promise<void>} the server acknowledgement
 */
export function addSessionEntry(sessionId, field, entry) {
    return sessionRef(sessionId).update({
        [field]: firebase.firestore.FieldValue.arrayUnion(entry)
    });
}
