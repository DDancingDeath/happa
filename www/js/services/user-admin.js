/**
 * @fileoverview Owner actions on another user's account (Admin → Users and the
 * Users page, AadhatManagementApp#74): send a password-reset email and remove access.
 * Deleting the Firebase Auth account needs the Admin SDK, so "delete" clears the
 * profile's role and marks it `disabled`; the rules then refuse every read/write
 * and the app signs the user out.
 * @module services/user-admin
 */

import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { t } from '../i18n/index.js';

export const DISABLED_STATUS = 'disabled';

export const isDisabledProfile = (user) => user?.status === DISABLED_STATUS;

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
            console.error('Error sending reset email:', error);
            UIManager.showToast(t('msg.common.failed_send_reset_email', { message: error?.message || '' }), 'error');
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
            UIManager.showToast(t('msg.users.user_removed', { userName: userName || '' }));
            return true;
        } catch (error) {
            console.error('Error removing user:', error);
            UIManager.showToast(t('msg.common.failed_delete_user', { message: error?.message || '' }), 'error');
            return false;
        } finally {
            UIManager.hideLoading();
        }
    }
};
