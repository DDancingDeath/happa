/**
 * @fileoverview Owner actions on another user's account (Admin → Users and the
 * Users page, AadhatManagementApp#74): send a password-reset email, remove access,
 * reject a registration and restore a removed or rejected person (#84).
 * Deleting the Firebase Auth account needs the Admin SDK, so "delete" clears the
 * profile's role and marks it `disabled`, and "reject" marks it `rejected`; the
 * profile is kept, so the rules refuse every read/write, the app signs the user
 * out and the person can't register again as pending.
 * @module services/user-admin
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t } from '../i18n/index.js';
import { authErrorMessage } from '../auth/authentication.js';
import { AuditService } from './audit.js';

export const DISABLED_STATUS = 'disabled';
export const REJECTED_STATUS = 'rejected';

export const isDisabledProfile = (user) => user?.status === DISABLED_STATUS;

/** Removed or rejected (#84): kept so the person can't register again; the owner may restore them. */
export const isRemovedProfile = (user) => user?.status === DISABLED_STATUS || user?.status === REJECTED_STATUS;

/** Audit entry for an owner action on an account (#85); never blocks the action. */
export function logUserAction(action, details) {
    AuditService.log(action, details).catch(e => console.warn('Audit entry not written:', e?.code || e));
}

/** Only the owner may act, and never on their own account. */
function canManage(userId) {
    if (AppState.userRole !== 'owner') {
        UIManager.showToast(t('msg.common.access_denied'), 'error');
        return false;
    }
    if (!userId || userId === AppState.currentUser?.uid) {
        UIManager.showToast(t('msg.users.cannot_change_own_account'), 'error');
        return false;
    }
    return true;
}

export const UserAdmin = {
    /** @returns {Promise<boolean>} true when the email was sent */
    async resetPassword(userId, email) {
        if (!canManage(userId)) return false;
        if (!email) {
            UIManager.showToast(t('msg.users.no_email_for_reset'), 'error');
            return false;
        }
        const confirmed = await UIManager.showModal(
            t('msg.common.send_password_reset_email', { email }),
            t('msg.common.reset_password'),
            true
        );
        if (!confirmed) return false;
        try {
            UIManager.showLoading();
            await firebase.auth().sendPasswordResetEmail(email);
            UIManager.showToast(t('msg.common.password_reset_email_sent', { email }));
            return true;
        } catch (error) {
            console.error('Error sending reset email:', error?.code || error);
            UIManager.showToast(t('msg.common.failed_send_reset_email', { message: authErrorMessage(error, 'reset') }), 'error');
            return false;
        } finally {
            UIManager.hideLoading();
        }
    },

    /** @returns {Promise<boolean>} true when access was removed */
    async removeUser(userId, userName) {
        if (!canManage(userId)) return false;
        const confirmed = await UIManager.showModal(
            t('msg.users.confirm_remove_user', { userName: userName || '' }),
            t('msg.common.delete_user'),
            true
        );
        if (!confirmed) return false;
        try {
            UIManager.showLoading();
            await FirebaseService.disableUserProfile(userId, AppState.currentUser?.uid || null);
            logUserAction(AuditService.ACTIONS.REMOVE_USER, { targetUserId: userId, targetName: userName || '' });
            UIManager.showToast(t('msg.users.user_removed', { userName: userName || '' }));
            return true;
        } catch (error) {
            console.error('Error removing user:', error);
            UIManager.showToast(t('msg.common.failed_delete_user', { message: error?.message || '' }), 'error');
            return false;
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Rejects a pending registration (#84): kept as rejected, not deleted.
     * @returns {Promise<boolean>} true when rejected
     */
    async rejectUser(userId, confirmKey = 'msg.admin.are_sure_want_reject_user') {
        if (!canManage(userId)) return false;
        const confirmed = await UIManager.showModal(t(confirmKey), t('msg.admin.reject_user'), true);
        if (!confirmed) return false;
        try {
            UIManager.showLoading();
            await FirebaseService.rejectUserProfile(userId, AppState.currentUser?.uid || null);
            logUserAction(AuditService.ACTIONS.REJECT_USER, { targetUserId: userId });
            UIManager.showToast(t('msg.admin.user_rejected'));
            return true;
        } catch (error) {
            console.error('Error rejecting user:', error);
            UIManager.showToast(t('msg.common.failed_reject_user'), 'error');
            return false;
        } finally {
            UIManager.hideLoading();
        }
    },

    /**
     * Gives a removed or rejected person back a pending registration (#84);
     * the owner then approves them with a role.
     * @returns {Promise<boolean>} true when restored
     */
    async restoreUser(userId, userName) {
        if (!canManage(userId)) return false;
        const confirmed = await UIManager.showModal(
            t('msg.users.confirm_restore_user', { userName: userName || '' }),
            t('ui.admin.restore'),
            true
        );
        if (!confirmed) return false;
        try {
            UIManager.showLoading();
            await FirebaseService.restoreUserProfile(userId);
            logUserAction(AuditService.ACTIONS.RESTORE_USER, { targetUserId: userId, targetName: userName || '' });
            UIManager.showToast(t('msg.users.user_restored', { userName: userName || '' }));
            return true;
        } catch (error) {
            console.error('Error restoring user:', error);
            UIManager.showToast(t('msg.users.failed_restore_user'), 'error');
            return false;
        } finally {
            UIManager.hideLoading();
        }
    }
};
