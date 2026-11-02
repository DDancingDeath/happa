/**
 * @fileoverview Repository of manual reminders (`reminders`, #86): Today
 * listens to the open ones (one query, at most 50); owners and managers
 * create, edit and cancel them; anyone approved marks one done (for everyone),
 * which also creates the next copy of a repeating one in the same batch.
 * Rules: firestore.rules "Manual reminders".
 * @module firebase/repos/reminders
 */

import { getDb, col, serverCreatedAt } from '../db.js';

/** Optional fields of a reminder: set when given, removed (on an edit) when empty. */
const optional = (doc, { party, repeat, repeatDay }, remove) => {
    const del = remove ? firebase.firestore.FieldValue.delete() : undefined;
    const put = (k, v) => { if (v) doc[k] = v; else if (remove) doc[k] = del; };
    put('party', party);
    put('repeat', repeat);
    put('repeatDay', repeat === 'monthly' ? repeatDay : null);
    return doc;
};

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
    async createReminder({ title, dueDate, party, repeat, repeatDay }, { uid, name }) {
        const ref = getDb().collection(col('reminders')).doc();
        const doc = optional({ title, dueDate, status: 'open', createdBy: uid, createdAt: serverCreatedAt() }, { party, repeat, repeatDay }, false);
        if (name) doc.createdByName = String(name).slice(0, 60);
        await ref.set(doc);
        return ref.id;
    },

    /**
     * Owner / manager: changes an open reminder's title, date, party or repeat.
     * @param {string} id
     * @param {{title: string, dueDate: string, party?: string, repeat?: ?string, repeatDay?: ?number}} r checked by checkReminder()
     * @param {{uid: string, name?: string}} by
     */
    async updateReminder(id, { title, dueDate, party, repeat, repeatDay }, { uid, name }) {
        const patch = optional({ title, dueDate, updatedBy: uid, updatedAt: serverCreatedAt() }, { party, repeat, repeatDay }, true);
        if (name) patch.updatedByName = String(name).slice(0, 60);
        await getDb().collection(col('reminders')).doc(id).update(patch);
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

    /**
     * Marks an open reminder done for everyone. With `next` (a repeating reminder) the next
     * copy is created in the same batch, linked both ways (`nextId` / `repeatOf`).
     * @param {string} id
     * @param {{uid: string, name?: string}} by
     * @param {?{title: string, dueDate: string, party?: string, repeat: string, repeatDay?: ?number}} [next]
     * @returns {Promise<?string>} the next reminder's id
     */
    async ackReminder(id, { uid, name }, next = null) {
        const coll = getDb().collection(col('reminders'));
        const patch = { status: 'done', doneBy: uid, doneAt: serverCreatedAt() };
        if (name) patch.doneByName = String(name).slice(0, 60);
        if (!next) {
            await coll.doc(id).update(patch);
            return null;
        }
        const ref = coll.doc();
        patch.nextId = ref.id;
        const doc = optional({ title: next.title, dueDate: next.dueDate, status: 'open', repeatOf: id, createdBy: uid, createdAt: serverCreatedAt() }, next, false);
        if (name) doc.createdByName = String(name).slice(0, 60);
        const batch = getDb().batch();
        batch.update(coll.doc(id), patch);
        batch.set(ref, doc);
        await batch.commit();
        return ref.id;
    },

    /** Cancels an open reminder (owner / manager). */
    async cancelReminder(id, { uid, name }) {
        const patch = { status: 'cancelled', cancelledBy: uid, cancelledAt: serverCreatedAt() };
        if (name) patch.cancelledByName = String(name).slice(0, 60);
        await getDb().collection(col('reminders')).doc(id).update(patch);
    }
};
