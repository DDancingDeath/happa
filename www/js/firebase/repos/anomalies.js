/**
 * @fileoverview Repository of anomaly records (`anomalies`, #187; owner/manager only by
 * the rules) and the audit-log range read of Diagnostics and the anomaly scan. Moved
 * verbatim out of firestore-service.js (docs/architecture.md, phase 5).
 * @module firebase/repos/anomalies
 */

import { col } from '../db.js';

/** FirebaseService methods for anomaly records and the audit-log reads of the anomaly scan; spread into FirebaseService (`this` is FirebaseService). */
export const anomalyMethods = {
    /**
     * Audit log entries since `sinceMs`, newest first (owner only by rules), read in
     * pages of `pageSize` until all are read or `max` is reached.
     * @param {number} sinceMs
     * @param {number} [max=1000]
     * @param {number} [pageSize=300]
     * @returns {Promise<Array<Object>>}
     */
    async loadAuditLogsSince(sinceMs, max = 1000, pageSize = 300) {
        const logs = [];
        let after = null;
        while (logs.length < max) {
            let query = this.db.collection(col('auditLogs'))
                .where('timestamp', '>=', sinceMs).orderBy('timestamp', 'desc');
            if (after) query = query.startAfter(after);
            const want = Math.min(pageSize, max - logs.length);
            const snapshot = await query.limit(want).get();
            snapshot.docs.forEach(doc => logs.push({ id: doc.id, ...doc.data() }));
            if (snapshot.docs.length < want) break;
            after = snapshot.docs[snapshot.docs.length - 1];
        }
        if (logs.length >= max) console.warn(`Audit log: stopped at ${max} entries since ${new Date(sinceMs).toISOString()}`);
        return logs;
    },

    /**
     * One page of anomaly records for IST days fromKey..toKey, newest day first.
     * @param {string} fromKey - YYYY-MM-DD
     * @param {string} toKey - YYYY-MM-DD
     * @param {{limit?: number, after?: Object|null, server?: boolean, cacheOnly?: boolean}} [opts] - `after` = `last`
     *   of the previous page; `server` fails instead of answering from the offline cache;
     *   `cacheOnly` answers from the offline cache only (no billed reads);
     *   otherwise: server first, offline cache when the server can't be reached
     * @returns {Promise<{docs: Array<Object>, last: Object|null, more: boolean}>}
     */
    async loadAnomalies(fromKey, toKey, { limit = 200, after = null, server = false, cacheOnly = false } = {}) {
        let query = this.db.collection(col('anomalies'))
            .where('dayKey', '>=', fromKey).where('dayKey', '<=', toKey)
            .orderBy('dayKey', 'desc').limit(limit);
        if (after) query = query.startAfter(after);
        let snapshot;
        if (cacheOnly) {
            snapshot = await query.get({ source: 'cache' });
            return { docs: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })), last: null, more: false };
        }
        try {
            snapshot = await query.get({ source: 'server' });
        } catch (e) {
            if (server) throw e;
            snapshot = await query.get({ source: 'cache' });
        }
        return {
            docs: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
            last: snapshot.docs[snapshot.docs.length - 1] || null,
            more: snapshot.size === limit
        };
    },

    /**
     * Write anomaly records with set-merge (deterministic ids: re-writing the
     * same anomaly updates it, never duplicates it).
     * @param {Array<{id: string, data: Object}>} writes
     * @returns {Promise<void>}
     */
    async saveAnomalies(writes) {
        if (!writes || writes.length === 0) return;
        const db = this.db;
        const ref = db.collection(col('anomalies'));
        for (let i = 0; i < writes.length; i += 400) {
            const batch = db.batch();
            writes.slice(i, i + 400).forEach(w => batch.set(ref.doc(w.id), w.data, { merge: true }));
            await batch.commit();
        }
    },

    /**
     * Creates only the records that don't exist yet (number-check flags, #160), each in a
     * transaction (one server read), so a flag already stored, even one reviewed a moment
     * ago on another phone, keeps its status and note.
     * @param {Array<{id: string, data: Object}>} writes - at most a few dozen
     * @returns {Promise<number>} how many were created
     */
    async addAnomaliesIfMissing(writes) {
        if (!writes || writes.length === 0) return 0;
        const ref = this.db.collection(col('anomalies'));
        let created = 0;
        for (const w of writes) {
            const doc = ref.doc(w.id);
            const made = await this.db.runTransaction(async (tx) => {
                const snap = await tx.get(doc);
                if (snap.exists) return false;
                tx.set(doc, w.data);
                return true;
            });
            if (made) created++;
        }
        return created;
    }
};
