/**
 * @fileoverview Repository of the figures built from bills: rate trends
 * (`rateStats/{itemId}_{YYYY}`, #65, with the bill pages its backfill reads) and month
 * snapshots (`monthStats/{YYYY-MM}`, redesign §7.6); owner/manager only (rules). Moved
 * verbatim out of firestore-service.js (docs/architecture.md, phase 5).
 * @module firebase/repos/bill-stats
 */

import { getDb, col, voidAwareStamp } from '../db.js';

/** FirebaseService methods for figures built from bills; spread into FirebaseService (`this` is FirebaseService). */
export const billStatsMethods = {
    /**
     * One page of a bill collection in document-id order, from the server
     * (rate-trends backfill). Billed reads = docs returned (min 1).
     * @param {string} collKey purchases | retailSales | wholesaleSales
     * @param {?string} after last document id of the previous page
     * @param {number} limit
     * @returns {Promise<{docs: Array<Object>, reads: number}>}
     */
    async loadBillPageById(collKey, after, limit) {
        let query = getDb().collection(col(collKey))
            .orderBy(firebase.firestore.FieldPath.documentId())
            .limit(limit);
        if (after) query = query.startAfter(after);
        const snapshot = await query.get({ source: 'server' });
        return { docs: snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })), reads: Math.max(1, snapshot.size) };
    },

    /**
     * Oldest numeric bill timestamp across the three bill collections (3 reads).
     * @returns {Promise<number>} ms, or Infinity when there are no bills
     */
    async oldestBillTimestamp() {
        const db = getDb();
        const values = await Promise.all(['purchases', 'retailSales', 'wholesaleSales'].map(key =>
            db.collection(col(key)).orderBy('timestamp', 'asc').limit(1).get()
                .then(s => (s.docs.length ? Number(s.docs[0].data().timestamp) : Infinity))));
        return Math.min(...values);
    },

    /**
     * Year stats docs of one item (document-id range, no index needed):
     * one read per year of history.
     * @param {string} itemId
     * @param {number} [max=30]
     * @returns {Promise<Array<Object>>} oldest year first
     */
    async loadRateStatsForItem(itemId, max = 30) {
        const snapshot = await getDb().collection(col('rateStats'))
            .orderBy(firebase.firestore.FieldPath.documentId())
            .startAt(`${itemId}_`)
            .endAt(`${itemId}_\uf8ff`)
            .limit(max)
            .get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(d => /^\d{4}$/.test(String(d.year || '')));
    },

    /**
     * Year stats docs of every item for one year (single-field equality, so no
     * composite index is needed). Bounded: at most `max` reads.
     * @param {string} year YYYY
     * @param {number} [max=300]
     * @returns {Promise<{docs: Array<Object>, more: boolean}>}
     */
    async loadRateStatsForYear(year, max = 300) {
        const snapshot = await getDb().collection(col('rateStats'))
            .where('year', '==', String(year))
            .limit(max)
            .get();
        return { docs: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })), more: snapshot.size >= max };
    },

    /**
     * Year stats docs of years >= fromYear from the SERVER (never the offline
     * cache), bounded, so a roll-forward compares with what everyone sees.
     * @param {string} fromYear YYYY
     * @param {number} [max=300]
     * @returns {Promise<{docs: Array<Object>, more: boolean}>}
     */
    async loadServerRateStatsFromYear(fromYear, max = 300) {
        const snapshot = await getDb().collection(col('rateStats'))
            .where('year', '>=', String(fromYear))
            .limit(max)
            .get({ source: 'server' });
        return { docs: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })), more: snapshot.size >= max };
    },

    /**
     * Writes whole stats docs (set, so re-running is idempotent), 400 per batch.
     * @param {Array<{id: string, data: Object}>} writes
     * @returns {Promise<void>}
     */
    async saveRateStats(writes) {
        if (!writes || writes.length === 0) return;
        const db = getDb();
        const ref = db.collection(col('rateStats'));
        const updatedAt = Date.now();
        for (let i = 0; i < writes.length; i += 400) {
            const batch = db.batch();
            writes.slice(i, i + 400).forEach(w => batch.set(ref.doc(w.id), { ...w.data, updatedAt, ...voidAwareStamp() }));
            await batch.commit();
        }
    },

    /**
     * Backfill status doc (rateStats/_meta), or null when it doesn't exist.
     * @param {{server?: boolean}} [opts]
     * @returns {Promise<?Object>}
     */
    async loadRateStatsMeta({ server = false } = {}) {
        const ref = getDb().collection(col('rateStats')).doc('_meta');
        const snap = server ? await ref.get({ source: 'server' }) : await ref.get();
        return snap.exists ? snap.data() : null;
    },

    /**
     * @param {Object} data merged into rateStats/_meta
     * @returns {Promise<void>}
     */
    async saveRateStatsMeta(data) {
        await getDb().collection(col('rateStats')).doc('_meta').set({ ...data, ...voidAwareStamp() }, { merge: true });
    },

    /**
     * Month snapshot docs from `fromMonth` on (document-id range, no index): at most `max` reads.
     * @param {string} fromMonth 'YYYY-MM'
     * @param {number} [max=40]
     * @returns {Promise<Object<string, Object>>} month → doc
     */
    async loadMonthStats(fromMonth, max = 40) {
        const snapshot = await getDb().collection(col('monthStats'))
            .orderBy(firebase.firestore.FieldPath.documentId())
            .startAt(String(fromMonth))
            .limit(max)
            .get();
        const out = {};
        snapshot.docs.forEach(doc => { if (/^\d{4}-\d{2}$/.test(doc.id)) out[doc.id] = { ...doc.data(), month: doc.id }; });
        return out;
    },

    /**
     * Writes whole month snapshots (set, idempotent), 400 per batch.
     * @param {Array<Object>} docs buildSnapshot() results
     * @returns {Promise<void>}
     */
    async saveMonthStats(docs) {
        if (!docs || docs.length === 0) return;
        const db = getDb();
        const ref = db.collection(col('monthStats'));
        for (let i = 0; i < docs.length; i += 400) {
            const batch = db.batch();
            docs.slice(i, i + 400).forEach(d => batch.set(ref.doc(d.month), { ...d, ...voidAwareStamp() }));
            await batch.commit();
        }
    },

    /**
     * Writes a rebuilt month snapshot over a stale one, in a transaction (1 read + 1 write):
     * skipped when it was marked stale again since `staleAt` (that change may not be in this
     * device's bills) or is no longer stale (another device rebuilt it).
     * @param {Object} doc buildSnapshot() result
     * @param {*} staleAt the `staleAt` of the stale mark this device saw
     * @returns {Promise<{status: 'written'|'newer'|'fresh', doc: Object}>} doc = what is stored now
     */
    async rebuildMonthStat(doc, staleAt) {
        const db = getDb();
        const ref = db.collection(col('monthStats')).doc(doc.month);
        return db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const stored = snap.exists ? { ...snap.data(), month: doc.month } : null;
            if (stored && !stored.stale) return { status: 'fresh', doc: stored };
            if (stored && stored.staleAt !== staleAt) return { status: 'newer', doc: stored };
            tx.set(ref, { ...doc, ...voidAwareStamp() });
            return { status: 'written', doc };
        });
    },

    /**
     * Writes a month snapshot unless the stored one carries a stale mark this device has not
     * handled (`handled` = { staleAt } of a mark whose change is in this device's bills), in a
     * transaction (1 read + 1 write). Build month history writes older months this way, so a mark
     * set by another phone after this one loaded the snapshots is never overwritten.
     * @param {Object} doc buildSnapshot() result
     * @param {?{staleAt: *}} handled
     * @returns {Promise<{status: 'written'|'newer', doc: Object}>} doc = what is stored now
     */
    async saveMonthStatGuarded(doc, handled = null) {
        const db = getDb();
        const ref = db.collection(col('monthStats')).doc(doc.month);
        return db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const stored = snap.exists ? { ...snap.data(), month: doc.month } : null;
            if (stored?.stale && !(handled && stored.staleAt === handled.staleAt)) return { status: 'newer', doc: stored };
            tx.set(ref, { ...doc, ...voidAwareStamp() });
            return { status: 'written', doc };
        });
    }
};
