/**
 * @fileoverview Who may change shared records — mirrors firestore.rules (#18)
 * so the app hides actions the database would refuse.
 * @module utils/record-permissions
 */

/** Message keys (i18n catalogue) for actions the rules refuse. */
export const EXPENSE_LOCKED_KEY = 'msg.expenses.locked';
export const ITEM_DELETE_LOCKED_KEY = 'msg.items.delete_locked';

// Who may void an expense: role-access.js canVoidExpenseWith (#99).

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
