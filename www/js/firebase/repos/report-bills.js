/**
 * @fileoverview Bills read for an owner's Ask item report (#415): one bill collection, older
 * than the loaded history window, read once when the owner confirms and kept in memory for the
 * session. Never merged into AppState (the pages keep their window); the meter counts these
 * reads as "ask report".
 * @module firebase/repos/report-bills
 */

import { col, getDb } from '../db.js';
import { getWithRetry } from '../core/reads.js';
import { mapDoc } from '../core/records.js';
import { S } from '../core/session.js';
import { tagQuery } from '../firestore-meter.js';

const TAG = 'ask report';
const READS = ['purchases', 'retailSales', 'wholesaleSales'];
/** @type {Map<string, {gen: number, from: ?number, bills: Array<Object>, readAt: number}>} */
const held = new Map();

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
        return snap.docs.length ? Number(snap.docs[0].data().timestamp) : Infinity;
    },

    /**
     * The bills of this session's earlier report read that cover `from`, else null.
     * @param {string} collKey
     * @param {?number} from null = all bills
     * @returns {?{bills: Array<Object>, readAt: number}}
     */
    reportBillsInMemory(collKey, from) {
        const h = held.get(collKey);
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
        if (gen === S.sessionGen) held.set(collKey, { gen, from, bills, readAt });
        return { bills, readAt };
    },

    /** Drops the report bills held in memory (sign-out; tests). */
    forgetReportBills() {
        held.clear();
    }
};
