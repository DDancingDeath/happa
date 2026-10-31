/**
 * @fileoverview Repository of error reports (`telemetry`, docs/architecture.md
 * phase 4): create-only report documents (#122), the owner's list, hiding
 * (#116) and the 90-day retention. services/telemetry.js
 * groups errors and decides when to send them.
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

/**
 * Deletes up to `max` reports last seen before `cutoff` (owner; retention), one batch.
 * @param {number} cutoff - ms
 * @param {number} [max=450]
 * @returns {Promise<number>} how many were deleted
 */
export async function deleteTelemetryReportsBefore(cutoff, max = 450) {
    const db = firebase.firestore();
    const snapshot = await telemetry(db).where('lastSeen', '<', cutoff).limit(max).get();
    if (snapshot.empty) return 0;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    return snapshot.size;
}

/**
 * Hides report documents (owner, #116): `hidden: true` with who and the server
 * time, in batches of 450. Nothing is deleted.
 * @param {string[]} ids
 * @param {string|null} uid
 */
export async function hideTelemetryReports(ids, uid) {
    const db = firebase.firestore();
    for (let i = 0; i < ids.length; i += 450) {
        const batch = db.batch();
        ids.slice(i, i + 450).forEach(id => batch.update(telemetry(db).doc(id), {
            hidden: true, hiddenBy: uid, hiddenAt: firebase.firestore.FieldValue.serverTimestamp()
        }));
        await batch.commit();
    }
}
