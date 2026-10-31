/**
 * @fileoverview Misuse signals for the owner's review queue (#124), on the free
 * plan (no server code): each phone writes small audit entries, and the owner's
 * daily anomaly scan (modules/anomalies.js, which already reads the audit log)
 * turns them into flags. Nothing here reads Firestore.
 *  - a single-document write the rules refused → `PERMISSION_DENIED` { source:
 *    "collection op" } (throttled per phone; refusals the app expects, such as a
 *    wrong phone clock or a bill a retry already saved, are marked and skipped);
 *  - a person's sign-in on a phone not in deviceLog/{uid}.devices → `NEW_DEVICE`
 *    (after the first DEVICE_GRACE_DAYS of their list; nothing for a known phone);
 *  - trying to change or void a bill past the edit window → `OLD_BILL_EDIT_TRY`.
 * Entries are written by the person's own app, so a modified app can skip them:
 * they are review hints, the rules stay the protection.
 * @module services/security-monitor
 */

import { AppState } from '../utils/state.js';
import { on, FIRESTORE_DENIED } from '../utils/events.js';
import { AuditService } from './audit.js';
import { addOwnDevice, readOwnDevices } from '../firebase/repos/users.js';
import { safeSetItem } from '../utils/storage-full.js';
import { tipDeviceId } from '../tip/index.js';
import { todayLocalISO } from '../utils/dates.js';
import { accessFor } from '../utils/role-access.js';
import { SECURITY_ACTIONS, deniedWriteSource, deviceCheck, planDeniedNote } from '../utils/security-flags.js';

/** This phone already recorded for the person ("uid|deviceId"). */
const DEVICE_KEY = 'happaDeviceKnown';
const DEVICE_TRIED_KEY = 'happaDeviceTried';

/** Time for the caller to mark a refusal as expected (the clock check takes up to 5 s). */
export const DENIED_DECIDE_MS = 8000;

let recentDenied = [];
let stopListening = null;
const timers = new Set();
/** Old-bill tries already recorded this session (`billId:what`). */
const triedBills = new Set();

const record = (action, details) => AuditService.log(action, details)
    .catch(e => console.warn('Audit entry not written:', e?.code || e));

/** Shop roles write the audit log (rentals-only people can't). */
const writesAudit = () => ['owner', 'manager', 'staff'].includes(AppState.userRole);

export const SecurityMonitor = {
    /** Starts recording refused writes (once per page). */
    start() {
        if (!stopListening) stopListening = on(FIRESTORE_DENIED, (source, err) => this.noteDenied(source, err));
    },

    stop() {
        if (stopListening) stopListening();
        stopListening = null;
        timers.forEach(clearTimeout);
        timers.clear();
        triedBills.clear();
        recentDenied = [];
    },

    /**
     * Records a refused write after DENIED_DECIDE_MS unless its error was marked
     * as expected by then.
     * @param {string} source - firestore-meter label of the refused call
     * @param {Object} [err]
     * @returns {boolean} true when it was queued for recording
     */
    noteDenied(source, err) {
        if (!AppState.currentUser?.uid || !writesAudit()) return false;
        const write = deniedWriteSource(source);
        if (!write) return false;
        const timer = setTimeout(() => {
            timers.delete(timer);
            this.decideDenied(write, err, Date.now());
        }, DENIED_DECIDE_MS);
        timers.add(timer);
        return true;
    },

    /** @returns {boolean} true when an audit entry was written */
    decideDenied(write, err, now) {
        if (err?.aadhatExpected || !AppState.currentUser?.uid) return false;
        const plan = planDeniedNote(recentDenied, write, now);
        recentDenied = plan.recent;
        if (!plan.note) return false;
        record(SECURITY_ACTIONS.DENIED, { source: write });
        return true;
    },

    /**
     * At start-up: remembers this phone for the person in deviceLog/{uid} and, when
     * they have had a list for a while, writes `NEW_DEVICE`. A phone that already
     * did this for the person reads nothing (kept on the phone).
     * @param {string} uid
     * @returns {Promise<boolean>} true when this phone was new
     */
    async checkDevice(uid) {
        if (!uid || !writesAudit()) return false;
        const deviceId = tipDeviceId(uid);
        const known = `${uid}|${deviceId}`;
        const today = todayLocalISO();
        try {
            if (localStorage.getItem(DEVICE_KEY) === known) return false;
            // A refused write (e.g. a phone clock days ahead) is tried again the next day, not on every start
            if (localStorage.getItem(DEVICE_TRIED_KEY) === `${known}|${today}`) return false;
        } catch (_) { /* no storage: check with the server */ }
        const check = deviceCheck(await readOwnDevices(uid), deviceId, today);
        if (check.isNew) {
            // Added with arrayUnion (another phone may add itself meanwhile); a full list is replaced
            try {
                await addOwnDevice(uid, check.entry, check.full ? check.next : null);
            } catch (e) {
                safeSetItem(DEVICE_TRIED_KEY, `${known}|${today}`);
                throw e;
            }
            if (check.flag) record(SECURITY_ACTIONS.NEW_DEVICE, { device: deviceId.slice(0, 10) });
        }
        safeSetItem(DEVICE_KEY, known);
        return check.isNew;
    },

    /**
     * Someone other than the owner tried to change or void a bill the app refused
     * because its edit window has passed.
     * @param {Object} bill
     * @param {string} billType
     * @param {'edit'|'void'} what
     */
    noteOldBillTry(bill, billType, what) {
        if (!bill || AppState.userRole === 'owner' || !writesAudit()) return;
        // No window at all (editDays 0 = never): nothing to try past; one entry per bill and action
        if (!(accessFor(AppState.userRole, AppState.settings?.roleAccess).editDays > 0)) return;
        const key = `${bill.id}:${what}`;
        if (triedBills.has(key)) return;
        triedBills.add(key);
        record(SECURITY_ACTIONS.OLD_BILL_TRY, {
            what, billType: String(billType || ''), billId: String(bill.id || ''), billNumber: bill.billNumber || null
        });
    }
};
