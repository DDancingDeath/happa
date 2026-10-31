/**
 * @fileoverview Misuse signals for the owner's review queue (#124), on the free
 * plan (no server code): each phone writes small audit entries, and the owner's
 * daily anomaly scan (modules/anomalies.js, which already reads the audit log)
 * turns them into flags. Nothing here reads Firestore.
 *  - a write the rules refused → `PERMISSION_DENIED` { source: "collection op" }
 *    (throttled: one per kind and at most 5 per 10 minutes per phone);
 *  - the first sign-in of a person on a new phone → `NEW_DEVICE` (the phone list
 *    lives in users/{uid}.devices; nothing is written for a known phone);
 *  - trying to change or void a bill past the edit window → `OLD_BILL_EDIT_TRY`.
 * Entries are written by the person's own app, so a modified app can skip them:
 * they are review hints, the rules stay the protection.
 * @module services/security-monitor
 */

import { AppState } from '../utils/state.js';
import { on, FIRESTORE_DENIED } from '../utils/events.js';
import { AuditService } from './audit.js';
import { setOwnDevices } from '../firebase/repos/users.js';
import { tipDeviceId } from '../tip/index.js';
import { SECURITY_ACTIONS, deniedWriteSource, deviceCheck, planDeniedNote } from '../utils/security-flags.js';

let recentDenied = [];

const record = (action, details) => {
    AuditService.log(action, details).catch(e => console.warn('Audit entry not written:', e?.code || e));
};
let stopListening = null;

export const SecurityMonitor = {
    /** Starts recording refused writes (once per page). */
    start() {
        if (!stopListening) stopListening = on(FIRESTORE_DENIED, (source) => this.noteDenied(source));
    },

    stop() {
        if (stopListening) stopListening();
        stopListening = null;
        recentDenied = [];
    },

    /**
     * @param {string} source - firestore-meter label of the refused call
     * @param {number} [now]
     * @returns {boolean} true when an audit entry was written
     */
    noteDenied(source, now = Date.now()) {
        if (!AppState.currentUser?.uid) return false;
        const write = deniedWriteSource(source);
        if (!write) return false;
        const plan = planDeniedNote(recentDenied, write, now);
        recentDenied = plan.recent;
        if (!plan.note) return false;
        record(SECURITY_ACTIONS.DENIED, { source: write });
        return true;
    },

    /**
     * After the profile was read at start-up: remembers this phone for the person
     * and, when they had used other phones before, writes `NEW_DEVICE`.
     * @param {string} uid
     * @param {Object} profile - users/{uid} data
     * @returns {Promise<boolean>} true when this phone was new
     */
    async checkDevice(uid, profile) {
        if (!uid || !profile) return false;
        const deviceId = tipDeviceId(uid);
        const check = deviceCheck(profile.devices, deviceId);
        if (!check.isNew) return false;
        if (check.flag) record(SECURITY_ACTIONS.NEW_DEVICE, { device: deviceId.slice(0, 10), known: check.next.length - 1 });
        await setOwnDevices(uid, check.next);
        return true;
    },

    /**
     * Someone other than the owner tried to change or void a bill the app refused
     * because its edit window has passed.
     * @param {Object} bill
     * @param {string} billType
     * @param {'edit'|'void'} what
     */
    noteOldBillTry(bill, billType, what) {
        if (!bill || AppState.userRole === 'owner') return;
        record(SECURITY_ACTIONS.OLD_BILL_TRY, {
            what, billType: String(billType || ''), billId: String(bill.id || ''), billNumber: bill.billNumber || null
        });
    }
};
