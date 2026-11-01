/**
 * @fileoverview Repository of Money › Worth's bank, savings and other accounts
 * (`settings/accounts`, #74): one document shared by every phone,
 * `{ accounts: { <id>: { name, balance, type } }, updatedAt, updatedBy, changedId }`.
 * Read by roles with Money on; written by the owner and managers with Money on
 * (firestore.rules). One account changes per write (a merge on its own key), so
 * two phones editing different accounts never overwrite each other.
 * @module firebase/repos/worth-accounts
 */

import { col } from '../db.js';
import { AppState } from '../../utils/state.js';

const accountsRef = (db) => db.collection(col('settings')).doc('accounts');

const stamp = () => ({
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: AppState.currentUser?.uid || null
});

/** FirebaseService methods for the shared accounts; spread into FirebaseService (`this` is FirebaseService). */
export const worthAccountMethods = {
    /**
     * The shared accounts map (server first, the offline cache when it can't be reached).
     * @returns {Promise<Object<string, Object>>} {} when nothing was saved yet
     */
    async loadWorthAccounts() {
        const doc = await accountsRef(this.db).get();
        const map = doc.exists ? (doc.data() || {}).accounts : null;
        return map && typeof map === 'object' ? map : {};
    },

    /**
     * Adds or replaces one account. Not async: queued on the phone at once.
     * @param {string} id
     * @param {{name: string, balance: number, type: string}} entry
     * @returns {Promise<void>} the server acknowledgement
     */
    saveWorthAccount(id, entry) {
        return accountsRef(this.db).set({ accounts: { [id]: entry }, changedId: id, ...stamp() }, { merge: true });
    },

    /**
     * Removes one account. Not async: queued on the phone at once.
     * @param {string} id
     * @returns {Promise<void>} the server acknowledgement
     */
    removeWorthAccount(id) {
        return accountsRef(this.db).set({
            accounts: { [id]: firebase.firestore.FieldValue.delete() }, changedId: id, ...stamp()
        }, { merge: true });
    },

    /**
     * Owner only: the first shared list, from one phone's accounts. Writes only while the
     * shared list is still empty (re-read on the server in a transaction).
     * @param {Object<string, Object>} map
     * @returns {Promise<boolean>} false when another phone saved accounts first
     */
    useAccountsForAllPhones(map) {
        const ref = accountsRef(this.db);
        return this.db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const now = snap.exists ? (snap.data() || {}).accounts : null;
            if (now && typeof now === 'object' && Object.keys(now).length) return false;
            tx.set(ref, { accounts: map, ...stamp() });
            return true;
        });
    }
};
