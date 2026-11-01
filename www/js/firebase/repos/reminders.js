/**
 * @fileoverview Repository of manual reminders (`reminders`, #86): Today
 * listens to the open ones (one query, at most 50); owners and managers
 * create and cancel them; anyone approved marks one done (for everyone).
 * Rules: firestore.rules "Manual reminders".
 * @module firebase/repos/reminders
 */

import { getDb, col, serverCreatedAt } from '../db.js';

/** FirebaseService methods for manual reminders; spread into FirebaseService. */
export const reminderMethods = {
    /**
     * Open reminders, live, soonest due first (index status + dueDate), so the limit keeps the most urgent.
     * @param {function(Array<Object>): void} onNext
     * @param {function(Error): void} onError
     * @param {number} [limit=50]
     * @returns {function(): void} unsubscribe
     */
    listenOpenReminders(onNext, onError, limit = 50) {
        return getDb().collection(col('reminders'))
            .where('status', '==', 'open')
            .orderBy('dueDate')
            .limit(limit)
            .onSnapshot(snapshot => onNext(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))), onError);
    },

    /**
     * @param {{title: string, dueDate: string, party?: string}} r checked by checkReminder()
     * @param {{uid: string, name?: string}} by
     * @returns {Promise<string>} the new id
     */
    async createReminder({ title, dueDate, party }, { uid, name }) {
        const ref = getDb().collection(col('reminders')).doc();
        const doc = { title, dueDate, status: 'open', createdBy: uid, createdAt: serverCreatedAt() };
        if (party) doc.party = party;
        if (name) doc.createdByName = String(name).slice(0, 60);
        await ref.set(doc);
        return ref.id;
    },

    /** True when the server has the reminder done or cancelled already (a refused Done / Cancel raced another phone). */
    async reminderClosed(id) {
        try {
            const snap = await getDb().collection(col('reminders')).doc(id).get({ source: 'server' });
            return snap.exists && snap.data().status !== 'open';
        } catch (_) {
            return false;
        }
    },

    /** Marks an open reminder done for everyone. */
    async ackReminder(id, { uid, name }) {
        const patch = { status: 'done', doneBy: uid, doneAt: serverCreatedAt() };
        if (name) patch.doneByName = String(name).slice(0, 60);
        await getDb().collection(col('reminders')).doc(id).update(patch);
    },

    /** Cancels an open reminder (owner / manager). */
    async cancelReminder(id, { uid, name }) {
        const patch = { status: 'cancelled', cancelledBy: uid, cancelledAt: serverCreatedAt() };
        if (name) patch.cancelledByName = String(name).slice(0, 60);
        await getDb().collection(col('reminders')).doc(id).update(patch);
    }
};
