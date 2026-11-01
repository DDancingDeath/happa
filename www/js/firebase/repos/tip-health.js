/**
 * @fileoverview Repository of Test in Production (#217): the per-device day counters
 * (`tipHealth`) and failure samples (`tipFailures`). Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5).
 * @module firebase/repos/tip-health
 */

import { getDb, col } from '../db.js';
import { buildHealthDoc, buildFailureDoc, healthDocId, failureDocId, validFailureSeq } from '../../tip/report.js';

/** FirebaseService methods for Test in Production; spread into FirebaseService (`this` is FirebaseService). */
export const tipMethods = {
    /**
     * Write TIP counters (one set+merge with FieldValue.increment per day doc)
     * and failure samples (create-only, one doc each). Failure samples whose
     * write failed for a retryable reason are returned for a later try;
     * permission-denied ones (e.g. id already used) are dropped.
     * @param {{uid: string, deviceId: string, delta: ?Object, failures: ?Array, appVersion: string, buildId: string, platform: string}} p
     * @returns {Promise<{retryFailures: Array}>}
     */
    async writeTip({ uid, deviceId, delta, failures, appVersion, buildId, platform }) {
        if (!uid) throw new Error('not signed in');
        const db = getDb();
        const fv = firebase.firestore.FieldValue;
        const inc = (n) => fv.increment(n);
        const days = Object.entries(delta || {});
        if (days.length) {
            const batch = db.batch();
            days.forEach(([day, perVersion]) => {
                batch.set(db.collection(col('tipHealth')).doc(healthDocId(deviceId, day)), buildHealthDoc({
                    deviceId, day, uid, delta: perVersion, appVersion, buildId, platform, inc, serverTime: fv.serverTimestamp()
                }), { merge: true });
            });
            await batch.commit();
        }
        const list = (failures || []).filter(f => validFailureSeq(f.seq));
        const results = await Promise.allSettled(list.map(f => db.collection(col('tipFailures')).doc(failureDocId(deviceId, f))
            .set(buildFailureDoc({ uid, deviceId, platform, failure: f, serverTime: fv.serverTimestamp() }))));
        const retryFailures = list.filter((f, i) => results[i].status === 'rejected' && results[i].reason?.code !== 'permission-denied');
        return { retryFailures };
    },

    /**
     * tipHealth docs for the Health page / Today banner: one doc per device per
     * day from `sinceDay` (YYYYMMDD) on, at most `limit` (bounded reads).
     * @returns {Promise<Array<Object>>}
     */
    async loadTipHealth({ sinceDay, untilDay = null, limit = 300 }) {
        let q = getDb().collection(col('tipHealth')).where('day', '>=', sinceDay);
        if (untilDay) q = q.where('day', '<=', untilDay);
        const snap = await q.orderBy('day', 'desc').limit(limit).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    /**
     * Latest TIP failure samples (newest first), at most `limit`.
     * @returns {Promise<Array<Object>>}
     */
    async loadTipFailures({ limit = 30 } = {}) {
        const snap = await getDb().collection(col('tipFailures')).orderBy('at', 'desc').limit(limit).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
};
