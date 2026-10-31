/**
 * @fileoverview Repository of the audit log (`auditLogs`, docs/architecture.md
 * phase 4): adds entries with the server time the rules require (#55), reads the
 * recent ones and deletes old ones. services/audit.js decides what to log and when.
 * @module firebase/repos/audit-logs
 */

const auditLogs = () => firebase.firestore()
    .collection(window.getCollection ? window.getCollection('auditLogs') : 'auditLogs');

const rows = (snapshot) => snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

/**
 * Adds one entry; `serverTime` is the server's request time (firestore.rules
 * require it). Not async: the entry is queued on the phone at once.
 * @param {Object} entry
 * @returns {Promise} the server acknowledgement
 */
export function addAuditLog(entry) {
    return auditLogs().add({ ...entry, serverTime: firebase.firestore.FieldValue.serverTimestamp() });
}

/**
 * Newest entries, optionally only one user's or one action's.
 * @param {{userId?: string, action?: string, limit: number}} q
 * @returns {Promise<Object[]>} `{ id, ...data }`, newest first
 */
export async function recentAuditLogs(q) {
    let query = auditLogs();
    if ('userId' in q) query = query.where('userId', '==', q.userId);
    if ('action' in q) query = query.where('action', '==', q.action);
    const snapshot = await query
        .orderBy('timestamp', 'desc')
        .limit(q.limit)
        .get();
    return rows(snapshot);
}

/**
 * Deletes up to `max` entries older than `cutoff` in one batch.
 * @param {number} cutoff - ms
 * @param {number} [max=100]
 * @returns {Promise<number>} how many were deleted
 */
export async function deleteAuditLogsBefore(cutoff, max = 100) {
    const snapshot = await auditLogs()
        .where('timestamp', '<', cutoff)
        .limit(max)
        .get();
    if (snapshot.empty) return 0;
    const batch = firebase.firestore().batch();
    snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    return snapshot.size;
}
