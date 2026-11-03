/**
 * @fileoverview FirebaseService: the one object pages and services use for every Firestore read
 * and write. It is put together from the data layer's modules (firebase/core/*: listeners, history
 * window, stock and its checkpoint; firebase/repos/*: one per collection family), whose method
 * objects are spread in, so callers, `this` and test spies see one object (docs/architecture.md).
 * @module firebase/firestore-service
 */

// -------------------- FIREBASE DATA OPERATIONS --------------------

import { CLIENT_VERSION, getDb } from './db.js';
import { itemMethods } from './repos/items.js';
import { billStatsMethods } from './repos/bill-stats.js';
import { collectionAdminMethods } from './repos/collection-admin.js';
import { tipMethods } from './repos/tip-health.js';
import { anomalyMethods } from './repos/anomalies.js';
import { userProfileMethods } from './repos/user-profiles.js';
import { notificationMethods } from './repos/notifications.js';
import { cashDayMethods } from './repos/cash-days.js';
import { worthAccountMethods } from './repos/worth-accounts.js';
import { reminderMethods } from './repos/reminders.js';
import { settingsMethods } from './repos/settings.js';
import { settleWrite } from './core/write-settle.js';
import { installFirestoreMeter } from './firestore-meter.js';
import { historyWindowMethods } from './core/history-window.js';
import { dueBackfillMethods, legacyScanMethods } from './core/legacy-scan.js';
import { stockCheckpointMethods } from './core/stock-checkpoint.js';
import { stockMethods } from './core/stock.js';
import { billMethods } from './repos/bills.js';
import { billSaveMethods } from './repos/bill-save.js';
import { billEditMethods } from './repos/bill-edit.js';
import { expenseMethods } from './repos/expenses.js';
import { stockRecordMethods } from './repos/stock-records.js';
import { listenerMethods } from './core/listeners.js';

// Count reads and catch quota errors for every Firestore call in the app (#194).
if (typeof firebase !== 'undefined' && firebase.firestore) {
    try {
        installFirestoreMeter(firebase.firestore);
    } catch (e) {
        console.warn('Read counter not installed:', e);
    }
}

/**
 * Firebase Service object containing all database operations.
 * Provides methods for CRUD operations on all collections.
 * @namespace FirebaseService
 */
const FirebaseService = {
    /**
     * Gets the Firestore database reference.
     * @type {firebase.firestore.Firestore}
     */
    get db() {
        return getDb();
    },

    /**
     * For the sync pill (ui/sync-status.js): a function that resolves once the SDK
     * has sent every queued write, or null when Firestore or that call isn't there.
     * @returns {?function(): Promise<void>}
     */
    pendingWritesWaiter() {
        const db = getDb();
        return typeof db.waitForPendingWrites === 'function' ? () => db.waitForPendingWrites() : null;
    },

    ...listenerMethods,

    ...itemMethods,

    ...billStatsMethods,

    ...historyWindowMethods,

    ...collectionAdminMethods,

    /**
     * See settleWrite(): resolves when a write is acknowledged, or stored on this
     * device (offline at once, online after a short timeout), so bill saves don't
     * block on the network; stored=false if that was not confirmed in time.
     * @param {Promise<void>} writePromise
     * @param {string} [label]
     * @returns {Promise<{pending: boolean, stored: boolean}>}
     */
    settleWrite(writePromise, label) {
        return settleWrite(writePromise, label);
    },

    ...billSaveMethods,

    ...billEditMethods,

    ...billMethods,

    ...expenseMethods,

    /** Version written as `clientVersion` on stock records (see firestore.rules). */
    CLIENT_VERSION,

    ...settingsMethods,

    ...tipMethods,

    ...stockMethods,

    ...stockCheckpointMethods,

    ...legacyScanMethods,
    ...dueBackfillMethods,

    ...stockRecordMethods,

    ...notificationMethods,

    ...cashDayMethods,

    ...anomalyMethods,
    ...worthAccountMethods,
    ...reminderMethods,

    ...userProfileMethods
};

// Export FirebaseService and cleanup function
export { FirebaseService };
