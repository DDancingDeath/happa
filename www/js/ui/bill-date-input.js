/**
 * @fileoverview The Date box of the bill forms (#147): purchase (`billDate`), retail
 * sale (`saleDate`) and wholesale (`wholesaleDate`). Which days may be picked and the
 * bill's time come from utils/bill-date.js; this file only drives the input.
 * @module ui/bill-date-input
 */

import { AppState } from '../utils/state.js';
import { backdatedCash, billDayRange } from '../utils/bill-date.js';
import { parseAnyBillDate, toLocalISODate } from '../utils/dates.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { sessionForDate } from '../utils/cash-session.js';
import { UIManager } from './ui-manager.js';
import { t } from '../i18n/index.js';

/** How long the owner's back-dated cash check waits to learn whether that cash day is closed. */
const CLOSED_DAY_WAIT_MS = 2500;

/** Who is entering: the role's day range (utils/bill-date.js). */
export const billDateWho = (now = new Date()) => ({ role: AppState.userRole, roleAccess: AppState.settings?.roleAccess, now });

/**
 * Sets the days the role may pick; today unless the user picked another day.
 * While a saved bill is edited the box shows its day and is locked (an edit
 * keeps the bill's date).
 * @param {string} id
 * @param {?Object} [editingBill]
 */
export function prepareBillDate(id, editingBill = null) {
    const input = document.getElementById(id);
    if (!input || (input.dataset.locked && !editingBill)) return;
    const range = billDayRange(billDateWho());
    input.max = range.max;
    input.min = range.min;
    if (!input.dataset.prepared) {
        input.dataset.prepared = '1';
        // Picking today is the same as not picking: it follows the clock
        input.addEventListener('change', () => {
            if (input.value && input.value !== toLocalISODate(new Date())) input.dataset.picked = '1';
            else delete input.dataset.picked;
        });
    }
    if (editingBill) {
        const d = Number(editingBill.timestamp) ? new Date(Number(editingBill.timestamp)) : parseAnyBillDate(editingBill.date);
        input.value = d ? toLocalISODate(d) : '';
        input.disabled = true;
        delete input.dataset.picked;
        return;
    }
    input.disabled = false;
    if (!input.dataset.picked || !input.value) input.value = range.max;
}

/**
 * The day the bill is for: the picked day, else today at save time (a form left
 * open over midnight saves on the new day).
 * @param {string} id
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function pickedBillDay(id, now = new Date()) {
    const input = document.getElementById(id);
    const today = toLocalISODate(now);
    if (!input?.value) return today;
    if (input.dataset.picked) return input.value;
    // A prepared box not picked follows the clock; one never prepared holds what was typed
    return input.dataset.prepared ? today : input.value;
}

/**
 * Once the first save attempt fixed the bill's time, the box shows that day and is
 * locked: a retry is written with the same time (clear the bill to change it).
 * @param {string} id
 * @param {number} timestamp
 */
export function lockBillDate(id, timestamp) {
    prepareBillDate(id, { timestamp });
    const input = document.getElementById(id);
    if (input) input.dataset.locked = '1';
}

/** After a save, a clear or the end of an edit: today again. */
export function resetBillDate(id) {
    const input = document.getElementById(id);
    if (!input) return;
    delete input.dataset.picked;
    delete input.dataset.locked;
    input.value = '';
    prepareBillDate(id);
}

/**
 * Cash on a bill dated before today (#147, utils/bill-date.js backdatedCash): refused
 * for everyone but the owner (online or due only); the owner confirms when that day's
 * cash is already closed (its figures won't change). Checked before every save attempt: a retry is
 * judged on its fixed day and entry time (as the rules judge it), with the payment as now typed.
 * @param {string} day YYYY-MM-DD picked (first attempt)
 * @param {number} cash
 * @param {?{timestamp?: number, enteredAt?: number}} [pending] the bill's earlier attempt, if any
 * @returns {Promise<boolean>} true when the bill may be saved
 */
export async function allowBackdatedCash(day, cash, pending = null) {
    const fixed = pending?.timestamp ? pending : null;
    if (fixed) day = toLocalISODate(new Date(fixed.timestamp));
    const entered = new Date(fixed ? (fixed.enteredAt || fixed.timestamp) : Date.now());
    const rule = backdatedCash(day, cash, AppState.userRole, entered);
    if (rule === 'ok') return true;
    if (rule === 'refuse') {
        UIManager.showToast(t('msg.billing.backdated_no_cash'), 'warning');
        return false;
    }
    let closed = false;
    try {
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), CLOSED_DAY_WAIT_MS));
        const sessions = await Promise.race([FirebaseService.loadCashSessionsForDate(day), timeout]);
        closed = !!sessionForDate(sessions || [], day)?.signedOut;
    } catch (e) {
        console.warn('Bill: cash day not checked:', e?.code || e);
    }
    if (!closed) return true;
    return UIManager.showModal(t('msg.billing.backdated_cash_closed_confirm'), t('msg.checks.check_before_saving'), true);
}