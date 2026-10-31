/**
 * @fileoverview Repository of error reports (`telemetry`, docs/architecture.md
 * phase 4): create-only report documents (#122), the owner's list, delete and
 * clear. services/telemetry.js groups errors and decides when to send them.
 * @module firebase/repos/telemetry
 */

const telemetry = (db) => db.collection(window.getCollection ? window.getCollection('telemetry') : 'telemetry');

/**
 * Creates one report document (rules forbid rewriting reports).
 * @param {string} id
 * @param {Object} doc
 * @returns {Promise<void>}
 */
export function saveTelemetryReport(id, doc) {
    return telemetry(firebase.firestore()).doc(id).set(doc);
}

/**
 * Newest reports first.
 * @param {number} [max=300]
 * @returns {Promise<Object[]>} `{ id, ...data }`
 */
export async function recentTelemetryReports(max = 300) {
    const snapshot = await telemetry(firebase.firestore())
        .orderBy('lastSeen', 'desc')
        .limit(max)
        .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/** Deletes every report (reads the whole collection, #159). */
export async function deleteAllTelemetryReports() {
    const db = firebase.firestore();
    const snapshot = await telemetry(db).get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    await batch.commit();
}

/**
 * Deletes report documents by id (at most 450, one batch).
 * @param {string[]} ids
 */
export async function deleteTelemetryReports(ids) {
    const db = firebase.firestore();
    const batch = db.batch();
    ids.slice(0, 450).forEach(id => batch.delete(telemetry(db).doc(id)));
    await batch.commit();
}
