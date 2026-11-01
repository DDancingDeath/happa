/**
 * @fileoverview Who may change shared records — mirrors firestore.rules (#18)
 * so the app hides actions the database would refuse.
 * @module utils/record-permissions
 */

/** Message keys (i18n catalogue) for actions the rules refuse. */
export const EXPENSE_LOCKED_KEY = 'msg.expenses.locked';
export const ITEM_ARCHIVE_LOCKED_KEY = 'msg.items.archive_locked';

const isOwnerOrManager = (role) => role === 'owner' || role === 'manager';

// Who may void an expense: role-access.js canVoidExpenseWith (#99).

/**
 * Owners and managers archive / unarchive items (#123; firestore.rules: item
 * updates are owner/manager). Nobody deletes an item from the app.
 * @param {string} role
 * @returns {boolean}
 */
export function canArchiveItem(role) {
    return isOwnerOrManager(role);
}

/** Firestore refused the write because of the security rules. */
export function isPermissionDenied(error) {
    return error?.code === 'permission-denied' || /PERMISSION_DENIED|insufficient permissions/i.test(String(error?.message || ''));
}
