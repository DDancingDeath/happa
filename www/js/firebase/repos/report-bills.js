/**
 * @fileoverview Bills read for an owner's Ask item report (#415): one bill collection, older
 * than the loaded history window, read once when the owner confirms and kept in memory for the
 * session. Never merged into AppState (the pages keep their window); the meter counts these
 * reads as "ask report". Also the item year stats behind an Ask quick figure (no bills read).
 * @module firebase/repos/report-bills
 */

import { col, getDb } from '../db.js';
import { getWithRetry } from '../core/reads.js';
import { mapDoc } from '../core/records.js';
import { S } from '../core/session.js';
import { tagQuery } from '../firestore-meter.js';

const TAG = 'ask report';
const READS = ['purchases', 'retailSales', 'wholesaleSales'];

const covers = (/** @type {?{from: ?number}} */ h, /** @type {?number} */ from) => !!h && (h.from === null || (from !== null && from >= h.from));

/** FirebaseService methods for Ask item reports; spread into FirebaseService. */
export const reportBillMethods = {
    /**
     * Oldest numeric `timestamp` of a bill collection (1 read).
     * @param {string} collKey purchases | retailSales | wholesaleSales
     * @returns {Promise<number>} Infinity when it has none
     */
    async oldestBillTime(collKey) {
        if (!READS.includes(collKey)) throw new Error(`Not a bill collection: ${collKey}`);
        const snap = await getWithRetry(a => tagQuery(getDb().collection(col(collKey)).orderBy('timestamp', 'asc').limit(1 + a), TAG), `${collKey} oldest`);
        // The phone's cache holds only the loaded window: its oldest bill would make the estimate far too low.
        if (snap.metadata?.fromCache) throw Object.assign(new Error('The oldest bill could not be read from the server'), { code: 'unavailable' });
        return snap.docs.length ? Number(snap.docs[0].data().timestamp) : Infinity;
    },

    /**
     * The bills of this session's earlier report read that cover `from`, else null.
     * @param {string} collKey
     * @param {?number} from null = all bills
     * @returns {?{bills: Array<Object>, readAt: number}}
     */
    reportBillsInMemory(collKey, from) {
        const h = S.reportBills.get(collKey);
        if (!h || h.gen !== S.sessionGen) return null;
        return covers(h, from) ? { bills: h.bills, readAt: h.readAt } : null;
    },

    /**
     * Reads a bill collection from `from` on (null = every bill, unfiltered so records
     * without a numeric `timestamp` come too), from the server. Voided bills are kept:
     * the report leaves them out like every figure.
     * @param {string} collKey
     * @param {?number} from
     * @returns {Promise<{bills: Array<Object>, readAt: number}>}
     */
    async readReportBills(collKey, from) {
        if (!READS.includes(collKey)) throw new Error(`Not a bill collection: ${collKey}`);
        const kept = this.reportBillsInMemory(collKey, from);
        if (kept) return kept;
        const gen = S.sessionGen;
        const readAt = Date.now();
        const snap = await getWithRetry((a) => {
            let q = getDb().collection(col(collKey));
            if (from !== null) q = q.where('timestamp', '>=', from);
            return tagQuery(a ? q.limit(100000 + a) : q, TAG);
        }, `${collKey} report`);
        if (snap.metadata?.fromCache) throw Object.assign(new Error('Older bills could not be read from the server'), { code: 'unavailable' });
        const bills = snap.docs.map(mapDoc);
        if (gen === S.sessionGen) S.reportBills.set(collKey, { gen, from, bills, readAt });
        return { bills, readAt };
    },

    /** Drops the report bills held in memory (tests). */
    forgetReportBills() {
        S.reportBills.clear();
        S.reportStats = null;
    },

    /**
     * Insights › Seasons' year stats (`rateStats/{itemId}_{YYYY}`) of these catalogue items, for
     * an Ask quick figure: from the server, kept for the session. Billed reads: 1 for `_meta` once,
     * then per item not yet held its year docs (min 1).
     * @param {string[]} itemIds
     * @returns {Promise<?{docs: Array<Object>, meta: Object}>} null when the history from bills was never built
     */
    async reportItemStats(itemIds) {
        const gen = S.sessionGen;
        if (S.reportStats?.gen !== gen) S.reportStats = { gen, meta: undefined, items: new Map() };
        const held = S.reportStats;
        const fromServer = (snap) => {
            // The phone's cache may hold only some years: the figure would quietly be too low.
            if (snap.metadata?.fromCache) throw Object.assign(new Error('Item stats could not be read from the server'), { code: 'unavailable' });
            return snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
        };
        const byId = (start, end, limit) => tagQuery(getDb().collection(col('rateStats'))
            .orderBy(firebase.firestore.FieldPath.documentId()).startAt(start).endAt(end).limit(limit), TAG);
        if (held.meta === undefined) {
            const [meta] = fromServer(await getWithRetry(() => byId('_meta', '_meta', 1), 'rateStats meta'));
            held.meta = meta || null;
        }
        if (!held.meta?.backfillDone) return null;
        const ids = [...new Set(itemIds)];
        await Promise.all(ids.filter(id => !held.items.has(id)).map(async (id) => {
            const docs = fromServer(await getWithRetry(() => byId(`${id}_`, `${id}_\uf8ff`, 40), `rateStats ${id}`));
            held.items.set(id, docs.filter(d => d.itemId === id && /^\d{4}$/.test(String(d.year || ''))));
        }));
        if (gen !== S.sessionGen) return null;
        return { docs: ids.flatMap(id => held.items.get(id) || []), meta: held.meta };
    }
};
