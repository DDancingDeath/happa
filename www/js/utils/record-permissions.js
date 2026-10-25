/**
 * @fileoverview Who may change shared records — mirrors firestore.rules (#18)
 * so the app hides actions the database would refuse.
 * @module utils/record-permissions
 */

/** Members may change their own expense for this long after creating it. */
export const MEMBER_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Message keys (i18n catalogue) for actions the rules refuse. */
export const EXPENSE_LOCKED_KEY = 'msg.expenses.locked';
export const ITEM_DELETE_LOCKED_KEY = 'msg.items.delete_locked';

const isOwnerOrManager = (role) => role === 'owner' || role === 'manager';

/**
 * Whether this user may edit or delete the expense (firestore.rules
 * canUpdateExpense / canDeleteExpense): owner/manager always; anyone else
 * only their own expense, within 24 hours of its `timestamp`.
 * @param {Object} expense
 * @param {{uid?: string, role?: string, now?: number}} user
 * @returns {boolean}
 */
export function canChangeExpense(expense, { uid, role, now = Date.now() } = {}) {
    if (isOwnerOrManager(role)) return true;
    if (!expense || !uid) return false;
    const creator = expense.userId !== undefined ? expense.userId : expense.createdBy;
    const t = expense.timestamp;
    return creator === uid && typeof t === 'number'
        && t > now - MEMBER_EDIT_WINDOW_MS && t < now + MEMBER_EDIT_WINDOW_MS;
}

/**
 * Only an owner deletes catalogue items (firestore.rules canDeleteRecord).
 * @param {string} role
 * @returns {boolean}
 */
export function canDeleteItem(role) {
    return role === 'owner';
}

/** Firestore refused the write because of the security rules. */
export function isPermissionDenied(error) {
    return error?.code === 'permission-denied' || /PERMISSION_DENIED|insufficient permissions/i.test(String(error?.message || ''));
}

/** Everyone but the owner may edit or delete a bill for this long after it was first saved (#87). */
export const BILL_EDIT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export const BILL_WINDOW_PASSED_KEY = 'msg.billing.edit_window_passed';

/**
 * When the bill was first saved (ms): its server `createdAt` (Firestore
 * Timestamp, or a local estimate right after saving). null for bills saved
 * before #87 — those count as outside the window.
 * @param {Object} bill
 * @returns {?number}
 */
export function billCreatedMs(bill) {
    const c = bill?.createdAt;
    if (c === null || c === undefined) return null;
    if (typeof c === 'number') return Number.isFinite(c) ? c : null;
    if (typeof c.toMillis === 'function') return c.toMillis();
    if (c instanceof Date) return Number.isFinite(c.getTime()) ? c.getTime() : null;
    if (typeof c.seconds === 'number') return c.seconds * 1000 + Math.floor((c.nanoseconds || 0) / 1e6);
    return null;
}

/** True while the bill is inside the 2-day window (firestore.rules withinBillWindow). */
export function withinBillEditWindow(bill, now = Date.now()) {
    const t = billCreatedMs(bill);
    return t !== null && now < t + BILL_EDIT_WINDOW_MS;
}

/**
 * Who may fully edit a bill (firestore.rules canFullyEditBill): the owner
 * always; a manager or the bill's creator only within the window.
 * @param {Object} bill
 * @param {{uid?: string, role?: string, now?: number}} user
 */
export function canEditBillFor(bill, { uid, role, now = Date.now() } = {}) {
    if (role === 'owner') return true;
    if (!bill || !uid) return false;
    const allowed = role === 'manager' || (!!bill.userId && bill.userId === uid);
    return allowed && withinBillEditWindow(bill, now);
}

/**
 * Who may delete a bill (firestore.rules canDeleteBill): the owner always;
 * the bill's creator only within the window.
 * @param {Object} bill
 * @param {{uid?: string, role?: string, now?: number}} user
 */
export function canDeleteBillFor(bill, { uid, role, now = Date.now() } = {}) {
    if (role === 'owner') return true;
    if (!bill || !uid || !bill.userId || bill.userId !== uid) return false;
    return withinBillEditWindow(bill, now);
}
