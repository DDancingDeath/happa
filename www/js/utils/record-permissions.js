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
