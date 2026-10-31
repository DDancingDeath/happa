/**
 * @fileoverview The Date box of the bill forms (#147): purchase (`billDate`), retail
 * sale (`saleDate`) and wholesale (`wholesaleDate`). Which days may be picked and the
 * bill's time come from utils/bill-date.js; this file only drives the input.
 * @module ui/bill-date-input
 */

import { AppState } from '../utils/state.js';
import { billDayRange } from '../utils/bill-date.js';
import { parseAnyBillDate, toLocalISODate } from '../utils/dates.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { sessionForDate } from '../utils/cash-session.js';
import { UIManager } from './ui-manager.js';
import { t } from '../i18n/index.js';

/** How long the "saved" toast waits to learn whether a back-dated cash day is closed. */
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
    if (!input) return;
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
    return input?.dataset.picked && input.value ? input.value : toLocalISODate(now);
}

/** After a save, a clear or the end of an edit: today again. */
export function resetBillDate(id) {
    const input = document.getElementById(id);
    if (!input) return;
    delete input.dataset.picked;
    input.value = '';
    prepareBillDate(id);
}

/**
 * "Saved" toast. A bill dated on an earlier day with cash in it, whose cash day is
 * already closed, adds that the closed day's figures won't change (the closed
 * session keeps the totals it was counted with).
 * @param {string} text - the saved message
 * @param {Object} bill - the saved bill (timestamp, enteredAt, cash)
 * @param {number} cash - cash paid / received at the bill
 */
export async function showBillSavedToast(text, bill, cash) {
    const day = Number(bill?.timestamp) ? toLocalISODate(new Date(Number(bill.timestamp))) : null;
    if (!day || !(cash > 0) || day >= toLocalISODate(new Date())) {
        UIManager.showToast(text);
        return;
    }
    let closed = false;
    try {
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), CLOSED_DAY_WAIT_MS));
        const sessions = await Promise.race([FirebaseService.loadCashSessionsForDate(day), timeout]);
        closed = !!sessionForDate(sessions || [], day)?.signedOut;
    } catch (e) {
        console.warn('Bill: cash day not checked:', e?.code || e);
    }
    UIManager.showToast(closed ? t('msg.billing.saved_cash_day_closed', { message: text }) : text, closed ? 5000 : undefined);
}
