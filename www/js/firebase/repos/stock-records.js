/**
 * @fileoverview Stock adjustments and withdrawals: new records with an id made on the phone, shown at
 * once also offline (#95); a refused write removes them again. Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/repos/stock-records
 */

import { AppState } from '../../utils/state.js';
import { noteMonthWrite, prepareStockRecord, startCreate } from '../core/history-window.js';
import { noteStockWrite } from '../core/stock-checkpoint.js';
import { parseAnyBillDate } from '../../utils/dates.js';

/** FirebaseService methods for stock adjustments and withdrawals; spread into FirebaseService (`this` is FirebaseService). */
export const stockRecordMethods = {
    /**
     * Saves a stock adjustment to Firestore.
     * @async
     * @param {Object} adjustment - The stock adjustment to save
     * @param {string} adjustment.itemId - ID of the item being adjusted
     * @param {string} adjustment.adjustType - Type of adjustment ('add', 'remove', 'set')
     * @param {number} adjustment.quantity - Adjustment quantity
     * @param {number} [adjustment.rate] - Rate for the adjustment
     * @param {string} adjustment.date - Adjustment date
     * @param {string} [adjustment.reason] - Reason for adjustment
     * @returns {Promise<Object>} The saved adjustment with ID
     */
    async saveStockAdjustment(adjustment) {
        const { record, committed } = this.startSaveStockAdjustment(adjustment);
        await committed;
        return record;
    },

    /**
     * Starts saving a new stock adjustment (id made on the phone) and shows it
     * at once, also offline (#95); a refused write removes it again.
     * @param {Object} adjustment
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveStockAdjustment(adjustment, { id } = {}) {
        if (!adjustment.userId && AppState.currentUser) {
            adjustment.userId = AppState.currentUser.uid;
        }
        if (!adjustment.userName && AppState.userName) {
            adjustment.userName = AppState.userName;
        }
        
        prepareStockRecord('stockAdjustments', adjustment, true);
        // `id`: a fixed id (a reversal, #146), so a second phone's copy lands on the same document
        const started = startCreate('stockAdjustments', adjustment, id || null);
        noteStockWrite('stockAdjustments', null, adjustment);
        noteMonthWrite('stockAdjustments', null, adjustment);
        return started;
    },

    /**
     * Starts saving a new withdrawal (id made on the phone) and shows it at
     * once, also offline (#95); a refused write removes it again.
     * @param {Object} withdrawal
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveWithdrawal(withdrawal) {
        if (!withdrawal.userId && AppState.currentUser) {
            withdrawal.userId = AppState.currentUser.uid;
        }
        if (!withdrawal.userName && AppState.userName) {
            withdrawal.userName = AppState.userName;
        }
        
        // The window queries filter on `timestamp`; `date` is a user-picked day, so use the
        // later of creation time and that day (a backdated withdrawal is then an extra older record).
        if (typeof withdrawal.timestamp !== 'number') {
            withdrawal.timestamp = Math.max(Date.now(), parseAnyBillDate(withdrawal.date)?.getTime() || 0);
        }
        const started = startCreate('withdrawals', withdrawal);
        noteMonthWrite('withdrawals', null, withdrawal);
        return started;
    }
};
