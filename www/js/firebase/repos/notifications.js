/**
 * @fileoverview Repository of in-app notifications (`notifications`, #12): sending an
 * event to its recipients in batches, the unread listener, pages, marking read and
 * cleaning up. Moved verbatim out of firestore-service.js (docs/architecture.md,
 * phase 5); still called as FirebaseService.sendNotification() etc.
 * @module firebase/repos/notifications
 */

import { AppState } from '../../utils/state.js';
import { getDb, col } from '../db.js';
import { planNotificationDocs, newEventId } from '../../utils/notification-format.js';
import { getUsersForNotifications } from './user-profiles.js';

/**
 * Writes planned notification docs ({id, data}) with batched writes. Doc ids
 * are per event + recipient, so re-sending an event never duplicates it.
 */
const writeNotificationDocs = async (docs) => {
    const db = getDb();
    const ref = db.collection(col('notifications'));
    for (let i = 0; i < docs.length; i += 450) {
        const batch = db.batch();
        docs.slice(i, i + 450).forEach(({ id, data }) => batch.set(ref.doc(id), data));
        await batch.commit();
    }
};

const notificationFromDoc = (doc) => {
    const data = typeof doc.data === 'function' ? (doc.data({ serverTimestamps: 'estimate' }) || {}) : {};
    return { ...data, id: doc.id };
};

/** FirebaseService methods for notifications; spread into FirebaseService (`this` is FirebaseService). */
export const notificationMethods = {
    /**
     * Sends one notification event to the given recipients (actor excluded)
     * in batched writes. Callers fire-and-forget with `.catch(...)` logging.
     * @param {string} eventId - same id → same docs, so an event never notifies twice
     * @param {string[]} recipientIds
     * @param {Object} data - notification fields (type, …)
     * @returns {Promise<number>} number of recipients
     */
    async sendNotification(eventId, recipientIds, data) {
        const docs = planNotificationDocs(eventId, recipientIds, AppState.currentUser?.uid, {
            ...data,
            read: false,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (docs.length) await writeNotificationDocs(docs);
        return docs.length;
    },

    /**
     * Notifies users about item rate changes (one event per rate type).
     * Wholesale rates are only visible to owners/managers, so only they hear
     * about wholesale changes. Never rejects.
     * @param {Object} item - the saved item
     * @param {Array<{rateType: string, oldRate: *, newRate: *}>} changes
     * @param {string} [eventPrefix] - stable id prefix for this save
     * @returns {Promise<void>}
     */
    async notifyRateChanges(item, changes, eventPrefix = newEventId('rate')) {
        try {
            if (!changes?.length) return;
            const users = await getUsersForNotifications();
            const labels = { purchase: 'Purchase', sale: 'Sale', wholesale: 'Wholesale' };
            for (const ch of changes) {
                const recipients = ch.rateType === 'wholesale'
                    ? users.filter(u => u.role === 'owner' || u.role === 'manager')
                    : users;
                await this.sendNotification(`${eventPrefix}-${ch.rateType}`, recipients.map(u => u.id), {
                    type: 'rate_change',
                    itemId: item.id || null,
                    itemName: item.name || '',
                    itemHindiName: item.hindiName || '',
                    rateType: ch.rateType,
                    rateTypeLabel: labels[ch.rateType] || ch.rateType,
                    oldRate: ch.oldRate,
                    newRate: ch.newRate,
                    changedBy: AppState.userName || 'Unknown',
                    changedByUserId: AppState.currentUser?.uid || null
                });
            }
        } catch (error) {
            console.error('Error notifying rate change:', error);
        }
    },

    /**
     * Notifies all users when one item rate is changed (inline rate editor).
     * Callers need not await this; it never rejects.
     * @param {Object} item - The item with changed rate
     * @param {string} rateType - 'purchase' | 'sale' | 'wholesale'
     * @param {number} oldRate - value when editing started
     * @param {number} newRate - committed value
     * @returns {Promise<void>}
     */
    async notifyRateChange(item, rateType, oldRate, newRate) {
        return this.notifyRateChanges(item, [{ rateType, oldRate, newRate }]);
    },

    /**
     * Tells owners that an item was added or its name/contact changed
     * (rate changes go through notifyRateChanges). Never rejects.
     * @param {Object} item
     * @param {'added'|'updated'} action
     * @param {string[]} [fields] - changed non-rate fields
     * @returns {Promise<void>}
     */
    async notifyItemEdit(item, action, fields = []) {
        try {
            const users = await getUsersForNotifications();
            const ownerIds = users.filter(u => u.role === 'owner').map(u => u.id);
            await this.sendNotification(newEventId('item'), ownerIds, {
                type: 'item_edit',
                action,
                fields,
                itemId: item.id || null,
                itemName: item.name || '',
                itemHindiName: item.hindiName || '',
                changedBy: AppState.userName || 'Unknown',
                changedByUserId: AppState.currentUser?.uid || null
            });
        } catch (error) {
            console.error('Error notifying item edit:', error);
        }
    },

    /**
     * Live listener on the user's newest unread notifications
     * (index: userId + read + timestamp desc).
     * @param {string} uid
     * @param {number} limit
     * @param {function(Array<Object>, Array<{type: string, id: string}>, Object): void} onNext
     * @param {function(Error): void} onError
     * @returns {function(): void} unsubscribe
     */
    listenUnreadNotifications(uid, limit, onNext, onError) {
        return getDb().collection(col('notifications'))
            .where('userId', '==', uid)
            .where('read', '==', false)
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .onSnapshot(snapshot => {
                const list = snapshot.docs.map(notificationFromDoc);
                const changes = snapshot.docChanges().map(ch => ({ type: ch.type, id: ch.doc.id }));
                onNext(list, changes, snapshot.metadata || {});
            }, onError);
    },

    /**
     * One page of the user's notifications, newest first (read and unread).
     * `read in [false, true]` lets the existing userId + read + timestamp
     * index serve this query, so no new index has to be deployed.
     * @param {string} uid
     * @param {{limit?: number, after?: Object}} [opts] - `after` = cursor from the previous page
     * @returns {Promise<{items: Array<Object>, cursor: ?Object, hasMore: boolean}>}
     */
    async loadNotificationsPage(uid, { limit = 30, after = null } = {}) {
        let query = getDb().collection(col('notifications'))
            .where('userId', '==', uid)
            .where('read', 'in', [false, true])
            .orderBy('timestamp', 'desc');
        if (after) query = query.startAfter(after);
        const snapshot = await query.limit(limit).get();
        const docs = snapshot.docs;
        return {
            items: docs.map(notificationFromDoc),
            cursor: docs.length ? docs[docs.length - 1] : after,
            hasMore: docs.length === limit
        };
    },

    /**
     * Marks notifications read (batched). Fire-and-forget callers add `.catch`.
     * @param {string[]} ids
     * @returns {Promise<void>}
     */
    async markNotificationsRead(ids) {
        const unique = [...new Set((ids || []).filter(Boolean))];
        if (!unique.length) return;
        const db = getDb();
        const ref = db.collection(col('notifications'));
        for (let i = 0; i < unique.length; i += 450) {
            const batch = db.batch();
            unique.slice(i, i + 450).forEach(id => batch.update(ref.doc(id), { read: true, readAt: Date.now() }));
            await batch.commit();
        }
    },

    /**
     * Marks all of this user's unread notifications read, in bounded pages
     * (`pageSize` docs per batch, at most `maxPages` pages) so a huge backlog
     * can't run away with reads/writes.
     * @param {string} uid
     * @param {{pageSize?: number, maxPages?: number}} [opts]
     * @returns {Promise<number>} number marked read
     */
    async markAllNotificationsRead(uid, { pageSize = 450, maxPages = 3 } = {}) {
        if (!uid) return 0;
        const db = getDb();
        let marked = 0;
        for (let page = 0; page < maxPages; page++) {
            const snapshot = await db.collection(col('notifications'))
                .where('userId', '==', uid)
                .where('read', '==', false)
                .limit(pageSize)
                .get();
            if (snapshot.empty) break;
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.update(doc.ref, { read: true, readAt: Date.now() }));
            await batch.commit();
            marked += snapshot.size;
            if (snapshot.size < pageSize) break;
        }
        return marked;
    },

    /**
     * Deletes this user's notifications older than `cutoffMs` (at most `max`
     * per run, to keep reads cheap).
     * @param {string} uid
     * @param {number} cutoffMs
     * @param {number} [max=100]
     * @returns {Promise<number>} deleted count
     */
    async deleteOldNotifications(uid, cutoffMs, max = 100) {
        const db = getDb();
        const cutoff = typeof firebase !== 'undefined' && firebase.firestore?.Timestamp?.fromMillis
            ? firebase.firestore.Timestamp.fromMillis(cutoffMs)
            : cutoffMs;
        const snapshot = await db.collection(col('notifications'))
            .where('userId', '==', uid)
            .where('read', 'in', [false, true])
            .where('timestamp', '<', cutoff)
            .orderBy('timestamp', 'desc')
            .limit(max)
            .get();
        if (snapshot.empty) return 0;
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        return snapshot.size;
    }
};
