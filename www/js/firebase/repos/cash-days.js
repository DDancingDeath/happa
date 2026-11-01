/**
 * @fileoverview Cash-drawer sessions (`cashManagement`) by day: the pages and the few
 * targeted reads the Cash page needs, one day or a range of days, opening a day once
 * (#38) and saving a whole session. Moved verbatim out of firestore-service.js
 * (docs/architecture.md, phase 5); the Cash page's checked updates are in
 * repos/cash-sessions.js.
 * @module firebase/repos/cash-days
 */

import { getDb, col } from '../db.js';
import { cashSessionDocId, sessionForDate, CASH_NEEDS_INTERNET } from '../../utils/cash-session.js';

/** Document reference of a cash session (openCashSession's transaction); `db` is FirebaseService.db. */
const cashSessionRef = (db, sessionId) => db.collection(col('cashManagement')).doc(String(sessionId));

/** FirebaseService methods for cash sessions by day; spread into FirebaseService (`this` is FirebaseService). */
export const cashDayMethods = {
    /**
     * Loads all cash management sessions from Firestore, ordered by date descending.
     * @async
     * @returns {Promise<Array<Object>>} Array of cash session objects
     */
    async loadCashSessions() {
        const snapshot = await getDb().collection(col('cashManagement')).orderBy('date', 'desc').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    /**
     * One page of cash sessions, newest first (#34): Cash Management reads the
     * latest few, and older days only when asked ("Load older").
     * @param {number} max
     * @param {?Object} [after] Last document snapshot of the previous page
     * @returns {Promise<{sessions: Object[], last: ?Object, more: boolean}>}
     */
    async loadCashSessionsPage(max, after = null) {
        let query = getDb().collection(col('cashManagement')).orderBy('date', 'desc');
        if (after) query = query.startAfter(after);
        const snapshot = await query.limit(max).get();
        return {
            sessions: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })),
            last: snapshot.docs[snapshot.docs.length - 1] || after,
            more: snapshot.docs.length === max
        };
    },

    /**
     * The few sessions Cash needs beyond the latest page (#34), each a small
     * targeted query: the newest counted day (carry-forward and the opening
     * check), past days still open (auto-close) and days closed without a
     * count (review list, newest 30).
     * @param {string} today YYYY-MM-DD
     * @returns {Promise<Object[]>}
     */
    async loadCashSessionsNeeded(today) {
        const coll = getDb().collection(col('cashManagement'));
        const rows = (snap) => snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const [counted, open, uncounted] = await Promise.all([
            coll.where('signedOut', '==', true).where('counted', '==', true).orderBy('date', 'desc').limit(1).get(),
            coll.where('signedOut', '==', false).where('date', '<', today).get(),
            coll.where('counted', '==', false).orderBy('date', 'desc').limit(30).get()
        ]);
        return [...rows(counted), ...rows(open), ...rows(uncounted)];
    },

    /**
     * Cash sessions for one local day (YYYY-MM-DD); usually one. One small
     * query instead of loadCashSessions() (which reads every session).
     * @param {string} date
     * @param {Object} [getOptions] e.g. `{ source: 'server' }`
     * @returns {Promise<Array<Object>>}
     */
    async loadCashSessionsForDate(date, getOptions) {
        const snapshot = await this.db.collection(col('cashManagement')).where('date', '==', date).get(getOptions);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },

    /**
     * Opens the day's cash session once (#38). The session lives at
     * `cash_<date>`, created in a transaction: a phone that comes second gets
     * the existing session back (`joined: true`) instead of a second one. A
     * session opened earlier that day by an older app (random id) is joined too.
     * Opening needs a connection: a write queued offline could not see another
     * phone's session and would overwrite its opening or reopen a closed day.
     * @param {Object} session New session (needs `date`)
     * @returns {Promise<{session: Object, joined: boolean}>}
     * @throws {Error} code `cash/needs-internet` when offline
     */
    async openCashSession(session) {
        const needsInternet = () => Object.assign(new Error('Open cash needs internet'), { code: CASH_NEEDS_INTERNET });
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw needsInternet();
        const ref = cashSessionRef(this.db, cashSessionDocId(session.date));
        const fresh = { ...session, id: ref.id };
        try {
            const legacy = sessionForDate(await this.loadCashSessionsForDate(session.date, { source: 'server' }), session.date);
            if (legacy) return { session: legacy, joined: true };
            return await getDb().runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (snap.exists) return { session: { id: ref.id, ...snap.data() }, joined: true };
                tx.set(ref, fresh);
                return { session: fresh, joined: false };
            });
        } catch (error) {
            if (error?.code === 'unavailable') throw needsInternet();
            throw error;
        }
    },

    /**
     * Updates an existing cash management session in Firestore.
     * @async
     * @param {Object} session - The session to update
     * @param {string} session.id - Session ID (required)
     * @returns {Promise<Object>} The updated session
     * @throws {Error} If session.id is not provided
     */
    async updateCashSession(session) {
        if (!session.id) {
            throw new Error('Session ID is required for update');
        }
        await getDb().collection(col('cashManagement')).doc(session.id).set(session);
        return session;
    },

    /**
     * Cash sessions for local days fromDate..toDate (YYYY-MM-DD, inclusive):
     * a few docs, unlike loadCashSessions() which reads every session.
     * @param {string} fromDate
     * @param {string} toDate
     * @returns {Promise<Array<Object>>}
     */
    async loadCashSessionsBetween(fromDate, toDate) {
        const snapshot = await this.db.collection(col('cashManagement'))
            .where('date', '>=', fromDate).where('date', '<=', toDate).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
};
